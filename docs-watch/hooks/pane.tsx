import type { RenderElement } from 'claude-code'

import type { LogEntry, Missing, Tracked } from '../types'
import type { Kit } from './host'
import { docsBranch } from './git'
import { describeMissing } from './requirements'

export type PaneModel = {
  current: Tracked[]
  open: { key: string; text: string } | null
  log: LogEntry[]
  missing: Missing[]
}

export type PaneActions = {
  approve: (t: Tracked) => void
  approveAll: (items: Tracked[]) => void
  toggleDiff: (t: Tracked) => void
  dismiss: (t: Tracked) => void
  redo: (t: Tracked, note: string) => void
  openPr: (url: string) => void
  clearErrors: () => void
}

export function paneView(kit: Kit, m: PaneModel, act: PaneActions): RenderElement {
  const { Box, Button, Text } = kit
  const suggested = m.current.filter((t) => t.status === 'suggested')
  return (
    <Box flexDirection="column">
      {m.missing.length > 0 && setupList(kit, m.missing)}
      {m.current.length === 0 && <Text dimColor>No documentation updates waiting.</Text>}
      {suggested.length > 1 && <Button key="approve-all" label={`Approve all ${suggested.length}`} onPress={() => act.approveAll(suggested)} />}
      {m.current.map((t) => itemView(kit, t, m.open, act))}
      {m.log.length > 0 && errorList(kit, m.log, act)}
    </Box>
  )
}

function setupList(kit: Kit, missing: Missing[]): RenderElement {
  const { Box, Text } = kit
  return (
    <Box key="setup" flexDirection="column">
      <Text bold color="yellow">Setup needed</Text>
      {missing.map((m) => (
        <Text key={`setup-${m.id}`} color="yellow">
          {describeMissing(m)}
        </Text>
      ))}
    </Box>
  )
}

function errorList(kit: Kit, log: LogEntry[], act: PaneActions): RenderElement {
  const { Box, Button, Text } = kit
  return (
    <Box key="errors" flexDirection="column">
      <Text bold>Recent errors</Text>
      {log.map((entry) => (
        <Text key={`${entry.at}-${entry.where}`} color="red">
          {`${new Date(entry.at).toLocaleString()}  ${entry.where}${entry.key ? ` ${entry.key}` : ''}: ${entry.message}`}
        </Text>
      ))}
      <Button key="clear-log" label="Clear errors" onPress={act.clearErrors} />
    </Box>
  )
}

function statusLine(kit: Kit, t: Tracked, act: PaneActions): RenderElement | null {
  const { Box, Button, Text } = kit
  if (t.status === 'drafting' && t.pendingStart) {
    return <Text color="yellow">{`Waiting to start the draft: ${t.error ?? ''}`}</Text>
  }
  if (t.status === 'pushed') {
    return (
      <Box>
        <Text>{`Docs PR: ${t.prUrl ?? ''} `}</Text>
        <Button key={`open-${t.key}`} label="Open PR" onPress={() => act.openPr(t.prUrl ?? '')} />
      </Box>
    )
  }
  if (t.status === 'failed') {
    return <Text color="red">{`Failed: ${t.error ?? ''}`}</Text>
  }
  if (t.status !== 'approved') {
    return null
  }
  return t.error ? <Text color="red">{`Push failed: ${t.error}`}</Text> : <Text>{`Approved, pushing ${docsBranch(t)}…`}</Text>
}

function itemView(kit: Kit, t: Tracked, open: PaneModel['open'], act: PaneActions): RenderElement {
  const { Box, Button, Input, Markdown, Text } = kit
  const isOpen = open !== null && open.key === t.key
  return (
    <Box key={t.key} flexDirection="column">
      <Text bold>{t.docsTitle ?? `${t.key}: ${t.title ?? ''}`}</Text>
      {t.docsTitle && <Text dimColor>{`After ${t.key}: ${t.title ?? ''}`}</Text>}
      <Text dimColor>{t.summary ?? ''}</Text>
      {statusLine(kit, t, act)}
      {t.status === 'suggested' && (
        <Box>
          <Button key={`approve-${t.key}`} label="Approve" onPress={() => act.approve(t)} />
          <Button key={`diff-${t.key}`} label={isOpen ? 'Hide diff' : 'Diff'} onPress={() => act.toggleDiff(t)} />
          <Button key={`dismiss-${t.key}`} label="Dismiss" onPress={() => act.dismiss(t)} />
        </Box>
      )}
      {t.status === 'suggested' && Input && (
        <Input
          key={`note-${t.key}`}
          label="Redo with a note: "
          placeholder="e.g. also update the README"
          submitLabel="redo"
          onSubmit={(value: string) => act.redo(t, value)}
        />
      )}
      {t.status === 'failed' && <Button key={`clear-${t.key}`} label="Clear" onPress={() => act.dismiss(t)} />}
      {isOpen && open && <Markdown text={`\`\`\`diff\n${open.text}\n\`\`\``} />}
    </Box>
  )
}
