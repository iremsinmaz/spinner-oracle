// Colors for scene programs: hex parsing with a loud fallback, blending, and small helpers.

export const ROWS = 6
export const FALLBACK = 0xff00ff // what a bad color draws: loud on purpose


export type Rgba = { rgb: number; a: number }

/** #rgb, #rgba, #rrggbb, #rrggbbaa (the # optional); anything else is null. */
export function parseHex(s: string): Rgba | null {
  const m = /^#?([0-9a-fA-F]+)$/.exec(s.trim())
  if (!m) return null
  const h = m[1]!
  const d = (i: number) => parseInt(h[i]! + h[i]!, 16)
  switch (h.length) {
    case 3: return { rgb: (d(0) << 16) | (d(1) << 8) | d(2), a: 255 }
    case 4: return { rgb: (d(0) << 16) | (d(1) << 8) | d(2), a: d(3) }
    case 6: return { rgb: parseInt(h, 16), a: 255 }
    case 8: return { rgb: parseInt(h.slice(0, 6), 16), a: parseInt(h.slice(6), 16) }
  }
  return null
}

const cache = new Map<string, Rgba>()
let badColors = 0

/** A program's color: a hex string, or a 0xRRGGBB number; null/undefined/'' draws nothing; anything else draws FALLBACK. */
export function color(v: unknown): Rgba | null {
  if (v === null || v === undefined || v === '' || v === false) return null
  if (typeof v === 'number') return Number.isFinite(v) ? { rgb: v & 0xffffff, a: 255 } : { rgb: FALLBACK, a: 255 }
  if (typeof v !== 'string') { badColors++; return { rgb: FALLBACK, a: 255 } }
  let c = cache.get(v)
  if (!c) {
    const parsed = parseHex(v)
    if (!parsed) badColors++
    c = parsed ?? { rgb: FALLBACK, a: 255 }
    if (cache.size > 2048) cache.clear()
    cache.set(v, c)
  }
  return c
}

export function badColorCount(): number { return badColors }

export const hex = (rgb: number) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0')

export function blend(under: number, over: number, a: number): number {
  const k = a / 255
  const ch = (s: number) => Math.round(((under >> s) & 255) * (1 - k) + ((over >> s) & 255) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export function hsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(1, s))
  l = Math.max(0, Math.min(1, l))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return hex((Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255))
}

export function mix(a: unknown, b: unknown, k: number): string {
  const ca = color(a)?.rgb ?? 0
  const cb = color(b)?.rgb ?? 0
  return hex(blend(ca, cb, Math.max(0, Math.min(1, Number(k) || 0)) * 255))
}

export function hash01(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}
