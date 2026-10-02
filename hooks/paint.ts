// Pixel-art farm: Claude (the orange mascot) plows the crops toward a barn labeled with the current file.
// Two pixels per terminal cell via half blocks; returns RasterProps.cells.
export const ROWS = 6
const PX_H = ROWS * 2
const DEF = 0x01000000
const CLAUDE = 0xd97757
const EYE = 0x1d1d22
const BARN = 0xbf6043
const CROPS = [0x8a8f4a, 0xb59a55, 0xc9803a]
const DIRT = 0x8a6a3a
const DIRT_DARK = 0x5e4a33
const STAR = 0x6b7080
const SPARK = 0xf2c46d

/** What Claude is doing, which picks the pose: run = Bash, read = Read/Grep/Glob, edit = Edit/Write, think = between tools. */
export type Mode = 'run' | 'read' | 'edit' | 'think'
export const SPEED: Record<Mode, number> = { run: 1, read: 0.34, edit: 0.25, think: 0.5 }

const W_SPRITE = 12
const BODY = ['  BBBBBBBB  ', '  BBBBBBBB  ', '  BBBBBBBB  ', '  BBBBBBBB  ']
const LEGS = ['  B B  B B  ', '   B B  B B ']
const hash = (n: number) => ((n * 2654435761) >>> 0) % 1000

export function paint(width: number, label: string, tick: number, pos: number, mode: Mode): string {
  const px: (number | null)[][] = Array.from({ length: PX_H }, () => Array(width).fill(null))
  const set = (x: number, y: number, c: number) => {
    if (x >= 0 && x < width && y >= 0 && y < PX_H) px[y]![x] = c
  }

  // the barn widens to fit its label: 10 to 20 cells inside, never crowding Claude off the field
  const fit = Math.max(10, Math.min(20, width - W_SPRITE - 12))
  const name = label.length > fit ? label.slice(0, fit - 1) + '…' : label
  const inner = Math.max(10, name.length)
  const barnW = inner + 4
  const barnX = width - barnW - 1
  const lane = Math.max(1, barnX - W_SPRITE)
  const x0 = Math.min(Math.floor(pos) % (lane + 6), lane) // a short pause at the barn before the next pass

  for (let i = 0; i < 6; i++) {
    const n = hash(i * 7 + 3)
    if ((tick >> 3) % 3 !== i % 3) set(n % width, n % 2, STAR)
  }
  for (let y = 1; y <= 7; y += 2) {
    for (let x = 4; x < barnX - 1; x += 2) {
      if (x > x0 + W_SPRITE - 1 && hash(x * 31 + y) < 750) set(x, y, CROPS[hash(x + y) % 3]!)
    }
  }
  const wall = 'RR' + ' '.repeat(inner) + 'RR'
  const roof = (inset: number) => ' '.repeat(inset) + 'R'.repeat(barnW - 2 * inset) + ' '.repeat(inset)
  const barnRows = [roof(4), roof(2), roof(1), roof(0), wall, wall, wall, roof(0)]
  barnRows.forEach((row, dy) => [...row].forEach((ch, dx) => ch === 'R' && set(barnX + dx, 2 + dy, BARN)))

  // Claude: body rows 5-8, legs row 9; run bobs, edit stays planted
  const step = mode === 'edit' ? 0 : Math.floor(pos * 2) % 2
  const bob = mode === 'run' ? step : 0
  const top = 5 - bob
  BODY.forEach((row, dy) => [...row].forEach((ch, dx) => ch === 'B' && set(x0 + dx, top + dy, CLAUDE)))
  ;[...LEGS[step]!].forEach((ch, dx) => ch === 'B' && set(x0 + dx, 9, CLAUDE))

  // arms: out at the sides; edit swings one up then the other, like hammering
  const hammer = (tick >> 1) % 2
  const armY = (side: number) => (mode === 'edit' && side === hammer ? top - 1 : top + 1)
  set(x0, armY(0), CLAUDE)
  set(x0 + 1, armY(0), CLAUDE)
  set(x0 + W_SPRITE - 2, armY(1), CLAUDE)
  set(x0 + W_SPRITE - 1, armY(1), CLAUDE)
  if (mode === 'edit') set(x0 + (hammer ? W_SPRITE - 1 : 0), top - 2, SPARK)

  // eyes: two tall dark bars; read glances side to side, everyone blinks now and then
  const glance = mode === 'read' ? [0, 1, 0, -1][(tick >> 2) % 4]! : mode === 'run' ? 1 : 0
  const blink = tick % 40 < 2
  for (const ex of [4, 7]) {
    if (!blink) set(x0 + ex + glance, top + 1, EYE)
    set(x0 + ex + glance, top + 2, EYE)
  }

  for (let x = 0; x < width; x++) {
    set(x, PX_H - 2, DIRT)
    set(x, PX_H - 1, DIRT_DARK)
  }

  // the label sits in the barn's hollow, cell row 3 (pixel rows 6-7)
  const text = new Map<number, number>()
  const start = barnX + 2 + Math.floor((inner - name.length) / 2)
  ;[...name].forEach((ch, i) => text.set(3 * width + start + i, ch.charCodeAt(0)))

  const words = new Uint32Array(width * ROWS * 3)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c
      const t = px[2 * r]![c]!
      const b = px[2 * r + 1]![c]!
      let ch = 0x20
      let fg = DEF
      let bg = DEF
      const tx = text.get(i)
      if (tx !== undefined) [ch, fg] = [tx, BARN]
      else if (t !== null && b !== null) [ch, fg, bg] = [0x2580, t, b]
      else if (t !== null) [ch, fg] = [0x2580, t]
      else if (b !== null) [ch, fg] = [0x2584, b]
      words.set([ch, fg, bg], i * 3)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
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
