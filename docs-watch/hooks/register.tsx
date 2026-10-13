import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { BranchState, LogEntry, Missing, Status, Tracked } from '../types'
import { describeMissing, dueForPopup, githubRepoOf, missingRequirements, popupText } from './requirements'
import type { Facts } from './requirements'
import { describe, docsTitleFrom, lastLine, onlyDocsTestsCi, parseJson, prBody, prTitle, slug } from './text'

const PANE = 'docs-watch'
const TICK_MS = 5 * 60 * 1000
const FIRST_TICK_MS = 20 * 1000
const DRAFT_TIMEOUT_MS = 45 * 60 * 1000
const DIFF_LIMIT = 60000
const RESOLVE_CHECK_MS = 15 * 1000
// A push runs git and gh in one session; a flag older than this was left by a session that ended mid-push.
const PUSH_STALE_MS = 10 * 60 * 1000
// One branch per repository collects every approved update, so many merged PRs ship as one docs PR. Approving
// pushes it; there is no separate push step.
const BRANCH = 'docs/updates'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const SHOWN: readonly Status[] = ['suggested', 'applying', 'resolving', 'approved', 'pushed', 'approving', 'pr-open', 'failed']
const LOG_KEY = 'log'
const LOG_LIMIT = 100
const RECHECK_MS = 30 * 1000
const POPUP_MS = 15 * 1000

const shown = atom({ plugin: 'docs-watch', key: 'shown' } as const, null)
const diff = atom({ plugin: 'docs-watch', key: 'diff' } as const, null)
const setup = atom({ plugin: 'docs-watch', key: 'setup' } as const, null)
const errors = atom({ plugin: 'docs-watch', key: 'errors' } as const, null)
const branches = atom({ plugin: 'docs-watch', key: 'branches' } as const, null)
const popups = atom({ plugin: 'docs-watch', key: 'popups' } as const, null)

// This session's id for the poller lease: only one open session polls GitHub at a time.
const me = Math.random().toString(36).slice(2)
// The checkout this session runs in, for the repository access check; set at session start.
let sessionCheckout: string | undefined
let lastRecheck = Number.NEGATIVE_INFINITY

// Every failure goes to the debug log and to the mod's own log, which the pane shows; logging itself never throws.
async function logError($: Engine, where: string, detail: unknown, key?: string): Promise<void> {
  const message = describe(detail).slice(0, 2000)
  try {
    $.ui.log(`docs-watch ${where}${key ? ` (${key})` : ''}: ${message}`, { to: 'debug' })
  } catch {
    // the debug log is best effort
  }
  try {
    const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
    const entry: LogEntry = { at: Date.now(), where, message, key }
    await $.store.set(LOG_KEY, [...log.slice(-(LOG_LIMIT - 1)), entry])
  } catch {
    // the store failing leaves the debug log line as the only record
  }
}

async function run($: Engine, argv: string[], cwd?: string) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs: 120000 })
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: describe(error) }
  }
}

// A command whose failure matters: a non-zero exit is logged with the command and the last line of its output.
async function runLogged($: Engine, where: string, argv: string[], cwd?: string, key?: string) {
  const result = await run($, argv, cwd)
  if (result.exitCode !== 0) {
    await logError($, where, `\`${argv.join(' ').slice(0, 200)}\` exited ${result.exitCode}: ${lastLine(result)}`, key)
    const tool = argv[0]
    if (tool === 'git' || tool === 'gh') {
      await recheckAfterFailure($, tool)
    }
  }
  return result
}

async function recentErrors($: Engine): Promise<LogEntry[]> {
  const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  return log.slice(-10).reverse()
}

// What this machine lacks: git, claude and gh on PATH, gh logged in to github.com, and this session's repository
// reachable and pushable with that login. Only exit codes and the permission name are read, so no token is ever shown.
async function checkRequirements($: Engine): Promise<Missing[]> {
  const os = (await run($, ['uname'])).stdout.trim()
  const git = (await run($, ['git', '--version'])).exitCode === 0
  const claude = (await run($, ['claude', '--version'])).exitCode === 0
  const gh = (await run($, ['gh', '--version'])).exitCode === 0
  const ghAuth = gh ? (await run($, ['gh', 'auth', 'status', '--hostname', 'github.com'])).exitCode === 0 : null
  const repo = git && ghAuth && sessionCheckout ? await repoAccess($, sessionCheckout) : null
  return missingRequirements({ os, git, claude, gh, ghAuth, repo })
}

async function repoAccess($: Engine, checkout: string): Promise<Facts['repo']> {
  const remote = await run($, ['git', '-C', checkout, 'remote', 'get-url', 'origin'])
  const name = remote.exitCode === 0 ? githubRepoOf(remote.stdout) : null
  if (!name) {
    return null
  }
  const view = await run($, ['gh', 'repo', 'view', name, '--json', 'viewerPermission', '-q', '.viewerPermission'])
  return { name, permission: view.exitCode === 0 ? view.stdout.trim() : null }
}

// The band shows what blocks the mod; a toast pops up each missing requirement once per session, and again when an
// action using its tool failed.
async function showRequirements($: Engine, missing: Missing[], failedTool?: string): Promise<void> {
  await update($, setup, () => missing)
  const now = await $.clock.now()
  let due: Missing[] = []
  await update($, popups, (seen) => {
    const shownAt = seen ?? {}
    due = dueForPopup(missing, shownAt, now, failedTool)
    return { ...shownAt, ...Object.fromEntries(due.map((m) => [m.id, now])) }
  })
  if (due.length > 0) {
    $.ui.toast(popupText(due), { timeoutMs: POPUP_MS })
  }
}

async function recheckAfterFailure($: Engine, tool: 'git' | 'gh'): Promise<void> {
  const now = await $.clock.now()
  if (now - lastRecheck < RECHECK_MS) {
    return
  }
  lastRecheck = now
  const missing = await checkRequirements($)
  await showRequirements($, missing, tool)
}

const blocking = (missing: Missing[]) => missing.filter((m) => m.blocks)

async function stateDir($: Engine): Promise<string> {
  const env = await runLogged($, 'home', ['printenv', 'HOME'])
  return `${env.stdout.trim()}/.claude/docs-watch`
}

// macOS: with terminal-notifier a click brings Claude to the front, where the line above the prompt has the action, and
// a newer notice replaces the last one. Without it a click does nothing, so the text names the step.
async function notify($: Engine, text: string): Promise<void> {
  $.ui.toast(text)
  const os = await run($, ['uname'])
  if (os.stdout.trim() !== 'Darwin') {
    return
  }
  const notifier = await run($, ['terminal-notifier', '-title', 'Claude: docs', '-message', text, '-activate', CLAUDE_APP, '-group', 'docs-watch'])
  if (notifier.exitCode === 0) {
    return
  }
  const script = `display notification ${JSON.stringify(`${text} Open Claude and run /docs-watch.`)} with title "Claude: docs"`
  await runLogged($, 'notify', ['osascript', '-e', script])
}

async function toplevel($: Engine): Promise<string | undefined> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'])
  return top.exitCode === 0 ? top.stdout.trim() : undefined
}

// The repository this session works in, so the poller knows where to make worktrees.
async function registerRepo($: Engine): Promise<void> {
  const checkout = sessionCheckout
  if (!checkout) {
    return
  }
  const name = await runLogged($, 'register repo', ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], checkout)
  if (name.exitCode !== 0) {
    return
  }
  await $.store.set(`repo:${name.stdout.trim()}`, checkout)
}

async function registeredRepos($: Engine): Promise<string[]> {
  return (await $.store.keys()).filter((k) => k.startsWith('repo:')).map((k) => k.slice('repo:'.length))
}

async function checkoutOf($: Engine, repo: string): Promise<string | undefined> {
  return (await $.store.get(`repo:${repo}`)) as string | undefined
}

async function allTracked($: Engine): Promise<Tracked[]> {
  const keys = await $.store.keys()
  const tracked: Tracked[] = []
  for (const key of keys.filter((k) => k.startsWith('pr:'))) {
    const value = (await $.store.get(key)) as Tracked | undefined
    if (value) {
      tracked.push(value)
    }
  }
  return tracked
}

async function save($: Engine, tracked: Tracked): Promise<void> {
  await $.store.set(`pr:${tracked.key}`, tracked)
}

async function visible($: Engine): Promise<Tracked[]> {
  const tracked = await allTracked($)
  return tracked.filter((t) => SHOWN.includes(t.status) || (t.status === 'drafting' && t.pendingStart))
}

async function holdsLease($: Engine, now: number): Promise<boolean> {
  const lease = (await $.store.get('lease')) as { owner: string; until: number } | undefined
  if (lease && lease.owner !== me && lease.until > now) {
    return false
  }
  await $.store.set('lease', { owner: me, until: now + 2 * TICK_MS })
  return true
}

async function branchState($: Engine, repo: string): Promise<BranchState> {
  return ((await $.store.get(`branch:${repo}`)) as BranchState | undefined) ?? {}
}

async function saveBranchState($: Engine, repo: string, state: BranchState): Promise<void> {
  await $.store.set(`branch:${repo}`, state)
}

async function branchWorktree($: Engine, repo: string): Promise<string> {
  return `${await stateDir($)}/branch/${slug(repo)}`
}

// Null while the file does not exist yet; a file that is there but not JSON is logged.
async function readResult($: Engine, file: string, key: string): Promise<Record<string, unknown> | null> {
  const out = await run($, ['cat', file])
  if (out.exitCode !== 0) {
    return null
  }
  const parsed = parseJson<Record<string, unknown>>(out.stdout)
  if (parsed === null) {
    await logError($, 'result file', `${file} is not JSON: ${out.stdout.slice(0, 200)}`, key)
  }
  return parsed
}

async function removeWorktree($: Engine, t: Tracked): Promise<void> {
  if (t.checkout && t.work) {
    await runLogged($, 'remove worktree', ['git', '-C', t.checkout, 'worktree', 'remove', '--force', t.work], undefined, t.key)
  }
}

async function defaultBase($: Engine, checkout: string): Promise<string> {
  const head = await run($, ['git', '-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
}

// Subagents start only from a session. When the engine refuses or fails to start one (as it may from a timer), the item
// waits with `pendingStart` and the next turn, `/docs-watch` or session start tries again; each refusal is logged.
async function spawnFor($: Engine, t: Tracked, where: string, spec: { prompt: string; subagentType: string; description: string; cwd?: string }): Promise<void> {
  let problem = ''
  try {
    const started = await $.agent.spawn(spec)
    if ('deny' in started && started.deny) {
      problem = `subagent refused: ${JSON.stringify(started.deny)}`
    } else if (!started.agentId) {
      problem = 'subagent did not start (no agent id)'
    } else {
      await save($, { ...t, agentId: started.agentId, pendingStart: undefined, note: undefined, error: undefined, startedAt: Date.now() })
      return
    }
  } catch (error) {
    problem = `subagent failed to start: ${describe(error)}`
  }
  await logError($, where, problem, t.key)
  await save($, { ...t, pendingStart: true, error: problem })
}

// The worktree on the shared branch, created from the default branch the first time.
async function ensureBranch($: Engine, repo: string, checkout: string): Promise<string | null> {
  const work = await branchWorktree($, repo)
  if ((await run($, ['git', '-C', work, 'rev-parse', '--git-dir'])).exitCode === 0) {
    return work
  }
  await runLogged($, 'docs branch', ['mkdir', '-p', `${await stateDir($)}/branch`])
  await runLogged($, 'docs branch', ['git', '-C', checkout, 'worktree', 'prune'])
  const hasBranch = await run($, ['git', '-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`])
  const added = hasBranch.exitCode === 0
    ? await runLogged($, 'docs branch', ['git', '-C', checkout, 'worktree', 'add', work, BRANCH])
    : await runLogged($, 'docs branch', ['git', '-C', checkout, 'worktree', 'add', '-b', BRANCH, work, await defaultBase($, checkout)])
  return added.exitCode === 0 ? work : null
}

// A conflicting cherry-pick is left in progress for the docs-merge agent to resolve.
async function replay($: Engine, branch: string, commit: string): Promise<'applied' | 'conflict'> {
  const picked = await run($, ['git', '-C', branch, 'cherry-pick', '--allow-empty', commit])
  return picked.exitCode === 0 ? 'applied' : 'conflict'
}

async function picking($: Engine, branch: string): Promise<boolean> {
  return (await run($, ['git', '-C', branch, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'])).exitCode === 0
}

// Restarts the branch from the latest default branch and queues the approvals still to ship to land again, through
// the same queue as a new approval, so a conflict with the new main is resolved the same way. Returns the base commit.
async function rebuild($: Engine, branch: string, checkout: string, keep: Tracked[]): Promise<string> {
  if ((await picking($, branch)) || (await run($, ['git', '-C', branch, 'status', '--porcelain'])).stdout.trim() !== '') {
    return ''
  }
  await runLogged($, 'rebuild', ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const base = await defaultBase($, checkout)
  await runLogged($, 'rebuild', ['git', '-C', branch, 'reset', '-q', '--hard', base])
  for (const t of keep) {
    await save($, { ...t, status: 'applying' })
  }
  return (await runLogged($, 'rebuild', ['git', '-C', checkout, 'rev-parse', base])).stdout.trim()
}

// Lands approvals on the shared branch one at a time, oldest first. A conflict goes to the docs-merge agent and the
// queue waits for it. Once nothing is left to land, the branch is pushed.
async function applyNext($: Engine, repo: string): Promise<void> {
  const checkout = await checkoutOf($, repo)
  const branch = checkout ? await ensureBranch($, repo, checkout) : null
  if (!branch || (await picking($, branch))) {
    return
  }
  for (;;) {
    const mine = (await allTracked($)).filter((t) => t.repo === repo)
    if (mine.some((t) => t.status === 'resolving')) {
      return
    }
    const next = mine.filter((t) => t.status === 'applying').sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))[0]
    if (!next) {
      if (mine.some((t) => t.status === 'approved')) {
        await requestPush($, repo)
      }
      return
    }
    if (!next.commit) {
      await logError($, 'apply', 'its commit is missing', next.key)
      await save($, { ...next, status: 'failed', error: 'its commit is missing; clear it and it drafts again after the next merge' })
      continue
    }
    if ((await replay($, branch, next.commit)) === 'applied') {
      await save($, { ...next, status: 'approved', landedAt: Date.now() })
      continue
    }
    await startResolve($, next, branch)
    return
  }
}

async function startResolve($: Engine, t: Tracked, branch: string): Promise<void> {
  const result = `${await stateDir($)}/results/${slug(t.key)}.merge.json`
  await runLogged($, 'resolve', ['rm', '-f', result], undefined, t.key)
  const resolving: Tracked = { ...t, status: 'resolving', startedAt: Date.now() }
  await save($, resolving)
  await startMerger($, resolving, branch, result)
  await notify($, `Resolving a docs conflict for ${t.key}…`)
}

async function startMerger($: Engine, t: Tracked, branch: string, result: string): Promise<void> {
  const prompt = [
    `Repository ${t.repo}. In this worktree (${branch}), branch ${BRANCH} has a cherry-pick in progress that conflicts:`,
    `the documentation update after merged pull request #${t.number} ("${t.title ?? ''}"; ${t.summary ?? ''}) against updates`,
    `already on the branch. Write your result file to ${result}.`,
  ].join(' ')
  await spawnFor($, t, 'resolve', { prompt, subagentType: 'docs-watch:docs-merge', description: `Resolve docs conflict for ${t.key}`, cwd: branch })
}

async function checkResolve($: Engine, t: Tracked): Promise<void> {
  if (t.pendingStart) {
    return
  }
  const branch = await branchWorktree($, t.repo)
  const result = await readResult($, `${await stateDir($)}/results/${slug(t.key)}.merge.json`, t.key)
  if (!result && Date.now() - (t.startedAt ?? 0) <= DRAFT_TIMEOUT_MS) {
    return
  }
  if (result?.ok === true && !(await picking($, branch))) {
    await save($, { ...t, status: 'approved', landedAt: Date.now() })
  } else {
    await runLogged($, 'resolve', ['git', '-C', branch, 'cherry-pick', '--abort'], undefined, t.key)
    const reason = result ? String(result.error ?? 'the conflict was not resolved') : 'the conflict was not resolved in time'
    await logError($, 'resolve', reason, t.key)
    await save($, { ...t, status: 'failed', error: reason })
    await notify($, `A docs conflict for ${t.key} could not be resolved: ${reason}`)
  }
  await applyNext($, t.repo)
}

async function startDraft($: Engine, t: Tracked): Promise<void> {
  const checkout = await checkoutOf($, t.repo)
  if (!checkout) {
    await logError($, 'draft', `no local checkout registered for ${t.repo}: open a Claude Code session in it`, t.key)
    return
  }
  const dir = await stateDir($)
  const work = `${dir}/work/${slug(t.key)}`
  await runLogged($, 'draft', ['mkdir', '-p', `${dir}/work`, `${dir}/results`], undefined, t.key)
  await runLogged($, 'draft', ['git', '-C', checkout, 'fetch', '-q', 'origin'], undefined, t.key)
  const base = await defaultBase($, checkout)
  await run($, ['git', '-C', checkout, 'worktree', 'remove', '--force', work])
  const added = await runLogged($, 'draft', ['git', '-C', checkout, 'worktree', 'add', '--detach', work, base], undefined, t.key)
  if (added.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: lastLine(added) })
    return
  }
  const drafting: Tracked = { ...t, status: 'drafting', checkout, work, base, startedAt: Date.now() }
  await save($, drafting)
  await startWriter($, drafting, `${dir}/results/${slug(t.key)}.json`, '')
}

async function startWriter($: Engine, t: Tracked, result: string, note: string): Promise<void> {
  const lines = [
    'Use the docs-watch:update-docs skill (call the Skill tool with it) and follow it exactly.',
    `PR: ${t.repo}#${t.number} ("${t.title ?? ''}").`,
    `Worktree: ${t.work}`,
    `Result file: ${result}`,
  ]
  if (note) {
    lines.push(`Note: ${note}`)
  }
  const prompt = lines.join('\n')
  const spec = { prompt, subagentType: 'general-purpose', description: `Docs after ${t.key}`, cwd: t.work }
  await spawnFor($, { ...t, note: note || undefined }, 'draft', spec)
}

// Starts the drafts and conflict resolutions that are waiting for a session to take them.
async function startPending($: Engine): Promise<void> {
  try {
    const dir = await stateDir($)
    for (const t of await allTracked($)) {
      if (t.status === 'drafting' && t.pendingStart) {
        await startWriter($, t, `${dir}/results/${slug(t.key)}.json`, t.note ?? '')
      } else if (t.status === 'resolving' && t.pendingStart) {
        await startMerger($, t, await branchWorktree($, t.repo), `${dir}/results/${slug(t.key)}.merge.json`)
      }
    }
  } catch (error) {
    await logError($, 'start pending', error)
  }
}

async function checkDraft($: Engine, t: Tracked): Promise<void> {
  const dir = await stateDir($)
  const result = await readResult($, `${dir}/results/${slug(t.key)}.json`, t.key)
  if (!result) {
    if (!t.pendingStart && Date.now() - (t.startedAt ?? 0) > DRAFT_TIMEOUT_MS) {
      const where = t.agentId ? ` (agent ${t.agentId})` : ''
      const error = `the draft wrote no result file within ${DRAFT_TIMEOUT_MS / 60000} minutes${where}`
      await logError($, 'draft', error, t.key)
      await save($, { ...t, status: 'failed', error })
    }
    return
  }
  const work = t.work ?? ''
  await runLogged($, 'draft', ['git', '-C', work, 'add', '-A'], undefined, t.key)
  const changes = await runLogged($, 'draft', ['git', '-C', work, 'diff', '--cached'], undefined, t.key)
  const text = changes.stdout
  if (text.trim() === '') {
    await removeWorktree($, t)
    await save($, { ...t, status: 'no-change' })
    return
  }
  const summary = typeof result.summary === 'string' ? result.summary : 'Documentation update'
  const docsTitle = typeof result.title === 'string' && result.title.startsWith('docs: ') ? result.title : docsTitleFrom(t)
  await save($, { ...t, status: 'suggested', summary, docsTitle, diff: text.slice(0, DIFF_LIMIT) })
  await notify($, `${t.key} merged: docs update suggested. Review with /docs-watch.`)
}

// One poll: track the person's open PRs in every repository a session registered, and move each tracked PR on.
async function tick($: Engine): Promise<void> {
  try {
    await poll($)
  } catch (error) {
    await logError($, 'poll', error)
  }
}

async function poll($: Engine): Promise<void> {
  const missing = await checkRequirements($)
  await showRequirements($, missing)
  const blocked = blocking(missing)
  if (blocked.length > 0) {
    await logError($, 'setup', blocked.map(describeMissing).join('; '))
    return
  }
  if (!(await holdsLease($, Date.now()))) {
    return
  }
  const repos = await registeredRepos($)
  for (const repo of repos) {
    const open = await runLogged($, 'list PRs', ['gh', 'pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--json', 'number,title,url'])
    if (open.exitCode !== 0) {
      continue
    }
    const prs = parseJson<{ number: number; title: string; url: string }[]>(open.stdout)
    if (prs === null) {
      await logError($, 'list PRs', `gh returned something that is not JSON for ${repo}: ${open.stdout.slice(0, 200)}`)
      continue
    }
    for (const pr of prs) {
      const key = `${repo}#${pr.number}`
      if (!(await $.store.get(`pr:${key}`))) {
        await save($, { key, repo, number: pr.number, title: pr.title, url: pr.url, status: 'open' })
      }
    }
  }
  for (const t of await allTracked($)) {
    if (t.status === 'open') {
      await checkMerged($, t)
    } else if (t.status === 'drafting') {
      await checkDraft($, t)
    } else if (t.status === 'resolving') {
      await checkResolve($, t)
    }
  }
  for (const repo of repos) {
    await checkBranch($, repo)
  }
}

async function checkMerged($: Engine, t: Tracked): Promise<void> {
  const view = await runLogged($, 'check PR', ['gh', 'pr', 'view', String(t.number), '--repo', t.repo, '--json', 'state,files'], undefined, t.key)
  if (view.exitCode !== 0) {
    return
  }
  const info = parseJson<{ state: string; files: { path: string }[] }>(view.stdout)
  if (info === null) {
    await logError($, 'check PR', `gh returned something that is not JSON: ${view.stdout.slice(0, 200)}`, t.key)
    return
  }
  if (info.state === 'CLOSED') {
    await save($, { ...t, status: 'closed' })
  } else if (info.state === 'MERGED') {
    const skip = onlyDocsTestsCi(info.files.map((f) => f.path))
    await (skip ? save($, { ...t, status: 'skipped' }) : startDraft($, t))
  }
}

// Moves a repository's shared branch on with GitHub: its PR merged or closed, and main moving while nothing is pushed.
async function checkBranch($: Engine, repo: string): Promise<void> {
  const state = await branchState($, repo)
  if (state.pushing && Date.now() - (state.pushStartedAt ?? 0) < PUSH_STALE_MS) {
    return
  }
  const checkout = await checkoutOf($, repo)
  const branch = await branchWorktree($, repo)
  if (!checkout || (await run($, ['git', '-C', branch, 'rev-parse', '--git-dir'])).exitCode !== 0) {
    return
  }
  if (state.prUrl) {
    const view = await runLogged($, 'docs PR', ['gh', 'pr', 'view', state.prUrl, '--json', 'state', '-q', '.state'])
    const prState = view.stdout.trim()
    if (view.exitCode !== 0 || (prState !== 'MERGED' && prState !== 'CLOSED')) {
      return
    }
    // Merged: its updates are done. Closed unmerged: they go back to approved and are pushed in a new PR.
    for (const t of await allTracked($)) {
      if (t.repo === repo && t.status === 'pushed') {
        await save($, { ...t, status: prState === 'MERGED' ? 'merged' : 'approved' })
      }
    }
    const keep = (await allTracked($)).filter((t) => t.repo === repo && t.status === 'approved')
    const baseSha = await rebuild($, branch, checkout, keep)
    await saveBranchState($, repo, { baseSha: baseSha || state.baseSha })
    await applyNext($, repo)
    await notify($, prState === 'MERGED' ? `Docs PR merged for ${repo}.` : `Docs PR closed for ${repo}; its updates are back to approved.`)
    return
  }
  await runLogged($, 'docs branch', ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const head = (await run($, ['git', '-C', checkout, 'rev-parse', await defaultBase($, checkout)])).stdout.trim()
  if (head && head !== state.baseSha) {
    const keep = (await allTracked($)).filter((t) => t.repo === repo && t.status === 'approved')
    const baseSha = await rebuild($, branch, checkout, keep)
    await saveBranchState($, repo, { ...state, pushing: false, baseSha: baseSha || state.baseSha })
  }
  await applyNext($, repo)
}

// Approving ships at once: a push starts now, or right after the one already running.
async function requestPush($: Engine, repo: string): Promise<void> {
  const state = await branchState($, repo)
  if (state.pushing && Date.now() - (state.pushStartedAt ?? 0) < PUSH_STALE_MS) {
    await saveBranchState($, repo, { ...state, pushAgain: true })
    return
  }
  await push($, repo)
}

// Pushes the shared branch with git and opens its PR with gh, or updates the one already open. An update that lands
// while the push runs is not in what was pushed, so it stays approved for the next push.
async function push($: Engine, repo: string): Promise<void> {
  const checkout = await checkoutOf($, repo)
  const branch = checkout ? await ensureBranch($, repo, checkout) : null
  if (!checkout || !branch) {
    return
  }
  const startedAt = Date.now()
  const before = await branchState($, repo)
  await saveBranchState($, repo, { ...before, pushing: true, pushStartedAt: startedAt, pushAgain: false, lastError: undefined, announce: false })
  await notify($, `Pushing the docs updates for ${repo}…`)
  const outcome = await pushAndOpen($, repo, checkout, branch, before.prUrl)
  const after = await branchState($, repo)
  if ('error' in outcome) {
    await logError($, 'push', outcome.error, repo)
    await finishPush($, repo, { ...after, pushing: false, lastError: outcome.error })
    return
  }
  for (const t of await allTracked($)) {
    if (t.repo === repo && t.status === 'approved' && (t.landedAt ?? 0) <= startedAt) {
      await save($, { ...t, status: 'pushed', prUrl: outcome.url })
    }
  }
  await finishPush($, repo, { ...after, pushing: false, prUrl: outcome.url, announce: true })
}

async function pushAndOpen($: Engine, repo: string, checkout: string, branch: string, prUrl: string | undefined): Promise<{ url: string } | { error: string }> {
  const baseRef = await defaultBase($, checkout)
  const log = await runLogged($, 'push', ['git', '-C', branch, 'log', '--reverse', '--format=%s', `${baseRef}..HEAD`], undefined, repo)
  const subjects = log.stdout.trim().split('\n').filter(Boolean)
  if (subjects.length === 0) {
    return { error: 'the docs branch has no commits to push' }
  }
  const pushed = await runLogged($, 'push', ['git', '-C', branch, 'push', '--force-with-lease', '-u', 'origin', BRANCH], undefined, repo)
  if (pushed.exitCode !== 0) {
    return { error: `git push: ${lastLine(pushed)}` }
  }
  const title = prTitle(subjects)
  const included = (await allTracked($)).filter((t) => t.repo === repo && (t.status === 'approved' || t.status === 'pushed'))
  const body = prBody(included)
  const found = prUrl ? null : await runLogged($, 'push', ['gh', 'pr', 'list', '--repo', repo, '--head', BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url'], undefined, repo)
  const open = prUrl ?? found?.stdout.trim()
  if (open) {
    const edited = await runLogged($, 'push', ['gh', 'pr', 'edit', open, '--title', title, '--body', body], undefined, repo)
    return edited.exitCode === 0 ? { url: open } : { error: `gh pr edit: ${lastLine(edited)}` }
  }
  const base = baseRef.replace(/^origin\//, '')
  const created = await runLogged($, 'push', ['gh', 'pr', 'create', '--repo', repo, '--base', base, '--head', BRANCH, '--title', title, '--body', body], branch, repo)
  return created.exitCode === 0 ? { url: created.stdout.trim().split('\n').pop() ?? '' } : { error: `gh pr create: ${lastLine(created)}` }
}

async function finishPush($: Engine, repo: string, state: BranchState): Promise<void> {
  await saveBranchState($, repo, state)
  await notify($, state.lastError ? `The docs push for ${repo} failed: ${state.lastError}` : `Docs PR updated: ${state.prUrl ?? ''}`)
  if (state.pushAgain || !state.lastError) {
    await applyNext($, repo)
  }
}

async function retryPush($: Engine): Promise<void> {
  for (const repo of await registeredRepos($)) {
    if ((await branchState($, repo)).lastError) {
      await push($, repo)
    }
  }
}

async function openPr($: Engine, url: string): Promise<void> {
  await runLogged($, 'open', ['open', url])
}

// Checked every few seconds by the session holding the poll lease, so a resolved conflict lands soon after it finishes.
async function checkResolves($: Engine): Promise<void> {
  const lease = (await $.store.get('lease')) as { owner: string } | undefined
  if (lease?.owner !== me) {
    return
  }
  for (const t of await allTracked($)) {
    if (t.status === 'resolving') {
      await checkResolve($, t)
    }
  }
}

// Commits the draft in its own worktree and queues it to land on the shared branch (applyNext). A ref keeps the commit
// alive after its worktree is removed, for later rebuilds.
async function approve($: Engine, t: Tracked): Promise<void> {
  const branch = t.checkout ? await ensureBranch($, t.repo, t.checkout) : null
  if (!branch || !t.work || !t.checkout) {
    await logError($, 'approve', 'the shared docs branch could not be created', t.key)
    await save($, { ...t, status: 'failed', error: 'the shared docs branch could not be created' })
    return
  }
  await runLogged($, 'approve', ['git', '-C', t.work, 'add', '-A'], undefined, t.key)
  const body = `${t.summary ?? ''}\n\nAfter #${t.number}${t.url ? ` (${t.url})` : ''}.`
  const committed = await runLogged($, 'approve', ['git', '-C', t.work, 'commit', '-q', '-m', t.docsTitle ?? docsTitleFrom(t), '-m', body], undefined, t.key)
  const head = await runLogged($, 'approve', ['git', '-C', t.work, 'rev-parse', 'HEAD'], undefined, t.key)
  if (committed.exitCode !== 0 || head.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: lastLine(committed) })
    return
  }
  const commit = head.stdout.trim()
  await runLogged($, 'approve', ['git', '-C', t.checkout, 'update-ref', `refs/docs-watch/${slug(t.key)}`, commit], undefined, t.key)
  await removeWorktree($, t)
  await save($, { ...t, status: 'applying', commit, approvedAt: Date.now() })
}

// Starts the draft again from a clean worktree, with the person's note.
async function redo($: Engine, t: Tracked, note: string): Promise<void> {
  const work = t.work ?? ''
  const result = `${await stateDir($)}/results/${slug(t.key)}.json`
  await runLogged($, 'redo', ['git', '-C', work, 'reset', '-q', '--hard'], undefined, t.key)
  await runLogged($, 'redo', ['git', '-C', work, 'clean', '-fdq'], undefined, t.key)
  await runLogged($, 'redo', ['rm', '-f', result], undefined, t.key)
  const drafting: Tracked = { ...t, status: 'drafting', startedAt: Date.now(), diff: undefined, summary: undefined, docsTitle: undefined }
  await save($, drafting)
  await startWriter($, drafting, result, note)
  $.ui.toast(`Redrafting the docs for ${t.key}…`)
}

async function dismiss($: Engine, t: Tracked): Promise<void> {
  await removeWorktree($, t)
  await save($, { ...t, status: 'dismissed' })
}

// A press returns at once and the work runs after it, so the surface never waits on git, an agent spawn or the store.
function inBackground($: Engine, action: string, work: () => Promise<void>): void {
  void work().catch(async (error) => {
    await logError($, action, error)
    $.ui.toast(`${action} failed: ${describe(error)}`)
  })
}

// Approve, dismiss and clear change the list before their slow work; the next refresh shows the real state.
async function showStatus($: Engine, t: Tracked, status: Status | null): Promise<void> {
  await update($, shown, (current) =>
    (current ?? []).flatMap((item) => (item.key !== t.key ? [item] : status === null ? [] : [{ ...item, status }])),
  )
}

async function refreshShown($: Engine): Promise<void> {
  const latest = await visible($)
  await update($, shown, () => latest)
  const states: Record<string, BranchState> = {}
  for (const repo of await registeredRepos($)) {
    states[repo] = await branchState($, repo)
  }
  await update($, branches, () => states)
  const log = await recentErrors($)
  await update($, errors, () => log)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'docs-watch', description: 'Review documentation updates drafted after your PRs merged' })
    sessionCheckout = await toplevel($)
    const missing = await checkRequirements($)
    await showRequirements($, missing)
    if (blocking(missing).length === 0) {
      await registerRepo($)
    }
    await startPending($)
    await refreshShown($)
    $.clock.after(FIRST_TICK_MS, async () => {
      await tick($)
      await refreshShown($)
    })
    $.clock.every(TICK_MS, async () => {
      await tick($)
      await refreshShown($)
    })
    $.clock.every(RESOLVE_CHECK_MS, async () => {
      await checkResolves($)
      await refreshShown($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await startPending($)
    await refreshShown($)

    return next(e)
  })

  // `/docs-watch redo <owner/repo#number> <note>` redrafts one suggestion with a note; anything else opens the list.
  on('command.run', { command: 'docs-watch' }, async ($, e) => {
    const redoArgs = /^redo\s+(\S+)\s+([\s\S]+)$/.exec(e.args.trim())
    if (redoArgs) {
      const [, key = '', note = ''] = redoArgs
      const target = (await $.store.get(`pr:${key}`)) as Tracked | undefined
      if (!target || target.status !== 'suggested') {
        return { text: `No suggestion waiting for ${key}.` }
      }
      await redo($, target, note.trim())
      await refreshShown($)
      return { text: `Redrafting ${key}.` }
    }
    await startPending($)
    await refreshShown($)
    await $.ui.open({ id: PANE, title: 'Docs updates' })

    return { text: 'Docs updates opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = (await read($, shown)) ?? []
    const blocked = blocking((await read($, setup)) ?? [])
    const waiting = current.filter((t) => t.status === 'suggested').length
    const states = Object.entries((await read($, branches)) ?? {})
    const announced = states.filter(([, b]) => b.announce && b.prUrl)
    const failed = states.filter(([, b]) => b.lastError && !b.pushing)
    const pushing = states.some(([, b]) => b.pushing)
    if (e.props.hasSurvey || (waiting === 0 && announced.length === 0 && failed.length === 0 && !pushing && blocked.length === 0)) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    if (blocked.length > 0) {
      return (
        <Box>
          <Text color="yellow">{`docs-watch: ${blocked.map(describeMissing).join('. ')}. Then press Check again. `}</Text>
          <Button
            key="recheck"
            label="Check again"
            onPress={() =>
              inBackground($, 'Check', async () => {
                const again = await checkRequirements($)
                await showRequirements($, again)
                if (blocking(again).length === 0) {
                  await registerRepo($)
                  $.ui.toast('docs-watch is set up.')
                }
              })
            }
          />
        </Box>
      )
    }

    const parts = [
      waiting > 0 ? `${waiting} docs update(s) suggested` : '',
      pushing ? 'Pushing docs updates…' : '',
      announced.length > 0 ? 'Docs PR updated' : '',
      failed[0] ? `Docs push failed: ${failed[0][1].lastError}` : '',
    ]
    return (
      <Box>
        <Text>{`${parts.filter(Boolean).join(' · ')} `}</Text>
        {waiting > 0 && <Button key="review" label="Review" onPress={() => $.ui.open({ id: PANE, title: 'Docs updates' })} />}
        {announced.map(([repo, b]) => (
          <Button key={`open-${repo}`} label={announced.length > 1 ? `Open ${repo} PR` : 'Open PR'} onPress={() => inBackground($, 'Open', () => openPr($, b.prUrl ?? ''))} />
        ))}
        {announced.length > 0 && (
          <Button
            key="hide"
            label="Hide"
            onPress={() =>
              inBackground($, 'Hide', async () => {
                for (const [repo] of announced) {
                  await saveBranchState($, repo, { ...(await branchState($, repo)), announce: false })
                }
                await refreshShown($)
              })
            }
          />
        )}
        {failed.length > 0 && (
          <Button
            key="retry"
            label="Retry"
            onPress={() =>
              inBackground($, 'Retry', async () => {
                await retryPush($)
                await refreshShown($)
              })
            }
          />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const Input = 'Input' in elements ? elements.Input : null
    const current = (await read($, shown)) ?? []
    const open = await read($, diff)
    const log = (await read($, errors)) ?? []
    const missing = (await read($, setup)) ?? []
    const setupList = missing.length > 0 && (
      <Box key="setup" flexDirection="column">
        <Text bold color="yellow">Setup needed</Text>
        {missing.map((m) => (
          <Text key={`setup-${m.id}`} color="yellow">
            {describeMissing(m)}
          </Text>
        ))}
      </Box>
    )
    const errorList = log.length > 0 && (
      <Box key="errors" flexDirection="column">
        <Text bold>Recent errors</Text>
        {log.map((entry) => (
          <Text key={`${entry.at}-${entry.where}`} color="red">
            {`${new Date(entry.at).toLocaleString()}  ${entry.where}${entry.key ? ` ${entry.key}` : ''}: ${entry.message}`}
          </Text>
        ))}
        <Button
          key="clear-log"
          label="Clear errors"
          onPress={() =>
            inBackground($, 'Clear errors', async () => {
              await $.store.set(LOG_KEY, [])
              await update($, errors, () => [])
            })
          }
        />
      </Box>
    )
    if (current.length === 0) {
      return (
        <Box flexDirection="column">
          {setupList}
          <Text dimColor>No documentation updates waiting.</Text>
          {errorList}
        </Box>
      )
    }

    const suggested = current.filter((t) => t.status === 'suggested')
    return (
      <Box flexDirection="column">
        {setupList}
        {suggested.length > 1 && (
          <Button
            key="approve-all"
            label={`Approve all ${suggested.length}`}
            onPress={() =>
              inBackground($, 'Approve all', async () => {
                for (const t of suggested) {
                  await showStatus($, t, 'applying')
                }
                for (const t of suggested) {
                  await approve($, t)
                }
                for (const repo of new Set(suggested.map((t) => t.repo))) {
                  await applyNext($, repo)
                }
                await refreshShown($)
              })
            }
          />
        )}
        {current.map((t) => (
          <Box key={t.key} flexDirection="column">
            <Text bold>{t.docsTitle ?? `${t.key}: ${t.title ?? ''}`}</Text>
            {t.docsTitle && <Text dimColor>{`After ${t.key}: ${t.title ?? ''}`}</Text>}
            <Text dimColor>{t.summary ?? ''}</Text>
            {t.status === 'drafting' && t.pendingStart && <Text color="yellow">{`Waiting to start the draft: ${t.error ?? ''}`}</Text>}
            {t.status === 'applying' && <Text>Approved, adding to the docs branch…</Text>}
            {t.status === 'resolving' && (
              <Text color={t.pendingStart ? 'yellow' : undefined}>
                {t.pendingStart ? `Waiting to start resolving a conflict: ${t.error ?? ''}` : 'Resolving a conflict with another update…'}
              </Text>
            )}
            {t.status === 'approved' && <Text>Approved, pushing…</Text>}
            {t.status === 'pushed' && (
              <Box>
                <Text>{`In the docs PR: ${t.prUrl ?? ''} `}</Text>
                <Button key={`open-${t.key}`} label="Open PR" onPress={() => inBackground($, 'Open', () => openPr($, t.prUrl ?? ''))} />
              </Box>
            )}
            {t.status === 'approving' && <Text>Opening the PR…</Text>}
            {t.status === 'pr-open' && <Text>{`PR: ${t.prUrl}`}</Text>}
            {t.status === 'failed' && <Text color="red">{`Failed: ${t.error ?? ''}`}</Text>}
            {t.status === 'suggested' && (
              <Box>
                <Button
                  key={`approve-${t.key}`}
                  label="Approve"
                  onPress={() =>
                    inBackground($, 'Approve', async () => {
                      await showStatus($, t, 'applying')
                      await approve($, t)
                      await applyNext($, t.repo)
                      await refreshShown($)
                    })
                  }
                />
                <Button
                  key={`diff-${t.key}`}
                  label={open && open.key === t.key ? 'Hide diff' : 'Diff'}
                  onPress={() =>
                    inBackground($, 'Diff', async () => {
                      const isOpen = open !== null && open.key === t.key
                      await update($, diff, () => (isOpen ? null : { key: t.key, text: t.diff ?? '' }))
                    })
                  }
                />
                <Button
                  key={`dismiss-${t.key}`}
                  label="Dismiss"
                  onPress={() =>
                    inBackground($, 'Dismiss', async () => {
                      await showStatus($, t, null)
                      await dismiss($, t)
                      await refreshShown($)
                    })
                  }
                />
              </Box>
            )}
            {t.status === 'suggested' && Input && (
              <Input
                key={`note-${t.key}`}
                label="Redo with a note: "
                placeholder="e.g. also update the README"
                submitLabel="redo"
                onSubmit={(value: string) => {
                  if (value.trim() === '') {
                    return
                  }
                  inBackground($, 'Redo', async () => {
                    await showStatus($, t, 'drafting')
                    await redo($, t, value.trim())
                    await refreshShown($)
                  })
                }}
              />
            )}
            {(t.status === 'pr-open' || t.status === 'failed' || t.status === 'approving') && (
              <Button
                key={`clear-${t.key}`}
                label="Clear"
                onPress={() =>
                  inBackground($, 'Clear', async () => {
                    await showStatus($, t, null)
                    await dismiss($, t)
                    await refreshShown($)
                  })
                }
              />
            )}
            {open && open.key === t.key && <Markdown text={`\`\`\`diff\n${open.text}\n\`\`\``} />}
          </Box>
        ))}
        {errorList}
      </Box>
    )
  })
}
