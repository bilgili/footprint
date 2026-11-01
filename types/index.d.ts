export type Via = 'tool' | 'bash' | 'os'

/** One look at one path: was it there, and when did we look. */
export type Obs = { exists: boolean; at: number }

export type Change = 'added' | 'modified' | 'deleted'

/**
 * Earliest look (the session baseline), latest look, who saw a change, and the
 * latest change event (what one source saw happen in one call), for the pane's flash.
 */
export type Mark = { base: Obs; cur: Obs; vias: Via[]; last?: { at: number; change: Change } }

export type Ledger = {
  /** Key: canonical absolute path. */
  files: Record<string, Mark>
  /** Set when a Bash walk gave up; the pane shows it. `cap` stops later walks under `root`; `time` clears on the next good walk. */
  bashUntracked?: { at: number; reason: 'cap' | 'time'; root: string }
}

/** What a source hands to record(): before is absent when the source had no earlier look. */
export type Observation = {
  path: string
  before?: Obs
  after: Obs
  via?: Via
  /** When the source handed the batch over; the flash time for a slow walk. */
  seen?: number
}

/** Pane state: folders the user opened, as canonical paths. Every other folder is collapsed. */
export type View = { expanded: string[] }

declare module 'claude-code' {
  interface PluginState {
    footprint: { ledger: Shaped<Ledger>; view: Shaped<View> }
  }
}
