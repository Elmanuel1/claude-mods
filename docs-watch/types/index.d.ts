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
  base?: string
  startedAt?: number
  summary?: string
  diff?: string
  prUrl?: string
  error?: string
  agentId?: string
  pendingStart?: boolean
  note?: string
}

export type LogEntry = { at: number; where: string; message: string; key?: string }

declare module 'claude-code' {
  interface PluginState {
    'docs-watch': { shown: Tracked[] | null; diff: { key: string; text: string } | null; setup: string | null; errors: LogEntry[] | null }
  }
}
