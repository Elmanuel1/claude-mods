import type { RenderElement } from 'claude-code'

import type { Missing, Tracked } from '../types'
import type { Kit } from './host'
import { describeMissing } from './requirements'

export type BandModel = {
  blocked: Missing[]
  waiting: number
  failedUpdates: number
  announced: Tracked[]
  failed: Tracked[]
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
    m.announced.length > 0 ? `${m.announced.length > 1 ? `${m.announced.length} docs PRs` : 'Docs PR'} opened` : '',
    m.failed[0] ? `Docs push failed for ${m.failed[0].key}: ${m.failed[0].error}` : '',
  ]
  return (
    <Box>
      <Text>{`${parts.filter(Boolean).join(' · ')} `}</Text>
      {(m.waiting > 0 || m.failedUpdates > 0) && <Button key="review" label="Review" onPress={act.review} />}
      {m.announced.map((t) => (
        <Button key={`open-${t.key}`} label={m.announced.length > 1 ? `Open #${t.number} docs` : 'Open PR'} onPress={() => act.openPr(t.prUrl ?? '')} />
      ))}
      {m.announced.length > 0 && <Button key="hide" label="Hide" onPress={act.hide} />}
      {m.failed.length > 0 && <Button key="retry" label="Retry" onPress={act.retry} />}
    </Box>
  )
}
