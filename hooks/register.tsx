import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_SCENE, Narrator } from './narrator'
import type { EventKind } from './narrator'
import { ROWS, Stage } from './script'

// Module state: a reload starts these over, which is fine for a live cartoon.
const stage = new Stage(DEFAULT_SCENE)
const narrator = new Narrator((reply, keepScene) => {
  stage.typer.type(reply.speech)
  if (!keepScene && reply.scene) stage.load(reply.scene, Date.now())
})
let mounted: { id: string; width: number } | null = null
let blitting = false

const FRAME_MS = 50 // ~20 fps
const STILL_MS = 20_000 // how often a long tool call pings "still running"

/** Starts the narrator's background loop if it is idle. Never awaited: the agent never waits on it. */
function pump($: EngineInterface): void {
  void narrator.pump({
    complete: (ask, signal) => $.model.complete(ask, { signal }),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  })
}

function tell($: EngineInterface, kind: EventKind, text: string): void {
  narrator.push(kind, text)
  pump($)
}

async function tick($: EngineInterface): Promise<void> {
  if (!mounted || blitting) return
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
export function describe(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const path = s(input.file_path) || s(input.path) || s(input.notebook_path)
  const parts = [tool]
  if (path) parts.push(path.split('/').slice(-2).join('/'))
  if (s(input.command)) parts.push(`$ ${s(input.command).replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '').slice(0, 120)}`)
  if (s(input.pattern)) parts.push(`pattern ${JSON.stringify(s(input.pattern).slice(0, 60))}`)
  if (s(input.description)) parts.push(`(${s(input.description).slice(0, 80)})`)
  if (s(input.prompt) && parts.length === 1) parts.push(s(input.prompt).slice(0, 80))
  return parts.join(' ')
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    try {
      $.clock.every(FRAME_MS, () => tick($))
    } catch {
      // no animation, but the first frame still draws with the spinner
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (e.text.trim() && !e.text.trim().startsWith('/')) narrator.setTask(e.text)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
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
    tell($, 'tool', line)
    const started = Date.now()
    let still: { cancel: () => void } | null = null
    try {
      still = $.clock.every(STILL_MS, () => tell($, 'still', `${line} (${Math.round((Date.now() - started) / 1000)}s)`))
    } catch {
      // no pings then; the tool call itself must never fail because of the cartoon
    }
    try {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError === true) tell($, 'result', `${String(tool)} failed`)
      return ran
    } finally {
      still?.cancel()
    }
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
    if (e.surface !== 'terminal') return line
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
