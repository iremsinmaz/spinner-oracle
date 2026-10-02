import { describe, expect, test } from 'claude-code/testing'

import { BudgetError, LangError, load } from './lang'

const out = (src: string): unknown => load(src, {}).get('out')

describe('the interpreter', () => {
  test('each for (let …) iteration gets its own binding', () => {
    expect(out('const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); const out = fs.map(f => f()).join(",")')).toBe('0,1,2')
    // var shares one binding, as in JS
    expect(out('const fs = []; for (var i = 0; i < 3; i++) fs.push(() => i); const out = fs.map(f => f()).join(",")')).toBe('3,3,3')
    expect(out('const fs = []; for (const x of [5, 6]) fs.push(() => x); const out = fs.map(f => f()).join(",")')).toBe('5,6')
  })

  test('closures keep their own state', () => {
    expect(out('function counter() { let n = 0; return () => ++n } const a = counter(), b = counter(); a(); a(); const out = [a(), b()].join(",")')).toBe('3,1')
    expect(out('const o = { n: 2, dbl() { return this.n * 2 } }; const out = o.dbl()')).toBe(4)
  })

  test('switch: matching, fallthrough, default and break', () => {
    const src = (v: string) => `let out = ''; switch (${v}) { case 1: out += 'a'; case 2: out += 'b'; break; case 'x': out += 'x'; break; default: out += 'd' }`
    expect(out(src('1'))).toBe('ab')
    expect(out(src('2'))).toBe('b')
    expect(out(src("'x'"))).toBe('x')
    expect(out(src('9'))).toBe('d')
    expect(out("let out = 0; for (let i = 0; i < 5; i++) { switch (i) { case 2: continue; default: out += i } }")).toBe(8)
  })

  test('every loop form, with break and continue', () => {
    expect(out('let out = 0; for (let i = 0; i < 10; i++) { if (i % 2) continue; if (i > 6) break; out += i }')).toBe(12)
    expect(out('let out = []; for (const k in { a: 1, b: 2 }) out.push(k); out = out.join("")')).toBe('ab')
    expect(out('let out = 0; let i = 0; while (true) { i++; if (i > 4) break; out += i }')).toBe(10)
    expect(out('let out = 0; do { out++ } while (out < 3)')).toBe(3)
    expect(out('let out = 0; do { out++ } while (false)')).toBe(1)
    expect(out('let out = ""; for (const ch of "hey") out = ch + out')).toBe('yeh')
  })

  test('templates, destructuring, spread and math', () => {
    expect(out('const [a, , b = 5, ...r] = [1, 2, undefined, 4, 6]; const { x, y: z = 9 } = { x: 3 }; const out = `${a}|${b}|${r}|${x}|${z}`')).toBe('1|5|4,6|3|9')
    expect(out('const out = 2 ** 3 ** 2 + Math.max(...[1, 7, 3]) - 10 % 4')).toBe(517)
    expect(out('const m = new Map(); m.set("k", 2); const out = (m.get("k") ?? 0) + (({ a: { b: 1 } })?.a?.c?.d ?? 3)')).toBe(5)
    expect(out('const o = null; const out = o?.x?.y ?? "none"')).toBe('none')
  })

  test('a runaway program runs out of budget instead of hanging', () => {
    expect(() => load('while (true) {}', {})).toThrow(BudgetError)
    expect(() => load('function f() { return f() } f()', {})).toThrow(LangError)
    expect(() => load('let s = "ab"; while (true) s += s', {})).toThrow(LangError)
  })

  test('the sandbox has no way out', () => {
    expect(out('const out = typeof globalThis + typeof process + typeof eval')).toBe('undefinedundefinedundefined')
    expect(out('const o = {}; const out = o.__proto__ === undefined && o.constructor === undefined')).toBe(true)
    expect(() => load('const o = {}; o.__proto__ = { x: 1 }', {})).toThrow(LangError)
    expect(() => load('[].constructor.constructor("return 1")()', {})).toThrow(LangError)
    expect(() => load('Math.floor = null', {})).toThrow(LangError)
  })

  test('syntax errors are LangErrors with a position', () => {
    expect(() => load('let = ;', {})).toThrow(/at \d+/)
    expect(() => load('const x = /re/', {})).toThrow(LangError)
  })
})
