import type { RenderElement } from 'claude-code'

import type { BranchState, Missing } from '../types'
import type { Kit } from './host'
import { describeMissing } from './requirements'

export type BandModel = {
  blocked: Missing[]
  waiting: number
  failedUpdates: number
  announced: [string, BranchState][]
  failed: [string, BranchState][]
  pushing: boolean
}

export type BandActions = {
  recheck: () => void
  review: () => void
  openPr: (url: string) => void
  hide: () => void
  retry: () => void
}

export const bandIsEmpty = (m: BandModel) =>
  m.blocked.length === 0 && m.waiting === 0 && m.failedUpdates === 0 && m.announced.length === 0 && m.failed.length === 0 && !m.pushing

export function bandView(kit: Kit, m: BandModel, act: BandActions): RenderElement {
  const { Box, Button, Text } = kit
  if (m.blocked.length > 0) {
    return (
      <Box>
        <Text color="yellow">{`docs-watch: ${m.blocked.map(describeMissing).join('. ')}. Then press Check again. `}</Text>
        <Button key="recheck" label="Check again" onPress={act.recheck} />
      </Box>
    )
  }
  const parts = [
    m.waiting > 0 ? `${m.waiting} docs update(s) suggested` : '',
    m.failedUpdates > 0 ? `${m.failedUpdates} docs update(s) failed` : '',
    m.pushing ? 'Pushing docs updates…' : '',
    m.announced.length > 0 ? 'Docs PR updated' : '',
    m.failed[0] ? `Docs push failed: ${m.failed[0][1].lastError}` : '',
  ]
  return (
    <Box>
      <Text>{`${parts.filter(Boolean).join(' · ')} `}</Text>
      {(m.waiting > 0 || m.failedUpdates > 0) && <Button key="review" label="Review" onPress={act.review} />}
      {m.announced.map(([repo, b]) => (
        <Button key={`open-${repo}`} label={m.announced.length > 1 ? `Open ${repo} PR` : 'Open PR'} onPress={() => act.openPr(b.prUrl ?? '')} />
      ))}
      {m.announced.length > 0 && <Button key="hide" label="Hide" onPress={act.hide} />}
      {m.failed.length > 0 && <Button key="retry" label="Retry" onPress={act.retry} />}
    </Box>
  )
}
