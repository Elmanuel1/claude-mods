import type { Host } from './host'
import { BRANCH, hasOpenRules, repoPath, resetToMain } from './rules'

/**
 * `unsynced`: it holds earlier rules that could not be rebased onto main; `busy`: it holds another repository's open
 * rules; `none`: the session ran outside a git repository, or no worktree could be added.
 */
export type WorktreeState = 'ready' | 'unsynced' | 'busy' | 'none'

// The mod sets the worktree up itself, so the learning run needs no git command but add and commit. One worktree
// holds one repository's rules at a time: a session from another repository waits until those rules are merged.
export async function prepareWorktree(io: Host, cwd: string): Promise<WorktreeState> {
  const worktree = repoPath(io, 'project')
  const theirs = await commonDir(io, cwd)
  if (!theirs) {
    return 'none'
  }
  const ours = await commonDir(io, worktree)
  if (ours && ours !== theirs && (await hasOpenRules(io, worktree))) {
    return 'busy'
  }
  if (ours && ours !== theirs) {
    await io.run(['git', `--git-dir=${ours}`, 'worktree', 'remove', '--force', worktree])
  }
  await io.run(['git', `--git-dir=${theirs}`, 'fetch', '-q', 'origin'], { timeoutMs: 60000 })
  if (ours !== theirs && !(await addWorktree(io, theirs, worktree))) {
    return 'none'
  }
  return (await syncWithMain(io, worktree)) ? 'ready' : 'unsynced'
}

async function addWorktree(io: Host, gitDir: string, worktree: string): Promise<boolean> {
  const hasBranch = (await io.run(['git', `--git-dir=${gitDir}`, 'rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`])).exitCode === 0
  const start = hasBranch ? [BRANCH] : ['-b', BRANCH, 'origin/main']
  return (await io.run(['git', `--git-dir=${gitDir}`, 'worktree', 'add', '-q', worktree, ...start])).exitCode === 0
}

// New rules start from the latest main: open rules are rebased onto it, a branch with none is reset to it.
async function syncWithMain(io: Host, worktree: string): Promise<boolean> {
  if (!(await hasOpenRules(io, worktree))) {
    return resetToMain(io, worktree)
  }
  if ((await io.run(['git', '-C', worktree, 'rebase', '-q', 'origin/main'])).exitCode === 0) {
    return true
  }
  await io.run(['git', '-C', worktree, 'rebase', '--abort'])
  return false
}

async function commonDir(io: Host, path: string): Promise<string> {
  const found = await io.run(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  return found.exitCode === 0 ? found.stdout.trim() : ''
}
