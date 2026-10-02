// A sandboxed interpreter for a small JS-like language. No eval, no host globals:
// a program sees only what the caller hands it, and every statement, loop turn and
// call spends from a step budget, so a runaway program throws instead of freezing the UI.

export class LangError extends Error {}
export class BudgetError extends LangError {}

// ---------------------------------------------------------------- tokens

type Tok =
  | { t: 'num'; v: number; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'tpl'; parts: (string | Tok[])[]; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'kw'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'eof'; p: number }

const KEYWORDS = new Set([
  'let', 'const', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'do',
  'break', 'continue', 'switch', 'case', 'default', 'true', 'false', 'null', 'undefined',
  'typeof', 'new', 'this', 'throw', 'try', 'catch', 'finally',
])
const OPS = [
  '>>>=', '===', '!==', '**=', '...', '>>>', '<<=', '>>=', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '++', '--', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '<', '>', '+', '-', '*', '/', '%', '=', '!', '?', ':', '&', '|', '^', '~',
]

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  const isId = (c: string) => /[A-Za-z0-9_$]/.test(c)
  while (i < n) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    const p = i
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|(\d[\d_]*)?\.?\d*([eE][+-]?\d+)?)/.exec(src.slice(i))!
      i += m[0].length
      out.push({ t: 'num', v: Number(m[0].replace(/_/g, '')), p })
      continue
    }
    if (c === '"' || c === "'") {
      let s = ''
      i++
      while (i < n && src[i] !== c) {
        if (src[i] === '\n') throw new LangError(`unterminated string at ${p}`)
        if (src[i] === '\\') { s += escape(src, i); i += escapeLen(src, i) } else s += src[i++]
      }
      if (i >= n) throw new LangError(`unterminated string at ${p}`)
      i++
      out.push({ t: 'str', v: s, p })
      continue
    }
    if (c === '`') {
      const parts: (string | Tok[])[] = []
      let s = ''
      i++
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { s += escape(src, i); i += escapeLen(src, i); continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          parts.push(s)
          s = ''
          const start = i + 2
          let depth = 1
          let j = start
          while (j < n && depth > 0) {
            const d = src[j]!
            if (d === '{') depth++
            else if (d === '}') depth--
            else if (d === '"' || d === "'" || d === '`') {
              j++
              while (j < n && src[j] !== d) j += src[j] === '\\' ? 2 : 1
            }
            j++
          }
          if (depth > 0) throw new LangError(`unterminated template at ${p}`)
          parts.push(tokenize(src.slice(start, j - 1)))
          i = j
          continue
        }
        s += src[i++]
      }
      if (i >= n) throw new LangError(`unterminated template at ${p}`)
      i++
      parts.push(s)
      out.push({ t: 'tpl', parts, p })
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && isId(src[j]!)) j++
      const w = src.slice(i, j)
      i = j
      out.push(KEYWORDS.has(w) ? { t: 'kw', v: w, p } : { t: 'id', v: w, p })
      continue
    }
    const op = OPS.find(o => src.startsWith(o, i))
    if (!op) throw new LangError(`unexpected character '${c}' at ${p}`)
    // `?.` followed by a digit is a ternary and a number (a ?.5 : b)
    if (op === '?.' && /[0-9]/.test(src[i + 2] ?? '')) { out.push({ t: 'op', v: '?', p }); i++; continue }
    out.push({ t: 'op', v: op, p })
    i += op.length
  }
  out.push({ t: 'eof', p: n })
  return out
}

function escapeLen(src: string, i: number): number {
  const c = src[i + 1]
  if (c === 'u') return src[i + 2] === '{' ? src.indexOf('}', i) - i + 1 : 6
  if (c === 'x') return 4
  return 2
}

function escape(src: string, i: number): string {
  const c = src[i + 1]
  switch (c) {
    case 'n': return '\n'
    case 't': return '\t'
    case 'r': return '\r'
    case '0': return '\0'
    case 'b': return '\b'
    case 'u': {
      const hex = src[i + 2] === '{' ? src.slice(i + 3, src.indexOf('}', i)) : src.slice(i + 2, i + 6)
      return String.fromCodePoint(parseInt(hex, 16) || 0xfffd)
    }
    case 'x': return String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16) || 0xfffd)
    default: return c ?? ''
  }
}

// ---------------------------------------------------------------- syntax tree

export type Node = { type: string; [k: string]: any }

const BINARY: Record<string, number> = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, in: 8,
  '<<': 9, '>>': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12,
}
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='])

class Parser {
  i = 0
  constructor(private toks: Tok[]) {}

  peek(k = 0): Tok { return this.toks[Math.min(this.i + k, this.toks.length - 1)]! }
  next(): Tok { return this.toks[this.i++]! }
  is(v: string, k = 0): boolean { const t = this.peek(k); return (t.t === 'op' || t.t === 'kw') && t.v === v }
  eat(v: string): boolean { if (this.is(v)) { this.i++; return true } return false }
  expect(v: string): void {
    if (!this.eat(v)) { const t = this.peek(); throw new LangError(`expected '${v}' at ${t.p}, got ${'v' in t ? `'${t.v}'` : t.t}`) }
  }
  ident(): string {
    const t = this.next()
    if (t.t !== 'id') throw new LangError(`expected a name at ${t.p}`)
    return t.v
  }
  semi(): void { this.eat(';') }

  program(): Node {
    const body: Node[] = []
    while (this.peek().t !== 'eof') body.push(this.statement())
    return { type: 'Program', body }
  }

  block(): Node {
    this.expect('{')
    const body: Node[] = []
    while (!this.is('}')) {
      if (this.peek().t === 'eof') throw new LangError('unclosed block')
      body.push(this.statement())
    }
    this.expect('}')
    return { type: 'Block', body }
  }

  statement(): Node {
    const t = this.peek()
    if (t.t === 'op' && t.v === '{') return this.block()
    if (t.t === 'op' && t.v === ';') { this.i++; return { type: 'Empty' } }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'let': case 'const': case 'var': { const d = this.varDecl(); this.semi(); return d }
        case 'function': {
          this.i++
          const name = this.ident()
          return { type: 'FunctionDecl', name, fn: this.functionRest(name) }
        }
        case 'return': {
          this.i++
          const arg = this.is(';') || this.is('}') || this.peek().t === 'eof' ? null : this.expression()
          this.semi()
          return { type: 'Return', arg }
        }
        case 'if': {
          this.i++
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          const then = this.statement()
          const otherwise = this.eat('else') ? this.statement() : null
          return { type: 'If', test, then, otherwise }
        }
        case 'for': return this.forStatement()
        case 'while': {
          this.i++
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          return { type: 'While', test, body: this.statement() }
        }
        case 'do': {
          this.i++
          const body = this.statement()
          this.expect('while')
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          this.semi()
          return { type: 'DoWhile', test, body }
        }
        case 'break': this.i++; this.semi(); return { type: 'Break' }
        case 'continue': this.i++; this.semi(); return { type: 'Continue' }
        case 'switch': return this.switchStatement()
        case 'throw': { this.i++; const arg = this.expression(); this.semi(); return { type: 'Throw', arg } }
        case 'try': {
          this.i++
          const block = this.block()
          let param: string | null = null
          let handler: Node | null = null
          let finalizer: Node | null = null
          if (this.eat('catch')) {
            if (this.eat('(')) { param = this.ident(); this.expect(')') }
            handler = this.block()
          }
          if (this.eat('finally')) finalizer = this.block()
          return { type: 'Try', block, param, handler, finalizer }
        }
      }
    }
    const expr = this.expression()
    this.semi()
    return { type: 'Expr', expr }
  }

  pattern(): Node {
    if (this.eat('[')) {
      const elements: (Node | null)[] = []
      while (!this.eat(']')) {
        if (this.is(',')) { this.i++; elements.push(null); continue }
        if (this.eat('...')) elements.push({ type: 'Rest', arg: this.pattern() })
        else elements.push(this.patternWithDefault())
        if (!this.is(']')) this.expect(',')
      }
      return { type: 'ArrayPattern', elements }
    }
    if (this.eat('{')) {
      const props: { key: string; value: Node }[] = []
      let rest: string | null = null
      while (!this.eat('}')) {
        if (this.eat('...')) rest = this.ident()
        else {
          const t = this.next()
          if (t.t !== 'id' && t.t !== 'str' && t.t !== 'kw') throw new LangError(`bad pattern key at ${t.p}`)
          const key = String(t.v)
          let value: Node = { type: 'Id', name: key }
          if (this.eat(':')) value = this.pattern()
          if (this.eat('=')) value = { type: 'Default', target: value, value: this.assignment() }
          props.push({ key, value })
        }
        if (!this.is('}')) this.expect(',')
      }
      return { type: 'ObjectPattern', props, rest }
    }
    return { type: 'Id', name: this.ident() }
  }

  patternWithDefault(): Node {
    const target = this.pattern()
    return this.eat('=') ? { type: 'Default', target, value: this.assignment() } : target
  }

  varDecl(): Node {
    const kind = (this.next() as { v: string }).v
    const decls: { id: Node; init: Node | null }[] = []
    do {
      const id = this.pattern()
      const init = this.eat('=') ? this.assignment() : null
      decls.push({ id, init })
    } while (this.eat(','))
    return { type: 'Var', kind, decls }
  }

  forStatement(): Node {
    this.i++
    this.expect('(')
    let init: Node | null = null
    if (this.is('let') || this.is('const') || this.is('var')) {
      const save = this.i
      const kind = (this.next() as { v: string }).v
      const id = this.pattern()
      if (this.is('of') || this.is('in')) {
        const of = this.next() as { v: string }
        const right = of.v === 'of' ? this.assignment() : this.expression()
        this.expect(')')
        return { type: of.v === 'of' ? 'ForOf' : 'ForIn', kind, id, right, body: this.statement() }
      }
      this.i = save
      init = this.varDecl()
    } else if (!this.is(';')) {
      const save = this.i
      const t = this.peek()
      if (t.t === 'id' && (this.is('of', 1) || this.is('in', 1))) {
        this.i++
        const of = this.next() as { v: string }
        const right = this.expression()
        this.expect(')')
        return { type: of.v === 'of' ? 'ForOf' : 'ForIn', kind: null, id: { type: 'Id', name: t.v }, right, body: this.statement() }
      }
      this.i = save
      init = { type: 'Expr', expr: this.expression() }
    }
    this.expect(';')
    const test = this.is(';') ? null : this.expression()
    this.expect(';')
    const update = this.is(')') ? null : this.expression()
    this.expect(')')
    return { type: 'For', init, test, update, body: this.statement() }
  }

  switchStatement(): Node {
    this.i++
    this.expect('(')
    const disc = this.expression()
    this.expect(')')
    this.expect('{')
    const cases: { test: Node | null; body: Node[] }[] = []
    while (!this.eat('}')) {
      let test: Node | null = null
      if (this.eat('default')) test = null
      else { this.expect('case'); test = this.expression() }
      this.expect(':')
      const body: Node[] = []
      while (!this.is('case') && !this.is('default') && !this.is('}')) body.push(this.statement())
      cases.push({ test, body })
    }
    return { type: 'Switch', disc, cases }
  }

  functionRest(name: string | null, arrow = false): Node {
    this.expect('(')
    const params = this.params(')')
    if (arrow) this.expect('=>')
    const body = this.block()
    return { type: 'Function', name, params, body, arrow }
  }

  params(close: string): Node[] {
    const params: Node[] = []
    while (!this.eat(close)) {
      if (this.eat('...')) params.push({ type: 'Rest', arg: this.pattern() })
      else params.push(this.patternWithDefault())
      if (!this.is(close)) this.expect(',')
    }
    return params
  }

  expression(): Node {
    const first = this.assignment()
    if (!this.is(',')) return first
    const list = [first]
    while (this.eat(',')) list.push(this.assignment())
    return { type: 'Seq', list }
  }

  isArrowAhead(): boolean {
    // at '(' : scan to the matching ')' and look for '=>'
    let depth = 0
    for (let k = this.i; k < this.toks.length; k++) {
      const t = this.toks[k]!
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++
      else if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) {
        depth--
        if (depth === 0) { const n = this.toks[k + 1]; return !!n && n.t === 'op' && n.v === '=>' }
      } else if (t.t === 'eof') return false
    }
    return false
  }

  arrowBody(params: Node[]): Node {
    if (this.is('{')) return { type: 'Function', name: null, params, body: this.block(), arrow: true }
    const expr = this.assignment()
    return { type: 'Function', name: null, params, body: { type: 'Block', body: [{ type: 'Return', arg: expr }] }, arrow: true }
  }

  assignment(): Node {
    const t = this.peek()
    if (t.t === 'id' && this.is('=>', 1)) {
      this.i += 2
      return this.arrowBody([{ type: 'Id', name: t.v }])
    }
    if (t.t === 'op' && t.v === '(' && this.isArrowAhead()) {
      this.i++
      const params = this.params(')')
      this.expect('=>')
      return this.arrowBody(params)
    }
    const left = this.conditional()
    const op = this.peek()
    if (op.t === 'op' && ASSIGN.has(op.v)) {
      if (left.type !== 'Id' && left.type !== 'Member' && !(op.v === '=' && (left.type === 'Array' || left.type === 'Object')))
        throw new LangError(`cannot assign to this at ${op.p}`)
      this.i++
      const target = left.type === 'Array' || left.type === 'Object' ? toPattern(left) : left
      return { type: 'Assign', op: op.v, target, value: this.assignment() }
    }
    return left
  }

  conditional(): Node {
    const test = this.binary(0)
    if (!this.eat('?')) return test
    const then = this.assignment()
    this.expect(':')
    return { type: 'Cond', test, then, otherwise: this.assignment() }
  }

  binary(min: number): Node {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      const op = t.t === 'op' || (t.t === 'kw' && t.v === 'in') ? t.v : null
      const prec = op === null ? undefined : BINARY[op]
      if (op === null || prec === undefined || prec < min) return left
      this.i++
      // ** is right-associative; everything else binds left
      const right = this.binary(op === '**' ? prec : prec + 1)
      left = { type: op === '&&' || op === '||' || op === '??' ? 'Logical' : 'Binary', op, left, right }
    }
  }

  unary(): Node {
    const t = this.peek()
    if (t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~')) {
      this.i++
      return { type: 'Unary', op: t.v, arg: this.unary() }
    }
    if (t.t === 'kw' && t.v === 'typeof') { this.i++; return { type: 'Unary', op: 'typeof', arg: this.unary() } }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.i++
      const arg = this.unary()
      if (arg.type !== 'Id' && arg.type !== 'Member') throw new LangError(`bad ${t.v} target at ${t.p}`)
      return { type: 'Update', op: t.v, prefix: true, arg }
    }
    return this.postfix()
  }

  postfix(): Node {
    const expr = this.call()
    const t = this.peek()
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      if (expr.type !== 'Id' && expr.type !== 'Member') throw new LangError(`bad ${t.v} target at ${t.p}`)
      this.i++
      return { type: 'Update', op: t.v, prefix: false, arg: expr }
    }
    return expr
  }

  args(): Node[] {
    const args: Node[] = []
    while (!this.eat(')')) {
      args.push(this.eat('...') ? { type: 'Spread', arg: this.assignment() } : this.assignment())
      if (!this.is(')')) this.expect(',')
    }
    return args
  }

  call(): Node {
    let expr: Node
    if (this.eat('new')) {
      const callee = this.primary()
      const args = this.eat('(') ? this.args() : []
      expr = { type: 'New', callee, args }
    } else expr = this.primary()
    for (;;) {
      if (this.eat('.')) {
        const t = this.next()
        if (t.t !== 'id' && t.t !== 'kw') throw new LangError(`expected a property name at ${t.p}`)
        expr = { type: 'Member', object: expr, prop: { type: 'Lit', value: t.v }, optional: false }
      } else if (this.eat('?.')) {
        if (this.eat('(')) expr = { type: 'Call', callee: expr, args: this.args(), optional: true }
        else if (this.eat('[')) {
          const prop = this.expression()
          this.expect(']')
          expr = { type: 'Member', object: expr, prop, optional: true }
        } else {
          const t = this.next()
          if (t.t !== 'id' && t.t !== 'kw') throw new LangError(`expected a property name at ${t.p}`)
          expr = { type: 'Member', object: expr, prop: { type: 'Lit', value: t.v }, optional: true }
        }
      } else if (this.eat('[')) {
        const prop = this.expression()
        this.expect(']')
        expr = { type: 'Member', object: expr, prop, optional: false }
      } else if (this.eat('(')) {
        expr = { type: 'Call', callee: expr, args: this.args(), optional: false }
      } else if (this.peek().t === 'tpl') {
        throw new LangError(`tagged templates are not supported at ${this.peek().p}`)
      } else return expr
    }
  }

  primary(): Node {
    const t = this.next()
    switch (t.t) {
      case 'num': case 'str': return { type: 'Lit', value: t.v }
      case 'tpl': return {
        type: 'Template',
        parts: t.parts.map(p => (typeof p === 'string' ? p : new Parser(p).expressionOnly())),
      }
      case 'id': return { type: 'Id', name: t.v }
      case 'kw':
        switch (t.v) {
          case 'true': return { type: 'Lit', value: true }
          case 'false': return { type: 'Lit', value: false }
          case 'null': return { type: 'Lit', value: null }
          case 'undefined': return { type: 'Lit', value: undefined }
          case 'this': return { type: 'This' }
          case 'function': {
            const name = this.peek().t === 'id' ? this.ident() : null
            return this.functionRest(name)
          }
        }
        break
      case 'op':
        if (t.v === '(') {
          const e = this.expression()
          this.expect(')')
          return e
        }
        if (t.v === '[') {
          const elements: Node[] = []
          while (!this.eat(']')) {
            if (this.is(',')) { this.i++; elements.push({ type: 'Lit', value: undefined }); continue }
            elements.push(this.eat('...') ? { type: 'Spread', arg: this.assignment() } : this.assignment())
            if (!this.is(']')) this.expect(',')
          }
          return { type: 'Array', elements }
        }
        if (t.v === '{') {
          const props: Node[] = []
          while (!this.eat('}')) {
            if (this.eat('...')) props.push({ type: 'SpreadProp', arg: this.assignment() })
            else {
              let key: Node
              let shorthand: string | null = null
              const k = this.next()
              if (k.t === 'op' && k.v === '[') { key = this.assignment(); this.expect(']') }
              else if (k.t === 'id' || k.t === 'kw') { key = { type: 'Lit', value: k.v }; if (k.t === 'id') shorthand = k.v }
              else if (k.t === 'str' || k.t === 'num') key = { type: 'Lit', value: String(k.v) }
              else throw new LangError(`bad object key at ${k.p}`)
              if (this.is('(')) props.push({ type: 'Prop', key, value: this.functionRest(null) })
              else if (this.eat(':')) props.push({ type: 'Prop', key, value: this.assignment() })
              else if (shorthand !== null) props.push({ type: 'Prop', key, value: { type: 'Id', name: shorthand } })
              else throw new LangError(`expected ':' at ${this.peek().p}`)
            }
            if (!this.is('}')) this.expect(',')
          }
          return { type: 'Object', props }
        }
    }
    throw new LangError(`unexpected ${'v' in t ? `'${t.v}'` : t.t} at ${t.p}`)
  }

  expressionOnly(): Node {
    const e = this.expression()
    if (this.peek().t !== 'eof') throw new LangError(`unexpected token in template at ${this.peek().p}`)
    return e
  }
}

function toPattern(n: Node): Node {
  if (n.type === 'Array') return { type: 'ArrayPattern', elements: n.elements.map((e: Node) => (e.type === 'Spread' ? { type: 'Rest', arg: toPattern(e.arg) } : toPattern(e))) }
  if (n.type === 'Object') return {
    type: 'ObjectPattern',
    props: n.props.map((p: Node) => ({ key: String(p.key.value), value: toPattern(p.value) })),
    rest: null,
  }
  if (n.type === 'Assign' && n.op === '=') return { type: 'Default', target: toPattern(n.target), value: n.value }
  if (n.type === 'Id' || n.type === 'Member') return n
  throw new LangError('bad destructuring target')
}

export function parse(src: string): Node {
  return new Parser(tokenize(src)).program()
}

// ---------------------------------------------------------------- values and scopes

type Slot = { v: unknown; c: boolean }

export class Env {
  vars = new Map<string, Slot>()
  constructor(public parent: Env | null, public fnScope = false) {}

  lookup(name: string): Slot | undefined {
    for (let e: Env | null = this; e; e = e.parent) {
      const s = e.vars.get(name)
      if (s) return s
    }
    return undefined
  }
  declare(name: string, v: unknown, c = false): void { this.vars.set(name, { v, c }) }
  root(): Env { let e: Env = this; while (e.parent) e = e.parent; return e }
  fn(): Env { let e: Env = this; while (!e.fnScope && e.parent) e = e.parent; return e }
}

export class Closure {
  constructor(public node: Node, public env: Env, public thisVal: unknown) {}
}

const BREAK = { s: 'break' }
const CONTINUE = { s: 'continue' }
class Ret { constructor(public v: unknown) {} }
type Signal = typeof BREAK | typeof CONTINUE | Ret | undefined

class Thrown { constructor(public v: unknown) {} }

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'])
const MAX_STR = 100_000
const MAX_ARR = 100_000
const MAX_DEPTH = 200

const ARRAY_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'indexOf', 'lastIndexOf', 'includes',
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every',
  'sort', 'reverse', 'fill', 'flat', 'flatMap', 'at', 'keys', 'entries',
])
const STRING_METHODS = new Set([
  'charAt', 'charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf', 'includes', 'slice', 'substring', 'substr',
  'toUpperCase', 'toLowerCase', 'split', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd', 'repeat',
  'startsWith', 'endsWith', 'replace', 'replaceAll', 'at', 'concat',
])
const NUMBER_METHODS = new Set(['toFixed', 'toString', 'toPrecision'])

export type Host = Record<string, unknown>

/** One loaded program: its global scope, and a budget the caller refills before each run. */
export class Interpreter {
  steps = 0
  depth = 0
  global: Env
  private natives = new WeakMap<Closure, (...a: unknown[]) => unknown>()

  constructor(host: Host) {
    this.global = new Env(null, true)
    for (const [k, v] of Object.entries(host)) this.global.declare(k, v, true)
  }

  /** Runs a whole program in the global scope with `budget` steps. */
  run(program: Node, budget: number): void {
    this.steps = budget
    this.depth = 0
    try {
      this.execBody(program.body, this.global)
    } catch (e) {
      throw unwrap(e)
    }
  }

  /** Calls a value of the program (a closure or a host function) with `budget` steps. */
  call(fn: unknown, args: unknown[], budget: number): unknown {
    this.steps = budget
    this.depth = 0
    try {
      return this.invoke(fn, args, undefined)
    } catch (e) {
      throw unwrap(e)
    }
  }

  get(name: string): unknown { return this.global.lookup(name)?.v }

  tick(): void {
    if (--this.steps < 0) throw new BudgetError('step budget exhausted')
  }

  // ------------------------------------------------ statements

  hoist(body: Node[], env: Env): void {
    for (const s of body) {
      if (s.type === 'FunctionDecl') env.declare(s.name, new Closure(s.fn, env, undefined))
      else if (s.type === 'Var' && s.kind === 'var') for (const d of s.decls) for (const n of names(d.id)) if (!env.fn().vars.has(n)) env.fn().declare(n, undefined)
    }
  }

  execBody(body: Node[], env: Env): Signal {
    this.hoist(body, env)
    for (const s of body) {
      const sig = this.exec(s, env)
      if (sig) return sig
    }
    return undefined
  }

  exec(s: Node, env: Env): Signal {
    this.tick()
    switch (s.type) {
      case 'Expr': this.eval(s.expr, env); return undefined
      case 'Var':
        for (const d of s.decls) {
          const v = d.init ? this.eval(d.init, env) : undefined
          this.bind(d.id, v, s.kind === 'var' ? env.fn() : env, s.kind === 'const', s.kind === 'var')
        }
        return undefined
      case 'FunctionDecl': case 'Empty': return undefined
      case 'Return': return new Ret(s.arg ? this.eval(s.arg, env) : undefined)
      case 'If':
        if (truthy(this.eval(s.test, env))) return this.exec(s.then, env)
        return s.otherwise ? this.exec(s.otherwise, env) : undefined
      case 'Block': return this.execBody(s.body, new Env(env))
      case 'For': return this.execFor(s, env)
      case 'ForOf': case 'ForIn': {
        const right = this.eval(s.right, env)
        let items: unknown[]
        if (s.type === 'ForIn') items = right && typeof right === 'object' ? Object.keys(right) : typeof right === 'string' ? Object.keys([...right]) : []
        else if (Array.isArray(right)) items = right.slice()
        else if (typeof right === 'string') items = [...right]
        else if (right instanceof Map || right instanceof Set) items = [...right]
        else throw new LangError(`for-of needs an array or string, got ${typeOf(right)}`)
        for (const item of items) {
          this.tick()
          const iter = new Env(env)
          if (s.kind === null) this.assignTo(s.id, item, env)
          else this.bind(s.id, item, s.kind === 'var' ? env.fn() : iter, s.kind === 'const', s.kind === 'var')
          const sig = this.exec(s.body, iter)
          if (sig === BREAK) break
          if (sig === CONTINUE) continue
          if (sig) return sig
        }
        return undefined
      }
      case 'While':
        while (truthy(this.eval(s.test, env))) {
          this.tick()
          const sig = this.exec(s.body, env)
          if (sig === BREAK) break
          if (sig === CONTINUE) continue
          if (sig) return sig
        }
        return undefined
      case 'DoWhile':
        do {
          this.tick()
          const sig = this.exec(s.body, env)
          if (sig === BREAK) break
          if (sig === CONTINUE) continue
          if (sig) return sig
        } while (truthy(this.eval(s.test, env)))
        return undefined
      case 'Break': return BREAK
      case 'Continue': return CONTINUE
      case 'Switch': {
        const d = this.eval(s.disc, env)
        const scope = new Env(env)
        let hit = s.cases.findIndex((c: Node) => c.test !== null && this.eval(c.test, scope) === d)
        if (hit < 0) hit = s.cases.findIndex((c: Node) => c.test === null)
        if (hit < 0) return undefined
        for (const c of s.cases) this.hoist(c.body, scope)
        for (let k = hit; k < s.cases.length; k++) {
          for (const st of s.cases[k].body) {
            const sig = this.exec(st, scope)
            if (sig === BREAK) return undefined
            if (sig) return sig
          }
        }
        return undefined
      }
      case 'Throw': throw new Thrown(this.eval(s.arg, env))
      case 'Try': {
        try {
          return this.exec(s.block, env)
        } catch (e) {
          if (e instanceof BudgetError || !s.handler) throw e
          const scope = new Env(env)
          if (s.param) scope.declare(s.param, e instanceof Thrown ? e.v : e instanceof Error ? e.message : e)
          return this.exec(s.handler, scope)
        } finally {
          if (s.finalizer) {
            const sig = this.exec(s.finalizer, env)
            if (sig) return sig // eslint-disable-line no-unsafe-finally
          }
        }
      }
    }
    throw new LangError(`unknown statement ${s.type}`)
  }

  /** `for (let …)` gives every turn its own copy of the loop variables, so closures capture 0, 1, 2. */
  execFor(s: Node, outer: Env): Signal {
    let env = new Env(outer)
    if (s.init) this.exec(s.init, env)
    const perTurn = s.init?.type === 'Var' && s.init.kind !== 'var'
    for (;;) {
      this.tick()
      if (s.test && !truthy(this.eval(s.test, env))) break
      const sig = this.exec(s.body, env)
      if (sig === BREAK) break
      if (sig && sig !== CONTINUE) return sig
      if (perTurn) {
        const copy = new Env(outer)
        for (const [k, slot] of env.vars) copy.vars.set(k, { v: slot.v, c: slot.c })
        env = copy
      }
      if (s.update) this.eval(s.update, env)
    }
    return undefined
  }

  bind(p: Node, v: unknown, env: Env, isConst: boolean, isVar = false): void {
    switch (p.type) {
      case 'Id':
        if (isVar && env.vars.has(p.name)) env.vars.get(p.name)!.v = v
        else env.declare(p.name, v, isConst)
        return
      case 'Default': return this.bind(p.target, v === undefined ? this.eval(p.value, env) : v, env, isConst, isVar)
      case 'ArrayPattern': {
        const arr = toArray(v)
        p.elements.forEach((el: Node | null, k: number) => {
          if (!el) return
          if (el.type === 'Rest') this.bind(el.arg, arr.slice(k), env, isConst, isVar)
          else this.bind(el, arr[k], env, isConst, isVar)
        })
        return
      }
      case 'ObjectPattern': {
        if (v === null || v === undefined) throw new LangError('cannot destructure null')
        const used = new Set<string>()
        for (const { key, value } of p.props) { used.add(key); this.bind(value, getProp(v, key), env, isConst, isVar) }
        if (p.rest) {
          const rest = newObject()
          for (const k of Object.keys(v as object)) if (!used.has(k)) rest[k] = (v as Record<string, unknown>)[k]
          env.declare(p.rest, rest, isConst)
        }
        return
      }
    }
    throw new LangError(`bad binding ${p.type}`)
  }

  // ------------------------------------------------ expressions

  eval(n: Node, env: Env): any {
    switch (n.type) {
      case 'Lit': return n.value
      case 'Id': {
        const s = env.lookup(n.name)
        if (!s) throw new LangError(`${n.name} is not defined`)
        return s.v
      }
      case 'This': {
        for (let e: Env | null = env; e; e = e.parent) if (e.vars.has('this')) return e.vars.get('this')!.v
        return undefined
      }
      case 'Template': {
        let s = ''
        for (const p of n.parts) s += typeof p === 'string' ? p : str(this.eval(p, env))
        return capStr(s)
      }
      case 'Array': {
        const out: unknown[] = []
        for (const el of n.elements) {
          if (el.type === 'Spread') out.push(...toArray(this.eval(el.arg, env)))
          else out.push(this.eval(el, env))
        }
        return capArr(out)
      }
      case 'Object': {
        const o = newObject()
        for (const p of n.props) {
          if (p.type === 'SpreadProp') {
            const src = this.eval(p.arg, env)
            if (src && typeof src === 'object') for (const k of Object.keys(src)) if (!FORBIDDEN.has(k)) o[k] = (src as Record<string, unknown>)[k]
            continue
          }
          const key = propKey(this.eval(p.key, env))
          if (FORBIDDEN.has(key)) throw new LangError(`property '${key}' is not allowed`)
          o[key] = this.eval(p.value, env)
        }
        return o
      }
      case 'Function': {
        const c = new Closure(n, env, undefined)
        if (n.name && !n.arrow) {
          const self = new Env(env)
          self.declare(n.name, c)
          c.env = self
        }
        return c
      }
      case 'Unary': {
        if (n.op === 'typeof') {
          if (n.arg.type === 'Id' && !env.lookup(n.arg.name)) return 'undefined'
          return typeOf(this.eval(n.arg, env))
        }
        const v = this.eval(n.arg, env)
        switch (n.op) {
          case '!': return !truthy(v)
          case '-': return -(v as number)
          case '+': return +(v as number)
          case '~': return ~(v as number)
        }
        break
      }
      case 'Update': {
        const old = Number(this.eval(n.arg, env))
        const nv = n.op === '++' ? old + 1 : old - 1
        this.assignTo(n.arg, nv, env)
        return n.prefix ? nv : old
      }
      case 'Binary': return binary(n.op, this.eval(n.left, env), this.eval(n.right, env))
      case 'Logical': {
        const l = this.eval(n.left, env)
        if (n.op === '&&') return truthy(l) ? this.eval(n.right, env) : l
        if (n.op === '||') return truthy(l) ? l : this.eval(n.right, env)
        return l ?? this.eval(n.right, env)
      }
      case 'Cond': return truthy(this.eval(n.test, env)) ? this.eval(n.then, env) : this.eval(n.otherwise, env)
      case 'Seq': { let v: unknown; for (const e of n.list) v = this.eval(e, env); return v }
      case 'Assign': {
        if (n.op === '=') {
          const v = this.eval(n.value, env)
          this.assignTo(n.target, v, env)
          return v
        }
        const cur = this.eval(n.target, env)
        if (n.op === '&&=') { if (!truthy(cur)) return cur; const v = this.eval(n.value, env); this.assignTo(n.target, v, env); return v }
        if (n.op === '||=') { if (truthy(cur)) return cur; const v = this.eval(n.value, env); this.assignTo(n.target, v, env); return v }
        if (n.op === '??=') { if (cur != null) return cur; const v = this.eval(n.value, env); this.assignTo(n.target, v, env); return v }
        const v = binary(n.op.slice(0, -1), cur, this.eval(n.value, env))
        this.assignTo(n.target, v, env)
        return v
      }
      case 'Member': {
        const obj = this.eval(n.object, env)
        if (n.optional && obj == null) return undefined
        return getProp(obj, this.eval(n.prop, env))
      }
      case 'Call': {
        let thisVal: unknown
        let fn: unknown
        if (n.callee.type === 'Member') {
          thisVal = this.eval(n.callee.object, env)
          if (n.callee.optional && thisVal == null) return undefined
          fn = getProp(thisVal, this.eval(n.callee.prop, env))
        } else fn = this.eval(n.callee, env)
        if (n.optional && fn == null) return undefined
        const args: unknown[] = []
        for (const a of n.args) {
          if (a.type === 'Spread') args.push(...toArray(this.eval(a.arg, env)))
          else args.push(this.eval(a, env))
        }
        if (fn === undefined || fn === null) {
          const what = n.callee.type === 'Id' ? n.callee.name : n.callee.type === 'Member' && n.callee.prop.type === 'Lit' ? `.${n.callee.prop.value}` : 'value'
          throw new LangError(`${what} is not a function`)
        }
        return this.invoke(fn, args, thisVal)
      }
      case 'New': {
        const fn = this.eval(n.callee, env)
        const args = n.args.map((a: Node) => this.eval(a, env))
        if (fn === ARRAY_CTOR) return capArr(Array.from({ length: Math.min(Number(args[0]) || 0, MAX_ARR) }))
        if (fn === MAP_CTOR) return new Map(args[0] as [unknown, unknown][] | undefined)
        if (fn === SET_CTOR) return new Set(args[0] as unknown[] | undefined)
        if (fn instanceof Closure && !fn.node.arrow) {
          const o = newObject()
          const r = this.invoke(fn, args, o)
          return r && typeof r === 'object' ? r : o
        }
        throw new LangError('new is only for Array, Map, Set and your own functions')
      }
    }
    throw new LangError(`unknown expression ${n.type}`)
  }

  assignTo(target: Node, v: unknown, env: Env): void {
    if (target.type === 'Id') {
      const s = env.lookup(target.name)
      if (!s) { env.root().declare(target.name, v); return }
      if (s.c) throw new LangError(`cannot assign to const ${target.name}`)
      s.v = v
      return
    }
    if (target.type === 'Member') {
      const obj = this.eval(target.object, env)
      setProp(obj, this.eval(target.prop, env), v)
      return
    }
    if (target.type === 'ArrayPattern' || target.type === 'ObjectPattern' || target.type === 'Default') {
      // destructuring assignment: bind into a scratch scope, then assign each name
      const scratch = new Env(env)
      this.bind(target, v, scratch, false)
      for (const [k, slot] of scratch.vars) this.assignTo({ type: 'Id', name: k }, slot.v, env)
      return
    }
    throw new LangError('bad assignment target')
  }

  invoke(fn: unknown, args: unknown[], thisVal: unknown): unknown {
    this.tick()
    if (fn instanceof Closure) {
      if (++this.depth > MAX_DEPTH) throw new LangError('too much recursion')
      try {
        const scope = new Env(fn.env, true)
        if (!fn.node.arrow) scope.declare('this', fn.thisVal ?? thisVal)
        fn.node.params.forEach((p: Node, k: number) => {
          if (p.type === 'Rest') this.bind(p.arg, args.slice(k), scope, false)
          else this.bind(p, args[k], scope, false)
        })
        const sig = this.execBody(fn.node.body.body, scope)
        return sig instanceof Ret ? sig.v : undefined
      } finally {
        this.depth--
      }
    }
    if (typeof fn === 'function') {
      const r = (fn as (...a: unknown[]) => unknown).apply(thisVal, args.map(a => this.toHost(a)))
      return r
    }
    throw new LangError(`${typeOf(fn)} is not a function`)
  }

  /** A program function handed to a host function (a map callback, a shader) becomes a plain JS function. */
  toHost(v: unknown): unknown {
    if (!(v instanceof Closure)) return v
    let f = this.natives.get(v)
    if (!f) {
      f = (...a: unknown[]) => this.invoke(v, a, undefined)
      this.natives.set(v, f)
    }
    return f
  }
}

function unwrap(e: unknown): Error {
  if (e instanceof LangError) return e
  if (e instanceof Thrown) return new LangError(`uncaught: ${str(e.v)}`)
  if (e instanceof RangeError) return new LangError(e.message)
  if (e instanceof Error) return new LangError(e.message)
  return new LangError(String(e))
}

function names(p: Node): string[] {
  switch (p.type) {
    case 'Id': return [p.name]
    case 'Default': return names(p.target)
    case 'Rest': return names(p.arg)
    case 'ArrayPattern': return p.elements.flatMap((e: Node | null) => (e ? names(e) : []))
    case 'ObjectPattern': return [...p.props.flatMap((x: { value: Node }) => names(x.value)), ...(p.rest ? [p.rest] : [])]
  }
  return []
}

// ---------------------------------------------------------------- semantics

const ARRAY_CTOR = Object.freeze(Object.assign(function Array() {}, {
  isArray: Array.isArray,
  from: (src: any, fn?: (v: unknown, i: number) => unknown) => {
    const n = src && typeof src === 'object' && !Array.isArray(src) && !(src instanceof Map) && !(src instanceof Set) ? Math.min(Number(src.length) || 0, MAX_ARR) : -1
    const base = n >= 0 ? Array.from({ length: n }) : toArray(src).slice()
    return fn ? base.map((v, i) => fn(v, i)) : base
  },
  of: (...a: unknown[]) => a,
}))
const MAP_CTOR = Object.freeze(function Map() {})
const SET_CTOR = Object.freeze(function Set() {})

function newObject(): Record<string, unknown> { return {} }

export function truthy(v: unknown): boolean { return !!v }

export function typeOf(v: unknown): string {
  if (v instanceof Closure) return 'function'
  if (v === null) return 'object'
  return typeof v
}

export function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Closure || typeof v === 'function') return '[function]'
  if (Array.isArray(v)) return v.map(x => (x == null ? '' : str(x))).join(',')
  if (v && typeof v === 'object') return '[object]'
  return String(v)
}

function capStr(s: string): string {
  if (s.length > MAX_STR) throw new LangError('string too long')
  return s
}
function capArr<T>(a: T[]): T[] {
  if (a.length > MAX_ARR) throw new LangError('array too long')
  return a
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [...v]
  if (v instanceof Map || v instanceof Set) return [...v]
  throw new LangError(`expected an array, got ${typeOf(v)}`)
}

function binary(op: string, a: any, b: any): unknown {
  switch (op) {
    case '+': {
      if (typeof a === 'string' || typeof b === 'string' || (a && typeof a === 'object') || (b && typeof b === 'object'))
        return capStr(str(a) + str(b))
      return a + b
    }
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
    case '**': return a ** b
    case '==': return a == b // eslint-disable-line eqeqeq
    case '!=': return a != b // eslint-disable-line eqeqeq
    case '===': return a === b
    case '!==': return a !== b
    case '<': return a < b
    case '>': return a > b
    case '<=': return a <= b
    case '>=': return a >= b
    case '&': return a & b
    case '|': return a | b
    case '^': return a ^ b
    case '<<': return a << b
    case '>>': return a >> b
    case '>>>': return a >>> b
    case 'in': return b && typeof b === 'object' ? Object.prototype.hasOwnProperty.call(b, propKey(a)) : false
  }
  throw new LangError(`unknown operator ${op}`)
}

function propKey(k: unknown): string {
  return typeof k === 'number' ? String(k) : str(k)
}

function getProp(obj: unknown, key: unknown): unknown {
  const k = propKey(key)
  if (FORBIDDEN.has(k)) return undefined
  if (obj === null || obj === undefined) throw new LangError(`cannot read '${k}' of ${obj}`)
  if (Array.isArray(obj)) {
    if (k === 'length') return obj.length
    if (/^\d+$/.test(k)) return obj[Number(k)]
    if (ARRAY_METHODS.has(k)) return arrayMethod(obj, k)
    return undefined
  }
  if (typeof obj === 'string') {
    if (k === 'length') return obj.length
    if (/^\d+$/.test(k)) return obj[Number(k)]
    if (STRING_METHODS.has(k)) return stringMethod(obj, k)
    return undefined
  }
  if (typeof obj === 'number') return NUMBER_METHODS.has(k) ? (...a: unknown[]) => (obj as any)[k](...a) : undefined
  if (obj instanceof Map) {
    if (k === 'size') return obj.size
    if (['get', 'set', 'has', 'delete', 'clear', 'keys', 'values', 'forEach'].includes(k))
      return k === 'keys' || k === 'values' ? () => [...obj[k as 'keys']()] : (obj as any)[k].bind(obj)
    return undefined
  }
  if (obj instanceof Set) {
    if (k === 'size') return obj.size
    if (['add', 'has', 'delete', 'clear', 'forEach'].includes(k)) return (obj as any)[k].bind(obj)
    if (k === 'values') return () => [...obj]
    return undefined
  }
  if (typeof obj === 'object' || typeof obj === 'function') {
    return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, unknown>)[k] : undefined
  }
  return undefined
}

function setProp(obj: unknown, key: unknown, v: unknown): void {
  const k = propKey(key)
  if (FORBIDDEN.has(k)) throw new LangError(`property '${k}' is not allowed`)
  if (Array.isArray(obj)) {
    if (k === 'length') { obj.length = Math.min(Number(v) || 0, MAX_ARR); return }
    if (!/^\d+$/.test(k)) throw new LangError(`cannot set '${k}' on an array`)
    if (Number(k) >= MAX_ARR) throw new LangError('array too long')
    obj[Number(k)] = v
    return
  }
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj) && !(obj instanceof Map) && !(obj instanceof Set)) {
    ;(obj as Record<string, unknown>)[k] = v
    return
  }
  throw new LangError(`cannot set '${k}' on ${typeOf(obj)}`)
}

function arrayMethod(arr: unknown[], k: string): (...a: any[]) => unknown {
  return (...a: any[]) => {
    if (k === 'push' || k === 'unshift' || k === 'concat') {
      const r = (arr as any)[k](...a)
      capArr(k === 'concat' ? r : arr)
      return r
    }
    if (k === 'fill' || k === 'flat') return capArr((arr as any)[k](...a))
    if (k === 'keys' || k === 'entries') return capArr([...(arr as any)[k]()])
    if (k === 'join') return capStr(arr.map(x => (x == null ? '' : str(x))).join(a[0] === undefined ? ',' : str(a[0])))
    return (arr as any)[k](...a)
  }
}

function stringMethod(s: string, k: string): (...a: any[]) => unknown {
  return (...a: any[]) => {
    if (k === 'repeat') return capStr(s.repeat(Math.max(0, Math.min(Number(a[0]) || 0, MAX_STR))))
    if (k === 'padStart' || k === 'padEnd') return capStr((s as any)[k](Math.min(Number(a[0]) || 0, MAX_STR), a[1]))
    if ((k === 'replace' || k === 'replaceAll' || k === 'split') && a[0] !== undefined && typeof a[0] !== 'string')
      throw new LangError(`${k} takes a string pattern`)
    return capStr((s as any)[k](...a))
  }
}

/** The standard library a program sees: Math, a few constructors and helpers, all frozen copies. */
export function stdlib(): Host {
  const M = Math as unknown as Record<string, unknown>
  const math: Record<string, unknown> = {}
  for (const k of ['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'sqrt', 'cbrt', 'pow', 'exp', 'log', 'log2', 'log10',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'hypot', 'random', 'fround', 'imul', 'clz32'])
    math[k] = M[k]
  for (const k of ['PI', 'E', 'LN2', 'LN10', 'SQRT2', 'SQRT1_2', 'LOG2E', 'LOG10E']) math[k] = M[k]
  return {
    Math: Object.freeze(math),
    Infinity,
    NaN,
    parseInt: (s: unknown, r?: number) => parseInt(str(s), r),
    parseFloat: (s: unknown) => parseFloat(str(s)),
    isNaN: (v: unknown) => Number.isNaN(Number(v)),
    isFinite: (v: unknown) => Number.isFinite(Number(v)),
    String: (v: unknown) => str(v),
    Number: Object.freeze(Object.assign((v: unknown) => Number(v), { isFinite: Number.isFinite, isInteger: Number.isInteger, MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, EPSILON: Number.EPSILON })),
    Boolean: (v: unknown) => !!v,
    Array: ARRAY_CTOR,
    Object: Object.freeze({
      keys: (o: object) => Object.keys(o ?? {}),
      values: (o: object) => Object.values(o ?? {}),
      entries: (o: object) => Object.entries(o ?? {}),
      assign: (t: Record<string, unknown>, ...s: object[]) => {
        for (const src of s) for (const [k, v] of Object.entries(src ?? {})) if (!FORBIDDEN.has(k)) t[k] = v
        return t
      },
      freeze: (o: object) => o,
    }),
    Map: MAP_CTOR,
    Set: SET_CTOR,
    JSON: Object.freeze({ stringify: (v: unknown) => capStr(JSON.stringify(v) ?? ''), parse: (s: string) => JSON.parse(str(s)) }),
    console: Object.freeze({ log: () => undefined, warn: () => undefined, error: () => undefined }),
  }
}

/** Parses and runs `src` once with `budget` steps; returns the interpreter so the caller can reach its functions. */
export function load(src: string, host: Host, budget = 200_000): Interpreter {
  const program = parse(src)
  const interp = new Interpreter({ ...stdlib(), ...host })
  interp.run(program, budget)
  return interp
}
