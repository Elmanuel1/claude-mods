export type RuleRepo = 'project' | 'personal'

export type EnforceStatus = 'exists' | 'new' | 'partial' | 'none'

/** The commit's "Enforce:" line: whether a static check catches the rule, and which. */
export type Enforcement = {
  status: EnforceStatus
  tool: string
  check: string
}

export type Rule = {
  /** repo + Rule-Id (subject on rules from before Rule-Id): survives the rebase that dropping another rule causes */
  key: string
  repo: RuleRepo
  sha: string
  title: string
  correction: string
  file: string
  /** null for commits without an Enforce line: skill triggers, and rules learned before it existed */
  enforce: Enforcement | null
}

export type Pending = {
  /** rules not yet accepted or rejected, project first */
  rules: Rule[]
  /** project commits on docs/learned-rules not yet on main */
  unpushed: number
}

/** What a press on the rules list asks for; `push` carries no rule key. */
export type RuleAction = 'accept' | 'reject' | 'correct' | 'diff' | 'enforce' | 'push'

/** What the rules list's surface module posts to the hooks module. */
export type RuleMessage = {
  action: RuleAction
  key: string
}

/** What the rules list draws from, the same on every surface. */
export type RulesView = {
  rules: Rule[]
  diff: { key: string; text: string } | null
  canPush: boolean
  isPushing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'learned-rules': {
      pending: Pending | null
      diff: { key: string; text: string } | null
      /** true from a Push press until its push, PR step and rescan have finished */
      isPushing: boolean
    }
  }
}
