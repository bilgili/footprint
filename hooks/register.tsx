import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderChildren } from 'claude-code'

import type { Change, Ledger, Mark, Obs, Observation, Via, View } from '../types'

const PANE = 'footprint'
const CAP = 20000
const BUDGET_MS = 5000
const SKIP = new Set([
  '.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv',
  '__pycache__', '.next', '.cache', '.turbo', '.idea', 'vendor', 'Pods', '.gradle', '.tox', 'coverage', 'DerivedData',
])

// Change the tag when a mark's fields change: it declines what an earlier
// version stored, which outlives a reload.
const ledger = atom({ plugin: 'footprint', key: 'ledger' } as const, { files: {} } as Ledger, {
  shape: 'ledger-2',
})
const view = atom({ plugin: 'footprint', key: 'view' } as const, { expanded: [] } as View, { shape: 'view-2' })

// ---- paths -----------------------------------------------------------------

const sepOf = (root: string) => (root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/')

/** The one owner of path form: native separator, upper drive letter, no `.`/`..`/dupes/trailing; UNC kept. */
function canon(path: string, sep: string): string {
  const win = sep === '\\'
  const unc = win && /^[\\/]{2}/.test(path)
  const segs = path.replace(win ? /[\\/]+/g : /\/+/g, sep).split(sep)
  const head = segs[0] ?? ''
  const out: string[] = []
  for (const s of segs.slice(1)) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return (unc ? sep : '') + (/^[a-z]:$/.test(head) ? head.toUpperCase() : head) + sep + out.join(sep)
}

const join = (dir: string, name: string, sep: string) => (dir.endsWith(sep) ? dir + name : dir + sep + name)
const parent = (path: string, sep: string) => path.slice(0, Math.max(path.lastIndexOf(sep), 1))
const under = (path: string, root: string, sep: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

// ---- ledger ----------------------------------------------------------------

const earlier = (a: Obs, b: Obs) => (a.at < b.at || (a.at === b.at && a.exists && !b.exists) ? a : b)
const later = (a: Obs, b: Obs) => (a.at > b.at || (a.at === b.at && a.exists && !b.exists) ? a : b)

const RANK: Record<Change, number> = { added: 0, modified: 1, deleted: 2 }

/** The one truth table: presence before and after → change (none when absent both times). */
const changeBetween = (b: boolean, a: boolean): Change | undefined =>
  !b && a ? 'added' : b && !a ? 'deleted' : b && a ? 'modified' : undefined

/** The newer of two change events; on a tie, deleted beats modified beats added. Used by merge and the pane. */
export const latest = (x: Mark['last'], y: Mark['last']): Mark['last'] =>
  !x ? y : !y ? x : y.at > x.at || (y.at === x.at && RANK[y.change] > RANK[x.change]) ? y : x

/** The change one observation saw, from its own two looks only (so merge stays a join). */
function changeOf(o: Observation): Mark['last'] {
  if (!o.via || !o.before) return undefined
  const change = changeBetween(o.before.exists, o.after.exists)
  // `seen` is when the source handed the batch over, so a slow walk still flashes on arrival.
  return change && { at: o.seen ?? o.after.at, change }
}

/** A join: commutative, associative, idempotent. Any record order gives one ledger. */
function merge(old: Mark | undefined, o: Observation): Mark {
  const pts = o.before ? [o.before, o.after] : [o.after]
  const base = pts.reduce(earlier, old?.base ?? pts[0]!)
  const cur = pts.reduce(later, old?.cur ?? pts[0]!)
  const vias = old?.vias ?? []
  const last = latest(old?.last, changeOf(o))
  return { base, cur, vias: o.via && !vias.includes(o.via) ? [...vias, o.via] : vias, ...(last ? { last } : {}) }
}

// The ledger's whole write API: record, setUntracked, clearUntracked. Nothing else writes it.
/** One batch is one update, so one redraw. */
function record($: Engine, batch: Observation[], sep: string) {
  if (batch.length === 0) return Promise.resolve()
  return update($, ledger, l => {
    const files = { ...l.files }
    for (const o of batch) {
      const key = canon(o.path, sep)
      files[key] = merge(files[key], o)
    }
    return { ...l, files }
  })
}
/** Set the Bash-tracking notice. Only `cap` for the same root stops later walks; `time` is per call. */
const setUntracked = ($: Engine, u: NonNullable<Ledger['bashUntracked']>) =>
  update($, ledger, l => ({ ...l, bashUntracked: u }))
/** Clear the notice after a good walk, only when it belongs to that root (checked inside the update: no race). */
const clearUntracked = ($: Engine, root: string) =>
  update($, ledger, l => {
    if (l.bashUntracked?.root !== root) return l
    const { bashUntracked: _, ...rest } = l
    return rest
  })

export type Status = Change | 'transient'
export const status = (m: Mark): Status => changeBetween(m.base.exists, m.cur.exists) ?? 'transient'

// ---- bash snapshot ---------------------------------------------------------

type Snap = {
  files: Map<string, { sig: string; at: number }>
  /** Folders listed with success, and when. */
  dirAt: Map<string, number>
  /** Every non-file entry a listing returned (folders, SKIP folders, links), by kind: it exists, listed or not. */
  seen: Map<string, 'dir' | 'other'>
  end: number
  capped?: 'cap' | 'time'
}

const WIDTH = 16

async function snapshot($: Engine, root: string, sep: string): Promise<Snap> {
  const t0 = await $.clock.now()
  const p0 = performance.now()
  const now = () => t0 + performance.now() - p0
  const snap: Snap = { files: new Map(), dirAt: new Map(), seen: new Map(), end: t0 }
  // ponytail: counting semaphore caps list calls in flight; a queue if the fan-out ever matters.
  let active = 0
  const waiters: (() => void)[] = []
  const acquire = () => (active < WIDTH ? (active++, Promise.resolve()) : new Promise<void>(r => waiters.push(() => (active++, r()))))
  const release = () => (active--, waiters.shift()?.())
  const walk = async (dir: string): Promise<void> => {
    if (snap.capped) return
    if (now() - t0 > BUDGET_MS) {
      snap.capped = 'time'
      return
    }
    await acquire()
    let entries: Awaited<ReturnType<typeof $.fs.list>> | undefined
    try {
      entries = await $.fs.list(dir).catch(() => undefined)
    } finally {
      release()
    }
    if (entries === undefined) return
    const at = now()
    snap.dirAt.set(dir, at)
    const subs: string[] = []
    for (const en of entries) {
      const p = join(dir, en.name, sep)
      if (en.kind !== 'file') snap.seen.set(p, en.kind)
      if (en.kind === 'dir') {
        if (!SKIP.has(en.name)) subs.push(p)
      } else if (en.kind === 'file') {
        snap.files.set(p, { sig: `${en.size}:${en.mtimeMs}`, at })
        if (snap.files.size > CAP) {
          snap.capped = 'cap'
          return
        }
      }
    }
    await Promise.all(subs.map(walk))
  }
  await walk(root)
  snap.end = now()
  return snap
}

/**
 * What one walk knew about a file path: present (with its signature), absent, or nothing (blind).
 * Absent needs a listed ancestor whose listing lacked the next step down: a folder that did not
 * exist then (`mkdir -p`, `rm -rf`). A step the listing did return but the walk never listed
 * (SKIP, a link, a failed list) is blind: absence is never inferred there.
 */
function look(snap: Snap, path: string, root: string, sep: string): (Obs & { sig?: string }) | undefined {
  const f = snap.files.get(path)
  if (f) return { exists: true, at: f.at, sig: f.sig }
  let child = path
  let dir = parent(path, sep)
  for (;;) {
    const at = snap.dirAt.get(dir)
    if (at !== undefined) {
      const kind = snap.seen.get(child)
      // The path itself is now a folder: the file is gone. A link, or a folder above it, is blind.
      if (kind === 'dir' && child === path) return { exists: false, at }
      return kind ? undefined : { exists: false, at }
    }
    if (dir === child || !under(dir, root, sep) || dir === root) return undefined
    child = dir
    dir = parent(dir, sep)
  }
}

/**
 * One observation per path the two walks differ on, plus one per ledger path under root.
 * `via: 'bash'` only when both walks knew the path and saw it differ. A side a walk was blind to
 * is stat'ed now (after) or left out (before): it is never guessed.
 */
async function diff($: Engine, before: Snap, after: Snap, known: string[], root: string, sep: string): Promise<Observation[]> {
  const knownSet = new Set(known.filter(p => under(p, root, sep)))
  const paths = new Set([...before.files.keys(), ...after.files.keys(), ...knownSet])
  const out: Observation[] = []
  for (const path of paths) {
    const b = look(before, path, root, sep)
    let a = look(after, path, root, sep)
    const changed = !!b && !!a && (b.exists !== a.exists || b.sig !== a.sig)
    if (!changed && !knownSet.has(path)) continue
    if (!a) a = { exists: await $.fs.exists(path), at: await $.clock.now() }
    out.push({
      path,
      ...(b ? { before: { exists: b.exists, at: b.at } } : {}),
      after: { exists: a.exists, at: a.at },
      ...(changed ? { via: 'bash' as Via } : {}),
    })
  }
  const seen = await $.clock.now()
  return out.map(o => (o.via ? { ...o, seen } : o))
}

// ---- hooks -----------------------------------------------------------------

export const register: Register = on => {
  /** Folders outside the working directory that the user already granted to the session. */
  const granted = new Set<string>()
  /** Grant requests the user has not answered yet, by folder. */
  const asking = new Map<string, Promise<boolean>>()
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'footprint', description: 'Show the files this session touched' })
    // The terminal opens a pane inline on its main screen; there /footprint opens it on demand.
    if (e.surface !== 'terminal') void $.ui.open({ id: PANE, title: 'Footprint' })
    return next(e)
  })

  on('command.run', { command: 'footprint' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Footprint' })
    return { text: 'Footprint pane opened.' }
  })

  // Tool source: Write, Edit, NotebookEdit. Look before and after, record both.
  on('tool.call', async ($, e, next) => {
    const path =
      e.tool === 'Write' || e.tool === 'Edit' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
    if (path === undefined) return next(e)
    const sep = sepOf(await $.session.cwd())
    const before: Obs = { exists: await $.fs.exists(path), at: await $.clock.now() }
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const after: Obs = { exists: await $.fs.exists(path), at: await $.clock.now() }
      await record($, [{ path, before, after, via: 'tool' }], sep)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Bash source: snapshot the root around the call, record the difference.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background) return next(e)
    const root0 = await $.session.cwd()
    const sep = sepOf(root0)
    const root = canon(root0, sep)
    const off = (await read($, ledger)).bashUntracked
    if (off?.reason === 'cap' && off.root === root) return next(e)
    const before = await snapshot($, root, sep)
    if (before.capped) {
      await setUntracked($, { at: before.end, reason: before.capped, root })
      return next(e)
    }
    const settle = async () => {
      const after = await snapshot($, root, sep)
      if (after.capped) {
        await setUntracked($, { at: after.end, reason: after.capped, root })
        return
      }
      const known = Object.keys((await read($, ledger)).files)
      await record($, await diff($, before, after, known, root, sep), sep)
      await clearUntracked($, root)
    }
    try {
      return await next(e)
    } finally {
      await settle()
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Svg draws real guide lines; the terminal has no Svg and gets glyph guides. Test the surface, not
    // `'Svg' in els`: the terminal's table answers an unknown element too, as a fragment that draws nothing.
    const Svg = ['desktop', 'vscode', 'mobile'].includes(e.surface) && 'Svg' in els ? els.Svg : undefined
    const l = await read($, ledger)
    const expanded = new Set((await read($, view)).expanded)
    const cwd0 = await $.session.cwd()
    const sep = sepOf(cwd0)
    const cwd = canon(cwd0, sep)
    const now = await $.clock.now()

    type File = { name: string; path: string; mark: Mark; st: Change }
    type Node = { dirs: Map<string, Node>; files: File[]; path: string; last?: Mark['last']; count: number }
    const node = (path: string): Node => ({ dirs: new Map(), files: [], path, count: 0 })
    // The tree starts at the filesystem root: '' on POSIX (its children are `Users`, ...), `C:` on Windows.
    const tree = node('')
    for (const [path, mark] of Object.entries(l.files)) {
      const st = status(mark)
      if (st === 'transient') continue
      // The flash keeps the event's time but takes the file's session status as its colour.
      const ev: Mark['last'] = mark.last && { at: mark.last.at, change: st }
      const segs = path.split(sep)
      const name = segs.pop()!
      let n = tree
      n.count++
      n.last = latest(n.last, ev)
      segs.forEach((s, i) => {
        if (s === '') return
        const p = segs.slice(0, i + 1).join(sep)
        let d = n.dirs.get(s)
        if (!d) n.dirs.set(s, (d = node(p)))
        n = d
        n.count++
        n.last = latest(n.last, ev)
      })
      n.files.push({ name, path, mark, st })
    }

    // Flash: full color for HOLD ms, then fade to nothing by FADE ms.
    const HOLD = 750
    const FADE = 3000
    // The status is the name's colour (no glyphs): green added, blue modified, red struck-through deleted.
    const COLOR: Record<Change, string> = { added: '#3FB950', modified: '#1E90FF', deleted: '#E24B4A' }
    let flashing = false
    const flash = (last: Mark['last']) => {
      const age = last ? now - last.at : FADE
      if (age >= FADE || age < 0) return undefined
      flashing = true
      const a = age < HOLD ? 0.6 : 0.6 * (1 - (age - HOLD) / (FADE - HOLD))
      return COLOR[last!.change] + Math.round(a * 255).toString(16).padStart(2, '0')
    }

    const toggle = (dir: string) =>
      void update($, view, v => ({
        expanded: v.expanded.includes(dir) ? v.expanded.filter(d => d !== dir) : [...v.expanded, dir],
      }))
    // The file pane opens only paths inside the session's folders. A file outside the working directory
    // first gets its folder granted (the user approves the request); a grant covers the folders below it.
    const open = (path: string) =>
      void (async () => {
        if (!under(path, cwd, sep) && ![...granted].some(g => under(path, g, sep))) {
          const dir = parent(path, sep)
          // One request per folder at a time: a second press while the user decides joins the first.
          let ask = asking.get(dir)
          if (!ask) {
            // A declined request comes back as isError, not a throw: nothing opens, and the next press asks again.
            ask = $.mcp.call('ccd_directory', 'request_directory', { path: dir })
              .then(r => !r.isError)
              .finally(() => asking.delete(dir))
            asking.set(dir, ask)
          }
          if (!(await ask)) return
          granted.add(dir)
        }
        // A grant the app no longer honours (revoked) fails here: forget them all and ask again next press.
        if ((await $.mcp.call('ccd_view', 'show_pane', { pane: 'file', path })).isError) granted.clear()
      })().catch(() => undefined)

    // One row's guide lines: `more[i]` says whether the ancestor at depth i+1 has a sibling below it.
    const STEP = 18
    const H = 22
    const guides = (more: boolean[], isLast: boolean, dir?: { open: boolean }) => {
      const d = more.length
      const x = (i: number) => STEP * i + 7
      const w = x(d) + 8
      const stroke = 'stroke="#888780" stroke-opacity="0.7" stroke-width="1"'
      let s = ''
      more.forEach((m, i) => {
        if (i > 0 && m) s += `<line x1="${x(i - 1)}" y1="0" x2="${x(i - 1)}" y2="${H}" ${stroke}/>`
      })
      if (d > 0) {
        s += `<line x1="${x(d - 1)}" y1="0" x2="${x(d - 1)}" y2="${isLast ? H / 2 : H}" ${stroke}/>`
        s += `<line x1="${x(d - 1)}" y1="${H / 2}" x2="${dir ? x(d) - 5 : x(d) + 4}" y2="${H / 2}" ${stroke}/>`
      }
      if (dir) {
        // One drawing for both states, so + and - boxes are the same size (glyphs fell back to different fonts).
        const c = x(d)
        const m = H / 2
        s += `<rect x="${c - 5}" y="${m - 5}" width="10" height="10" rx="2" fill="none" stroke="#888780" stroke-width="1"/>`
        s += `<line x1="${c - 3}" y1="${m}" x2="${c + 3}" y2="${m}" stroke="#888780" stroke-width="1.2"/>`
        if (!dir.open) s += `<line x1="${c}" y1="${m - 3}" x2="${c}" y2="${m + 3}" stroke="#888780" stroke-width="1.2"/>`
      }
      return { w, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">${s}</svg>` }
    }
    // The desktop paints an Svg only with an explicit width: without one its slot in a row Box is zero.
    // An Svg takes no press, so a folder's drawn box gets an invisible plain Button laid over it:
    // an absolute Box anchored to the Svg's right edge (where the box is), holding one em space.
    const lead = (more: boolean[], isLast: boolean, dir?: { open: boolean; path: string }) => {
      if (!Svg) {
        // The terminal drops a Text of spaces alone, so indent is fixed-width Boxes holding the same
        // guide lines as the Svg: column j carries `│` when more[j + 1], the last column the branch.
        const d = more.length
        const cell = (k: string, glyph?: string) => (
          <Box key={k} width={2} flexShrink={0}>
            {glyph && <Text dimColor>{glyph}</Text>}
          </Box>
        )
        return (
          <Box flexDirection="row">
            {more.slice(1).map((m, j) => cell('g' + j, m ? '│' : undefined))}
            {d > 0 && cell('b', isLast ? '└─' : '├─')}
            {/* A file's branch runs on where a folder's +/- sits, so file and folder names line up. */}
            {!dir && cell('f', d > 0 ? '──' : undefined)}
            {dir && <Button plain key={'d:' + dir.path} onPress={() => toggle(dir.path)}>{dir.open ? '-' : '+'}</Button>}
          </Box>
        )
      }
      const g = guides(more, isLast, dir)
      // alt must be non-empty: the desktop drops an Svg whose alt is blank.
      const alt = dir ? (dir.open ? 'collapse folder' : 'expand folder') : 'tree branch'
      const svg = <Svg source={g.svg} alt={alt} width={g.w} height={H} />
      if (!dir) return svg
      return (
        <Box position="relative">
          {svg}
          <Box position="absolute" top={0} right={0}>
            <Button plain key={'d:' + dir.path} onPress={() => toggle(dir.path)}>{'\u2003'}</Button>
          </Box>
        </Box>
      )
    }

    // A long name is cut in the middle, never wrapped: a wrapped row breaks the fixed-height guide lines.
    // The lines never shrink; only the name does.
    const fixed = (child: RenderChildren) => <Box flexShrink={0}>{child}</Box>
    const MAX_ROWS = 300

    const rows = (n: Node, more: boolean[]): RenderChildren[] => {
      const dirs = [...n.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
      const files = [...n.files].sort((a, b) => a.name.localeCompare(b.name))
      // ponytail: a flat cap per folder keeps a huge checkout from drawing thousands of rows; paging if anyone needs them.
      const items = [...dirs.map(d => ({ d })), ...files.map(f => ({ f }))]
      const shown = items.slice(0, MAX_ROWS)
      const hidden = items.length - shown.length
      const count = shown.length + (hidden > 0 ? 1 : 0)
      let i = 0
      const out: RenderChildren[] = shown.flatMap(it => {
        const isLast = ++i === count
        if ('d' in it) {
          const [name, d] = it.d!
          const isOpen = expanded.has(d.path)
          // Only the row that shows a change flashes: an open folder's children are on screen, so it stays quiet;
          // a collapsed folder is the first visible parent of what changed below it.
          const row = (
            <Box key={'rd:' + d.path} flexDirection="row" overflow="hidden" backgroundColor={isOpen ? undefined : flash(d.last)}>
              {fixed(lead(more, isLast, { open: isOpen, path: d.path }))}
              <Box flexShrink={1} minWidth={0}>
                <Button plain key={'n:' + d.path} onPress={() => toggle(d.path)}>
                  <Text wrap="truncate-middle"> {name}</Text>
                  <Text dimColor> {d.count}</Text>
                </Button>
              </Box>
            </Box>
          )
          return isOpen ? [row, ...rows(d, [...more, !isLast])] : [row]
        }
        const f = it.f!
        // White only while the flash is at full strength (a same-hue name is unreadable on it); once the
        // fade starts the status colour returns, so a light theme never shows white on a near-white row.
        const bg = flash(f.mark.last && { at: f.mark.last.at, change: f.st })
        const hot = !!f.mark.last && now - f.mark.last.at >= 0 && now - f.mark.last.at < HOLD
        const label = (
          <Text wrap="truncate-middle" color={hot ? '#FFFFFF' : COLOR[f.st]} strikethrough={f.st === 'deleted'}>
            {f.name}
          </Text>
        )
        // ccd_view opens files only on the desktop; `open` grants a folder outside the working directory first,
        // but never a filesystem root (`/`, `C:`): one approval there would hand over the whole disk.
        const dir = parent(f.path, sep)
        const canOpen =
          e.surface === 'desktop' && f.st !== 'deleted' && (under(f.path, cwd, sep) || !(dir === sep || /^[A-Za-z]:$/.test(dir)))
        return [
          <Box key={'rf:' + f.path} flexDirection="row" overflow="hidden" backgroundColor={bg}>
            {fixed(lead(more, isLast))}
            {/* The desktop flattens a Button's children into a plain label, so the coloured name is a Text
                and an invisible plain Button (one figure space per character) lies over it to take the press. */}
            <Box flexShrink={1} minWidth={0} position="relative" overflow="hidden">
              {label}
              {canOpen && (
                <Box position="absolute" top={0} left={0}>
                  <Button plain key={'f:' + f.path} onPress={() => open(f.path)}>{'\u2007'.repeat(f.name.length)}</Button>
                </Box>
              )}
            </Box>
          </Box>,
        ]
      })
      if (hidden > 0) {
        // The "… more" row stands in for the rows it hides, so it shows (flashes) their newest change.
        const last = items.slice(MAX_ROWS).reduce<Mark['last']>(
          (acc, it) =>
            latest(acc, 'd' in it ? it.d![1].last : it.f!.mark.last && { at: it.f!.mark.last.at, change: it.f!.st }),
          undefined,
        )
        out.push(
          <Box key={'rm:' + n.path} flexDirection="row" backgroundColor={flash(last)}>
            {fixed(lead(more, true))}
            <Text dimColor> … {hidden} more</Text>
          </Box>,
        )
      }
      return out
    }

    const body = tree.count === 0 ? <Text dimColor>No files touched yet.</Text> : rows(tree, [])
    // ponytail: the fade is redraws on a timer (ten a second at most); a Client module if it ever looks choppy.
    if (flashing) $.clock.after(100, () => $.ui.invalidate('ui.render'))

    return (
      <Box flexDirection="column">
        {/* The pane's own title already says Footprint; the row keeps only the count. */}
        <Text dimColor>{tree.count} file{tree.count === 1 ? '' : 's'}</Text>
        {l.bashUntracked && (
          <Text color="warning">
            Bash changes not tracked: {l.bashUntracked.reason === 'cap' ? `tree over ${CAP} files` : 'walk over time budget'}
          </Text>
        )}
        {body}
      </Box>
    )
  })
}
