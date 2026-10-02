import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_SCENE, EXAMPLE_SCENE, Narrator, backoffMs, parseReply, trimHistory } from './narrator'
import type { Answer, Exchange } from './narrator'
import { FALLBACK, Stage, Typewriter, color, parseHex, wrap } from './script'

describe('hex colors', () => {
  test('3, 4, 6 and 8 digits, with or without #', () => {
    expect(parseHex('#f80')).toEqual({ rgb: 0xff8800, a: 255 })
    expect(parseHex('#f808')).toEqual({ rgb: 0xff8800, a: 0x88 })
    expect(parseHex('#12ab9F')).toEqual({ rgb: 0x12ab9f, a: 255 })
    expect(parseHex('12ab9f80')).toEqual({ rgb: 0x12ab9f, a: 0x80 })
  })

  test('anything else is rejected, and draws the loud fallback', () => {
    for (const bad of ['#12', '#12345', '#1234567', 'red', '#ggg', '', '#', 'rgb(1,2,3)']) expect(parseHex(bad)).toBeNull()
    expect(color('#zzz')).toEqual({ rgb: FALLBACK, a: 255 })
    expect(color({})).toEqual({ rgb: FALLBACK, a: 255 })
    expect(color(null)).toBeNull()
  })
})

describe('the narrator', () => {
  const exchanges = (n: number): Exchange[] => Array.from({ length: n }, (_, k) => ({ events: `e${k}`, speech: `s${k}`, scene: null }))

  test('history: 29 stays, 30 is cut to the last 15', () => {
    expect(trimHistory(exchanges(29)).length).toBe(29)
    const cut = trimHistory(exchanges(30))
    expect(cut.length).toBe(15)
    expect(cut[0]!.events).toBe('e15')
    expect(cut[14]!.events).toBe('e29')
  })

  test('the task survives trimming, in every prompt', async () => {
    const n = new Narrator(() => {})
    n.setTask('Refactor the effects module')
    n.startTurn()
    let prompt = ''
    const deps = {
      complete: async (ask: { prompt: string }) => { prompt = ask.prompt; return { isAnswered: true, text: '{"speech":"ok","scene":null}' } as Answer },
      sleep: async () => {},
    }
    for (let k = 0; k < 40; k++) { n.push('tool', `Read file${k}.ts`); await n.pump(deps) }
    expect(n.history.length).toBeLessThan(30)
    expect(prompt).toContain('Refactor the effects module')
    expect(prompt).toContain('file39.ts')
    expect(prompt).not.toContain('file3.ts\n')
  })

  test('backoff: 5s, doubling, capped at 2 min', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([5000, 10000, 20000, 40000, 80000, 120000, 120000, 120000])
  })

  test('parseReply takes the JSON object, fenced or bare, and nothing else', () => {
    expect(parseReply('{"speech":"hi","scene":"function update(t) {}"}')).toEqual({ speech: 'hi', scene: 'function update(t) {}' })
    expect(parseReply('```json\n{"speech":"hi","scene":null}\n```')).toEqual({ speech: 'hi', scene: null })
    expect(parseReply('Sure! {"speech":"hi"}')).toEqual({ speech: 'hi', scene: null })
    for (const bad of ['', 'no json here', '{"speech": 3}', '{"speech":"a","scene":7}', '[1,2]', '{"speech":"a"', '{broken}'])
      expect(parseReply(bad)).toBeNull()
  })

  test('malformed replies and API errors count as failures with backoff; the loop survives and recovers', async () => {
    const replies: (Answer | Error)[] = [
      { isAnswered: true, text: 'I cannot draw today' },
      new Error('network down'),
      { isAnswered: false, reason: 'api-error' },
      { isAnswered: true, text: '{"speech":"Back on the road!","scene":"function update(t) { backdrop(\'road\', t) }"}' },
    ]
    const sleeps: number[] = []
    const got: string[] = []
    const n = new Narrator(r => got.push(r.speech))
    n.startTurn()
    n.push('tool', 'Bash $ npm test')
    await n.pump({
      complete: async () => { const r = replies.shift()!; if (r instanceof Error) throw r; return r },
      sleep: async ms => { sleeps.push(ms) },
    })
    expect(sleeps).toEqual([5000, 10000, 20000])
    expect(got).toEqual(['Back on the road!'])
    expect(n.failures).toBe(0)
    expect(n.history.length).toBe(1)
  })

  test('"still running" pings keep the scene', async () => {
    const calls: boolean[] = []
    const n = new Narrator((_, keep) => calls.push(keep))
    n.startTurn()
    const deps = { complete: async () => ({ isAnswered: true, text: '{"speech":"Still digging.","scene":"function update(t) {}"}' }) as Answer, sleep: async () => {} }
    n.push('still', 'Bash $ npm test (20s)')
    await n.pump(deps)
    n.push('tool', 'Read README.md')
    await n.pump(deps)
    expect(calls).toEqual([true, false])
  })

  test('the turn ending stops the loop mid-backoff', async () => {
    const n = new Narrator(() => {})
    n.startTurn()
    n.push('tool', 'Read a.ts')
    const pumping = n.pump({
      complete: async () => ({ isAnswered: true, text: 'junk' }) as Answer,
      sleep: (_ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    })
    n.endTurn()
    await pumping
    expect(n.queue.length).toBe(0)
  })
})

describe('the speech bubble', () => {
  test('a new line types out; a live change after it finished shows whole; repeats do nothing', () => {
    const w = new Typewriter()
    w.type('Hello there')
    w.step(3)
    expect(w.text).toBe('Hel')
    w.type('Hello there') // the same line again: no restart
    expect(w.text).toBe('Hel')
    w.step(100)
    expect(w.done).toBe(true)
    w.live('Counted 1 rock')
    expect(w.text).toBe('Counted 1 rock')
    w.live('Counted 2 rocks')
    expect(w.text).toBe('Counted 2 rocks')
    w.type('A brand new step')
    expect(w.text).toBe('')
  })

  test('a live change while typing keeps typing from where it was', () => {
    const w = new Typewriter()
    w.type('Counting 1')
    w.step(4)
    w.live('Counting 2')
    expect(w.text).toBe('Coun')
  })

  test('wrap: two lines at most, ending in … when cut', () => {
    expect(wrap('one two three', 20)).toEqual(['one two three'])
    expect(wrap('aaaa bbbb cccc dddd', 9)).toEqual(['aaaa bbbb', 'cccc dddd'])
    const cut = wrap('aaaa bbbb cccc dddd eeee', 9)
    expect(cut.length).toBe(2)
    expect(cut[1]!.endsWith('…')).toBe(true)
  })
})

describe('the stage', () => {
  const crashing = 'let n = 0; function update(t) { n++; if (n > 2) throw "boom"; backdrop("ocean", t) }'

  test('a crashing scene hands back the previous one', () => {
    const s = new Stage(DEFAULT_SCENE)
    expect(s.load(EXAMPLE_SCENE, 0)).toBe(true)
    const good = s.current
    expect(s.load(crashing, 0)).toBe(true)
    for (let k = 0; k < 5; k++) s.frame(80, k * 50)
    expect(s.current).toBe(good)
    expect(s.lastError).toContain('boom')
  })

  test('a runaway frame is a crash, not a freeze', () => {
    const s = new Stage(DEFAULT_SCENE)
    s.load(EXAMPLE_SCENE, 0)
    const good = s.current
    s.load('function update(t) { while (true) {} }', 0)
    s.frame(80, 0)
    expect(s.current).toBe(good)
    expect(s.lastError).toContain('budget')
  })

  test('a program that does not parse keeps the scene that is up', () => {
    const s = new Stage(DEFAULT_SCENE)
    s.load(EXAMPLE_SCENE, 0)
    const good = s.current
    expect(s.load('function update(t) { let = }', 0)).toBe(false)
    expect(s.load('const x = 1', 0)).toBe(false) // no update(t)
    expect(s.current).toBe(good)
  })

  test('the default and example scenes run, and a frame stays well under 10 ms', () => {
    for (const src of [DEFAULT_SCENE, EXAMPLE_SCENE]) {
      const s = new Stage(DEFAULT_SCENE)
      expect(s.load(src, 0)).toBe(true)
      s.typer.type('Pinging the asteroid field. One rock has a bug in it.')
      s.frame(120, 0)
      const start = Date.now()
      for (let k = 1; k <= 60; k++) s.frame(120, k * 50)
      const perFrame = (Date.now() - start) / 60
      expect(s.lastError).toBeNull()
      expect(perFrame).toBeLessThan(10)
    }
  })

  test('every backdrop draws without a crash at narrow and wide widths', () => {
    for (const name of ['space', 'forest', 'road', 'castle', 'ocean', 'workshop', 'meadow']) {
      const s = new Stage(DEFAULT_SCENE)
      expect(s.load(`function update(t) { backdrop('${name}', t); crab(10, GROUND, 'run'); box(W - 14, 4, 12, 8, 'README.md') }`, 0)).toBe(true)
      for (const w of [20, 80, 240]) s.frame(w, 1234)
      expect(s.lastError).toBeNull()
    }
  })

  test('the cells are a Raster: 3 words per cell, width x 6', () => {
    const s = new Stage(DEFAULT_SCENE)
    const cells = s.frame(40, 0)
    expect(Uint8Array.fromBase64(cells).length).toBe(40 * 6 * 12)
  })

  test('Claude stays in front of whatever the scene draws after it', () => {
    const s = new Stage(DEFAULT_SCENE)
    expect(s.load('function update(t) { crab(10, GROUND, "idle", 1); rect(0, 0, W, H, "#00ff00") }', 0)).toBe(true)
    s.frame(40, 0)
    // the body's middle, x 10+5 at pixel row GROUND+3: Claude's orange, not the green drawn over it
    expect(s.canvas.px[(12 - 5 + 3) * 40 + 15]).toBe(0xd97757)
  })

  test("a lane stripe sharing a cell with Claude's leg never wins it", () => {
    const s = new Stage(DEFAULT_SCENE)
    s.typer.type('') // no bubble in the way
    // Claude at y 6: legs on pixel row 10 (x 12, 14, 17, 19). Row 10 is orange all across, so the rarer-color
    // rule alone would pick the one yellow stripe pixel under the leg at x 12 on row 11.
    const scene = 'function update(t) { rect(0, 10, W, 1, "#d97757"); rect(0, 11, W, 1, "#333333"); pixel(12, 11, "#ffd166"); crab(10, 6, "idle", 1) }'
    expect(s.load(scene, 0)).toBe(true)
    const w = new Uint32Array(Uint8Array.fromBase64(s.frame(40, 0)).buffer)
    expect(w[(5 * 40 + 12) * 3 + 2]).toBe(0xd97757)
  })

  test("a sign's label is wiped where Claude stands, and kept beside Claude", () => {
    const s = new Stage(DEFAULT_SCENE)
    s.typer.type('') // no bubble in the way
    expect(s.load('function update(t) { crab(10, GROUND, "idle", 1); text(0, 4, "hook hook hook hook hook hook", "#ffffff") }', 0)).toBe(true)
    s.frame(40, 0)
    expect(s.canvas.ch[4 * 40 + 15]).toBe(0) // cell row 4 holds Claude's body: no letter there
    expect(s.canvas.ch[4 * 40 + 1]).toBe('o'.charCodeAt(0)) // left of Claude the label stays
  })

  test("a later sign covers an earlier sign's label; text outside its box stays", () => {
    const s = new Stage(DEFAULT_SCENE)
    s.typer.type('') // no bubble in the way
    // sign A spans x 0..19, sign B x 10..29 over it; both labels sit in cell row 2 (pixel rows 4..5)
    expect(s.load('function update(t) { box(0, 2, 20, 6, "aaaaaaaaaaaaaaaa", "#335588"); box(10, 2, 20, 6, "bbbb", "#558833") }', 0)).toBe(true)
    s.frame(40, 0)
    const row = Array.from({ length: 40 }, (_, c) => String.fromCharCode(s.canvas.ch[2 * 40 + c]! || 32)).join('')
    expect(row.slice(0, 10)).toBe('  aaaaaaaa') // A's label left of B is kept
    expect(row.slice(10, 30).trim()).toBe('bbbb') // inside B only B's label, no leftover a's
  })

  test('cells are plain backgrounds, no block glyphs; a cell keeps its rarer pixel', () => {
    const s = new Stage(DEFAULT_SCENE)
    const all = new Uint32Array(Uint8Array.fromBase64(s.frame(60, 1234)).buffer)
    for (let k = 0; k < all.length; k += 3) expect([0x2580, 0x2584, 0x2588]).not.toContain(all[k]!)

    const cv = s.canvas
    cv.resize(10)
    cv.clear()
    cv.rect(0, 0, 10, 1, color('#000044')) // sky on pixel row 0
    cv.rect(0, 1, 10, 1, color('#004400')) // ground on pixel row 1
    cv.set(3, 1, color('#ff0000')) // one leg in the ground row
    cv.set(7, 0, color('#ffffff')) // one star in the sky row: 9 sky and 9 ground pixels each
    const w = new Uint32Array(Uint8Array.fromBase64(cv.encode()).buffer)
    expect(w[3 * 3 + 2]).toBe(0xff0000) // the leg wins over the sky above it
    expect(w[7 * 3 + 2]).toBe(0xffffff) // the star wins over the ground below it
    expect(w[0 * 3 + 2]).toBe(0x000044) // elsewhere a tie: the top pixel
  })
})
