// Reusable backdrops and particles, drawn natively so a scene gets rich motion for a few steps of
// its budget. Every effect is a pure function of time t (seconds): nothing is kept between frames.
import { color, hash01, ROWS } from './colors'
import type { Rgba } from './colors'
import type { Canvas } from './script'

const C = (rgb: number): Rgba => ({ rgb, a: 255 })
const H = ROWS * 2

function lerp(a: number, b: number, k: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** A vertical gradient over pixel rows y0..y1, stepped per cell row: both pixels of a cell share a color, so
 *  the cell draws as a background with no half-block glyph (glyphs leave seams in Apple Terminal). */
export function gradient(cv: Canvas, top: number, bottom: number, y0 = 0, y1 = H): void {
  for (let y = y0; y < y1; y++) {
    const q = Math.max(y0, y - (y % 2)) // the cell's top pixel row
    cv.rect(0, y, cv.w, 1, C(lerp(top, bottom, (q - y0) / Math.max(1, y1 - y0 - 1))))
  }
}

export function disc(cv: Canvas, cx: number, cy: number, r: number, c: Rgba | null): void {
  if (!c) return
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.25) cv.set(x, y, c)
}

const wrapX = (x: number, w: number) => ((x % w) + w) % w

/** Twinkling stars drifting left; `speed` in px/s gives parallax when layered. */
export function stars(cv: Canvas, t: number, speed = 2, density = 0.04, c = 0xcfd3ff, rows = H - 3, seed = 1): void {
  const n = Math.floor(cv.w * rows * density)
  for (let i = 0; i < n; i++) {
    const tw = hash01(i * 7 + seed + Math.floor(t * 3 + hash01(i) * 9))
    if (tw < 0.15) continue
    const x = wrapX(hash01(i * 13 + seed) * cv.w - t * speed, cv.w)
    const y = Math.floor(hash01(i * 31 + seed) * rows)
    cv.set(x, y, C(tw > 0.85 ? 0xffffff : c))
  }
}

/** A row of mountains (or hills) scrolling at `speed`. */
export function ridge(cv: Canvas, t: number, speed: number, base: number, height: number, c: number, seed = 3): void {
  for (let x = 0; x < cv.w; x++) {
    const u = x + t * speed
    const h = height * (0.55 + 0.25 * Math.sin(u * 0.11 + seed) + 0.2 * Math.sin(u * 0.27 + seed * 2))
    cv.rect(x, base - h, 1, h, C(c))
  }
}

/** Pine trees scrolling at `speed`, standing on `base`. */
export function trees(cv: Canvas, t: number, speed: number, base: number, c: number, gap = 7, seed = 5): void {
  const off = t * speed
  const first = Math.floor(off / gap) - 1
  for (let k = first; k < first + cv.w / gap + 3; k++) {
    const x = Math.floor(k * gap - off + hash01(k + seed) * 3)
    const h = 4 + Math.floor(hash01(k * 3 + seed) * 4)
    for (let r = 0; r < h; r++) {
      const half = Math.floor(((r + 1) / h) * 2.5)
      cv.rect(x - half, base - h + r, half * 2 + 1, 1, C(c))
    }
  }
}

export function clouds(cv: Canvas, t: number, speed = 1.5, c = 0xe9ecf5, seed = 9): void {
  for (let k = 0; k < Math.max(2, cv.w / 30); k++) {
    const x = wrapX(hash01(k + seed) * cv.w * 1.4 - t * speed * (0.6 + hash01(k * 5) * 0.8), cv.w + 20) - 10
    const y = Math.floor(hash01(k * 7 + seed) * 3)
    cv.rect(x, y + 1, 9, 1, C(c))
    cv.rect(x + 2, y, 5, 1, C(c))
  }
}

/** Falling rain streaks. */
export function rain(cv: Canvas, t: number, c = 0x7f9cc9, density = 0.03): void {
  const n = Math.floor(cv.w * density * 10)
  for (let i = 0; i < n; i++) {
    const x = Math.floor(hash01(i * 3) * cv.w - t * 4)
    const y = Math.floor((hash01(i * 11) * H + t * (14 + hash01(i) * 6)) % H)
    cv.set(wrapX(x, cv.w), y, C(c))
  }
}

export function snow(cv: Canvas, t: number, c = 0xf2f4ff): void {
  const n = Math.floor(cv.w * 0.25)
  for (let i = 0; i < n; i++) {
    const x = wrapX(hash01(i * 3) * cv.w + Math.sin(t * 1.5 + i) * 1.5, cv.w)
    const y = Math.floor((hash01(i * 17) * H + t * (2 + hash01(i) * 2)) % H)
    cv.set(x, y, C(c))
  }
}

const BLOCK_COLORS = [0xe06c75, 0xe5c07b, 0x98c379, 0x56b6c2, 0x61afef, 0xc678dd]

/** Tetris-ish blocks raining down and stacking out of sight. */
export function blocks(cv: Canvas, t: number, size = 2): void {
  const cols = Math.floor(cv.w / (size + 2))
  for (let k = 0; k < cols; k++) {
    if (hash01(k * 5) < 0.55) continue
    const period = 1.5 + hash01(k) * 2
    const y = ((t + hash01(k * 9) * period) % period) / period * (H + size) - size
    cv.rect(k * (size + 2), Math.floor(y), size + 1, size, C(BLOCK_COLORS[k % BLOCK_COLORS.length]!))
  }
}

/** A rolling wave line at pixel row y with foam on the crests; everything under it is water. */
export function waves(cv: Canvas, t: number, y = 4, c = 0x2f6fa8, foam = 0xcfe8f7): void {
  for (let x = 0; x < cv.w; x++) {
    const h = Math.round(Math.sin(x * 0.35 + t * 3) * 0.8 + Math.sin(x * 0.13 - t * 1.7) * 0.7)
    const top = y + h
    cv.rect(x, top, 1, H - top, C(lerp(c, 0x0c2440, 0.0)))
    if (h <= -1) cv.set(x, top, C(foam))
  }
}

export function fish(cv: Canvas, t: number, n = 4): void {
  for (let i = 0; i < n; i++) {
    const dir = hash01(i * 3) < 0.5 ? 1 : -1
    const x = wrapX(hash01(i) * cv.w + dir * t * (3 + hash01(i * 7) * 4), cv.w + 6) - 3
    const y = 6 + Math.floor(hash01(i * 11) * 4) + Math.round(Math.sin(t * 2 + i))
    const body = C(BLOCK_COLORS[i % BLOCK_COLORS.length]!)
    cv.rect(x, y, 3, 1, body)
    cv.set(x + (dir > 0 ? -1 : 3), y, body)
    cv.set(x + (dir > 0 ? 2 : 0), y, C(0x111111))
  }
}

export function bubbles(cv: Canvas, t: number, c = 0xbfe3ff): void {
  for (let i = 0; i < Math.max(3, cv.w / 12); i++) {
    const x = Math.floor(hash01(i * 5) * cv.w + Math.sin(t * 2 + i) * 0.8)
    const y = Math.floor(H - ((t * (2 + hash01(i) * 2) + hash01(i * 9) * H) % H))
    cv.set(x, y, C(c))
  }
}

/** Cars driving along the road band at pixel row y (2 px tall). */
export function cars(cv: Canvas, t: number, y = 9, n = 3): void {
  for (let i = 0; i < n; i++) {
    const dir = i % 2 ? -1 : 1
    const x = wrapX(hash01(i * 13) * cv.w + dir * t * (8 + hash01(i) * 8), cv.w + 8) - 4
    const body = C(BLOCK_COLORS[(i * 2) % BLOCK_COLORS.length]!)
    cv.rect(x, y, 5, 1, body)
    cv.rect(x + 1, y - 1, 3, 1, body)
    cv.set(x + (dir > 0 ? 4 : 0), y, C(0xfff2a8))
  }
}

export function asteroids(cv: Canvas, t: number, n = 5): void {
  for (let i = 0; i < n; i++) {
    const x = wrapX(hash01(i * 3 + 1) * cv.w - t * (3 + hash01(i * 5) * 5), cv.w + 6) - 3
    const y = 1 + Math.floor(hash01(i * 7) * (H - 4))
    const r = hash01(i * 11) < 0.4 ? 1.4 : 0.8
    disc(cv, x, y, r, C(0x8b7d6b))
    cv.set(x - 1, y - 1, C(0xb3a48f))
  }
}

export function fireflies(cv: Canvas, t: number, c = 0xf6e27f): void {
  for (let i = 0; i < Math.max(3, cv.w / 14); i++) {
    if (Math.sin(t * 3 + i * 1.7) < 0) continue
    const x = Math.floor(hash01(i) * cv.w + Math.sin(t * 0.7 + i) * 3)
    const y = 2 + Math.floor(hash01(i * 9) * 7 + Math.cos(t * 0.9 + i) * 1.5)
    cv.set(x, y, C(c))
  }
}

export function sparks(cv: Canvas, t: number, x: number, y: number, c = 0xffc65c): void {
  for (let i = 0; i < 6; i++) {
    const k = (t * 3 + hash01(i)) % 1
    const a = hash01(i * 7) * Math.PI - Math.PI
    cv.set(x + Math.cos(a) * k * 5, y + Math.sin(a) * k * 4 + k * k * 4, C(c))
  }
}

// ------------------------------------------------------------------ whole backdrops

export const THEMES = ['space', 'forest', 'road', 'castle', 'ocean', 'workshop', 'meadow'] as const

export function backdrop(cv: Canvas, name: string, t: number): void {
  const w = cv.w
  switch (name) {
    case 'space':
      gradient(cv, 0x07081a, 0x1a1440)
      stars(cv, t, 0.6, 0.03, 0x6a6f9a, H, 1)
      stars(cv, t, 2, 0.02, 0xcfd3ff, H, 2)
      disc(cv, w * 0.78, 3, 2.6, C(0x6b5bd6))
      cv.rect(w * 0.78 - 4, 3, 9, 1, C(0xb3a8ff))
      asteroids(cv, t, Math.max(3, Math.floor(w / 20)))
      return
    case 'forest':
      gradient(cv, 0x1d2b4a, 0xe08a5b, 0, 9)
      ridge(cv, t, 0.8, 9, 4, 0x3b4a5e, 1)
      trees(cv, t, 2, 10, 0x1f4733, 9, 2)
      trees(cv, t, 4.5, 11, 0x12301f, 6, 7)
      cv.rect(0, 10, w, 2, C(0x2c4a1e))
      fireflies(cv, t)
      return
    case 'road':
      gradient(cv, 0x283a66, 0xf2a65a, 0, 8)
      for (let x = 0; x < w; x++) {
        const k = Math.floor((x + t * 1.5) / 4)
        const h = 2 + Math.floor(hash01(k) * 5)
        cv.rect(x, 8 - h, 1, h, C(0x1e2235))
        if (hash01(k * 3 + x) > 0.92) cv.set(x, 8 - h + 1, C(0xffe08a))
      }
      cv.rect(0, 8, w, 4, C(0x3a3d46))
      for (let x = 0; x < w; x++) if (wrapX(x + t * 12, 6) < 3) cv.set(x, 10, C(0xe8d36a))
      cars(cv, t, 9, Math.max(2, Math.floor(w / 30)))
      return
    case 'castle': {
      gradient(cv, 0x0d1030, 0x3a2d5c)
      stars(cv, t, 0.3, 0.02, 0xd8dcff, 5, 4)
      disc(cv, w * 0.15, 2, 1.6, C(0xf4f1d0))
      cv.rect(0, 5, w, 7, C(0x5d5a6b))
      for (let x = 0; x < w; x += 4) cv.rect(x, 4, 2, 1, C(0x5d5a6b))
      for (let x = 2; x < w; x += 8) cv.rect(x, 7 + (x % 3), 2, 1, C(0x4a4757))
      for (let x = 10; x < w; x += 22) {
        const flick = hash01(x + Math.floor(t * 8)) > 0.5
        cv.set(x, 6, C(flick ? 0xffb347 : 0xff7a2f))
        cv.set(x, 7, C(0x6b4a2a))
      }
      return
    }
    case 'ocean':
      gradient(cv, 0x8fd3ff, 0xd6f0ff, 0, 4)
      waves(cv, t, 4, 0x2f6fa8)
      gradient(cv, 0x2f6fa8, 0x0d2d55, 6, 11)
      cv.rect(0, 11, w, 1, C(0xd8c38a))
      fish(cv, t, Math.max(3, Math.floor(w / 18)))
      bubbles(cv, t)
      return
    case 'workshop': {
      gradient(cv, 0x3b2f2a, 0x2a211d)
      for (let x = 0; x < w; x += 16) {
        cv.rect(x + 1, 3, 12, 1, C(0x7a5534))
        cv.rect(x + 2, 1, 3, 2, C(BLOCK_COLORS[(x / 16) % BLOCK_COLORS.length]!))
        cv.rect(x + 7, 2, 2, 1, C(0x9aa5b1))
      }
      cv.rect(0, 11, w, 1, C(0x5a4030))
      const lamp = Math.floor(w * 0.55)
      cv.rect(lamp, 0, 1, 2, C(0x777777))
      cv.set(lamp, 2, C(hash01(Math.floor(t * 4)) > 0.1 ? 0xffe9a8 : 0x8a7a50))
      return
    }
    case 'meadow':
    default:
      gradient(cv, 0x6fb7f0, 0xcfeaff, 0, 9)
      clouds(cv, t)
      ridge(cv, t, 0.6, 10, 3, 0x7fb069, 4)
      cv.rect(0, 10, w, 2, C(0x4f8a3a))
      for (let x = 0; x < w; x += 5) if (hash01(x) > 0.6) cv.set(x, 9, C(hash01(x * 3) > 0.5 ? 0xffd166 : 0xef476f))
      return
  }
}

/** The effect functions a scene program sees. Colors come in as program colors (hex strings). */
export function api(cv: Canvas): Record<string, unknown> {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const rgb = (v: unknown, d: number) => (v === undefined ? d : color(v)?.rgb ?? d)
  return {
    THEMES: [...THEMES],
    backdrop: (name: unknown, t: unknown) => backdrop(cv, String(name), n(t, 0)),
    gradient: (top: unknown, bottom: unknown, y0?: unknown, y1?: unknown) => gradient(cv, rgb(top, 0), rgb(bottom, 0), n(y0, 0), n(y1, H)),
    stars: (t: unknown, speed?: unknown, density?: unknown, c?: unknown) => stars(cv, n(t, 0), n(speed, 2), Math.min(0.3, n(density, 0.04)), rgb(c, 0xcfd3ff)),
    ridge: (t: unknown, speed: unknown, base: unknown, height: unknown, c: unknown) => ridge(cv, n(t, 0), n(speed, 1), n(base, 10), n(height, 3), rgb(c, 0x3b4a5e)),
    trees: (t: unknown, speed: unknown, base: unknown, c: unknown, gap?: unknown) => trees(cv, n(t, 0), n(speed, 2), n(base, 11), rgb(c, 0x1f4733), Math.max(3, n(gap, 7))),
    clouds: (t: unknown, speed?: unknown, c?: unknown) => clouds(cv, n(t, 0), n(speed, 1.5), rgb(c, 0xe9ecf5)),
    rain: (t: unknown, c?: unknown) => rain(cv, n(t, 0), rgb(c, 0x7f9cc9)),
    snow: (t: unknown, c?: unknown) => snow(cv, n(t, 0), rgb(c, 0xf2f4ff)),
    blocks: (t: unknown, size?: unknown) => blocks(cv, n(t, 0), Math.max(1, Math.min(4, n(size, 2)))),
    waves: (t: unknown, y?: unknown, c?: unknown) => waves(cv, n(t, 0), n(y, 4), rgb(c, 0x2f6fa8)),
    fish: (t: unknown, count?: unknown) => fish(cv, n(t, 0), Math.min(20, n(count, 4))),
    bubbles: (t: unknown, c?: unknown) => bubbles(cv, n(t, 0), rgb(c, 0xbfe3ff)),
    cars: (t: unknown, y?: unknown, count?: unknown) => cars(cv, n(t, 0), n(y, 9), Math.min(12, n(count, 3))),
    asteroids: (t: unknown, count?: unknown) => asteroids(cv, n(t, 0), Math.min(20, n(count, 5))),
    fireflies: (t: unknown, c?: unknown) => fireflies(cv, n(t, 0), rgb(c, 0xf6e27f)),
    sparks: (t: unknown, x: unknown, y: unknown, c?: unknown) => sparks(cv, n(t, 0), n(x, 0), n(y, 0), rgb(c, 0xffc65c)),
  }
}
