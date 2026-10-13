import type { Tracked } from '../types'
import { DRAFT_TIMEOUT_MS, spawnFor } from './draft'
import { BRANCH, defaultBase, ensureBranch, picking, rebuild, removeWorktree, replay } from './git'
import type { Host } from './host'
import { logError, notify, readResult, runLogged, stateDir } from './log'
import { pushRunning, requestPush } from './push'
import { allTracked, branchState, branchWorktree, checkoutOf, leaseIsMine, registeredRepos, save, saveBranchState } from './store'
import { docsTitleFrom, lastLine, slug } from './text'

export async function mergeResult(io: Host, t: Tracked): Promise<string> {
  return `${await stateDir(io)}/results/${slug(t.key)}.merge.json`
}

// Commits the draft in its own worktree and queues it to land on the shared branch (applyNext). A ref keeps the commit
// alive after its worktree is removed, for later rebuilds.
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
    await save(io, { ...t, status: 'failed', error: lastLine(committed) })
    return
  }
  const commit = head.stdout.trim()
  await runLogged(io, 'approve', ['git', '-C', t.checkout, 'update-ref', `refs/docs-watch/${slug(t.key)}`, commit], undefined, t.key)
  await removeWorktree(io, t)
  await save(io, { ...t, status: 'applying', commit, approvedAt: Date.now() })
}

// Lands approvals on the shared branch one at a time, oldest first. A conflict goes to the docs-merge agent and the
// queue waits for it. Once nothing is left to land, the branch is pushed.
export async function applyNext(io: Host, repo: string): Promise<void> {
  const checkout = await checkoutOf(io, repo)
  const branch = checkout ? await ensureBranch(io, repo, checkout) : null
  if (!branch || (await picking(io, branch))) {
    return
  }
  for (;;) {
    const mine = (await allTracked(io)).filter((t) => t.repo === repo)
    if (mine.some((t) => t.status === 'resolving')) {
      return
    }
    const next = mine.filter((t) => t.status === 'applying').sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))[0]
    if (!next) {
      const lookAgain = mine.some((t) => t.status === 'approved') && (await requestPush(io, repo))
      if (!lookAgain) {
        return
      }
      continue
    }
    if (!next.commit) {
      await logError(io, 'apply', 'its commit is missing', next.key)
      await save(io, { ...next, status: 'failed', error: 'its commit is missing; clear it and it drafts again after the next merge' })
      continue
    }
    if ((await replay(io, branch, next.commit)) === 'applied') {
      await save(io, { ...next, status: 'approved', landedAt: Date.now() })
      continue
    }
    await startResolve(io, next, branch)
    return
  }
}

async function startResolve(io: Host, t: Tracked, branch: string): Promise<void> {
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

export async function checkResolve(io: Host, t: Tracked): Promise<void> {
  if (t.pendingStart) {
    return
  }
  const branch = await branchWorktree(io, t.repo)
  const result = await readResult(io, await mergeResult(io, t), t.key)
  if (!result && Date.now() - (t.startedAt ?? 0) <= DRAFT_TIMEOUT_MS) {
    return
  }
  if (result?.ok === true && !(await picking(io, branch))) {
    await save(io, { ...t, status: 'approved', landedAt: Date.now() })
  } else {
    await runLogged(io, 'resolve', ['git', '-C', branch, 'cherry-pick', '--abort'], undefined, t.key)
    const reason = result ? String(result.error ?? 'the conflict was not resolved') : 'the conflict was not resolved in time'
    await logError(io, 'resolve', reason, t.key)
    await save(io, { ...t, status: 'failed', error: reason })
    await notify(io, `A docs conflict for ${t.key} could not be resolved: ${reason}`)
  }
  await applyNext(io, t.repo)
}

// Checked every few seconds by the session holding the poll lease, so a resolved conflict lands soon after it finishes.
export async function checkResolves(io: Host): Promise<void> {
  if (!(await leaseIsMine(io))) {
    return
  }
  for (const t of await allTracked(io)) {
    if (t.status === 'resolving') {
      await checkResolve(io, t)
    }
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
  if (state.prUrl) {
    const view = await runLogged(io, 'docs PR', ['gh', 'pr', 'view', state.prUrl, '--json', 'state', '-q', '.state'])
    const prState = view.stdout.trim()
    if (view.exitCode !== 0 || (prState !== 'MERGED' && prState !== 'CLOSED')) {
      return
    }
    // Merged: its updates are done. Closed unmerged: they go back to approved and are pushed in a new PR.
    for (const t of await allTracked(io)) {
      if (t.repo === repo && t.status === 'pushed') {
        await save(io, { ...t, status: prState === 'MERGED' ? 'merged' : 'approved' })
      }
    }
    const keep = (await allTracked(io)).filter((t) => t.repo === repo && t.status === 'approved')
    const baseSha = await rebuild(io, branch, checkout, keep)
    await saveBranchState(io, repo, { baseSha: baseSha || state.baseSha })
    await applyNext(io, repo)
    await notify(io, prState === 'MERGED' ? `Docs PR merged for ${repo}.` : `Docs PR closed for ${repo}; its updates are back to approved.`)
    return
  }
  await runLogged(io, 'docs branch', ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const head = (await io.run(['git', '-C', checkout, 'rev-parse', await defaultBase(io, checkout)])).stdout.trim()
  if (head && head !== state.baseSha) {
    const keep = (await allTracked(io)).filter((t) => t.repo === repo && t.status === 'approved')
    const baseSha = await rebuild(io, branch, checkout, keep)
    await saveBranchState(io, repo, { ...state, pushing: false, baseSha: baseSha || state.baseSha })
  }
  await applyNext(io, repo)
}

export async function retryPush(io: Host): Promise<void> {
  for (const repo of await registeredRepos(io)) {
    const failed = (await branchState(io, repo)).lastError !== undefined
    if (failed && (await requestPush(io, repo))) {
      await applyNext(io, repo)
    }
  }
}
