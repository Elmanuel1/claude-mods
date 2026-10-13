import type { BranchState, Status, Tracked } from '../types'
import type { Host } from './host'
import { runLogged, stateDir } from './log'
import { slug } from './text'

const LEASE_MS = 10 * 60 * 1000
const SHOWN: readonly Status[] = ['suggested', 'applying', 'resolving', 'approved', 'pushed', 'failed']

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
  const lease = (await io.get('lease')) as { owner: string } | undefined
  return lease?.owner === me
}

export async function registeredRepos(io: Host): Promise<string[]> {
  return (await io.keys()).filter((k) => k.startsWith('repo:')).map((k) => k.slice('repo:'.length))
}

export async function checkoutOf(io: Host, repo: string): Promise<string | undefined> {
  return (await io.get(`repo:${repo}`)) as string | undefined
}

export async function branchState(io: Host, repo: string): Promise<BranchState> {
  return ((await io.get(`branch:${repo}`)) as BranchState | undefined) ?? {}
}

export async function saveBranchState(io: Host, repo: string, state: BranchState): Promise<void> {
  await io.set(`branch:${repo}`, state)
}

export async function branchStates(io: Host): Promise<Record<string, BranchState>> {
  const states: Record<string, BranchState> = {}
  for (const repo of await registeredRepos(io)) {
    states[repo] = await branchState(io, repo)
  }
  return states
}

export async function branchWorktree(io: Host, repo: string): Promise<string> {
  return `${await stateDir(io)}/branch/${slug(repo)}`
}

export async function toplevel(io: Host): Promise<string | undefined> {
  const top = await io.run(['git', 'rev-parse', '--show-toplevel'])
  return top.exitCode === 0 ? top.stdout.trim() : undefined
}

// The repository a session works in, so the poller knows where to make worktrees.
export async function registerRepo(io: Host, checkout: string | undefined): Promise<void> {
  if (!checkout) {
    return
  }
  const name = await runLogged(io, 'register repo', ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], checkout)
  if (name.exitCode !== 0) {
    return
  }
  await io.set(`repo:${name.stdout.trim()}`, checkout)
}
