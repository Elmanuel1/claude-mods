import type { Host, RunResult } from './host'
import { BRANCH, repoPath } from './rules'

const PR_TITLE = 'docs: rules learned from review corrections'
const PR_BODY = 'Rules the learned-rules mod wrote from review corrections, each accepted one by one in /learned.'

function failureOf(run: RunResult): string {
  const lastLine = (text: string) => text.trim().split('\n').pop() ?? ''
  return lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.exitCode}`
}

// Pushes the accepted project rules, then opens the PR to main or reports the open one.
export async function push(io: Host): Promise<void> {
  const worktree = repoPath(io, 'project')
  const pushed = await io.run(['git', '-C', worktree, 'push', '--force-with-lease', '-u', 'origin', BRANCH], { timeoutMs: 120000 })
  if (pushed.exitCode !== 0) {
    io.toast(`Push failed: ${failureOf(pushed)}`)
    return
  }

  const existing = await io.run(['gh', 'pr', 'view', BRANCH, '--json', 'url,state', '-q', 'select(.state == "OPEN") | .url'], { cwd: worktree })
  const openUrl = existing.exitCode === 0 ? existing.stdout.trim() : ''
  if (openUrl) {
    io.toast(`Pushed. PR updated: ${openUrl}`)
    return
  }

  const created = await io.run(['gh', 'pr', 'create', '--base', 'main', '--head', BRANCH, '--title', PR_TITLE, '--body', PR_BODY], { cwd: worktree, timeoutMs: 60000 })
  const createdUrl = created.stdout.trim().split('\n').pop()
  io.toast(created.exitCode === 0 ? `Pushed. PR opened: ${createdUrl}` : `Pushed, but the PR was not opened: ${failureOf(created)}`)
}
