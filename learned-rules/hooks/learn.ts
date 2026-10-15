import { applyRules, parseRules } from './apply'
import { enforcerInventory } from './inventory'
import type { Host } from './host'
import { releaseLease, takeLease } from './lease'
import { repoPath } from './rules'
import { prepareWorktree } from './worktree'
import type { WorktreeState } from './worktree'

export type QueuedSession = { sessionId: string; cwd: string; attempts?: number; retryAt?: number }

type Ready = { item: QueuedSession; worktree: WorktreeState }

const TYPED_LIMIT = 80000
const MIN_TYPED = 400
const MAX_ATTEMPTS = 3
const RETRY_AFTER_MS = 30 * 60 * 1000
// Not what the user typed: reminders, notifications, skill bodies, markup and interrupts.
const NOT_TYPED = /system-reminder|task-notification|Base directory for this skill|^\s*<|^\[Request interrupted/

// The typed text steers the run, pasted text included, so the run only reads, and the mod applies the rules it
// returns. It loads only project settings, from an empty folder it starts in, so none of the user's settings (which
// may allow every command), hooks or plugins apply.
function runArgs(readable: string[]): string[] {
  return [
    '-p', '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', 'Read,Grep,Glob', ...readable.flatMap(dir => ['--add-dir', dir]),
    '--permission-mode', 'default', '--allowedTools', 'Read,Grep,Glob',
  ]
}

// What a person typed: at the terminal, through Remote Control, or in an app that drives Claude Code through the SDK
// (the desktop app). Notifications, triggers, other sessions' messages and slash commands are not corrections.
const TYPED_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

const typedKey = (sessionId: string) => `typed:${sessionId}`

export function isTypedPrompt(e: { command?: unknown; isMeta?: true; origin: { kind: string } }): boolean {
  return !e.command && !e.isMeta && TYPED_ORIGINS.includes(e.origin.kind)
}

// One learning run per session at a time; a run the session's end kills leaves its item queued for the next one.
let isRunning = false

export async function recordTyped(io: Host, text: string): Promise<void> {
  if (NOT_TYPED.test(text)) {
    return
  }
  const key = typedKey(await io.sessionId())
  const typed = ((await io.get(key)) as string | undefined) ?? ''
  await io.set(key, `${typed}${text}\n`.slice(-TYPED_LIMIT))
}

export async function enqueueEnded(io: Host, sessionId: string, cwd: string): Promise<void> {
  const typed = ((await io.get(typedKey(sessionId))) as string | undefined) ?? ''
  if (typed.length < MIN_TYPED) {
    await io.remove(typedKey(sessionId))
    return
  }
  await io.set('queue', [...(await queued(io)).filter(item => item.sessionId !== sessionId), { sessionId, cwd }])
}

export async function learnNext(io: Host): Promise<void> {
  const now = await io.now()
  const due = (await queued(io)).filter(item => (item.retryAt ?? 0) <= now)
  if (isRunning || due.length === 0) {
    return
  }
  const skills = await ensureSkillsRepo(io)
  const lease = await takeLease(io, skills)
  if (!lease) {
    return
  }
  isRunning = true
  try {
    const ready = await nextReady(io, due)
    if (ready) {
      await learnFrom(io, skills, ready)
    }
  } finally {
    isRunning = false
    await releaseLease(io, skills, lease)
  }
}

// A busy item waits as a failed one does, without using an attempt, so turns do not keep checking it.
async function nextReady(io: Host, due: QueuedSession[]): Promise<Ready | undefined> {
  for (const item of due) {
    const worktree = await prepareWorktree(io, item.cwd)
    if (worktree !== 'busy') {
      return { item, worktree }
    }
    await setRetry(io, item, { retryAt: (await io.now()) + RETRY_AFTER_MS })
  }
  return undefined
}

async function learnFrom(io: Host, skills: string, { item, worktree }: Ready): Promise<void> {
  const runDir = `${io.home}/.claude/learned/run`
  await io.write(`${runDir}/README.md`, 'The learning run starts here, in a folder with no settings.\n')
  const project = worktree === 'ready' || worktree === 'unsynced' ? repoPath(io, 'project') : null
  // The files it reads lie outside the folder it starts in, and a read there needs a person under -p otherwise.
  const readable = [skills, io.pluginRoot, ...(project ? [project] : []), ...((await io.exists(item.cwd)) ? [item.cwd] : [])]
  const { code, output } = await io.claude(runArgs(readable), await buildPrompt(io, skills, item, worktree), runDir)
  if (code === null) {
    return
  }
  const summary = `${io.home}/.claude/learned/${item.sessionId}.md`
  const rules = parseRules(output)
  if (code !== 0 || rules === null) {
    await io.write(summary, output)
    await retryLater(io, item, summary)
    return
  }
  const applied = await applyRules(io, rules, { personal: skills, project })
  await io.write(summary, [output, ...applied.refused.map(refusal => `Not applied: ${refusal}`)].join('\n'))
  await finish(io, item)
  if (applied.refused.length > 0) {
    io.notify(`${applied.refused.length} learned rule(s) were not applied. See ${summary}`)
  }
  if (applied.committed > 0) {
    io.notify(`${applied.committed} rule(s) suggested. Accept or reject each with /learned.`)
  }
}

async function retryLater(io: Host, item: QueuedSession, summary: string): Promise<void> {
  const attempts = (item.attempts ?? 0) + 1
  if (attempts >= MAX_ATTEMPTS) {
    await finish(io, item)
    io.notify(`The learning run failed ${MAX_ATTEMPTS} times; that session's corrections were dropped. See ${summary}`)
    return
  }
  await setRetry(io, item, { attempts, retryAt: (await io.now()) + RETRY_AFTER_MS })
  io.notify(`The learning run failed; it tries again in 30 minutes. See ${summary}`)
}

async function setRetry(io: Host, item: QueuedSession, retry: Pick<QueuedSession, 'attempts' | 'retryAt'>): Promise<void> {
  await io.set('queue', (await queued(io)).map(queuedItem => (queuedItem.sessionId === item.sessionId ? { ...queuedItem, ...retry } : queuedItem)))
}

async function finish(io: Host, item: QueuedSession): Promise<void> {
  await io.set('queue', (await queued(io)).filter(queuedItem => queuedItem.sessionId !== item.sessionId))
  await io.remove(typedKey(item.sessionId))
}

const WORKTREE_NOTES: Record<WorktreeState, string> = {
  ready: 'on the branch docs/learned-rules, up to date with the latest main',
  unsynced: 'on the branch docs/learned-rules; its earlier rules could not be rebased onto main, so add to it as it is',
  busy: '',
  none: '',
}
const NO_WORKTREE = 'none: no repository worktree could be prepared for this session, so skip repo rules'

async function buildPrompt(io: Host, skills: string, item: QueuedSession, worktree: WorktreeState): Promise<string> {
  const template = (await io.read(`${io.pluginRoot}/prompts/learn.md`)) ?? ''
  const instructions = template
    .replaceAll('{{CWD}}', item.cwd)
    .replaceAll('{{PLUGIN_ROOT}}', io.pluginRoot)
    .replaceAll('{{SKILLS}}', skills)
    .replaceAll('{{WORKTREE}}', WORKTREE_NOTES[worktree] ? `${repoPath(io, 'project')}, ${WORKTREE_NOTES[worktree]}` : NO_WORKTREE)
  const typed = ((await io.get(typedKey(item.sessionId))) as string | undefined) ?? ''
  const inventory = await enforcerInventory(io, item.cwd)
  return [instructions, 'The enforcers that exist:', '-----', inventory, '-----', "The user's messages:", '-----', typed, '-----'].join('\n')
}

// Personal rules are commits in ~/.claude/skills, so /learned can accept or revert each one.
async function ensureSkillsRepo(io: Host): Promise<string> {
  const skills = `${io.home}/.claude/skills`
  if ((await io.run(['git', '-C', skills, 'rev-parse', '--git-dir'])).exitCode === 0) {
    return skills
  }
  await io.run(['git', 'init', '-q', skills])
  await io.run(['git', '-C', skills, 'add', '-A'])
  await io.run(['git', '-C', skills, 'commit', '-q', '--allow-empty', '-m', 'skills before learned rules'])
  return skills
}

async function queued(io: Host): Promise<QueuedSession[]> {
  return ((await io.get('queue')) as QueuedSession[] | undefined) ?? []
}
