export type Status =
  | 'open'
  | 'drafting'
  | 'suggested'
  | 'applying'
  | 'resolving'
  | 'approved'
  | 'pushed'
  | 'merged'
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
  base?: string
  startedAt?: number
  summary?: string
  /** the docs commit subject the writer chose, e.g. `docs: document failing the build on removed APIs` */
  docsTitle?: string
  diff?: string
  prUrl?: string
  error?: string
  /** the subagent drafting the update or resolving its conflict */
  agentId?: string
  /** the engine refused to start that subagent; the next turn, `/docs-watch` or session start tries again */
  pendingStart?: boolean
  /** the person's note for a redraft still waiting to start */
  note?: string
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

export type LogEntry = { at: number; where: string; message: string; key?: string }

/** A tool the mod needs that is missing, or a login it needs that does not work, with the step that fixes it. */
export type Missing = {
  id: string
  /** a failed command of this tool brings the popup back */
  tool: 'git' | 'gh' | 'claude'
  what: string
  fix: string
  /** nothing polls or drafts until it is fixed */
  blocks: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'docs-watch': {
      shown: Tracked[] | null
      diff: { key: string; text: string } | null
      setup: Missing[] | null
      errors: LogEntry[] | null
      branches: Record<string, BranchState> | null
      /** when each requirement's popup last showed in this session */
      popups: Record<string, number> | null
    }
  }
}
