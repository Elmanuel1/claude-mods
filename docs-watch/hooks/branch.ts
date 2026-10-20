import type { BranchState, Tracked } from '../types'
import { DRAFT_TIMEOUT_MS, spawnFor } from './draft'
import { BRANCH, defaultBase, ensureBranch, fetchOrigin, picking, rebuild, removeWorktree, replay } from './git'
import type { Host } from './host'
import { logError, notify, readResult, runLogged, stateDir } from './log'
import { pushRunning, requestPush } from './push'
import { allTracked, branchState, branchWorktree, checkoutOf, leaseIsMine, registeredRepos, save, saveBranchState } from './store'
import { docsTitleFrom, failureReason, slug } from './text'

export async function mergeResult(io: Host, t: Tracked): Promise<string> {
  return `${await stateDir(io)}/results/${slug(t.key)}.merge.json`
}

// Commits the draft in its own worktree and queues it to land on the shared branch. A ref keeps the commit alive after
// its worktree is removed, for later rebuilds. Landing is left to the session holding the poll lease (advanceQueues).
export async function approve(io: Host, t: Tracked): Promise<void> {
  const branch = t.checkout ? await ensureBranch(io, t.repo, t.checkout) : null
  if (!branch || !t.work || !t.checkout) {
    await logError(io, 'approve', 'the shared docs branch could not be created', t.key)
    await save(io, { ...t, status: 'failed', error: 'the shared docs branch could not be created' })
    return
  }
  await runLogged(io, 'approve', ['git', '-C', t.work, 'add', '-A'], undefined, t.key)
  const body = `${t.summary ?? ''}\n\nAfter #${t.number}${t.url ? ` (${t.url})` : ''}.`
  const commitArgs = ['git', '-C', t.work, 'commit', '-q', '-m', t.docsTitle ?? docsTitleFrom(t), '-m', body]
  const committed = await runLogged(io, 'approve', commitArgs, undefined, t.key)
  const head = await runLogged(io, 'approve', ['git', '-C', t.work, 'rev-parse', 'HEAD'], undefined, t.key)
  if (committed.exitCode !== 0 || head.exitCode !== 0) {
    await save(io, { ...t, status: 'failed', error: failureReason(committed) })
    return
  }
  const commit = head.stdout.trim()
  await runLogged(io, 'approve', ['git', '-C', t.checkout, 'update-ref', `refs/docs-watch/${slug(t.key)}`, commit], undefined, t.key)
  await removeWorktree(io, t)
  await save(io, { ...t, status: 'applying', commit, approvedAt: Date.now() })
}

// Lands approvals on the shared branch one at a time, oldest first, and pushes once none is left to land.
async function applyNext(io: Host, repo: string): Promise<void> {
  const checkout = await checkoutOf(io, repo)
  const branch = checkout ? await ensureBranch(io, repo, checkout) : null
  if (!branch || (await picking(io, branch))) {
    return
  }
  let more = true
  while (more) {
    more = await landOne(io, repo, branch)
  }
}

// A conflict goes to the docs-merge agent and the queue waits for it. True while there is more to do.
async function landOne(io: Host, repo: string, branch: string): Promise<boolean> {
  const mine = (await allTracked(io)).filter((t) => t.repo === repo)
  if (mine.some((t) => t.status === 'resolving')) {
    return false
  }
  const next = mine.filter((t) => t.status === 'applying').sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))[0]
  if (!next) {
    return mine.some((t) => t.status === 'approved') && (await requestPush(io, repo))
  }
  if (!next.commit) {
    await logError(io, 'apply', 'its commit is missing', next.key)
    await save(io, { ...next, status: 'failed', error: 'its commit is missing; clear it and it drafts again after the next merge' })
    return true
  }
  if ((await replay(io, branch, next.commit)) === 'conflict') {
    await startResolve(io, next)
    return false
  }
  await save(io, { ...next, status: 'approved', landedAt: Date.now() })
  return true
}

async function startResolve(io: Host, t: Tracked): Promise<void> {
  await runLogged(io, 'resolve', ['rm', '-f', await mergeResult(io, t)], undefined, t.key)
  const resolving: Tracked = { ...t, status: 'resolving', startedAt: Date.now() }
  await save(io, resolving)
  await startMerger(io, resolving)
  await notify(io, `Resolving a docs conflict for ${t.key}…`)
}

export async function startMerger(io: Host, t: Tracked): Promise<void> {
  const branch = await branchWorktree(io, t.repo)
  const prompt = [
    `Repository ${t.repo}. In this worktree (${branch}), branch ${BRANCH} has a cherry-pick in progress that conflicts:`,
    `the documentation update after merged pull request #${t.number} ("${t.title ?? ''}"; ${t.summary ?? ''}) against updates`,
    `already on the branch. Write your result file to ${await mergeResult(io, t)}.`,
  ].join(' ')
  await spawnFor(io, t, 'resolve', { prompt, subagentType: 'docs-watch:docs-merge', description: `Resolve docs conflict for ${t.key}`, cwd: branch })
}

async function checkResolve(io: Host, t: Tracked): Promise<void> {
  const branch = await branchWorktree(io, t.repo)
  const result = await readResult(io, await mergeResult(io, t), t.key)
  if (!result && Date.now() - (t.startedAt ?? 0) <= DRAFT_TIMEOUT_MS) {
    return
  }
  const resolved = result?.ok === true && !(await picking(io, branch))
  await (resolved ? save(io, { ...t, status: 'approved', landedAt: Date.now() }) : failResolve(io, t, branch, result))
}

async function failResolve(io: Host, t: Tracked, branch: string, result: Record<string, unknown> | null): Promise<void> {
  await runLogged(io, 'resolve', ['git', '-C', branch, 'cherry-pick', '--abort'], undefined, t.key)
  const reason = result ? String(result.error ?? 'the conflict was not resolved') : 'the conflict was not resolved in time'
  await logError(io, 'resolve', reason, t.key)
  await save(io, { ...t, status: 'failed', error: reason })
  await notify(io, `A docs conflict for ${t.key} could not be resolved: ${reason}`)
}

// Work on the machine-wide worktrees runs one pass at a time in this session; a pass asked for while one runs is
// skipped, and the next timer tick picks up what it would have done.
let running: Promise<void> | null = null

export async function exclusive(work: () => Promise<void>): Promise<void> {
  if (running) {
    return
  }
  running = work().finally(() => {
    running = null
  })
  await running
}

// Only the session holding the poll lease lands approvals on and pushes the machine-wide worktree; it runs this every
// few seconds, so an approval or a resolved conflict ships soon after it happens.
export async function advanceQueues(io: Host): Promise<void> {
  if (await leaseIsMine(io)) {
    await exclusive(() => advanceAll(io))
  }
}

async function advanceAll(io: Host): Promise<void> {
  const all = await allTracked(io)
  for (const t of all.filter((t) => t.status === 'resolving' && !t.pendingStart)) {
    await checkResolve(io, t)
  }
  for (const repo of await registeredRepos(io)) {
    await advanceQueue(io, repo)
  }
}

async function advanceQueue(io: Host, repo: string): Promise<void> {
  const mine = (await allTracked(io)).filter((t) => t.repo === repo)
  const state = await branchState(io, repo)
  const unpushed = mine.some((t) => t.status === 'approved') && !state.lastError && !pushRunning(state)
  if (mine.some((t) => t.status === 'applying') || unpushed) {
    await applyNext(io, repo)
  }
}

// Moves a repository's shared branch on with GitHub: its PR merged or closed, and main moving while nothing is pushed.
export async function checkBranch(io: Host, repo: string): Promise<void> {
  const state = await branchState(io, repo)
  const checkout = await checkoutOf(io, repo)
  const branch = await branchWorktree(io, repo)
  if (pushRunning(state) || !checkout || (await io.run(['git', '-C', branch, 'rev-parse', '--git-dir'])).exitCode !== 0) {
    return
  }
  await (state.prUrl ? followDocsPr(io, repo, state, branch, checkout) : followMain(io, repo, state, branch, checkout))
}

// Merged: its updates are done. Closed unmerged: they go back to approved and are pushed in a new PR.
async function followDocsPr(io: Host, repo: string, state: BranchState, branch: string, checkout: string): Promise<void> {
  const view = await runLogged(io, 'docs PR', ['gh', 'pr', 'view', state.prUrl ?? '', '--json', 'state', '-q', '.state'])
  const prState = view.stdout.trim()
  if (view.exitCode !== 0 || (prState !== 'MERGED' && prState !== 'CLOSED')) {
    return
  }
  const merged = prState === 'MERGED'
  for (const t of (await allTracked(io)).filter((t) => t.repo === repo && t.status === 'pushed')) {
    await save(io, { ...t, status: merged ? 'merged' : 'approved' })
  }
  const baseSha = await rebuild(io, repo, branch, checkout)
  await saveBranchState(io, repo, { baseSha: baseSha || state.baseSha })
  await notify(io, merged ? `Docs PR merged for ${repo}.` : `Docs PR closed for ${repo}; its updates are back to approved.`)
}

async function followMain(io: Host, repo: string, state: BranchState, branch: string, checkout: string): Promise<void> {
  await fetchOrigin(io, checkout, 'docs branch')
  const head = (await io.run(['git', '-C', checkout, 'rev-parse', await defaultBase(io, checkout)])).stdout.trim()
  if (head && head !== state.baseSha) {
    const baseSha = await rebuild(io, repo, branch, checkout)
    await saveBranchState(io, repo, { ...state, pushing: false, baseSha: baseSha || state.baseSha })
  }
}

// Retry clears the failed pushes' reasons, so the next pass of advanceQueues pushes them again. It prunes only refs whose
// branch GitHub deleted; a full fetch would move the lease past someone else's push and the force push would drop it.
export async function clearPushErrors(io: Host): Promise<void> {
  for (const repo of await registeredRepos(io)) {
    const state = await branchState(io, repo)
    if (!state.lastError) {
      continue
    }
    const checkout = await checkoutOf(io, repo)
    if (checkout) {
      await runLogged(io, 'retry', ['git', '-C', checkout, 'remote', 'prune', 'origin'], undefined, repo)
    }
    await saveBranchState(io, repo, { ...state, lastError: undefined })
  }
}
