export type Status =
  | 'open'
  | 'drafting'
  | 'suggested'
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
}

declare module 'claude-code' {
  interface PluginState {
    'docs-watch': { shown: Tracked[] | null; diff: { key: string; text: string } | null; setup: string | null }
  }
}
