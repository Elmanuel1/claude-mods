import type { Host } from './host'
import { BRANCH, repoPath } from './rules'

// One worktree holds the repo rules of one repository at a time. A session from another repository waits while the
// worktree holds unpushed rules, and otherwise frees it so the learning run recreates it from its own repository.
export async function worktreeFits(io: Host, cwd: string): Promise<boolean> {
  const worktree = repoPath(io, 'project')
  const ours = await commonDir(io, worktree)
  const theirs = await commonDir(io, cwd)
  if (!ours || !theirs || ours === theirs) {
    return true
  }
  const ahead = await io.run(['git', '-C', worktree, 'rev-list', '--count', `origin/main..${BRANCH}`])
  if (ahead.exitCode === 0 && Number(ahead.stdout.trim()) > 0) {
    return false
  }
  await io.run(['git', `--git-dir=${ours}`, 'worktree', 'remove', '--force', worktree])
  return true
}

async function commonDir(io: Host, path: string): Promise<string> {
  const found = await io.run(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  return found.exitCode === 0 ? found.stdout.trim() : ''
}
