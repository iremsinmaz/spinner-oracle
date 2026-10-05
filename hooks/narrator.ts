// The narrator: a running conversation with Haiku about what the main agent is doing. Each batch of
// events goes out with the task and the recent exchanges; the reply is { speech, scene }, scene being
// a program in the scene language (or null to keep the scene that is up). A new scene is asked for only
// when the turn starts or the agent moves to another file or tool; otherwise the reply is speech only. Pure: the caller hands in
// the model call and the sleep, so nothing here touches the engine and every path is testable.

export const MODEL = 'claude-haiku-4-5-20251001'
export const MAX_TOKENS = 16_000
export const TRIM_AT = 30
export const TRIM_TO = 15
export const BACKOFF_START_MS = 5_000
export const BACKOFF_CAP_MS = 120_000
const MAX_QUEUE = 12

export type Reply = { speech: string; scene: string | null }
export type Exchange = { events: string; speech: string; scene: string | null }
export type EventKind = 'task' | 'tool' | 'text' | 'turn' | 'result'
/** One thing the agent did; `topic` (a file, or a tool name) changing is what earns a new scene. */
export type Event = { kind: EventKind; text: string; topic?: string }
export type Ask = { model: string; system: string; prompt: string; maxTokens: number; effort: 'low'; timeoutMs: number }
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type Answer = ({ isAnswered: true; text: string } | { isAnswered: false; reason: string; status?: number | null }) & { usage?: Usage }
/** What the narrator has cost since the module loaded: model requests and their tokens. */
export type Spent = { requests: number; failed: Record<string, number>; input: number; output: number; cacheRead: number; cacheWrite: number }
export type Deps = {
  complete: (ask: Ask, signal: AbortSignal) => Promise<Answer>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/** 5s, 10s, 20s, … capped at 2 min, for the n-th failure in a row (n ≥ 1). */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_START_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS)
}

/** Once the history reaches 30 exchanges, keep the last 15. The task lives apart from it and is never cut. */
export function trimHistory(history: Exchange[]): Exchange[] {
  return history.length >= TRIM_AT ? history.slice(-TRIM_TO) : history
}

/** The model's reply as { speech, scene }, or null when it is not that JSON (a failed request). */
export function parseReply(text: string): Reply | null {
  const body = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let v: unknown
  try {
    v = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.speech !== 'string') return null
  if (o.scene !== undefined && o.scene !== null && typeof o.scene !== 'string') return null
  const scene = typeof o.scene === 'string' && o.scene.trim() ? o.scene : null
  return { speech: o.speech.trim().slice(0, 200), scene }
}

export class Narrator {
  task = ''
  history: Exchange[] = []
  queue: Event[] = []
  topic = '' // what the scene up now is about
  dropped = 0
  failures = 0
  width = 80
  spent: Spent = { requests: 0, failed: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  private busy = false
  private active = false
  private stop = new AbortController()

  /** Called with each good reply; `keepScene` when the batch asked for speech only. */
  constructor(private onReply: (reply: Reply, keepScene: boolean) => void) {}

  setTask(text: string): void {
    this.task = text.trim().slice(0, 4000)
    this.history = []
  }

  startTurn(): void {
    this.stop.abort()
    this.stop = new AbortController()
    this.active = true
    this.queue = []
    this.dropped = 0
    this.failures = 0
    this.topic = ''
  }

  endTurn(): void {
    this.active = false
    this.queue = []
    this.stop.abort()
  }

  push(kind: EventKind, text: string, topic?: string): void {
    if (!this.active) return
    this.queue.push({ kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 300), topic })
    if (this.queue.length > MAX_QUEUE) {
      this.dropped += this.queue.length - MAX_QUEUE
      this.queue = this.queue.slice(-MAX_QUEUE)
    }
  }

  /** Works the queue in the background, one request at a time. Never throws; returns when idle. */
  async pump(deps: Deps): Promise<void> {
    if (this.busy) return
    this.busy = true
    const signal = this.stop.signal
    try {
      while (this.active && !signal.aborted && this.queue.length > 0) {
        const batch = this.queue
        const dropped = this.dropped
        this.queue = []
        this.dropped = 0
        const wantScene = this.wantsScene(batch)
        const reply = await this.ask(deps, batch, dropped, wantScene, signal)
        if (signal.aborted) return
        if (!reply) {
          this.failures++
          this.queue = [...batch, ...this.queue].slice(-MAX_QUEUE)
          try { await deps.sleep(backoffMs(this.failures), signal) } catch { return }
          continue
        }
        this.failures = 0
        const scene = wantScene ? reply.scene : null
        if (wantScene) this.topic = [...batch].reverse().find(e => e.topic)?.topic ?? this.topic
        this.history = trimHistory([...this.history, { events: format(batch, dropped), speech: reply.speech, scene }])
        try {
          this.onReply({ speech: reply.speech, scene }, !wantScene)
        } catch {
          // a bad scene is the stage's problem; the loop carries on
        }
      }
    } catch {
      // never let the background loop die loudly
    } finally {
      this.busy = false
    }
  }

  /** A new scene at the turn's start, and when the agent moves to another file or tool. */
  wantsScene(batch: Event[]): boolean {
    return batch.some(e => e.kind === 'turn' || (e.topic !== undefined && e.topic !== this.topic))
  }

  private async ask(deps: Deps, batch: Event[], dropped: number, wantScene: boolean, signal: AbortSignal): Promise<Reply | null> {
    try {
      const r = await deps.complete(
        { model: MODEL, system: SYSTEM, prompt: this.prompt(batch, dropped, wantScene), maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: 240_000 },
        signal,
      )
      this.spent.requests++
      if (!r.isAnswered) {
        const why = r.status ? `${r.reason} ${r.status}` : r.reason
        this.spent.failed[why] = (this.spent.failed[why] ?? 0) + 1
      }
      if (r.usage) {
        this.spent.input += r.usage.input_tokens
        this.spent.output += r.usage.output_tokens
        this.spent.cacheRead += r.usage.cache_read_input_tokens
        this.spent.cacheWrite += r.usage.cache_creation_input_tokens
      }
      return r.isAnswered ? parseReply(r.text) : null
    } catch {
      return null
    }
  }

  /** The conversation so far, flattened into one prompt (the model helper takes a single message). */
  prompt(batch: Event[], dropped = 0, wantScene = true): string {
    const parts = [`THE USER'S TASK:\n${this.task || '(not stated)'}`]
    if (this.history.length) {
      parts.push('YOUR EARLIER REPLIES (oldest first):')
      this.history.forEach((h, k) => {
        const last = k === this.history.length - 1
        const scene = h.scene === null ? 'null (kept the scene)' : last ? `\n${h.scene.slice(0, 2500)}${h.scene.length > 2500 ? '\n…' : ''}` : `(a ${h.scene.length}-char program)`
        parts.push(`[events]\n${h.events}\n[you] speech: ${JSON.stringify(h.speech)} scene: ${scene}`)
      })
    }
    parts.push(`NEW EVENTS:\n${format(batch, dropped)}`)
    parts.push(
      wantScene
        ? `Write a new scene. The canvas is ${this.width} cells wide (W = ${this.width}). Reply with the JSON object only.`
        : 'Speech only: the scene stays. Reply with {"speech": "...", "scene": null} and nothing else.',
    )
    return parts.join('\n\n')
  }
}

function format(batch: Event[], dropped: number): string {
  const lines = batch.map(e => `- ${e.text}`)
  if (dropped) lines.unshift(`- (${dropped} earlier events skipped)`)
  return lines.join('\n')
}

/** The built-in scene: what shows before the model's first reply, and the example in the system prompt. */
export const EXAMPLE_SCENE = `// Theme: space. The crab flies a little ship through an asteroid field toward effects.ts,
// hunting the one rock with a bug in it.
const rocks = []
for (let i = 0; i < 7; i++) rocks.push({ x: i * 15 + 24, y: 1 + (i * 5) % 7, bug: i === 4 })

const SHIP = ['..AA..', '.ABBA.', 'AACCAA']
const PAL = { A: '#9aa5b1', B: '#d97757', C: '#ffd166' }

function wrapX(x) {
  const span = W + 12
  return ((x % span) + span) % span - 6
}

function update(t) {
  backdrop('space', t)
  // a faint nebula through the per-cell shader
  shade((x, row) => (Math.sin(x * 0.12 + t * 0.7 + row * 0.9) > 0.93 ? '#3b2a6a80' : null))

  let near = null
  for (const r of rocks) {
    const x = wrapX(r.x - t * 7)
    circle(x, r.y + 1, 1.3, r.bug ? '#e06c75' : '#8b7d6b')
    if (r.bug && x > 16 && x < 40) near = x
  }

  const bob = Math.round(Math.sin(t * 3))
  sprite(1, 6 + bob, SHIP, PAL)
  crab(8, GROUND, near === null ? 'look' : 'surprised', 1)
  box(W - 16, 3, 14, 9, 'effects.ts', '#4a6fa5')
  if (near !== null) {
    line(19, GROUND + 1, near, 2, '#ffd16699')
    say('Bug rock spotted, ' + Math.round(near - 19) + ' px out!')
  }
}
`

export const SYSTEM = `You are the narrator of a live pixel-art cartoon shown in a coding agent's terminal while it works.
The star is a small orange pixel crab mascot (the agent). Each time you hear what the agent is doing,
you reply with a line for the crab's speech bubble and, usually, a short program that draws the scene.

REPLY FORMAT: one JSON object and nothing else:
{"speech": "...", "scene": "<program source>" | null}
- speech: one or two short, playful lines (under 90 characters) narrating the current step in the
  first person, as the crab. Name what it is touching. Example: "Pinging the asteroid field. One rock has a bug in it."
- scene: a complete program (below), or null to keep the scene that is up. The last line of each
  request says which: "Write a new scene" or "Speech only" (then scene must be null).
- Pick a backdrop that fits the task metaphorically: forest (searching), road with cars (running
  commands, pipelines), castle wall (security, auth, rules), space with asteroids (debugging),
  ocean with fish (data, streams, logs), workshop (editing, building), meadow (reading, planning).
- Props are labeled boxes named after what the agent touches right now: file names (README.md,
  effects.ts) or concepts (speech handler, error backoff, thread). Keep labels short.
- Write real code (state, loops, functions, small simulations, counters with say()) whenever the
  idea is more than sprites sliding around. Make every scene different and alive.

THE CANVAS: W cells wide by 6 cells tall. Each cell is two pixels stacked, so drawing happens on a
W x 12 pixel grid: x from 0 to W-1 left to right, y from 0 (top) to 11 (bottom). The crab is 12 px
wide and 5 px tall; crab(x, GROUND) stands it on the bottom row. The speech bubble is drawn for you
in the top two cell rows beside the crab: keep the crab and the important props visible under it.
Text cells (text, box labels) are whole cells: row 0 to 5.

THE LANGUAGE: a sandboxed subset of JavaScript, run by an interpreter (not eval).
Supported: let, const, var; function declarations, function expressions and arrow functions;
closures; default and rest parameters; arrays and objects (literals, spread, destructuring);
if/else, switch/case (with fallthrough), for, for-of, for-in, while, do-while, break, continue,
return; try/catch/finally and throw; template strings; ternary; && || ?? and optional chaining
(?.); all arithmetic, comparison and bitwise operators; ++/--; compound assignment; typeof;
new Array(n), new Map(), new Set(). Each \`for (let ...)\` iteration has its own binding.
Built-ins: Math (all functions, Math.random included), Number, String, Boolean, parseInt,
parseFloat, isNaN, Array.from, Array.isArray, Object.keys/values/entries/assign, JSON,
the usual array methods (push, map, filter, reduce, forEach, find, some, every, slice, splice,
sort, join, includes, indexOf, fill, flat, ...) and string methods (slice, split, padStart,
repeat, toUpperCase, includes, replace with string patterns, ...).
NOT supported: classes, regular expressions, getters/setters, generators, async/await, labels,
import/export, any browser or Node API.
Every program has a step budget: setup ~300k steps, each frame ~60k steps. A frame that runs out
crashes the scene and the previous scene comes back, so keep update(t) light: loop over your own
objects, not over every pixel (use shade() for full-width color effects; it is per cell).

THE PROGRAM: top-level code runs once (set up state there). It must define function update(t),
called about 20 times a second with t = seconds since the scene started. Draw everything every
frame, back to front; the canvas is cleared before each frame. State you keep in top-level
variables persists between frames.

THE API (colors are hex strings: '#rgb', '#rgba', '#rrggbb' or '#rrggbbaa'; alpha blends):
  W, H (12), ROWS (6), GROUND (y for the crab standing on the bottom row)
  clear(color?)                      fill everything
  pixel(x, y, color)                 one pixel
  rect(x, y, w, h, color)            filled rectangle in pixels
  line(x0, y0, x1, y1, color)        a pixel line
  circle(cx, cy, r, color)           filled disc
  text(x, row, string, color?, bg?)  text in cell row 0..5 (one character per cell)
  box(x, y, w, h, label, color?, ink?)  a filled box with its label across its middle cell row
                                     (make h >= 4 so the label row is inside the box)
  sprite(x, y, rows, palette, flip?) rows: array of strings; palette: { char: color }; ' ' and '.' are clear
  shade((x, row) => color | null)    a full-width per-cell shader, called for every cell
  crab(x, y, pose?, face?)           the mascot; pose: idle walk run hop think work wave happy sad
                                     surprised sleep look; face 1 right, -1 left. Move it yourself:
                                     hop by lowering y, walk by changing x over time.
  say(text)                          change the speech bubble live (a counter, a reaction); a line
                                     that finished typing switches at once
  rgb(r, g, b), hsl(h, s, l), mix(a, b, k)   color helpers returning hex strings
  hash(n)                            a stable pseudo-random number in [0, 1) for integer n
  backdrop(name, t)                  a whole animated backdrop: ${['space', 'forest', 'road', 'castle', 'ocean', 'workshop', 'meadow'].join(', ')}
  Effects you can layer (t is the scene time; colors optional):
  gradient(top, bottom, y0?, y1?), stars(t, speed?, density?, color?), ridge(t, speed, base, height, color),
  trees(t, speed, base, color, gap?), clouds(t, speed?, color?), rain(t, color?), snow(t, color?),
  blocks(t, size?) (falling blocks), waves(t, y?, color?), fish(t, count?), bubbles(t, color?),
  cars(t, y?, count?), asteroids(t, count?), fireflies(t, color?), sparks(t, x, y, color?)

A COMPLETE EXAMPLE PROGRAM:
${EXAMPLE_SCENE}`

/** What shows before the first reply of a turn: the crab strolls a meadow, thinking it over. */
export const DEFAULT_SCENE = `function update(t) {
  backdrop('meadow', t)
  const span = Math.max(10, W - 40)
  const p = (t * 5) % (span * 2)
  const x = 4 + (p < span ? p : span * 2 - p)
  crab(x, GROUND, Math.floor(t) % 4 === 3 ? 'think' : 'walk', p < span ? 1 : -1)
}
`
