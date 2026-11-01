import { expect, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const PANE = {
  plugin: 'footprint',
  component: 'Pane',
  requestId: 'footprint',
  props: {
    title: 'Footprint',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const F = (name: string, size = 1): FsEntry => ({ name, kind: 'file', size, mtimeMs: 1, isLink: false })

// Nothing sits beneath the plugin: each hook here stands for the engine.
// `list` answers each fs.list in order; `lists` counts the calls.
function engine(on: On, fs: { exists: boolean[]; list: FsEntry[][]; root?: string; lists?: { n: number } }) {
  let t = 0
  on('command.register', () => ({ value: { command: 'footprint' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: fs.root ?? '/r' }))
  on('clock.now', () => ({ value: ++t }))
  on('fs.exists', () => ({ value: fs.exists.shift() ?? true }))
  on('fs.list', () => {
    if (fs.lists) fs.lists.n++
    return { value: fs.list.shift() ?? [] }
  })
  on('tool.call', () => ({ result: {} }))
}

type Ui = { press: (t: { key: string }) => Promise<unknown> }
const expand = async (ui: Ui, ...dirs: string[]) => {
  for (const d of dirs) await ui.press({ key: 'd:' + d })
}

test('Write then Edit of a new file stays added; one folder row per segment from /', async ($, on) => {
  engine(on, { exists: [false, true, true, true], list: [] })
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/r/src/lib/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/src/lib/a.ts', old_string: 'x', new_string: 'y' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'd:/r' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'n:/r' }))?.text).toMatch(/^\s*r\s+1$/)
  await expand(ui, '/r', '/r/src', '/r/src/lib')
  expect(await ui.find({ type: 'Button', key: 'd:/r/src/lib' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'n:/r/src/lib' }))?.text).toMatch(/^\s*lib\s+1$/)
  expect(await ui.find({ type: 'Button', key: 'f:/r/src/lib/a.ts' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'a.ts' }))?.text).toBe('a.ts')
  // No glyph: the name carries the status. Flashing right after the change, so it is white for now.
  expect((await ui.find({ type: 'Text', text: 'a.ts' }))?.props.color).toBe('#FFFFFF')
  await ui.unmount()
})

test('folders start collapsed and a press toggles them', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/src/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'd:/r/src' })).toBe(undefined)
  await expand(ui, '/r', '/r/src')
  expect(await ui.find({ type: 'Button', key: 'f:/r/src/a.ts' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'a.ts' }))?.text).toBe('a.ts')
  await expand(ui, '/r/src')
  expect(await ui.find({ type: 'Button', key: 'f:/r/src/a.ts' })).toBe(undefined)
  await ui.unmount()
})

test('a change flashes the file row and every parent row', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/src/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const bg = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.backgroundColor
  // added = amber, at full strength right after the change; the collapsed parent flashes too.
  expect(await bg('rd:/r')).toMatch(/^#3FB950/)
  await expand(ui, '/r', '/r/src')
  expect(await bg('rd:/r/src')).toMatch(/^#3FB950/)
  expect(await bg('rf:/r/src/a.ts')).toMatch(/^#3FB950/)
  await ui.unmount()
})

test('Bash snapshot difference records a new file as bash', async ($, on) => {
  engine(on, {
    exists: [],
    list: [[], [{ name: 'new.txt', kind: 'file', size: 3, mtimeMs: 10, isLink: false }]],
  })
  await $.tool.call({ tool: 'Bash', command: 'echo hi > new.txt' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r')
  expect(await ui.find({ type: 'Button', key: 'f:/r/new.txt' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'new.txt' }))?.text).toBe('new.txt')
  // `vias` still records bash in the ledger; the pane shows no sh tag (removed on request).
  expect(await ui.find({ type: 'Text', text: /^\s+sh$/ })).toBe(undefined)
  await ui.unmount()
})

test('a session-created file removed by Bash is not shown as deleted', async ($, on) => {
  engine(on, {
    exists: [false, true],
    list: [[{ name: 'tmp.txt', kind: 'file', size: 1, mtimeMs: 1, isLink: false }], []],
  })
  await $.tool.call({ tool: 'Write', file_path: '/r/tmp.txt', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'rm tmp.txt' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /touched/ }))?.text).toBe('No files touched yet.')
  await ui.unmount()
})

test('an unchanged file seen by both walks is not recorded', async ($, on) => {
  engine(on, { exists: [], list: [[F('untouched.txt')], [F('untouched.txt')]] })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /touched/ }))?.text).toBe('No files touched yet.')
  await ui.unmount()
})

test('a tool-written file under a skipped folder survives a Bash call', async ($, on) => {
  // Write under build/ (exists: false, then true). /r lists build/ as a folder, but SKIP keeps the
  // walks out of it: blind, so diff stats it (true) instead of inferring it gone.
  const build: FsEntry = { name: 'build', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
  engine(on, { exists: [false, true, true], list: [[build], [build]] })
  await $.tool.call({ tool: 'Write', file_path: '/r/build/cfg.json', content: '{}' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r', '/r/build')
  expect(await ui.find({ type: 'Button', key: 'f:/r/build/cfg.json' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'cfg.json' }))?.text).toBe('cfg.json')
  await ui.unmount()
})

test('a pre-existing file changed by sed -i shows modified', async ($, on) => {
  engine(on, { exists: [], list: [[F('a.txt', 5)], [F('a.txt', 9)]] })
  await $.tool.call({ tool: 'Bash', command: "sed -i '' s/x/y/ a.txt" })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r')
  expect(await ui.find({ type: 'Button', key: 'f:/r/a.txt' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'a.txt' }))?.text).toBe('a.txt')
  // `vias` still records bash in the ledger; the pane shows no sh tag (removed on request).
  expect(await ui.find({ type: 'Text', text: /^\s+sh$/ })).toBe(undefined)
  await ui.unmount()
})

test('a background Bash call takes no snapshot', async ($, on) => {
  const lists = { n: 0 }
  engine(on, { exists: [], list: [], lists })
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true })
  expect(lists.n).toBe(0)
})

test('a Windows root canonicalises mixed separators and the drive letter', async ($, on) => {
  engine(on, { exists: [false, true], list: [], root: 'c:\\work\\app' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/work/app/src/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'n:C:' }))?.text).toMatch(/^\s*C:\s+1$/)
  await expand(ui, 'C:', 'C:\\work', 'C:\\work\\app', 'C:\\work\\app\\src')
  expect(await ui.find({ type: 'Button', key: 'f:C:\\work\\app\\src\\a.ts' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'a.ts' }))?.text).toBe('a.ts')
  await ui.unmount()
})

test('on the terminal a file row is text, not a press', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await expand(ui, '/r')
  expect(await ui.find({ type: 'Button', key: 'f:/r/a.ts' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /a\.ts/ }))?.text).toBe('a.ts')
  await ui.unmount()
})

test('every row Svg carries an explicit width and a non-empty alt (the desktop paints none without them)', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(typeof svg?.props.width).toBe('number')
  expect(svg?.props.width as number).toBeGreaterThan(0)
  expect((svg?.props.alt as string).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('Bash: a new file in a new folder is added, and flashes', async ($, on) => {
  // before: /r is empty. after: /r holds sub/, and sub/ holds new.txt.
  engine(on, { exists: [], list: [[], [{ name: 'sub', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }], [F('new.txt')]] })
  await $.tool.call({ tool: 'Bash', command: 'mkdir sub && echo x > sub/new.txt' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r', '/r/sub')
  expect(await ui.find({ type: 'Button', key: 'f:/r/sub/new.txt' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'new.txt' }))?.text).toBe('new.txt')
  // `vias` still records bash in the ledger; the pane shows no sh tag (removed on request).
  expect(await ui.find({ type: 'Text', text: /^\s+sh$/ })).toBe(undefined)
  expect((await ui.find({ type: 'Box', key: 'rf:/r/sub/new.txt' }))?.props.backgroundColor).toMatch(/^#3FB950/)
  await ui.unmount()
})

test('Bash: rm -rf of a folder of pre-existing files shows them deleted', async ($, on) => {
  // before: /r holds sub/, sub/ holds old.txt. after: /r is empty.
  engine(on, { exists: [], list: [[{ name: 'sub', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }], [F('old.txt')], []] })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf sub' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r', '/r/sub')
  expect((await ui.find({ type: 'Text', text: /old\.txt/ }))?.text).toMatch(/old\.txt/)
  await ui.unmount()
})

test('a UNC path draws no unnamed folder row', async ($, on) => {
  engine(on, { exists: [false, true], list: [], root: '\\\\srv\\share' })
  await $.tool.call({ tool: 'Write', file_path: '\\\\srv\\share\\a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'n:\\\\srv' }))?.text).toMatch(/^\s*srv\s+1$/)
  await ui.unmount()
})

test('a deleted file and a new folder of the same name get distinct row keys', async ($, on) => {
  // x existed as a file; Bash removes it and creates folder x/ holding y.
  engine(on, { exists: [], list: [[F('x')], [{ name: 'x', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }], [F('y')]] })
  await $.tool.call({ tool: 'Bash', command: 'rm x; mkdir x; touch x/y' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r')
  expect(await ui.find({ type: 'Box', key: 'rd:/r/x' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'rf:/r/x' })).toBeDefined()
  await ui.unmount()
})

test('a settled name is coloured by status: green added, blue modified, red struck-through deleted', async ($, on) => {
  // Long-ago events (clock jumps well past the 3 s flash) so no row flashes and names show their colour.
  let t = 0
  const lists: FsEntry[][] = [[F('new.txt', 1), F('mod.txt', 1), F('gone.txt', 1)], [F('new.txt', 1), F('mod.txt', 2)]]
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('clock.now', () => ({ value: (t += 10000) }))
  const exists = [false, true]
  on('fs.exists', () => ({ value: exists.shift() ?? true }))
  on('fs.list', () => ({ value: lists.shift() ?? [] }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Write', file_path: '/r/new.txt', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'edit mod.txt; rm gone.txt' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r')
  // A deleted row wraps its name in an outer Text; read the props of the one that carries the colour.
  const color = async (name: string) => (await ui.findAll({ type: 'Text', text: name })).map(e => e.props).find(p => p.color)
  expect((await color('new.txt'))?.color).toBe('#3FB950')
  expect((await color('mod.txt'))?.color).toBe('#1E90FF')
  expect((await color('gone.txt'))?.color).toBe('#E24B4A')
  expect((await color('gone.txt'))?.strikethrough).toBe(true)
  // Only openable rows get the invisible press overlay; a deleted file has none.
  expect(await ui.find({ type: 'Button', key: 'f:/r/new.txt' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'f:/r/gone.txt' })).toBe(undefined)
  await ui.unmount()
})

test('editing a file this session created flashes green (added), not blue', async ($, on) => {
  let t = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('clock.now', () => ({ value: (t += 10) }))
  const exists = [false, true, true, true]
  on('fs.exists', () => ({ value: exists.shift() ?? true }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Box', key: 'rd:/r' }))?.props.backgroundColor).toMatch(/^#3FB950/)
  await expand(ui, '/r')
  expect((await ui.find({ type: 'Box', key: 'rf:/r/a.ts' }))?.props.backgroundColor).toMatch(/^#3FB950/)
  await ui.unmount()
})

test('an empty ledger says so', async ($, on) => {
  engine(on, { exists: [], list: [] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /touched/ }))?.text).toBe('No files touched yet.')
  await ui.unmount()
})
