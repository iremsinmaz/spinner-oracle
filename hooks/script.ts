// The scene runtime: a pixel canvas two pixels per terminal cell (half blocks), the drawing API a
// scene program calls, the crab mascot, the typed speech bubble, and the loop that runs one frame.
import { BudgetError, Interpreter, load, str } from './lang'
import type { Host } from './lang'
import * as fx from './effects'
import { blend, color, hash01, hex, hsl, mix, ROWS } from './colors'
import type { Rgba } from './colors'

export { color, parseHex, FALLBACK, ROWS, hex, hsl, mix, hash01, badColorCount } from './colors'
export type { Rgba } from './colors'

export const FRAME_BUDGET = 60_000
export const SETUP_BUDGET = 300_000
const DEF = 0x01000000 // the terminal's own color
const BUBBLE_BG = 0xf3ead3
const BUBBLE_FG = 0x2b2b30

// ------------------------------------------------------------------ canvas

export class Canvas {
  w = 0
  h = ROWS * 2
  px = new Int32Array(0) // -1: nothing drawn
  ch = new Uint32Array(0) // 0: no text in this cell
  fg = new Int32Array(0)
  bg = new Int32Array(0) // -1: the pixels under it
  mark: Set<number> | null = null // while set, collects the pixels set() paints
  front = new Set<number>() // Claude's pixels: a cell holding one shows it, whatever the other pixel is
  private words = new Uint32Array(0)

  resize(w: number): void {
    if (w === this.w) return
    this.w = w
    this.px = new Int32Array(w * this.h)
    this.ch = new Uint32Array(w * ROWS)
    this.fg = new Int32Array(w * ROWS)
    this.bg = new Int32Array(w * ROWS)
    this.words = new Uint32Array(w * ROWS * 3)
  }

  clear(): void {
    this.px.fill(-1)
    this.ch.fill(0)
    this.front = new Set()
  }

  set(x: number, y: number, c: Rgba | null): void {
    if (!c || c.a === 0) return
    x = Math.floor(x)
    y = Math.floor(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = y * this.w + x
    this.mark?.add(i)
    if (c.a === 255) this.px[i] = c.rgb
    else {
      const under = this.px[i]!
      if (under >= 0) this.px[i] = blend(under, c.rgb, c.a)
      else if (c.a >= 128) this.px[i] = c.rgb
    }
  }

  rect(x: number, y: number, w: number, h: number, c: Rgba | null): void {
    if (!c) return
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w, Math.floor(x + w))
    const y1 = Math.min(this.h, Math.floor(y + h))
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c)
  }

  text(x: number, row: number, s: string, fgc: Rgba | null, bgc: Rgba | null = null): void {
    row = Math.floor(row)
    if (row < 0 || row >= ROWS) return
    x = Math.floor(x)
    let k = 0
    for (const glyph of s) {
      const cx = x + k++
      if (cx >= this.w) break
      if (cx < 0) continue
      let cp = glyph.codePointAt(0)!
      if (cp < 0x20 || cp > 0xffff) cp = 0x3f // the raster takes printable BMP characters only
      if (cp >= 0x1100 && isWide(cp)) cp = 0x3f
      const i = row * this.w + cx
      this.ch[i] = cp
      this.fg[i] = fgc ? fgc.rgb : 0xffffff
      this.bg[i] = bgc ? bgc.rgb : -1
    }
  }

  /**
   * The Raster's cells: little-endian [codePoint, fg, bg] per cell, base64. Every cell is one color, a space on
   * a background: block glyphs (▀ ▄ █) leave seams and slivers in Apple Terminal, a background fills the cell.
   * So a cell shows one of its two pixels: Claude's when it holds one, else the one whose color is rarer in its
   * own pixel row, which keeps the detail (a star, a sign's edge) over the sky or ground around it.
   */
  encode(): string {
    const { w, h, px, ch, fg, bg, words, front } = this
    const counts = Array.from({ length: h }, (_, y) => {
      const m = new Map<number, number>()
      for (let x = 0; x < w; x++) { const v = px[y * w + x]!; m.set(v, (m.get(v) ?? 0) + 1) }
      return m
    })
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c
        const top = px[2 * r * w + c]!
        const bot = px[(2 * r + 1) * w + c]!
        const one =
          top < 0 ? bot :
          bot < 0 || top === bot || front.has(2 * r * w + c) ? top :
          front.has((2 * r + 1) * w + c) || counts[2 * r + 1]!.get(bot)! < counts[2 * r]!.get(top)! ? bot : top
        let cp = 0x20
        let f = DEF
        let b = one >= 0 ? one : DEF
        if (ch[i]) {
          cp = ch[i]!
          f = fg[i]!
          if (bg[i]! >= 0) b = bg[i]!
        }
        const o = i * 3
        words[o] = cp
        words[o + 1] = f
        words[o + 2] = b
      }
    }
    return new Uint8Array(words.buffer, 0, w * ROWS * 12).toBase64()
  }
}

function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
}

// ------------------------------------------------------------------ the crab

export const CRAB_POSES = ['idle', 'walk', 'run', 'hop', 'think', 'work', 'wave', 'happy', 'sad', 'surprised', 'sleep', 'look'] as const
export type Pose = (typeof CRAB_POSES)[number]
export const CRAB_W = 12
export const CRAB_H = 5
const CRAB = { rgb: 0xd97757, a: 255 }
const EYE = { rgb: 0x1d1d22, a: 255 }

/** Draws the mascot with its top-left at (x, y); 12 px wide, 5 px tall (4 body + legs). `face` 1 looks right, -1 left. */
export function drawCrab(cv: Canvas, x: number, y: number, pose: string, face: number, ms: number): void {
  x = Math.floor(x)
  y = Math.floor(y)
  const f6 = Math.floor(ms / 166) // ~6 steps a second
  const f12 = Math.floor(ms / 83)
  const blink = ms % 3200 < 140
  const p: Pose = (CRAB_POSES as readonly string[]).includes(pose) ? (pose as Pose) : 'idle'
  const bob = p === 'run' ? f12 % 2 : 0
  const top = y - bob

  cv.rect(x + 2, top, 8, 4, CRAB)

  // legs
  const legs =
    p === 'hop' ? [3, 8] :
    p === 'walk' ? (f6 % 2 ? [3, 5, 6, 8] : [2, 4, 7, 9]) :
    p === 'run' ? (f12 % 2 ? [3, 5, 6, 8] : [2, 4, 7, 9]) :
    p === 'sleep' ? [] : [2, 4, 7, 9]
  for (const lx of legs) cv.set(x + lx, y + 4, CRAB)

  // arms: [left y, right y] relative to top
  let arms: [number, number] = [1, 1]
  if (p === 'think') arms = [1, -1]
  else if (p === 'work') arms = f12 % 2 ? [-1, 1] : [1, -1]
  else if (p === 'wave') arms = [1, f6 % 2 ? -1 : 0]
  else if (p === 'happy' || p === 'surprised') arms = [-1, -1]
  else if (p === 'sad') arms = [3, 3]
  else if (p === 'sleep') arms = [2, 2]
  cv.set(x, top + arms[0], CRAB)
  cv.set(x + 1, top + arms[0], CRAB)
  cv.set(x + 10, top + arms[1], CRAB)
  cv.set(x + 11, top + arms[1], CRAB)
  if (p === 'work') cv.set(x + (f12 % 2 ? 0 : 11), top - 2, { rgb: 0xf2c46d, a: 255 })

  // eyes
  const look = p === 'look' ? [0, 1, 0, -1][Math.floor(ms / 600) % 4]! : face < 0 ? -1 : p === 'run' || p === 'walk' ? 1 : 0
  for (const ex of [4, 7]) {
    const ix = x + ex + look
    if (p === 'sleep' || blink) cv.set(ix, top + 2, EYE)
    else if (p === 'happy') { cv.set(ix - 1, top + 2, EYE); cv.set(ix, top + 1, EYE); cv.set(ix + 1, top + 2, EYE) }
    else if (p === 'surprised') { cv.set(ix, top, EYE); cv.set(ix, top + 1, EYE); cv.set(ix, top + 2, EYE) }
    else if (p === 'think') { cv.set(ix, top, EYE); cv.set(ix, top + 1, EYE) }
    else if (p === 'sad') { cv.set(ix, top + 2, EYE); cv.set(ix, top + 3, EYE) }
    else { cv.set(ix, top + 1, EYE); cv.set(ix, top + 2, EYE) }
  }
  if (p === 'sleep') {
    const zr = Math.floor((top - 2) / 2)
    if (zr >= 0) cv.text(x + 10 + (f6 % 2), zr, 'z', { rgb: 0xc8c8d8, a: 255 })
  }
}

// ------------------------------------------------------------------ speech

/** Types a line out a few characters a frame. A line that changes after it finished typing shows whole at once. */
export class Typewriter {
  target = ''
  shown = 0

  /** A new narration line: types out from the start (unless it is the line already up). */
  type(text: string): void {
    if (text === this.target) return
    this.target = text
    this.shown = 0
  }

  /** A live update (a counter ticking): whole at once if the old line had finished, else typing carries on. */
  live(text: string): void {
    if (text === this.target) return
    const done = this.shown >= this.target.length
    this.target = text
    this.shown = done ? text.length : Math.min(this.shown, text.length)
  }

  step(chars = 1): void { this.shown = Math.min(this.target.length, this.shown + chars) }
  get text(): string { return this.target.slice(0, this.shown) }
  get done(): boolean { return this.shown >= this.target.length }
}

/** Splits `s` into at most `lines` lines of at most `width` cells, word-wrapped, the last ending in … if cut. */
export function wrap(s: string, width: number, lines = 2): string[] {
  const out: string[] = []
  let line = ''
  const words = s.replace(/\s+/g, ' ').trim().split(' ')
  for (let k = 0; k < words.length; k++) {
    let w = words[k]!
    while (w.length > width) { // a word longer than a line breaks hard
      if (line) { out.push(line); line = '' }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ' ' + w
    else { out.push(line); line = w }
  }
  if (line) out.push(line)
  if (out.length > lines) {
    const kept = out.slice(0, lines)
    const last = kept[lines - 1]!
    kept[lines - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + '…'
    return kept
  }
  return out
}

function drawBubble(cv: Canvas, full: string, shown: number, crabX: number | null): void {
  if (!full) return
  const maxW = Math.max(12, Math.min(44, cv.w - 6))
  const lines = wrap(full, maxW - 2)
  const bw = Math.max(...lines.map(l => l.length)) + 2
  let bx: number
  if (crabX === null) bx = 1
  else if (crabX + CRAB_W + 1 + bw <= cv.w) bx = crabX + CRAB_W + 1
  else bx = Math.max(0, crabX - bw - 1)
  bx = Math.max(0, Math.min(bx, cv.w - bw))
  const bubble = { rgb: BUBBLE_BG, a: 255 }
  const ink = { rgb: BUBBLE_FG, a: 255 }
  let left = shown
  lines.forEach((l, r) => {
    const visible = l.slice(0, Math.max(0, left))
    left -= l.length + 1
    cv.text(bx, r, ' '.repeat(bw), ink, bubble)
    cv.text(bx + 1, r, visible, ink, bubble)
  })
  if (crabX !== null) {
    const tailX = bx > crabX ? bx : bx + bw - 1
    cv.text(tailX, lines.length, bx > crabX ? '◣' : '◢', bubble)
  }
}

// ------------------------------------------------------------------ the stage

type Scene = { interp: Interpreter; update: unknown; start: number; src: string }

/**
 * Runs scene programs. The current scene draws each frame; a scene that throws (or runs out of
 * budget) is dropped and the one before it comes back, else the built-in default.
 */
export class Stage {
  canvas = new Canvas()
  typer = new Typewriter()
  current: Scene | null = null
  previous: Scene | null = null
  lastError: string | null = null
  crashes = 0
  private crabX: number | null = null
  private crabs: [number, number, string, number][] = [] // drawn after the scene, so nothing covers Claude
  private ms = 0
  private now = 0

  constructor(private fallbackSrc: string) {
    this.canvas.resize(80)
  }

  /** Compiles and starts a scene. A program that does not parse or set up keeps the scene that is up. */
  load(src: string, nowMs: number): boolean {
    try {
      const scene = this.compile(src, nowMs)
      this.previous = this.current
      this.current = scene
      return true
    } catch (e) {
      this.lastError = `load: ${(e as Error).message}`
      return false
    }
  }

  private compile(src: string, nowMs: number): Scene {
    const interp = load(src, this.api(), SETUP_BUDGET)
    const update = interp.get('update')
    if (update === undefined) throw new Error('the program defines no update(t)')
    return { interp, update, start: nowMs, src }
  }

  /** Draws one frame at `nowMs` and returns the Raster cells. Never throws. */
  frame(width: number, nowMs: number): string {
    this.canvas.resize(width)
    this.now = nowMs
    this.ms = nowMs
    for (let attempt = 0; attempt < 3; attempt++) {
      this.canvas.clear()
      this.crabX = null
      this.crabs = []
      if (!this.current) {
        try { this.current = this.compile(this.fallbackSrc, nowMs) } catch (e) { this.lastError = `fallback: ${(e as Error).message}`; break }
      }
      const scene = this.current
      try {
        scene.interp.global.declare('W', this.canvas.w, true)
        scene.interp.call(scene.update, [(nowMs - scene.start) / 1000], FRAME_BUDGET)
        break
      } catch (e) {
        this.crashes++
        this.lastError = `${e instanceof BudgetError ? 'budget' : 'crash'}: ${(e as Error).message}`
        this.current = this.previous
        this.previous = null
      }
    }
    // Claude goes in front of the scene's pixels and its text too: a sign's label in a cell Claude paints is wiped
    const cv = this.canvas
    cv.mark = cv.front
    for (const [x, y, pose, face] of this.crabs) drawCrab(cv, x, y, pose, face, this.ms)
    cv.mark = null
    for (const p of cv.front) cv.ch[(Math.floor(p / cv.w) >> 1) * cv.w + (p % cv.w)] = 0
    drawBubble(this.canvas, this.typer.target, this.typer.shown, this.crabX)
    this.typer.step()
    return this.canvas.encode()
  }

  /** The globals a scene program sees, beside the language's own standard library. */
  private api(): Host {
    const cv = this.canvas
    const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
    return {
      ROWS,
      H: ROWS * 2,
      GROUND: ROWS * 2 - CRAB_H, // the crab's y standing on the bottom row
      W: cv.w, // refreshed every frame
      width: () => cv.w,
      clear: (c?: unknown) => cv.rect(0, 0, cv.w, cv.h, color(c ?? '#14161c')),
      pixel: (x: unknown, y: unknown, c: unknown) => cv.set(num(x), num(y), color(c)),
      rect: (x: unknown, y: unknown, w: unknown, h: unknown, c: unknown) => cv.rect(num(x), num(y), num(w), num(h), color(c)),
      line: (x0: unknown, y0: unknown, x1: unknown, y1: unknown, c: unknown) => line(cv, num(x0), num(y0), num(x1), num(y1), color(c)),
      circle: (cx: unknown, cy: unknown, r: unknown, c: unknown) => fx.disc(cv, num(cx), num(cy), num(r), color(c)),
      text: (x: unknown, row: unknown, s: unknown, c?: unknown, bg?: unknown) => cv.text(num(x), num(row), str(s ?? ''), color(c ?? '#ffffff'), color(bg)),
      box: (x: unknown, y: unknown, w: unknown, h: unknown, label: unknown, c: unknown, ink?: unknown) =>
        labeledBox(cv, num(x), num(y), num(w), num(h), str(label ?? ''), color(c ?? '#bf6043'), color(ink ?? '#f6efe2')),
      sprite: (x: unknown, y: unknown, rows: unknown, palette: unknown, flip?: unknown) => sprite(cv, num(x), num(y), rows, palette, !!flip),
      shade: (fn: unknown) => shade(cv, fn),
      crab: (x: unknown, y: unknown, pose?: unknown, face?: unknown) => {
        const cx = num(x)
        this.crabX = Math.floor(cx)
        if (this.crabs.length < 8) this.crabs.push([cx, num(y, ROWS * 2 - CRAB_H), str(pose ?? 'idle'), num(face, 1)])
      },
      say: (s: unknown) => this.typer.live(str(s ?? '')),
      rgb: (r: unknown, g: unknown, b: unknown) => hex((clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b)),
      hsl: (h: unknown, s: unknown, l: unknown) => hsl(num(h), num(s), num(l)),
      mix: (a: unknown, b: unknown, k: unknown) => mix(a, b, num(k)),
      hash: (n: unknown) => hash01(num(n)),
      now: () => this.now / 1000,
      ...fx.api(cv),
    }
  }
}

const clamp255 = (v: unknown) => Math.max(0, Math.min(255, Math.round(typeof v === 'number' ? v : 0)))

function line(cv: Canvas, x0: number, y0: number, x1: number, y1: number, c: Rgba | null): void {
  if (!c) return
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1)
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (let n = 0; n < 1024; n++) {
    cv.set(x0, y0, c)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
}

/** A filled box with its label in the cell row across its middle. It covers what is under it, labels included:
 *  text always shows over pixels, so an earlier sign's label in the cells this box touches is wiped first. */
function labeledBox(cv: Canvas, x: number, y: number, w: number, h: number, label: string, c: Rgba | null, ink: Rgba | null): void {
  cv.rect(x, y, w, h, c)
  if (!c) return
  const x0 = Math.max(0, Math.floor(x))
  const x1 = Math.min(cv.w, Math.floor(x + w))
  const r0 = Math.max(0, Math.floor(y / 2))
  const r1 = Math.min(ROWS - 1, Math.floor((y + h - 1) / 2))
  for (let r = r0; r <= r1; r++) cv.ch.fill(0, r * cv.w + x0, r * cv.w + Math.max(x0, x1))
  if (!label) return
  const row = Math.floor((y + h / 2 - 0.5) / 2)
  const room = Math.max(0, Math.floor(w) - 2)
  const s = label.length > room ? label.slice(0, Math.max(0, room - 1)) + '…' : label
  cv.text(Math.floor(x + (w - s.length) / 2), row, s, ink, c)
}

function sprite(cv: Canvas, x: number, y: number, rows: unknown, palette: unknown, flip: boolean): void {
  if (!Array.isArray(rows) || !palette || typeof palette !== 'object') return
  const pal = palette as Record<string, unknown>
  for (let r = 0; r < rows.length && r < 64; r++) {
    const row = String(rows[r])
    for (let k = 0; k < row.length && k < 256; k++) {
      const ch = row[k]!
      if (ch === ' ' || ch === '.') continue
      if (!Object.prototype.hasOwnProperty.call(pal, ch)) continue
      cv.set(x + (flip ? row.length - 1 - k : k), y + r, color(pal[ch]))
    }
  }
}

/** Calls fn(x, row) for every cell, full width; a color it returns fills both pixels of that cell. */
function shade(cv: Canvas, fn: unknown): void {
  if (typeof fn !== 'function') return
  const f = fn as (x: number, row: number) => unknown
  for (let row = 0; row < ROWS; row++) {
    for (let x = 0; x < cv.w; x++) {
      const c = color(f(x, row))
      if (c) { cv.set(x, row * 2, c); cv.set(x, row * 2 + 1, c) }
    }
  }
}

// the module environment has the ES2025 base64 methods; the es2023 lib does not declare them
declare global {
  interface Uint8Array {
    toBase64(): string
  }
  interface Uint8ArrayConstructor {
    fromBase64(s: string): Uint8Array
  }
}
