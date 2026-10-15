import type { Host } from './host'

const LEASE_REF = 'refs/learned/lease'
const NO_REF = '0'.repeat(40)
const LEASE_S = 60 * 60

// $.store has no compare-and-set; git update-ref with the expected old value does, so of two sessions that both see
// the lease free or expired, one takes it. The lease is a commit whose time is when it was taken.
export async function takeLease(io: Host, skills: string): Promise<string | null> {
  const made = await io.run(['git', '-C', skills, 'commit-tree', 'HEAD^{tree}', '-m', `learning lease: ${await io.sessionId()}`])
  const mine = made.stdout.trim()
  if (made.exitCode !== 0 || !mine) {
    return null
  }
  const held = await io.run(['git', '-C', skills, 'log', '-1', '--format=%H %ct', LEASE_REF])
  const [sha = NO_REF, takenAt = '0'] = held.exitCode === 0 ? held.stdout.trim().split(' ') : []
  if (sha !== NO_REF && Number(takenAt) > (await io.now()) / 1000 - LEASE_S) {
    return null
  }
  const taken = await io.run(['git', '-C', skills, 'update-ref', LEASE_REF, mine, sha])
  return taken.exitCode === 0 ? mine : null
}

export async function releaseLease(io: Host, skills: string, mine: string): Promise<void> {
  await io.run(['git', '-C', skills, 'update-ref', '-d', LEASE_REF, mine])
}
