import { expect, test } from 'claude-code/testing'

import { paint, ROWS } from './paint'

const decode = (b64: string) => new Uint32Array(Uint8Array.fromBase64(b64).buffer)
const barnRow = (cells: string, width: number) => {
  const w = decode(cells)
  return Array.from({ length: width }, (_, c) => String.fromCharCode(w[(3 * width + c) * 3]!)).join('')
}

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('the farm scene stays in the band while the turn works', async ($, on) => {
  let asked = ''
  on('model.complete', async (_, e) => {
    asked = e.prompt
    return { value: { isAnswered: true, text: '"Plowing through effects.ts, hunting for bugs."', usage } }
  })
  on('tool.call', async () => ({ result: { isError: false, text: 'ok' } }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async (s, e) => {
    const { Text } = s.ui.resolve(e)
    return <Text key="engine">engine band</Text>
  })

  await $.tool.call({ tool: 'Bash', command: 'cd "/a b" && grep -rn foo' } as never)
  expect(asked).toContain('grep')
  await $.tool.call({ tool: 'Read', file_path: '/src/effects.ts' } as never)
  expect(asked).toContain('effects.ts')

  const band = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const term = await $.ui.mount({ plugin: 'toon-spinner', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect(await term.find({ text: 'Plowing through effects.ts, hunting for bugs.' })).toBeDefined()
  const raster = (await term.find({ type: 'Raster', key: 'scene' })) as { props: { cells: string; columns: number } } | undefined
  expect(raster).toBeDefined()
  expect(barnRow(raster!.props.cells, raster!.props.columns)).toContain('Read effects.ts')

  const desk = await $.ui.mount({ plugin: 'toon-spinner', surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(await desk.find({ text: /Plowing through effects\.ts/ })).toBeDefined()

  const idle = await $.ui.mount({ plugin: 'toon-spinner', surface: 'terminal', component: 'AbovePrompt', props: { ...band, isWorking: false } })
  expect(await idle.find({ type: 'Raster' })).toBeUndefined()
  expect(await idle.find({ text: 'engine band' })).toBeDefined()
})

test('the barn shows the file label and Claude moves', () => {
  const a = decode(paint(56, 'Read effects.ts', 0, 0, 'run'))
  const b = decode(paint(56, 'Read effects.ts', 10, 10, 'run'))
  expect(a.length).toBe(56 * ROWS * 3)
  expect(barnRow(paint(56, 'Read effects.ts', 0, 0, 'run'), 56)).toContain('Read effects.ts')
  expect(Array.from(a).join()).not.toBe(Array.from(b).join())
})

test('each mode draws a different pose', () => {
  const frames = (['run', 'read', 'edit', 'think'] as const).map(m =>
    Array.from({ length: 8 }, (_, t) => paint(40, 'x', t, 3, m)).join('|'),
  )
  expect(new Set(frames).size).toBe(4)
})
