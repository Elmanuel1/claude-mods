import type { BranchState } from '../types'
import { BRANCH, defaultBase, ensureBranch } from './git'
import type { Host } from './host'
import { logError, notify, runLogged } from './log'
import { allTracked, branchState, checkoutOf, save, saveBranchState } from './store'
import { lastLine, prBody, prTitle } from './text'

// A push runs git and gh in one session; a flag older than this was left by a session that ended mid-push.
const PUSH_STALE_MS = 10 * 60 * 1000

export const pushRunning = (state: BranchState) => state.pushing === true && Date.now() - (state.pushStartedAt ?? 0) < PUSH_STALE_MS

// A push starts now, or right after the one already running. True when the queue needs another look: this push
// succeeded, or another approval arrived while it ran.
export async function requestPush(io: Host, repo: string): Promise<boolean> {
  const state = await branchState(io, repo)
  if (pushRunning(state)) {
    await saveBranchState(io, repo, { ...state, pushAgain: true })
    return false
  }
  return push(io, repo)
}

// An update that lands while the push runs is not in what was pushed, so it stays approved for the next push.
async function push(io: Host, repo: string): Promise<boolean> {
  const checkout = await checkoutOf(io, repo)
  const branch = checkout ? await ensureBranch(io, repo, checkout) : null
  if (!checkout || !branch) {
    return false
  }
  const startedAt = Date.now()
  const before = await branchState(io, repo)
  await saveBranchState(io, repo, { ...before, pushing: true, pushStartedAt: startedAt, pushAgain: false, lastError: undefined, announce: false })
  await notify(io, `Pushing the docs updates for ${repo}…`)
  const outcome = await pushAndOpen(io, repo, checkout, branch, before.prUrl)
  const after = await branchState(io, repo)
  if ('error' in outcome) {
    await logError(io, 'push', outcome.error, repo)
    return finishPush(io, repo, { ...after, pushing: false, lastError: outcome.error })
  }
  for (const t of await allTracked(io)) {
    if (t.repo === repo && t.status === 'approved' && (t.landedAt ?? 0) <= startedAt) {
      await save(io, { ...t, status: 'pushed', prUrl: outcome.url })
    }
  }
  return finishPush(io, repo, { ...after, pushing: false, prUrl: outcome.url, announce: true })
}

// Pushes the shared branch with git and opens its PR with gh, or updates the one already open.
async function pushAndOpen(io: Host, repo: string, checkout: string, branch: string, prUrl: string | undefined): Promise<{ url: string } | { error: string }> {
  const baseRef = await defaultBase(io, checkout)
  const log = await runLogged(io, 'push', ['git', '-C', branch, 'log', '--reverse', '--format=%s', `${baseRef}..HEAD`], undefined, repo)
  const subjects = log.stdout.trim().split('\n').filter(Boolean)
  if (subjects.length === 0) {
    return { error: 'the docs branch has no commits to push' }
  }
  const pushed = await runLogged(io, 'push', ['git', '-C', branch, 'push', '--force-with-lease', '-u', 'origin', BRANCH], undefined, repo)
  if (pushed.exitCode !== 0) {
    return { error: `git push: ${lastLine(pushed)}` }
  }
  const title = prTitle(subjects)
  const included = (await allTracked(io)).filter((t) => t.repo === repo && (t.status === 'approved' || t.status === 'pushed'))
  const body = prBody(included)
  const open = prUrl ?? (await openPrFor(io, repo))
  if (open) {
    const edited = await runLogged(io, 'push', ['gh', 'pr', 'edit', open, '--title', title, '--body', body], undefined, repo)
    return edited.exitCode === 0 ? { url: open } : { error: `gh pr edit: ${lastLine(edited)}` }
  }
  const base = baseRef.replace(/^origin\//, '')
  const create = ['gh', 'pr', 'create', '--repo', repo, '--base', base, '--head', BRANCH, '--title', title, '--body', body]
  const created = await runLogged(io, 'push', create, branch, repo)
  return created.exitCode === 0 ? { url: created.stdout.trim().split('\n').pop() ?? '' } : { error: `gh pr create: ${lastLine(created)}` }
}

async function openPrFor(io: Host, repo: string): Promise<string | undefined> {
  const found = await runLogged(io, 'push', ['gh', 'pr', 'list', '--repo', repo, '--head', BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url'], undefined, repo)
  return found.stdout.trim() || undefined
}

async function finishPush(io: Host, repo: string, state: BranchState): Promise<boolean> {
  await saveBranchState(io, repo, state)
  await notify(io, state.lastError ? `The docs push for ${repo} failed: ${state.lastError}` : `Docs PR updated: ${state.prUrl ?? ''}`)
  return state.pushAgain === true || !state.lastError
}
