import type { Tracked } from '../types'
import { defaultBase, docsBranch } from './git'
import type { Host } from './host'
import { logError, notify, runLogged } from './log'
import { save } from './store'
import { docsTitleFrom, lastLine, prBody } from './text'

// Pushes one approved update's branch and opens its PR. A push that failed keeps the update approved with the reason.
export async function pushOne(io: Host, t: Tracked): Promise<void> {
  const outcome = await pushAndOpen(io, t, docsBranch(t))
  if ('error' in outcome) {
    await logError(io, 'push', outcome.error, t.key)
    await save(io, { ...t, error: outcome.error })
    await notify(io, `The docs push for ${t.key} failed: ${outcome.error}`)
    return
  }
  await save(io, { ...t, status: 'pushed', prUrl: outcome.url, announce: true, error: undefined })
  await notify(io, `Docs PR opened: ${outcome.url}`)
}

// A session that ended between the push and gh pr create leaves the branch pushed; the next pass finds or opens its PR.
async function pushAndOpen(io: Host, t: Tracked, branch: string): Promise<{ url: string } | { error: string }> {
  if (!t.checkout) {
    return { error: 'no local checkout is registered for this update' }
  }
  const pushed = await runLogged(io, 'push', ['git', '-C', t.checkout, 'push', '-u', 'origin', branch], undefined, t.key)
  if (pushed.exitCode !== 0) {
    return { error: `git push: ${lastLine(pushed)}` }
  }
  const open = await openPrFor(io, t, branch)
  if ('error' in open || open.url) {
    return open
  }
  const base = (await defaultBase(io, t.checkout)).replace(/^origin\//, '')
  const title = t.docsTitle ?? docsTitleFrom(t)
  const create = ['gh', 'pr', 'create', '--repo', t.repo, '--base', base, '--head', branch, '--title', title, '--body', prBody(t)]
  const created = await runLogged(io, 'push', create, t.checkout, t.key)
  return created.exitCode === 0 ? { url: created.stdout.trim().split('\n').pop() ?? '' } : { error: `gh pr create: ${lastLine(created)}` }
}

async function openPrFor(io: Host, t: Tracked, branch: string): Promise<{ url: string } | { error: string }> {
  const found = await runLogged(io, 'push', ['gh', 'pr', 'list', '--repo', t.repo, '--head', branch, '--state', 'open', '--json', 'url', '-q', '.[0].url'], undefined, t.key)
  return found.exitCode === 0 ? { url: found.stdout.trim() } : { error: `gh pr list: ${lastLine(found)}` }
}
