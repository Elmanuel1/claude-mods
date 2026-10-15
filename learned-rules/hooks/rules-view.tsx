import type { ClientElements } from 'claude-code'

import type { Rule, RuleAction, RulesView } from '../types'

type Tags = Pick<ClientElements, 'Box' | 'Button' | 'Markdown' | 'Text'>

// A rule an existing check already covers, or that no tool can see, has nothing to build.
export const isEnforceable = (rule: Rule) => rule.enforce?.status === 'new' || rule.enforce?.status === 'partial'

// Drawn by the Client's surface module where the surface has one, and by the pane hook itself elsewhere.
export function rulesView({ Box, Button, Markdown, Text }: Tags, view: RulesView, onAction: (action: RuleAction, key: string) => void) {
  return (
    <Box flexDirection="column">
      {view.rules.map(rule => (
        <Box key={rule.key} flexDirection="column">
          <Text bold>
            {rule.title} ({rule.repo === 'project' ? 'repo' : 'personal'})
          </Text>
          {rule.correction && <Text dimColor>From: {rule.correction}</Text>}
          {rule.file && <Text dimColor>File: {rule.file}</Text>}
          {rule.enforce && (
            <Text dimColor>
              Enforce: {rule.enforce.status}
              {rule.enforce.tool !== '-' && ` · ${rule.enforce.tool}`}
              {rule.enforce.check && `: ${rule.enforce.check}`}
            </Text>
          )}
          <Box gap={1}>
            <Button key={`accept-${rule.key}`} label="Accept" onPress={() => onAction('accept', rule.key)} />
            <Button key={`reject-${rule.key}`} label="Reject" onPress={() => onAction('reject', rule.key)} />
            <Button key={`correct-${rule.key}`} label="Correct" onPress={() => onAction('correct', rule.key)} />
            <Button
              key={`diff-${rule.key}`}
              label={view.diff?.key === rule.key ? 'Hide diff' : 'Diff'}
              onPress={() => onAction('diff', rule.key)}
            />
            {isEnforceable(rule) && <Button key={`enforce-${rule.key}`} label="Enforce" onPress={() => onAction('enforce', rule.key)} />}
          </Box>
          {view.diff?.key === rule.key && <Markdown text={`\`\`\`diff\n${view.diff.text}\n\`\`\``} />}
        </Box>
      ))}
      {view.canPush && view.isPushing && <Text dimColor>Pushing accepted rules and opening the PR…</Text>}
      {view.canPush && !view.isPushing && <Button key="pane-push" label="Push accepted rules and open the PR" onPress={() => onAction('push', '')} />}
    </Box>
  )
}

// The line above the prompt; its Review press answers in the hooks module, by key.
export function bandView({ Box, Button, Text }: Pick<Tags, 'Box' | 'Button' | 'Text'>, toReview: number) {
  return (
    <Box>
      <Text>{toReview > 0 ? `${toReview} learned rule(s) to review ` : 'Pushing learned rules… '}</Text>
      {toReview > 0 && <Button key="review" label="Review" onPress={() => {}} />}
    </Box>
  )
}

export const hasRows = (view: RulesView) => view.rules.length > 0 || view.canPush

// The pane where the hooks module draws it itself: every surface but the terminal, and the empty list.
export function paneView(tags: Tags, view: RulesView) {
  return hasRows(view) ? rulesView(tags, view, () => {}) : <tags.Text dimColor>No learned rules to review.</tags.Text>
}
