import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scene } from '../types'
import { paint, ROWS, SPEED } from './paint'
import type { Mode } from './paint'

const scene = atom({ plugin: 'toon-spinner', key: 'scene' } as const, null as Scene | null)

const SYSTEM =
  'You are Claude, captioning a pixel-art animation of yourself: the little orange Claude mascot plows a crop field toward a barn ' +
  'labeled with the file you are working on. Given what you are doing right now, ' +
  'reply with ONE playful farm-flavored sentence, at most 9 words, naming the file or command, ' +
  "like: Plowing through effects.ts, hunting for bugs. No quotes, nothing else."

// ponytail: one Sonnet call in flight, newest tool call wins; skipped calls never get a caption
let busy = false
let queued: string | null = null
// the mounted spinner the animation blits into; a module variable, so a reload waits for the next draw
let mounted: { id: string; width: number; label: string } | null = null
let tick = 0
let pos = 0
let mode: Mode = 'think'

async function caption($: EngineInterface, activity: string): Promise<void> {
  busy = true
  const r = await $.model.complete({
    model: 'claude-sonnet-5-5',
    system: SYSTEM,
    prompt: `You are doing this right now: ${activity}`,
    maxTokens: 60,
    effort: 'low',
    timeoutMs: 15000,
  })
  const text = r.isAnswered ? r.text.trim().split('\n')[0]!.replace(/^["']|["']$/g, '').slice(0, 64) : ''
  if (text) await update($, scene, s => (s ? { ...s, caption: text } : s))
  busy = false
  const nextUp = queued
  queued = null
  if (nextUp) void caption($, nextUp)
}

async function animate($: EngineInterface): Promise<void> {
  if (!mounted) return
  tick += 1
  pos += SPEED[mode]
  const r = await $.ui.blit({ requestId: mounted.id, key: 'scene', columns: mounted.width, rows: ROWS, cells: paint(mounted.width, mounted.label, tick, pos, mode) })
  if (r.deny) mounted = null
}

function modeFor(tool: string): Mode {
  if (tool === 'Bash') return 'run'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'edit'
  return 'read'
}

function targetFor(tool: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.path ?? input.notebook_path
  if (typeof path === 'string' && path) return path.split('/').pop()!
  if (typeof input.command === 'string') {
    const cmd = input.command.trim().replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')
    return cmd.split(/\s+/)[0] || tool
  }
  if (typeof input.pattern === 'string') return input.pattern
  return tool
}

/** The barn's sign: the tool and what it works on, like "Read effects.ts". */
function labelFor(tool: string, input: Record<string, unknown>): string {
  const target = targetFor(tool, input)
  return target === tool ? tool : `${tool} ${target}`
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    // ponytail: ticks all session, ~7/s; idle ticks return at once
    $.clock.every(140, () => animate($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, scene, () => null)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const { tool, agentId, ...input } = e as Record<string, unknown>
      const label = labelFor(String(tool), input)
      await update($, scene, s => ({ caption: s?.caption ?? 'Heading out to the field...', label }))
      const activity = `${String(tool)} ${JSON.stringify(input)}`.slice(0, 200)
      if (busy) queued = activity
      else void caption($, activity)
      mode = modeFor(String(tool))
      const ran = await next(e)
      mode = 'think'
      return ran
    }
    return next(e)
  })

  // the band above the prompt stays up all turn, unlike the spinner, which hides while a tool runs
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, scene)
    if (s === null || !e.props.isWorking || e.props.hasSurvey) {
      mounted = null
      return next(e)
    }

    if (e.surface !== 'terminal' || e.props.maxRows < ROWS) {
      const { Text } = $.ui.resolve(e)
      return <Text color="#d97757">{s.caption}</Text>
    }

    const { Box, Text, Raster } = $.ui.resolve(e)
    const width = Math.max(24, Math.min(64, e.props.bodyColumns - 34))
    mounted = { id: e.requestId, width, label: s.label }
    return (
      <Box flexDirection="row" alignItems="center">
        <Box borderStyle="round" borderColor="gray" paddingX={1} width={32}>
          <Text>{s.caption}</Text>
        </Box>
        <Raster key="scene" columns={width} rows={ROWS} cells={paint(width, s.label, tick, pos, mode)} />
      </Box>
    )
  })
}
