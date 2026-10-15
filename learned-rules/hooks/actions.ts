import type { Rule, RuleAction, RuleMessage } from '../types'
import type { Host } from './host'
import { markReviewed, reject, repoPath, ruleDiff } from './rules'
import { isEnforceable } from './rules-view'

export const ACTION_LABELS: Record<RuleAction, string> = {
  accept: 'Accept',
  reject: 'Reject',
  correct: 'Correct',
  diff: 'Diff',
  enforce: 'Enforce',
  push: 'Push',
}

const RULE_ACTIONS: readonly RuleAction[] = ['accept', 'reject', 'correct', 'diff', 'enforce']

// A Button's key is its address (`accept-<rule key>`, `pane-push`), the same on every redraw, so a press is
// read from the key the engine reports instead of from the closure of the tree it was drawn in.
export function pressedRule(element: string): RuleMessage | null {
  if (element === 'pane-push') {
    return { action: 'push', key: '' }
  }
  const dash = element.indexOf('-')
  const action = element.slice(0, dash) as RuleAction
  if (dash < 0 || !RULE_ACTIONS.includes(action)) {
    return null
  }
  return { action, key: element.slice(dash + 1) }
}

// The correction is applied in place: a fixup squashed into the rule's own commit keeps its subject, so the
// rule stays one entry to accept or reject.
export function correctionPrompt(io: Host, rule: Rule): string {
  const path = repoPath(io, rule.repo)
  return [
    `Correct the learned rule "${rule.title}" (${rule.file}, commit ${rule.sha.slice(0, 9)} in ${path}).`,
    `Edit the rule text in that file, then: git -C ${path} commit --fixup=${rule.sha} -- <file>;`,
    `GIT_SEQUENCE_EDITOR=true git -C ${path} rebase -i --autostash --autosquash ${rule.sha}^.`,
    'Correction: ',
  ].join(' ')
}

// The check is built in the session the person sends this from, so it is compiled, run and reviewed like any change.
export function enforcePrompt(rule: Rule): string {
  const enforce = rule.enforce
  const where = rule.repo === 'project' ? 'in this repo' : 'in ~/.claude (a hook or a permissions rule)'
  return [
    `Add a static check for the learned rule "${rule.title}" (${rule.file}) ${where}: ${enforce?.tool}, ${enforce?.check}.`,
    enforce?.status === 'partial' ? 'It covers part of the rule; say which part stays a review item.' : '',
    'Read that enforcer first and add the check the way it writes its others (rule name, message, how it records the',
    "violations that exist today, so only new ones fail), and show it fails on the rule's BAD example and passes on its",
    'GOOD one.',
  ].filter(part => part.length > 0).join(' ')
}

// What a press may change; register.tsx builds it from the engine's state.
export type RulesUi = {
  io: Host
  rule: (key: string) => Promise<Rule | undefined>
  /** Accept and reject drop the rule from the list before their git work; a failed reject comes back on refresh. */
  hide: (rule: Rule) => Promise<void>
  refresh: () => Promise<void>
  fill: (text: string) => Promise<void>
  diffKey: () => Promise<string | null>
  showDiff: (shown: { key: string; text: string } | null) => Promise<void>
  startPush: () => Promise<void>
}

// The rule is looked up when the press arrives, so a press never acts on a list from before a rescan.
export async function act(ui: RulesUi, { action, key }: RuleMessage): Promise<void> {
  if (action === 'push') {
    return ui.startPush()
  }
  const rule = await ui.rule(key)
  if (!rule) {
    return
  }
  switch (action) {
    case 'accept':
      await ui.hide(rule)
      await markReviewed(ui.io, rule.key, 'accepted')
      return ui.refresh()
    case 'reject':
      await ui.hide(rule)
      await reject(ui.io, rule)
      return ui.refresh()
    case 'correct':
      return ui.fill(correctionPrompt(ui.io, rule))
    case 'diff':
      return ui.showDiff((await ui.diffKey()) === rule.key ? null : { key: rule.key, text: await ruleDiff(ui.io, rule) })
    case 'enforce':
      return isEnforceable(rule) ? ui.fill(enforcePrompt(rule)) : undefined
  }
}
