import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const props = { word: 'Vibing', message: null, suffix: '…', mode: 'tool-use' } as const

test('a tool call reaches the model with the task, and the spinner keeps its line above the scene', async ($, on) => {
  mock.clock(on)
  const prompts: string[] = []
  on('model.complete', async (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: '{"speech":"Sniffing README.md for typos.","scene":null}', usage } }
  })
  on('tool.call', async () => ({ result: { isError: false, text: 'ok' } }) as never)
  on('ui.render', { component: 'Spinner' }, async (s, e) => {
    const { Text } = s.ui.resolve(e)
    return <Text>Vibing… (35s · ↓ 1.8k tokens)</Text>
  })
  on('prompt.submit', async (_, e) => ({ text: e.text }) as never)
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)

  await $.prompt.submit({ text: 'Tidy up the README', wait: false } as never)
  await $.turn.start({ text: 'Tidy up the README', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' } as never)

  expect(prompts.some(p => p.includes('Tidy up the README') && p.includes('Read repo/README.md'))).toBe(true)

  const term = await $.ui.mount({ plugin: 'spinner-oracle', surface: 'terminal', component: 'Spinner', props })
  const tree = (await term.drawn()) as unknown as { type: string; children: { type: string }[] }
  // the engine's status line first, the scene under it
  expect(tree.type).toBe('Box')
  expect(tree.children.map(c => c.type)).toEqual(['Text', 'Raster'])
  expect(await term.find({ text: /Vibing… \(35s/ })).toBeDefined()
  expect(await term.find({ type: 'Raster', key: 'oracle' })).toBeDefined()

  const desk = await $.ui.mount({ plugin: 'spinner-oracle', surface: 'desktop', component: 'Spinner', props })
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  expect(await desk.find({ text: /Vibing… \(35s/ })).toBeDefined()
})

test('/spinner-usage tallies model tokens, and /close-spinner stops the calls and the scene until /open-spinner', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const spent = { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 }
  let calls = 0
  on('model.complete', async () => {
    calls++
    return { value: { isAnswered: true, text: '{"speech":"Reading.","scene":null}', usage: spent } }
  })
  on('tool.call', async () => ({ result: { isError: false, text: 'ok' } }) as never)
  on('ui.render', { component: 'Spinner' }, async (s, e) => {
    const { Text } = s.ui.resolve(e)
    return <Text>Vibing…</Text>
  })
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
  expect(calls).toBeGreaterThan(0)
  const report = (await $.command.run({ command: 'spinner-usage' })).text ?? ''
  expect(report).toContain(`${calls} model requests`)
  expect(report).toContain(`output ${(40 * calls).toLocaleString('en-US')} tokens`)

  await $.command.run({ command: 'close-spinner' })
  const before = calls
  await $.turn.start({ text: 'go', turnId: 't2' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' } as never)
  expect(calls).toBe(before)
  const term = await $.ui.mount({ plugin: 'spinner-oracle', surface: 'terminal', component: 'Spinner', props })
  expect(await term.find({ type: 'Raster' })).toBeUndefined()
  expect(await term.find({ text: /Vibing…/ })).toBeDefined()

  await $.command.run({ command: 'open-spinner' })
  await $.turn.start({ text: 'go', turnId: 't3' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' } as never)
  expect(calls).toBeGreaterThan(before)
})
