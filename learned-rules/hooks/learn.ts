import { enforcerInventory } from './inventory'
import type { Host } from './host'

export type QueuedSession = { sessionId: string; cwd: string }

const TYPED_LIMIT = 80000
const MIN_TYPED = 400
const LEASE_MS = 60 * 60 * 1000
// Not what the user typed: reminders, notifications, skill bodies, markup and interrupts.
const NOT_TYPED = /system-reminder|task-notification|Base directory for this skill|^\s*<|^\[Request interrupted/

const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'Bash(git fetch *)', 'Bash(git worktree *)', 'Bash(git -C *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git reset *)', 'Bash(git rebase *)',
  'Bash(mkdir *)', 'Bash(ls *)',
].join(',')
const DISALLOWED_TOOLS = 'Bash(git push*),Bash(git -C * push*),Bash(gh *)'

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
  const queue = await queued(io)
  await io.set('queue', [...queue.filter(item => item.sessionId !== sessionId), { sessionId, cwd }])
}

export async function learnNext(io: Host): Promise<void> {
  const [next] = await queued(io)
  if (isRunning || !next || !(await takeLease(io))) {
    return
  }
  isRunning = true
  try {
    await learnFrom(io, next)
  } finally {
    isRunning = false
    await io.remove('lease')
  }
}

async function learnFrom(io: Host, item: QueuedSession): Promise<void> {
  const prompt = await buildPrompt(io, item)
  await ensureSkillsRepo(io)
  const { code, output } = await io.claude(
    ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS, '--disallowedTools', DISALLOWED_TOOLS],
    prompt,
    item.cwd,
  )
  if (code === null) {
    return
  }
  const summary = `${io.home}/.claude/learned/${item.sessionId}.md`
  await io.write(summary, output)
  await io.set('queue', (await queued(io)).filter(queuedItem => queuedItem.sessionId !== item.sessionId))
  await io.remove(typedKey(item.sessionId))

  const suggested = Number(output.match(/^SUGGESTED: (\d+)\s*$/m)?.[1] ?? NaN)
  if (code !== 0 || Number.isNaN(suggested)) {
    io.notify(`The learning run failed. See ${summary}`)
    return
  }
  if (suggested > 0) {
    io.notify(`${suggested} rule(s) suggested. Accept or reject each with /learned.`)
  }
}

async function buildPrompt(io: Host, item: QueuedSession): Promise<string> {
  const template = (await io.read(`${io.pluginRoot}/prompts/learn.md`)) ?? ''
  const instructions = template.replaceAll('{{CWD}}', item.cwd).replaceAll('{{PLUGIN_ROOT}}', io.pluginRoot)
  const typed = ((await io.get(typedKey(item.sessionId))) as string | undefined) ?? ''
  return [
    instructions,
    'The enforcers that exist:',
    '-----',
    await enforcerInventory(io, item.cwd),
    '-----',
    "The user's messages:",
    '-----',
    typed,
    '-----',
  ].join('\n')
}

// Personal rules are commits in ~/.claude/skills, so /learned can accept or revert each one.
async function ensureSkillsRepo(io: Host): Promise<void> {
  const skills = `${io.home}/.claude/skills`
  if ((await io.run(['git', '-C', skills, 'rev-parse', '--git-dir'])).exitCode === 0) {
    return
  }
  await io.run(['git', 'init', '-q', skills])
  await io.run(['git', '-C', skills, 'add', '-A'])
  await io.run(['git', '-C', skills, 'commit', '-q', '--allow-empty', '-m', 'skills before learned rules'])
}

async function queued(io: Host): Promise<QueuedSession[]> {
  return ((await io.get('queue')) as QueuedSession[] | undefined) ?? []
}

// Every open session may try; the one whose write is read back holds the lease until its run ends or the lease expires.
async function takeLease(io: Host): Promise<boolean> {
  const now = await io.now()
  const me = await io.sessionId()
  const lease = (await io.get('lease')) as { owner: string; until: number } | undefined
  if (lease && lease.owner !== me && lease.until > now) {
    return false
  }
  await io.set('lease', { owner: me, until: now + LEASE_MS })
  const held = (await io.get('lease')) as { owner: string } | undefined
  return held?.owner === me
}
