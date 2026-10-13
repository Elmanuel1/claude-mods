import type { Tracked } from '../types'
import type { Host } from './host'
import { runLogged, stateDir } from './log'
import { allTracked, branchWorktree, save } from './store'

// One branch per repository collects every approved update, so many merged PRs ship as one docs PR.
export const BRANCH = 'docs/updates'

export async function defaultBase(io: Host, checkout: string): Promise<string> {
  const head = await io.run(['git', '-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
}

export async function removeWorktree(io: Host, t: Tracked): Promise<void> {
  if (t.checkout && t.work) {
    await runLogged(io, 'remove worktree', ['git', '-C', t.checkout, 'worktree', 'remove', '--force', t.work], undefined, t.key)
  }
}

// The worktree on the shared branch, created from the default branch the first time.
export async function ensureBranch(io: Host, repo: string, checkout: string): Promise<string | null> {
  const work = await branchWorktree(io, repo)
  if ((await io.run(['git', '-C', work, 'rev-parse', '--git-dir'])).exitCode === 0) {
    return work
  }
  await runLogged(io, 'docs branch', ['mkdir', '-p', `${await stateDir(io)}/branch`])
  await runLogged(io, 'docs branch', ['git', '-C', checkout, 'worktree', 'prune'])
  const hasBranch = await io.run(['git', '-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`])
  const add = hasBranch.exitCode === 0
    ? ['git', '-C', checkout, 'worktree', 'add', work, BRANCH]
    : ['git', '-C', checkout, 'worktree', 'add', '-b', BRANCH, work, await defaultBase(io, checkout)]
  const added = await runLogged(io, 'docs branch', add)
  return added.exitCode === 0 ? work : null
}

// A conflicting cherry-pick is left in progress for the docs-merge agent to resolve.
export async function replay(io: Host, branch: string, commit: string): Promise<'applied' | 'conflict'> {
  const picked = await io.run(['git', '-C', branch, 'cherry-pick', '--allow-empty', commit])
  return picked.exitCode === 0 ? 'applied' : 'conflict'
}

export async function picking(io: Host, branch: string): Promise<boolean> {
  return (await io.run(['git', '-C', branch, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'])).exitCode === 0
}

// Restarts the branch from the latest default branch and queues the approvals still to ship to land again, through
// the same queue as a new approval, so a conflict with the new main is resolved the same way. Returns the base commit.
export async function rebuild(io: Host, repo: string, branch: string, checkout: string): Promise<string> {
  const dirty = (await io.run(['git', '-C', branch, 'status', '--porcelain'])).stdout.trim() !== ''
  if (dirty || (await picking(io, branch))) {
    return ''
  }
  await runLogged(io, 'rebuild', ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const base = await defaultBase(io, checkout)
  await runLogged(io, 'rebuild', ['git', '-C', branch, 'reset', '-q', '--hard', base])
  for (const t of (await allTracked(io)).filter((t) => t.repo === repo && t.status === 'approved')) {
    await save(io, { ...t, status: 'applying' })
  }
  return (await runLogged(io, 'rebuild', ['git', '-C', checkout, 'rev-parse', base])).stdout.trim()
}
