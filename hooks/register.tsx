import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_SCENE, Narrator } from './narrator'
import type { EventKind, Spent } from './narrator'
import { ROWS, Stage } from './script'

// Module state: a reload starts these over, which is fine for a live cartoon.
const stage = new Stage(DEFAULT_SCENE)
const narrator = new Narrator((reply, keepScene) => {
  stage.typer.type(reply.speech)
  if (!keepScene && reply.scene) stage.load(reply.scene, Date.now())
})
let mounted: { id: string; width: number } | null = null
let blitting = false
let enabled = true // /close-spinner and /open-spinner; kept in $.store across sessions

const FRAME_MS = 50 // ~20 fps

/** Starts the narrator's background loop if it is idle. Never awaited: the agent never waits on it. */
function pump($: EngineInterface): void {
  void narrator.pump({
    complete: (ask, signal) => $.model.complete(ask, { signal }),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  })
}

function tell($: EngineInterface, kind: EventKind, text: string, topic?: string): void {
  if (!enabled) return
  narrator.push(kind, text, topic)
  pump($)
}

async function tick($: EngineInterface): Promise<void> {
  if (!enabled || !mounted || blitting) return
  blitting = true
  try {
    const { id, width } = mounted
    const r = await $.ui.blit({ requestId: id, key: 'oracle', columns: width, rows: ROWS, cells: stage.frame(width, Date.now()) })
    if (r.deny) mounted = null
  } catch {
    mounted = null
  } finally {
    blitting = false
  }
}

/** A tool call in a line: its name and the argument that says the most (a path, a command, a pattern). */
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const pathOf = (input: Record<string, unknown>) => str(input.file_path) || str(input.path) || str(input.notebook_path)

/** What a tool call is about, for deciding on a new scene: its file, or else the tool. */
export function topicOf(tool: string, input: Record<string, unknown>): string {
  return pathOf(input) || tool
}

export function describe(tool: string, input: Record<string, unknown>): string {
  const s = str
  const path = pathOf(input)
  const parts = [tool]
  if (path) parts.push(path.split('/').slice(-2).join('/'))
  if (s(input.command)) parts.push(`$ ${s(input.command).replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '').slice(0, 120)}`)
  if (s(input.pattern)) parts.push(`pattern ${JSON.stringify(s(input.pattern).slice(0, 60))}`)
  if (s(input.description)) parts.push(`(${s(input.description).slice(0, 80)})`)
  if (s(input.prompt) && parts.length === 1) parts.push(s(input.prompt).slice(0, 80))
  return parts.join(' ')
}

const n = (x: number) => x.toLocaleString('en-US')

/** /spinner-usage: what the narrator has spent on the model since the mod loaded. */
export function usageReport(s: Spent): string {
  const input = s.input + s.cacheRead + s.cacheWrite
  if (!s.requests) return 'No model requests yet.'
  const failed = Object.entries(s.failed)
  const nFailed = failed.reduce((sum, [, k]) => sum + k, 0)
  return [
    `${n(s.requests)} model requests since it loaded` + (nFailed ? ` (${n(nFailed)} unanswered: ${failed.map(([why, k]) => `${k} ${why}`).join(', ')})` : ''),
    `  input  ${n(input)} tokens (${n(s.input)} uncached, ${n(s.cacheRead)} cache read, ${n(s.cacheWrite)} cache write)`,
    `  output ${n(s.output)} tokens`,
    `  per request: ~${n(Math.round(input / s.requests))} in, ~${n(Math.round(s.output / s.requests))} out`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      enabled = (await $.store.get('enabled')) !== false
      await $.command.register({ name: 'close-spinner', description: 'Turn off the spinner-oracle cartoon (no more model calls)', immediate: true })
      await $.command.register({ name: 'open-spinner', description: 'Turn the spinner-oracle cartoon back on', immediate: true })
      await $.command.register({ name: 'spinner-usage', description: 'Show how many tokens the spinner-oracle cartoon has used', immediate: true })
    } catch {
      // commands are a nicety; the cartoon runs without them
    }
    try {
      $.clock.every(FRAME_MS, () => tick($))
    } catch {
      // no animation, but the first frame still draws with the spinner
    }
    return next(e)
  })

  on('command.run', { command: 'close-spinner' }, async $ => {
    enabled = false
    narrator.endTurn() // aborts the request in flight
    mounted = null
    await $.store.set('enabled', false)
    return { text: 'spinner-oracle off. Back on with /open-spinner.' }
  })

  on('command.run', { command: 'open-spinner' }, async $ => {
    enabled = true
    await $.store.set('enabled', true)
    return { text: 'spinner-oracle on. The cartoon starts with the next turn.' }
  })

  on('command.run', { command: 'spinner-usage' }, async () => ({ text: usageReport(narrator.spent) }))

  on('prompt.submit', ($, e, next) => {
    if (e.text.trim() && !e.text.trim().startsWith('/')) narrator.setTask(e.text)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (!enabled) return next(e)
    narrator.startTurn()
    stage.current = null // the default scene until the narrator's first reply
    stage.previous = null
    stage.typer.type('Reading the task…')
    tell($, 'turn', 'a new turn started; the agent is reading the task')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { tool, agentId, ...input } = e as Record<string, unknown>
    const line = describe(String(tool), input)
    tell($, 'tool', line, topicOf(String(tool), input))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) tell($, 'result', `${String(tool)} failed`)
    return ran
  })

  on('session.append', ($, e, next) => {
    if (e.agentId === undefined && e.door === 'response' && e.message.type === 'assistant') {
      const text = e.message.content
        .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .join(' ')
        .trim()
      if (text) tell($, 'text', `the agent says: ${text.slice(0, 200)}`)
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    narrator.endTurn()
    return next(e)
  })

  // The spinner region: the engine's own status line on top, the scene full width under it.
  // Anything going wrong here hands back the engine's spinner untouched.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const line = await next(e)
    if (!enabled || e.surface !== 'terminal') return line
    try {
      const { Box, Raster } = $.ui.resolve(e)
      const width = Math.max(20, Math.min(240, (e.viewport?.columns ?? 80) - 2))
      mounted = { id: e.requestId, width }
      narrator.width = width
      return (
        <Box flexDirection="column">
          {line}
          <Raster key="oracle" columns={width} rows={ROWS} cells={stage.frame(width, Date.now())} />
        </Box>
      )
    } catch {
      mounted = null
      return line
    }
  })
}
