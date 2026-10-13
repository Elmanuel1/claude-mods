import type { Tracked } from '../types'
import { defaultBase, removeWorktree } from './git'
import type { Host, SpawnSpec } from './host'
import { logError, notify, readResult, runLogged, stateDir } from './log'
import { checkoutOf, save } from './store'
import { describe, docsTitleFrom, lastLine, slug } from './text'

export const DRAFT_TIMEOUT_MS = 45 * 60 * 1000
const DIFF_LIMIT = 60000

export async function draftResult(io: Host, t: Tracked): Promise<string> {
  return `${await stateDir(io)}/results/${slug(t.key)}.json`
}

// Subagents start only from a session. When the engine refuses or fails to start one (as it may from a timer), the item
// waits with `pendingStart` and the next turn, `/docs-watch` or session start tries again; each refusal is logged.
export async function spawnFor(io: Host, t: Tracked, where: string, spec: SpawnSpec): Promise<void> {
  let problem = ''
  try {
    const started = await io.spawn(spec)
    if ('deny' in started && started.deny) {
      problem = `subagent refused: ${JSON.stringify(started.deny)}`
    } else if (!started.agentId) {
      problem = 'subagent did not start (no agent id)'
    } else {
      await save(io, { ...t, agentId: started.agentId, pendingStart: undefined, note: undefined, error: undefined, startedAt: Date.now() })
      return
    }
  } catch (error) {
    problem = `subagent failed to start: ${describe(error)}`
  }
  await logError(io, where, problem, t.key)
  await save(io, { ...t, pendingStart: true, error: problem })
}

export async function startDraft(io: Host, t: Tracked): Promise<void> {
  const checkout = await checkoutOf(io, t.repo)
  if (!checkout) {
    await logError(io, 'draft', `no local checkout registered for ${t.repo}: open a Claude Code session in it`, t.key)
    return
  }
  const dir = await stateDir(io)
  const work = `${dir}/work/${slug(t.key)}`
  await runLogged(io, 'draft', ['mkdir', '-p', `${dir}/work`, `${dir}/results`], undefined, t.key)
  await runLogged(io, 'draft', ['git', '-C', checkout, 'fetch', '-q', 'origin'], undefined, t.key)
  const base = await defaultBase(io, checkout)
  await io.run(['git', '-C', checkout, 'worktree', 'remove', '--force', work])
  const added = await runLogged(io, 'draft', ['git', '-C', checkout, 'worktree', 'add', '--detach', work, base], undefined, t.key)
  if (added.exitCode !== 0) {
    await save(io, { ...t, status: 'failed', error: lastLine(added) })
    return
  }
  const drafting: Tracked = { ...t, status: 'drafting', checkout, work, base, startedAt: Date.now() }
  await save(io, drafting)
  await startWriter(io, drafting, '')
}

export async function startWriter(io: Host, t: Tracked, note: string): Promise<void> {
  const lines = [
    'Use the docs-watch:update-docs skill (call the Skill tool with it) and follow it exactly.',
    `PR: ${t.repo}#${t.number} ("${t.title ?? ''}").`,
    `Worktree: ${t.work}`,
    `Result file: ${await draftResult(io, t)}`,
  ]
  if (note) {
    lines.push(`Note: ${note}`)
  }
  const spec = { prompt: lines.join('\n'), subagentType: 'general-purpose', description: `Docs after ${t.key}`, cwd: t.work }
  await spawnFor(io, { ...t, note: note || undefined }, 'draft', spec)
}

export async function checkDraft(io: Host, t: Tracked): Promise<void> {
  const result = await readResult(io, await draftResult(io, t), t.key)
  if (!result) {
    if (!t.pendingStart && Date.now() - (t.startedAt ?? 0) > DRAFT_TIMEOUT_MS) {
      const where = t.agentId ? ` (agent ${t.agentId})` : ''
      const error = `the draft wrote no result file within ${DRAFT_TIMEOUT_MS / 60000} minutes${where}`
      await logError(io, 'draft', error, t.key)
      await save(io, { ...t, status: 'failed', error })
    }
    return
  }
  const work = t.work ?? ''
  await runLogged(io, 'draft', ['git', '-C', work, 'add', '-A'], undefined, t.key)
  const changes = await runLogged(io, 'draft', ['git', '-C', work, 'diff', '--cached'], undefined, t.key)
  const text = changes.stdout
  if (text.trim() === '') {
    await removeWorktree(io, t)
    await save(io, { ...t, status: 'no-change' })
    return
  }
  const summary = typeof result.summary === 'string' ? result.summary : 'Documentation update'
  const docsTitle = typeof result.title === 'string' && result.title.startsWith('docs: ') ? result.title : docsTitleFrom(t)
  await save(io, { ...t, status: 'suggested', summary, docsTitle, diff: text.slice(0, DIFF_LIMIT) })
  await notify(io, `${t.key} merged: docs update suggested. Review with /docs-watch.`)
}

// Starts the draft again from a clean worktree, with the person's note.
export async function redo(io: Host, t: Tracked, note: string): Promise<void> {
  const work = t.work ?? ''
  await runLogged(io, 'redo', ['git', '-C', work, 'reset', '-q', '--hard'], undefined, t.key)
  await runLogged(io, 'redo', ['git', '-C', work, 'clean', '-fdq'], undefined, t.key)
  await runLogged(io, 'redo', ['rm', '-f', await draftResult(io, t)], undefined, t.key)
  const drafting: Tracked = { ...t, status: 'drafting', startedAt: Date.now(), diff: undefined, summary: undefined, docsTitle: undefined }
  await save(io, drafting)
  await startWriter(io, drafting, note)
  io.toast(`Redrafting the docs for ${t.key}…`)
}

export async function dismiss(io: Host, t: Tracked): Promise<void> {
  await removeWorktree(io, t)
  await save(io, { ...t, status: 'dismissed' })
}
