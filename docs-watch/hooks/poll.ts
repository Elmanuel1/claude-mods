import type { Status, Tracked } from '../types'
import { checkDocsPr } from './branch'
import { checkDraft, startDraft, startWriter } from './draft'
import type { Host } from './host'
import { logError, runLogged } from './log'
import { allTracked, holdsLease, registeredRepos, save, tracked } from './store'
import { onlyDocsTestsCi, parseJson } from './text'

export async function tick(io: Host, ready: () => Promise<boolean>): Promise<void> {
  try {
    if (await ready()) {
      await poll(io)
    }
  } catch (error) {
    await logError(io, 'poll', error)
  }
}

async function poll(io: Host): Promise<void> {
  if (!(await holdsLease(io, Date.now()))) {
    return
  }
  const repos = await registeredRepos(io)
  for (const repo of repos) {
    await trackOpen(io, repo)
  }
  for (const t of await allTracked(io)) {
    await STEPS[t.status]?.(io, t)
  }
}

async function trackOpen(io: Host, repo: string): Promise<void> {
  const open = await runLogged(io, 'list PRs', ['gh', 'pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--json', 'number,title,url'])
  if (open.exitCode !== 0) {
    return
  }
  const prs = parseJson<{ number: number; title: string; url: string }[]>(open.stdout)
  if (prs === null) {
    await logError(io, 'list PRs', `gh returned something that is not JSON for ${repo}: ${open.stdout.slice(0, 200)}`)
    return
  }
  for (const pr of prs) {
    const key = `${repo}#${pr.number}`
    if (!(await tracked(io, key))) {
      await save(io, { key, repo, number: pr.number, title: pr.title, url: pr.url, status: 'open' })
    }
  }
}

async function checkMerged(io: Host, t: Tracked): Promise<void> {
  const view = await runLogged(io, 'check PR', ['gh', 'pr', 'view', String(t.number), '--repo', t.repo, '--json', 'state,files'], undefined, t.key)
  if (view.exitCode !== 0) {
    return
  }
  const info = parseJson<{ state: string; files: { path: string }[] }>(view.stdout)
  if (info === null) {
    await logError(io, 'check PR', `gh returned something that is not JSON: ${view.stdout.slice(0, 200)}`, t.key)
    return
  }
  if (info.state === 'CLOSED') {
    await save(io, { ...t, status: 'closed' })
    return
  }
  if (info.state !== 'MERGED') {
    return
  }
  const skip = onlyDocsTestsCi(info.files.map((f) => f.path))
  await (skip ? save(io, { ...t, status: 'skipped' }) : startDraft(io, t))
}

const STEPS: Partial<Record<Status, (io: Host, t: Tracked) => Promise<void>>> = { open: checkMerged, drafting: checkDraft, pushed: checkDocsPr }

const RESTARTS: Partial<Record<Status, (io: Host, t: Tracked) => Promise<void>>> = {
  drafting: (io, t) => startWriter(io, t, t.note ?? ''),
}

// Starts the drafts that are waiting for a session to take them.
export async function startPending(io: Host): Promise<void> {
  try {
    for (const t of (await allTracked(io)).filter((t) => t.pendingStart)) {
      await RESTARTS[t.status]?.(io, t)
    }
  } catch (error) {
    await logError(io, 'start pending', error)
  }
}
