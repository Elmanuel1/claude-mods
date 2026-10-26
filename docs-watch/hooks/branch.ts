import type { Tracked } from '../types'
import { docsBranch, removeWorktree } from './git'
import type { Host } from './host'
import { notify, runLogged } from './log'
import { pushOne } from './push'
import { allTracked, leaseIsMine, save } from './store'
import { docsTitleFrom, lastLine } from './text'

// Commits the draft on its own branch (docsBranch) in its worktree; the branch outlives the worktree. Pushing is left to the session
// holding the poll lease (advanceQueues).
export async function approve(io: Host, t: Tracked): Promise<void> {
  if (!t.work) {
    await save(io, { ...t, status: 'failed', error: 'its worktree is missing; clear it and it drafts again after the next merge' })
    return
  }
  const body = `${t.summary ?? ''}\n\nAfter #${t.number}${t.url ? ` (${t.url})` : ''}.`
  const steps = [
    ['git', '-C', t.work, 'switch', '-q', '-C', docsBranch(t)],
    ['git', '-C', t.work, 'add', '-A'],
    ['git', '-C', t.work, 'commit', '-q', '-m', t.docsTitle ?? docsTitleFrom(t), '-m', body],
  ]
  for (const step of steps) {
    const done = await runLogged(io, 'approve', step, undefined, t.key)
    if (done.exitCode !== 0) {
      await save(io, { ...t, status: 'failed', error: lastLine(done) })
      return
    }
  }
  await removeWorktree(io, t)
  await save(io, { ...t, status: 'approved', error: undefined })
}

// Work on the pushes runs one pass at a time in this session; a pass asked for while one runs is skipped, and the next
// timer tick picks up what it would have done.
let running: Promise<void> | null = null

async function exclusive(work: () => Promise<void>): Promise<void> {
  if (running) {
    return
  }
  running = work().finally(() => {
    running = null
  })
  await running
}

// Only the session holding the poll lease pushes; it runs this every few seconds, so an approval ships soon after it
// happens. A failed push keeps its reason until Retry clears it.
export async function advanceQueues(io: Host): Promise<void> {
  if (await leaseIsMine(io)) {
    await exclusive(async () => {
      for (const t of (await allTracked(io)).filter((t) => t.status === 'approved' && !t.error)) {
        await pushOne(io, t)
      }
    })
  }
}

// Merged: the update is done. Closed unmerged: it counts as dismissed. Either way its local branch goes.
export async function checkDocsPr(io: Host, t: Tracked): Promise<void> {
  const view = await runLogged(io, 'docs PR', ['gh', 'pr', 'view', t.prUrl ?? '', '--json', 'state', '-q', '.state'], undefined, t.key)
  const state = view.stdout.trim()
  if (view.exitCode !== 0 || (state !== 'MERGED' && state !== 'CLOSED')) {
    return
  }
  if (t.checkout) {
    await runLogged(io, 'docs PR', ['git', '-C', t.checkout, 'branch', '-D', docsBranch(t)], undefined, t.key)
  }
  const merged = state === 'MERGED'
  await save(io, { ...t, status: merged ? 'merged' : 'dismissed', announce: false })
  await notify(io, merged ? `Docs PR merged for ${t.key}.` : `Docs PR closed for ${t.key}.`)
}

// Retry clears the failed pushes' reasons, so the next pass of advanceQueues pushes them again.
export async function clearPushErrors(io: Host): Promise<void> {
  for (const t of (await allTracked(io)).filter((t) => t.status === 'approved' && t.error)) {
    await save(io, { ...t, error: undefined })
  }
}
