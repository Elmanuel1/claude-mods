export type Status =
  | 'open'
  | 'drafting'
  | 'suggested'
  | 'applying'
  | 'resolving'
  | 'approved'
  | 'pushed'
  | 'merged'
  | 'approving'
  | 'pr-open'
  | 'failed'
  | 'skipped'
  | 'no-change'
  | 'dismissed'
  | 'closed'

export type Tracked = {
  key: string
  repo: string
  number: number
  status: Status
  title?: string
  url?: string
  checkout?: string
  work?: string
  startedAt?: number
  summary?: string
  diff?: string
  prUrl?: string
  error?: string
  /** the draft's commit, replayed onto the shared docs branch whenever it is rebuilt */
  commit?: string
  approvedAt?: number
  /** when the commit landed on the shared branch; a push covers what landed before it started */
  landedAt?: number
}

/** One repository's shared docs branch and the PR it is pushed to. */
export type BranchState = {
  pushing?: boolean
  pushStartedAt?: number
  prUrl?: string
  /** the base commit the branch was last built on, to notice main moving */
  baseSha?: string
  /** an approval arrived during a push; push again when it finishes */
  pushAgain?: boolean
  /** the last push finished; the line above the prompt offers its PR until hidden */
  announce?: boolean
  /** why the last push failed, offered with Retry until the next push */
  lastError?: string
}

declare module 'claude-code' {
  interface PluginState {
    'docs-watch': {
      shown: Tracked[] | null
      diff: { key: string; text: string } | null
      setup: string | null
      branches: Record<string, BranchState> | null
    }
  }
}
