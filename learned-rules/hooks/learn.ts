import { enforcerInventory } from './inventory'
import type { Host } from './host'
import { releaseLease, takeLease } from './lease'
import { worktreeFits } from './worktree'

export type QueuedSession = { sessionId: string; cwd: string; attempts?: number; retryAt?: number }

const TYPED_LIMIT = 80000
const MIN_TYPED = 400
const MAX_ATTEMPTS = 3
const RETRY_AFTER_MS = 30 * 60 * 1000
// Not what the user typed: reminders, notifications, skill bodies, markup and interrupts.
const NOT_TYPED = /system-reminder|task-notification|Base directory for this skill|^\s*<|^\[Request interrupted/

// The typed text steers the run, so it may write only rule files, and git is kept from running other commands
// (config, -c, aliases, submodules, --exec, transport helpers).
const ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Edit(~/.claude/skills/**)', 'Write(~/.claude/skills/**)',
  'Edit(~/.claude/learned/repo-worktree/**)', 'Write(~/.claude/learned/repo-worktree/**)',
  'Bash(git fetch *)', 'Bash(git worktree *)', 'Bash(git -C *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git reset *)', 'Bash(git rebase *)',
  'Bash(mkdir *)', 'Bash(ls *)',
].join(',')
const DISALLOWED_TOOLS = [
  'Bash(git push*)', 'Bash(git * push*)', 'Bash(gh *)', 'Bash(git -c *)', 'Bash(git * -c *)', 'Bash(git config*)',
  'Bash(git * config*)', 'Bash(git * submodule*)', 'Bash(git * --exec*)', 'Bash(git * -x *)', 'Bash(git * filter-branch*)',
  'Bash(git * bisect*)', 'Bash(git * difftool*)', 'Bash(git * mergetool*)', 'Bash(git * --upload-pack*)',
  'Bash(git * --receive-pack*)', 'Bash(git * ext::*)',
].join(',')

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
  await saveQueue(io, [...(await queued(io)).filter(item => item.sessionId !== sessionId), { sessionId, cwd }])
}

export async function learnNext(io: Host): Promise<void> {
  if (isRunning || (await queued(io)).length === 0) {
    return
  }
  const skills = await ensureSkillsRepo(io)
  const lease = await takeLease(io, skills)
  if (!lease) {
    return
  }
  isRunning = true
  try {
    const item = await nextReady(io)
    if (item) {
      await learnFrom(io, item)
    }
  } finally {
    isRunning = false
    await releaseLease(io, skills, lease)
  }
}

async function nextReady(io: Host): Promise<QueuedSession | undefined> {
  const now = await io.now()
  for (const item of await queued(io)) {
    if ((item.retryAt ?? 0) <= now && (await worktreeFits(io, item.cwd))) {
      return item
    }
  }
  return undefined
}

async function learnFrom(io: Host, item: QueuedSession): Promise<void> {
  const { code, output } = await io.claude(
    ['-p', '--permission-mode', 'default', '--allowedTools', ALLOWED_TOOLS, '--disallowedTools', DISALLOWED_TOOLS],
    await buildPrompt(io, item),
    item.cwd,
  )
  if (code === null) {
    return
  }
  const summary = `${io.home}/.claude/learned/${item.sessionId}.md`
  await io.write(summary, output)
  const suggested = Number(output.match(/^SUGGESTED: (\d+)\s*$/m)?.[1] ?? NaN)
  if (code === 0 && !Number.isNaN(suggested)) {
    await finish(io, item)
    if (suggested > 0) {
      io.notify(`${suggested} rule(s) suggested. Accept or reject each with /learned.`)
    }
    return
  }
  await retryLater(io, item, summary)
}

// A failed run (an expired login, a usage limit) keeps the session's corrections and tries again later, up to a cap.
async function retryLater(io: Host, item: QueuedSession, summary: string): Promise<void> {
  const attempts = (item.attempts ?? 0) + 1
  if (attempts >= MAX_ATTEMPTS) {
    await finish(io, item)
    io.notify(`The learning run failed ${MAX_ATTEMPTS} times; that session's corrections were dropped. See ${summary}`)
    return
  }
  const retryAt = (await io.now()) + RETRY_AFTER_MS
  await saveQueue(io, (await queued(io)).map(queuedItem => (queuedItem.sessionId === item.sessionId ? { ...queuedItem, attempts, retryAt } : queuedItem)))
  io.notify(`The learning run failed; it tries again in 30 minutes. See ${summary}`)
}

async function finish(io: Host, item: QueuedSession): Promise<void> {
  await saveQueue(io, (await queued(io)).filter(queuedItem => queuedItem.sessionId !== item.sessionId))
  await io.remove(typedKey(item.sessionId))
}

async function buildPrompt(io: Host, item: QueuedSession): Promise<string> {
  const template = (await io.read(`${io.pluginRoot}/prompts/learn.md`)) ?? ''
  const instructions = template.replaceAll('{{CWD}}', item.cwd).replaceAll('{{PLUGIN_ROOT}}', io.pluginRoot)
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

async function saveQueue(io: Host, queue: QueuedSession[]): Promise<void> {
  await io.set('queue', queue)
}
