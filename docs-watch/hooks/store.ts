import type { Status, Tracked } from '../types'
import type { Host } from './host'
import { runLogged } from './log'

const LEASE_MS = 10 * 60 * 1000
const SHOWN: readonly Status[] = ['suggested', 'approved', 'pushed', 'failed']

// This session's id for the poller lease: only one open session polls GitHub at a time.
const me = Math.random().toString(36).slice(2)

export async function allTracked(io: Host): Promise<Tracked[]> {
  const keys = await io.keys()
  const items: Tracked[] = []
  for (const key of keys.filter((k) => k.startsWith('pr:'))) {
    const value = (await io.get(key)) as Tracked | undefined
    if (value) {
      items.push(value)
    }
  }
  return items
}

export async function tracked(io: Host, key: string): Promise<Tracked | undefined> {
  return (await io.get(`pr:${key}`)) as Tracked | undefined
}

export async function save(io: Host, item: Tracked): Promise<void> {
  await io.set(`pr:${item.key}`, item)
}

export async function visible(io: Host): Promise<Tracked[]> {
  const all = await allTracked(io)
  return all.filter((t) => SHOWN.includes(t.status) || (t.status === 'drafting' && t.pendingStart))
}

export async function holdsLease(io: Host, now: number): Promise<boolean> {
  const lease = (await io.get('lease')) as { owner: string; until: number } | undefined
  if (lease && lease.owner !== me && lease.until > now) {
    return false
  }
  await io.set('lease', { owner: me, until: now + LEASE_MS })
  return true
}

export async function leaseIsMine(io: Host): Promise<boolean> {
  const lease = (await io.get('lease')) as { owner: string; until: number } | undefined
  return lease?.owner === me && lease.until > Date.now()
}

export async function registeredRepos(io: Host): Promise<string[]> {
  return (await io.keys()).filter((k) => k.startsWith('repo:')).map((k) => k.slice('repo:'.length))
}

export async function checkoutOf(io: Host, repo: string): Promise<string | undefined> {
  return (await io.get(`repo:${repo}`)) as string | undefined
}

export async function toplevel(io: Host): Promise<string | undefined> {
  const top = await io.run(['git', 'rev-parse', '--show-toplevel'])
  return top.exitCode === 0 ? top.stdout.trim() : undefined
}

// The repository a session works in, so the poller knows where to make worktrees and push from.
export async function registerRepo(io: Host, checkout: string | undefined): Promise<void> {
  if (!checkout) {
    return
  }
  const name = await runLogged(io, 'register repo', ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], checkout)
  if (name.exitCode !== 0) {
    return
  }
  await io.set(`repo:${name.stdout.trim()}`, await mainCheckout(io, checkout))
}

// A session often runs in a worktree that is deleted when the session ends, while an update drafted from it is pushed
// later; git lists the repository's main checkout first, and that one outlives its worktrees.
async function mainCheckout(io: Host, checkout: string): Promise<string> {
  // -z: a worktree path may itself contain a newline.
  const list = await io.run(['git', '-C', checkout, 'worktree', 'list', '--porcelain', '-z'])
  const first = list.exitCode === 0 ? list.stdout.split('\0')[0] : ''
  return first.startsWith('worktree ') ? first.slice('worktree '.length) : checkout
}
