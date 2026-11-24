import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'
import { clean, endOf, FADE, fmtMs, groupRuns, HOLD, isHot, lastEnded, programOf, pulse, RUN_COLOR, statusOf, tailOf } from './register'
import type { Run } from '../types'

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
// `call` answers each tool call (default `{ result: {} }`): a test scripts ok, failed, background or denied.
function engine(
  on: On,
  fs: { exists: boolean[]; list: FsEntry[][]; root?: string; lists?: { n: number }; call?: (e: any) => object },
) {
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
  on('tool.call', (_, e) => (fs.call ? fs.call(e) : { result: {} }) as any)
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

test('a change flashes only the row that shows it: the file, or its first collapsed parent', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/src/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const bg = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.backgroundColor
  // All collapsed: /r is the first visible parent, so it flashes (added = green).
  expect(await bg('rd:/r')).toMatch(/^#3FB950/)
  // /r open, /r/src collapsed: /r goes quiet, /r/src flashes.
  await expand(ui, '/r')
  expect(await bg('rd:/r')).toBe(undefined)
  expect(await bg('rd:/r/src')).toMatch(/^#3FB950/)
  // Everything open: only the file row flashes.
  await expand(ui, '/r/src')
  expect(await bg('rd:/r/src')).toBe(undefined)
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
  // Indent is drawn guide glyphs, not a Text of spaces the terminal drops.
  expect((await ui.find({ type: 'Text', text: '└─' }))?.text).toBe('└─')
  await ui.unmount()
})

test('on the terminal the guides follow the tree: ├─ for a sibling below, │ under it, └─ for the last', async ($, on) => {
  engine(on, { exists: [false, true, false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/x/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/r/y/b.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await expand(ui, '/r', '/r/x')
  // Rows: Files · └─ r · ├─ x · │ └─── a.ts · └─ y  (the tree hangs one level under the Files header)
  expect(await ui.findAll({ type: 'Text', text: '├─' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: '│' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: '└─' })).toHaveLength(3)
  expect(await ui.findAll({ type: 'Text', text: '──' })).toHaveLength(1)
  expect((await ui.find({ type: 'Button', key: 'd:/r/x' }))?.text).toBe('-')
  expect((await ui.find({ type: 'Button', key: 'd:/r/y' }))?.text).toBe('+')
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

test('a press outside the working directory grants the folder, then opens; never a root, never twice', async ($, on) => {
  const calls: string[] = []
  let declined = false
  let gate: Promise<void> = Promise.resolve()
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/r' }))
  let t = 0
  on('clock.now', () => ({ value: (t += 10000) }))
  let n = 0
  on('fs.exists', () => ({ value: n++ % 2 === 1 }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', async (_, e) => {
    calls.push(`${e.server}.${e.tool}:${e.args.path}`)
    if (e.tool === 'request_directory') await gate
    return { value: { content: [], isError: declined && e.tool === 'request_directory' } }
  })
  for (const f of ['/r/in.txt', '/tmp/o/a.txt', '/tmp/o/b.txt', '/tmp/o/sub/c.txt', '/top.txt'])
    await $.tool.call({ tool: 'Write', file_path: f, content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await expand(ui, '/r', '/tmp', '/tmp/o', '/tmp/o/sub')
  // A file directly under the filesystem root has no press target: granting `/` would grant the disk.
  expect(await ui.find({ type: 'Button', key: 'f:/top.txt' })).toBe(undefined)
  // A file inside the working directory needs no grant.
  await ui.press({ key: 'f:/r/in.txt' })
  expect(calls).toEqual(['ccd_view.show_pane:/r/in.txt'])
  calls.length = 0

  // A declined grant opens nothing, and the next press asks again.
  declined = true
  await ui.press({ key: 'f:/tmp/o/a.txt' })
  expect(calls).toEqual(['ccd_directory.request_directory:/tmp/o'])
  calls.length = 0
  declined = false

  // Two presses while the user is still deciding make one request.
  let release!: () => void
  gate = new Promise(r => (release = r))
  const first = ui.press({ key: 'f:/tmp/o/a.txt' })
  const second = ui.press({ key: 'f:/tmp/o/b.txt' })
  release()
  await Promise.all([first, second])
  // A folder below a granted one is covered.
  await ui.press({ key: 'f:/tmp/o/sub/c.txt' })
  expect(calls.filter(c => c.startsWith('ccd_directory'))).toEqual(['ccd_directory.request_directory:/tmp/o'])
  expect(calls.filter(c => c.startsWith('ccd_view')).sort()).toEqual([
    'ccd_view.show_pane:/tmp/o/a.txt',
    'ccd_view.show_pane:/tmp/o/b.txt',
    'ccd_view.show_pane:/tmp/o/sub/c.txt',
  ])
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

// ---- Files header and Runs section -----------------------------------------

const OK = (stdout = '') => ({ result: { stdout, stderr: '', interrupted: false }, text: stdout })
const FAIL = (text: string) => ({ result: text, text, isError: true as const })

test('the Files header counts the files, closes the tree, and flashes while closed', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:files' }))?.text).toMatch(/^\s*Files\s+1$/)
  await expand(ui, '/r')
  expect(await ui.find({ type: 'Button', key: 'f:/r/a.ts' })).toBeDefined()
  await ui.press({ key: 'sec:files' })
  expect(await ui.find({ type: 'Button', key: 'd:/r' })).toBe(undefined)
  expect((await ui.find({ type: 'Box', key: 'sh:files' }))?.props.backgroundColor).toMatch(/^#3FB950/)
  await ui.press({ key: 'sec:files' })
  // The folder the user opened stays open.
  expect(await ui.find({ type: 'Button', key: 'f:/r/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('an empty ledger still draws the Files header with a zero count', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK() })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:files' }))?.text).toMatch(/^\s*Files\s+0$/)
  expect((await ui.find({ type: 'Text', text: /touched/ }))?.text).toBe('No files touched yet.')
  expect((await ui.find({ type: 'Button', key: 'sec:runs' }))?.text).toMatch(/^\s*Runs\s+1$/)
  await ui.unmount()
})

test('a session with no command draws no Runs section', async ($, on) => {
  engine(on, { exists: [false, true], list: [] })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'sec:runs' })).toBe(undefined)
  await ui.unmount()
})

test('commands are logged, grouped by program, and a group opens to the full command lines', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK() })
  const multi = 'git commit -m "Draw it\n\nGroup runs."'
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: multi })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:runs' }))?.text).toMatch(/^\s*Runs\s+3$/)
  // Closed by default: no group row.
  expect(await ui.find({ type: 'Button', key: 'rg:git' })).toBe(undefined)
  await ui.press({ key: 'sec:runs' })
  expect((await ui.find({ type: 'Button', key: 'rg:git' }))?.text).toMatch(/^\s*git\s+2$/)
  expect((await ui.find({ type: 'Button', key: 'rg:npm' }))?.text).toMatch(/^\s*npm\s+1$/)
  // Every group starts closed.
  expect(await ui.find({ type: 'Text', text: 'git status' })).toBe(undefined)
  await ui.press({ key: 'rg:git' })
  expect((await ui.find({ type: 'Text', text: 'git status' }))?.text).toBe('git status')
  // The whole command, line breaks kept.
  expect((await ui.find({ type: 'Text', text: multi }))?.text).toBe(multi)
  await ui.press({ key: 'rg:git' })
  expect(await ui.find({ type: 'Text', text: 'git status' })).toBe(undefined)
  await ui.unmount()
})

test('a failed command counts in the header and marks its group; its output opens on a press', async ($, on) => {
  engine(on, {
    exists: [],
    list: [],
    call: e => (e.command === 'npm test' ? FAIL('FAIL a.test.ts\nExit code 1') : OK('fine')),
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:runs' }))?.text).toMatch(/^\s*Runs\s+2\s+·\s+1 failed$/)
  await ui.press({ key: 'sec:runs' })
  expect((await ui.find({ type: 'Button', key: 'rg:npm' }))?.text).toContain('✕')
  expect((await ui.find({ type: 'Button', key: 'rg:git' }))?.text).not.toContain('✕')
  await ui.press({ key: 'rg:npm' })
  expect(await ui.find({ type: 'Box', key: 'rt:0' })).toBe(undefined)
  await ui.press({ key: 'rr:0' })
  expect((await ui.find({ type: 'Text', text: /Exit code 1/ }))?.text).toContain('Exit code 1')
  await ui.press({ key: 'rr:0' })
  expect(await ui.find({ type: 'Box', key: 'rt:0' })).toBe(undefined)
  // `git status` returned output "fine" too, but that group is closed: nothing to press yet.
  await ui.unmount()
})

test('a run with no output has no press target', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK() })
  await $.tool.call({ tool: 'Bash', command: 'true' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:true' })
  expect((await ui.find({ type: 'Text', text: /^true$/ }))?.text).toBe('true')
  expect(await ui.find({ type: 'Button', key: 'rr:0' })).toBe(undefined)
  await ui.unmount()
})

test('background and Monitor runs show background; denied, command-less and non-command calls leave no run', async ($, on) => {
  engine(on, {
    exists: [false, true],
    list: [],
    call: e =>
      e.tool === 'Monitor'
        ? { result: { taskId: 't', timeoutMs: 0 }, text: 'started' }
        : e.command === 'blocked'
          ? { deny: 'no' }
          : e.command?.startsWith('sleep')
            ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: '' }
            : { result: {} },
  })
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f app.log' } as any)
  await $.tool.call({ tool: 'Monitor', ws: 'wss://example.test' } as any)
  await $.tool.call({ tool: 'Bash', command: 'blocked' })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:runs' }))?.text).toMatch(/^\s*Runs\s+2$/)
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:sleep' })
  await ui.press({ key: 'rg:tail' })
  // Each background run shows `background` where a duration would be.
  expect(await ui.findAll({ type: 'Text', text: 'background' })).toHaveLength(2)
  // `text` only says the call started: neither run has output to show, so neither takes a press.
  expect(await ui.find({ type: 'Button', key: 'rr:0' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'rr:1' })).toBe(undefined)
  await ui.unmount()
})

test('a command is cut at 2000 characters; an output keeps its last 1000', async ($, on) => {
  const long = 'echo ' + 'a'.repeat(2495)
  engine(on, { exists: [], list: [], call: () => OK('z'.repeat(4500) + 'LAST') })
  await $.tool.call({ tool: 'Bash', command: long })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:echo' })
  const cmd = (await ui.find({ type: 'Text', text: /^echo a+…$/ }))?.text as string
  expect(cmd).toHaveLength(2000)
  await ui.press({ key: 'rr:0' })
  const tail = (await ui.find({ type: 'Text', text: /^z+LAST$/ }))?.text as string
  expect(tail).toHaveLength(1000)
  await ui.unmount()
})

test('the log keeps the newest 100 runs', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK() })
  for (let i = 0; i <= 100; i++) await $.tool.call({ tool: 'Bash', command: `echo ${i}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:runs' }))?.text).toMatch(/^\s*Runs\s+100$/)
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:echo' })
  expect(await ui.find({ type: 'Text', text: 'echo 0' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^echo 1$/ }))?.text).toBe('echo 1')
  expect((await ui.find({ type: 'Text', text: /^echo 100$/ }))?.text).toBe('echo 100')
  await ui.unmount()
})

test('two calls that end together get two ids', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK() })
  await Promise.all([$.tool.call({ tool: 'Bash', command: 'alpha 1' }), $.tool.call({ tool: 'Bash', command: 'beta 2' })])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:alpha' })
  await ui.press({ key: 'rg:beta' })
  expect(await ui.find({ type: 'Box', key: 'rre:0' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'rre:1' })).toBeDefined()
  await ui.unmount()
})

test('a folder press keeps Runs open, and a section press keeps the folders open', async ($, on) => {
  // The Bash walk lists a.ts before and after, so the ledger keeps it.
  engine(on, { exists: [false, true], list: [[F('a.ts')], [F('a.ts')]], call: e => (e.tool === 'Write' ? { result: {} } : OK()) })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await expand(ui, '/r')
  expect(await ui.find({ type: 'Button', key: 'rg:git' })).toBeDefined()
  await ui.press({ key: 'sec:files' })
  await ui.press({ key: 'sec:files' })
  expect(await ui.find({ type: 'Button', key: 'f:/r/a.ts' })).toBeDefined()
  // Closing and opening Runs leaves the open folder alone.
  await ui.press({ key: 'sec:runs' })
  expect(await ui.find({ type: 'Button', key: 'rg:git' })).toBe(undefined)
  await ui.press({ key: 'sec:runs' })
  expect(await ui.find({ type: 'Button', key: 'rg:git' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'f:/r/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('on the terminal the Runs section has the same rows and presses', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK('out') })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:git' })
  expect((await ui.find({ type: 'Text', text: 'git status' }))?.text).toBe('git status')
  // The press on the mark shows the output, as on the desktop.
  expect(await ui.find({ type: 'Box', key: 'rt:0' })).toBe(undefined)
  await ui.press({ key: 'rr:0' })
  expect(await ui.find({ type: 'Box', key: 'rt:0' })).toBeDefined()
  await ui.unmount()
})

test('the command is plain Text on the desktop: the press sits on the mark, not on the command', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK('out') })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:git' })
  const cmd = await ui.find({ type: 'Text', text: /^git status$/ })
  expect(cmd?.props.mono).toBe(true)
  // The Button over the mark holds no command text.
  expect((await ui.find({ type: 'Button', key: 'rr:0' }))?.text?.includes('git')).toBe(false)
  await ui.unmount()
})

test('groups and runs draw newest first', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => OK() })
  await $.tool.call({ tool: 'Bash', command: 'git a' })
  await $.tool.call({ tool: 'Bash', command: 'npm b' })
  await $.tool.call({ tool: 'Bash', command: 'git c' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:git' })
  await ui.press({ key: 'rg:npm' })
  const keys = (await ui.findAll({ type: 'Box' }))
    .map(b => b.key as string | undefined)
    .filter(k => k?.startsWith('rgr:') || k?.startsWith('rre:'))
  expect(keys).toEqual(['rgr:git', 'rre:2', 'rre:0', 'rgr:npm', 'rre:1'])
  await ui.unmount()
})

test('a command the user rejects shows failed, with the reject text as output', async ($, on) => {
  engine(on, { exists: [], list: [], call: () => FAIL("The user doesn't want to proceed with this tool use.") })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'sec:runs' }))?.text).toMatch(/Runs\s+1\s+·\s+1 failed/)
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:rm' })
  await ui.press({ key: 'rr:0' })
  expect((await ui.find({ type: 'Text', text: /doesn't want to proceed/ }))?.text).toContain("doesn't want")
  await ui.unmount()
})

test('output is cleaned: no carriage returns, no hyperlink escapes', async ($, on) => {
  engine(on, {
    exists: [],
    list: [],
    call: e => (e.command === 'progress' ? OK('10%\r50%\r100%') : OK('\x1b]8;;https://x.test\x07link\x1b]8;;\x07')),
  })
  await $.tool.call({ tool: 'Bash', command: 'progress' })
  await $.tool.call({ tool: 'Bash', command: 'links' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:progress' })
  await ui.press({ key: 'rg:links' })
  await ui.press({ key: 'rr:0' })
  await ui.press({ key: 'rr:1' })
  expect((await ui.find({ type: 'Text', text: /^10%50%100%$/ }))?.text).toBe('10%50%100%')
  expect((await ui.find({ type: 'Text', text: /^link$/ }))?.text).toBe('link')
  await ui.unmount()
})

test('the untracked-Bash notice shows while the Files section is closed', async ($, on) => {
  // 20001 files in the root: the before-walk gives up, and the pane says Bash changes are not tracked.
  const many = Array.from({ length: 20001 }, (_, i) => F(`f${i}`))
  engine(on, { exists: [], list: [many], call: () => OK() })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /not tracked/ })).toBeDefined()
  await ui.press({ key: 'sec:files' })
  expect(await ui.find({ type: 'Text', text: /not tracked/ })).toBeDefined()
  await ui.unmount()
})

test('programOf skips directory prefixes, assignments and wrappers, and names the program', () => {
  expect(programOf('git status')).toBe('git')
  expect(programOf('CI=1 sudo npm test')).toBe('npm')
  expect(programOf('sudo -E npm test')).toBe('npm')
  expect(programOf('cd app && pnpm build')).toBe('pnpm')
  expect(programOf('cd app; env FOO=1 make')).toBe('make')
  expect(programOf('/usr/bin/git log')).toBe('git')
  expect(programOf('')).toBe('other')
  expect(programOf('   ')).toBe('other')
  expect(programOf('sudo')).toBe('other')
})

test('programOf: wrapper value flags, quoted paths and values, parentheses and comment lines', () => {
  expect(programOf('sudo -u root npm test')).toBe('npm')
  expect(programOf('nice -n 10 make')).toBe('make')
  expect(programOf('env -u HOME make')).toBe('make')
  expect(programOf('env -i X=1 make')).toBe('make')
  expect(programOf('time -p ls')).toBe('ls')
  expect(programOf('cd "my dir" && git status')).toBe('git')
  expect(programOf('FOO="a b" make')).toBe('make')
  expect(programOf('(cd app && make)')).toBe('make')
  expect(programOf('# build\nmake')).toBe('make')
})

test('clean drops escapes, OSC links and control characters; fmtMs never rounds up to 60s or goes negative', () => {
  expect(clean('10%\r50%\r100%')).toBe('10%50%100%')
  expect(clean('a\r\nb\tc')).toBe('a\nb\tc')
  expect(clean('\x1b]8;;https://x.test\x07link\x1b]8;;\x07')).toBe('link')
  expect(clean('\x1b[31mred\x1b[0m\x9b')).toBe('red')
  expect(fmtMs(59_950)).toBe('59.9s')
  expect(fmtMs(-5)).toBe('0.0s')
  expect(fmtMs(65_000)).toBe('1m 05s')
})

test('groupRuns sorts groups and runs newest first and reports the worst status', () => {
  const run = (id: number, command: string, at: number, status: Run['status'] = 'ok'): Run => ({
    id, tool: 'Bash', command, at, ms: 1, status,
  })
  const g = groupRuns([
    run(0, 'git status', 1),
    run(1, 'npm test', 2, 'failed'),
    run(2, 'git log', 3, 'background'),
    run(3, 'git push', 3, 'failed'),
  ])
  expect(g.map(x => x.name)).toEqual(['git', 'npm'])
  expect(g[0]!.runs.map(r => r.id)).toEqual([3, 2, 0])
  expect(g[0]!.worst).toBe('failed')
  expect(groupRuns([run(0, 'ls', 1)])[0]!.worst).toBe(undefined)
})

test('statusOf: abort beats error beats background beats interrupted; typed fields count only without an error', () => {
  expect(statusOf('Bash', { result: {} }, true)).toBe('interrupted')
  expect(statusOf('Bash', { isError: true, result: 'boom' }, false)).toBe('failed')
  expect(statusOf('Bash', { result: { backgroundTaskId: 'b' } }, false)).toBe('background')
  expect(statusOf('Monitor', { result: { taskId: 't' } }, false)).toBe('background')
  expect(statusOf('Bash', { result: { interrupted: true } }, false)).toBe('interrupted')
  expect(statusOf('Bash', { result: { stdout: 'x', interrupted: false } }, false)).toBe('ok')
})

test('tailOf takes the model-read text, strips escapes and control characters, keeps the last 1000', () => {
  expect(tailOf({ text: '\x1b[31mred\x1b[0m\x07 ok\n' })).toBe('red ok')
  expect(tailOf({ result: 'Exit code 2' })).toBe('Exit code 2')
  expect(tailOf({ text: '' })).toBe(undefined)
  expect(tailOf({ text: 'a'.repeat(1500) + 'END' })).toHaveLength(1000)
})

// ---- Run flash ---------------------------------------------------------------

// The flash tests run on a mock clock: it stands still until the test moves it, and `advance` fires the pane's
// redraw timer. Nothing else draws the pane, so a missing timer shows as a flash that never fades.
// `hold` makes a command wait until the test releases it: the mock clock moves only when the test advances it.
function clockWorld(on: On, call: (e: any) => object = () => OK(), hold: (e: any) => Promise<void> | undefined = () => undefined) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'footprint' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [] }))
  on('tool.call', async (_, e) => {
    await hold(e)
    return call(e) as any
  })
  return clock
}
const bgOf = (ui: { find: (q: any) => Promise<any> }, key: string) => async () =>
  (await ui.find({ type: 'Box', key }))?.props.backgroundColor as string | undefined

test('a run flashes the closed Runs header, then fades with no other event to draw it', async ($, on) => {
  const clock = clockWorld(on)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const header = bgOf(ui, 'sh:runs')
  expect(await header()).toMatch(/^#3FB950/)
  // Past the hold the flash is still on, and fainter.
  await clock.advance(HOLD + 50)
  const fading = await header()
  expect(fading).toMatch(/^#3FB950/)
  expect(fading).not.toBe('#3FB95099')
  // No press, no new event: the timer alone ends it.
  await clock.advance(FADE)
  expect(await header()).toBe(undefined)
  await ui.unmount()
})

test('a run flashes only the row that shows it: header, closed group, or entry', async ($, on) => {
  clockWorld(on)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Section closed: the header.
  expect(await bgOf(ui, 'sh:runs')()).toMatch(/^#3FB950/)
  // Section open, group closed: the group row, not the header.
  await ui.press({ key: 'sec:runs' })
  expect(await bgOf(ui, 'sh:runs')()).toBe(undefined)
  expect(await bgOf(ui, 'rgr:git')()).toMatch(/^#3FB950/)
  // Group open: the entry row, not the group row and not the header.
  await ui.press({ key: 'rg:git' })
  expect(await bgOf(ui, 'rgr:git')()).toBe(undefined)
  expect(await bgOf(ui, 'sh:runs')()).toBe(undefined)
  expect(await bgOf(ui, 'rrow:0')()).toMatch(/^#3FB950/)
  await ui.unmount()
})

test('the flash takes the color of the status: ok green, failed red, background and interrupted amber', async ($, on) => {
  clockWorld(on, e => {
    if (e.command === 'failc') return FAIL('boom')
    if (e.command === 'bgc') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b' }, text: '' }
    if (e.command === 'intc') return { result: { stdout: '', stderr: '', interrupted: true }, text: '' }
    return OK()
  })
  for (const command of ['okc', 'failc', 'bgc', 'intc'])
    await $.tool.call({ tool: 'Bash', command, ...(command === 'bgc' ? { run_in_background: true } : {}) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  for (const g of ['okc', 'failc', 'bgc', 'intc']) await ui.press({ key: 'rg:' + g })
  expect(await bgOf(ui, 'rrow:0')()).toMatch(/^#3FB950/)
  expect(await bgOf(ui, 'rrow:1')()).toMatch(/^#E24B4A/)
  expect(await bgOf(ui, 'rrow:2')()).toMatch(/^#D29922/)
  expect(await bgOf(ui, 'rrow:3')()).toMatch(/^#D29922/)
  await ui.unmount()
})

test('an older run does not flash, and a flash is over after 3 seconds', async ($, on) => {
  const clock = clockWorld(on)
  await $.tool.call({ tool: 'Bash', command: 'git a' })
  await clock.advance(10_000)
  await $.tool.call({ tool: 'Bash', command: 'git b' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:git' })
  expect(await bgOf(ui, 'rrow:0')()).toBe(undefined)
  expect(await bgOf(ui, 'rrow:1')()).toMatch(/^#3FB950/)
  await clock.advance(FADE)
  expect(await bgOf(ui, 'rrow:1')()).toBe(undefined)
  await ui.unmount()
})

test('a closed row flashes for the run that ended last', async ($, on) => {
  const clock = clockWorld(on, e => (e.command === 'badc' ? FAIL('boom') : OK()))
  await $.tool.call({ tool: 'Bash', command: 'goodc' })
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'badc' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await bgOf(ui, 'sh:runs')()).toMatch(/^#E24B4A/)
  await ui.unmount()
})

test('status-colored text is white and not dim while a row flashes at full strength', async ($, on) => {
  const clock = clockWorld(on, e => (e.command === 'badc' ? FAIL('boom') : OK()))
  await $.tool.call({ tool: 'Bash', command: 'goodc' })
  await $.tool.call({ tool: 'Bash', command: 'badc' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Closed header: its `1 failed` text.
  expect((await ui.find({ type: 'Text', text: /1 failed/ }))?.props.color).toBe('#FFFFFF')
  await ui.press({ key: 'sec:runs' })
  // Closed group `badc`: its worst-status mark.
  expect((await ui.find({ type: 'Text', text: /✕/ }))?.props.color).toBe('#FFFFFF')
  await ui.press({ key: 'rg:goodc' })
  // Open group `goodc`: the entry mark is white and not dim.
  const mark = await ui.find({ type: 'Text', text: /^●$/ })
  expect(mark?.props.color).toBe('#FFFFFF')
  expect(mark?.props.dimColor).toBeFalsy()
  // The command text keeps its own color.
  expect((await ui.find({ type: 'Text', text: /^goodc$/ }))?.props.color).toBeUndefined()
  // After the hold the text takes its own color again, and the ok mark is dim.
  await clock.advance(HOLD + 50)
  const later = await ui.find({ type: 'Text', text: /^●$/ })
  expect(later?.props.color).not.toBe('#FFFFFF')
  expect(later?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: /✕/ }))?.props.color).toBe('#E24B4A')
  await ui.unmount()
})

test('the flash covers the row of an entry and not its box or its output', async ($, on) => {
  clockWorld(on, () => OK('some output'))
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:git' })
  await ui.press({ key: 'rr:0' })
  expect(await ui.find({ type: 'Box', key: 'rt:0' })).toBeDefined()
  expect(await bgOf(ui, 'rrow:0')()).toMatch(/^#3FB950/)
  expect(await bgOf(ui, 'rre:0')()).toBe(undefined)
  expect(await bgOf(ui, 'rt:0')()).toBe(undefined)
  await ui.unmount()
})

test('on the terminal the same row flashes in the same color', async ($, on) => {
  clockWorld(on, e => (e.command === 'badc' ? FAIL('boom') : OK()))
  await $.tool.call({ tool: 'Bash', command: 'badc' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await bgOf(ui, 'sh:runs')()).toMatch(/^#E24B4A/)
  await ui.press({ key: 'sec:runs' })
  expect(await bgOf(ui, 'rgr:badc')()).toMatch(/^#E24B4A/)
  await ui.press({ key: 'rg:badc' })
  expect(await bgOf(ui, 'rrow:0')()).toMatch(/^#E24B4A/)
  await ui.unmount()
})

test('the row of an entry aligns its children to the start, so the mark sits on the first line', async ($, on) => {
  clockWorld(on)
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline --decorate --graph --max-count=5 --format="%h %an %ad %s"' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  await ui.press({ key: 'rg:git' })
  expect((await ui.find({ type: 'Box', key: 'rrow:0' }))?.props.alignItems).toBe('flex-start')
  await ui.unmount()
})

test('a closed group flashes for the run that ended last, not the one that started last', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(res => (release = res))
  const clock = clockWorld(on, e => (e.command === 'git slow' ? FAIL('boom') : OK()), e => (e.command === 'git slow' ? gate : undefined))
  // The slow run starts first and ends last; the quick one starts later and ends in between.
  const slow = $.tool.call({ tool: 'Bash', command: 'git slow' })
  await clock.advance(100)
  await $.tool.call({ tool: 'Bash', command: 'git quick' })
  await clock.advance(400)
  release()
  await slow
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sec:runs' })
  expect(await bgOf(ui, 'rgr:git')()).toMatch(/^#E24B4A/)
  await ui.unmount()
})

test('one timer at a time: a flash draws a bounded number of times, and none once it is over', async ($, on) => {
  const clock = clockWorld(on)
  let draws = 0
  on('ui.invalidate', (_, e, next) => {
    draws++
    return next(e)
  })
  // The pane is open while the commands run: each state write draws it again, and each draw could arm a timer.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The commands end at different times, so a timer armed for each would fall due at different times too.
  for (let i = 0; i < 5; i++) {
    await $.tool.call({ tool: 'Bash', command: `echo ${i}` })
    await clock.advance(30)
  }
  await clock.advance(FADE + 300)
  const during = draws
  // Ten a second for three seconds is about thirty; a timer chain for each run would be five times that.
  expect(during).toBeLessThan(80)
  await clock.advance(5000)
  expect(draws).toBe(during)
  await ui.unmount()
})

test('a timer that never fires is replaced by the next draw, so a later flash still fades', async ($, on) => {
  let t = 1_000_000
  let afters = 0
  let pending: { due: number; fire: () => void }[] = []
  on('clock.now', () => ({ value: t }))
  // The first timer is lost: a hook that refuses it, or a host that drops it, never runs its callback.
  on('clock.after', (_, e) => new Promise<any>(res => {
    afters++
    if (afters > 1) pending.push({ due: t + e.ms, fire: () => res({ value: undefined }) })
  }))
  on('command.register', () => ({ value: { command: 'footprint' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }) as any)
  await $.tool.call({ tool: 'Write', file_path: '/r/a.ts', content: 'x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const folder = bgOf(ui, 'rd:/r')
  expect(await folder()).toBeDefined()
  const step = async (ms: number) => {
    t += ms
    const due = pending.filter(p => p.due <= t)
    pending = pending.filter(p => p.due > t)
    due.forEach(p => p.fire())
    for (let i = 0; i < 200; i++) await Promise.resolve()
    await ui.find({ type: 'Box' })
  }
  // Ten seconds on, a second file changes: that draw must arm a new timer, though the first one never fired.
  t += 10_000
  await $.tool.call({ tool: 'Write', file_path: '/r/b.ts', content: 'x' })
  expect(await folder()).toBeDefined()
  for (let i = 0; i < 34; i++) await step(100)
  expect(await folder()).toBe(undefined)
  await ui.unmount()
})

test('pulse and isHot: the hold, the fade and the edges', () => {
  const at = 5000
  expect(pulse(at - 1, at, '#3FB950')).toBe(undefined)
  expect(pulse(at, at, '#3FB950')).toBe('#3FB95099')
  expect(pulse(at + HOLD - 1, at, '#3FB950')).toBe('#3FB95099')
  expect(pulse(at + HOLD, at, '#3FB950')).toBe('#3FB95099')
  expect(pulse(at + FADE - 1, at, '#3FB950')).toBe('#3FB95000')
  expect(pulse(at + FADE, at, '#3FB950')).toBe(undefined)
  expect(isHot(at - 1, at)).toBe(false)
  expect(isHot(at, at)).toBe(true)
  expect(isHot(at + HOLD - 1, at)).toBe(true)
  expect(isHot(at + HOLD, at)).toBe(false)
  expect(Object.values(RUN_COLOR).every(c => /^#[0-9A-F]{6}$/.test(c))).toBe(true)
})

test('lastEnded picks the run with the latest end, and the higher id on a tie', () => {
  const run = (id: number, at: number, ms: number): Run => ({ id, tool: 'Bash', command: 'x', at, ms, status: 'ok' })
  expect(lastEnded([])).toBe(undefined)
  expect(lastEnded([run(0, 10, 2), run(1, 4, 3)])?.id).toBe(0)
  // A run that started earlier but ended later is the last one.
  expect(lastEnded([run(0, 10, 2), run(1, 4, 20)])?.id).toBe(1)
  // Equal ends: the higher id.
  expect(lastEnded([run(0, 10, 5), run(1, 12, 3), run(2, 5, 10)])?.id).toBe(2)
  expect(endOf(run(0, 10, 5))).toBe(15)
})
