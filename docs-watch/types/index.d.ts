export type Status =
  | 'open'
  | 'drafting'
  | 'suggested'
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
}

/** One repository's shared docs branch and the PR it is pushed to. */
export type BranchState = {
  pushing?: boolean
  pushStartedAt?: number
  prUrl?: string
  /** the base commit the branch was last built on, to notice main moving */
  baseSha?: string
}

declare module 'claude-code' {
  interface PluginState {
    'docs-watch': { shown: Tracked[] | null; diff: { key: string; text: string } | null; setup: string | null }
  }
}
