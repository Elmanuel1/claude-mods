import type { Tracked } from '../types'
import type { Host } from './host'
import { runLogged } from './log'

// Each approved update ships on its own branch and PR, named for the merged pull request it follows.
export const docsBranch = (t: Tracked) => `docs/updates-${t.number}`

export async function defaultBase(io: Host, checkout: string): Promise<string> {
  const head = await io.run(['git', '-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
}

export async function removeWorktree(io: Host, t: Tracked): Promise<void> {
  if (t.checkout && t.work) {
    await runLogged(io, 'remove worktree', ['git', '-C', t.checkout, 'worktree', 'remove', '--force', t.work], undefined, t.key)
  }
}
