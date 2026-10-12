import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { BranchState, Status, Tracked } from '../types'

const PANE = 'docs-watch'
const TICK_MS = 5 * 60 * 1000
const FIRST_TICK_MS = 20 * 1000
const DRAFT_TIMEOUT_MS = 45 * 60 * 1000
const DIFF_LIMIT = 60000
const PUSH_TIMEOUT_MS = 45 * 60 * 1000
const PUSH_CHECK_MS = 15 * 1000
// One branch per repository collects every approved update, so many merged PRs ship as one docs PR. Approving
// pushes it; there is no separate push step.
const BRANCH = 'docs/updates'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const SHOWN: readonly Status[] = ['suggested', 'applying', 'resolving', 'approved', 'pushed', 'approving', 'pr-open', 'failed']
// A PR that touched only these needs no documentation update.
const NO_DOCS_NEEDED = /(^|\/)docs?\/|\.mdx?$|(^|\/)(test|tests|__tests__|spec)\/|(Spec|Test)\.(groovy|java|kt)$|\.(test|spec)\.[cm]?[jt]sx?$|^\.github\/|^\.claude\//

const shown = atom({ plugin: 'docs-watch', key: 'shown' } as const, null)
const diff = atom({ plugin: 'docs-watch', key: 'diff' } as const, null)
const setup = atom({ plugin: 'docs-watch', key: 'setup' } as const, null)
const branches = atom({ plugin: 'docs-watch', key: 'branches' } as const, null)

// This session's id for the poller lease: only one open session polls GitHub at a time.
const me = Math.random().toString(36).slice(2)

async function run($: Engine, argv: string[], cwd?: string) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs: 120000 })
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: String(error) }
  }
}

// What stops the mod from working on this machine, as the step that fixes it; null when nothing does.
async function setupProblem($: Engine): Promise<string | null> {
  const git = await run($, ['git', '--version'])
  if (git.exitCode !== 0) {
    return 'docs-watch needs git: install it, then press Check again.'
  }
  const gh = await run($, ['gh', '--version'])
  if (gh.exitCode !== 0) {
    return 'docs-watch needs the GitHub CLI: install it from https://cli.github.com, then press Check again.'
  }
  const auth = await run($, ['gh', 'auth', 'status'])
  if (auth.exitCode !== 0) {
    return 'docs-watch needs GitHub access: run `gh auth login` in a terminal, then press Check again.'
  }
  return null
}

async function home($: Engine): Promise<string> {
  const env = await run($, ['printenv', 'HOME'])
  return env.stdout.trim()
}

async function stateDir($: Engine): Promise<string> {
  const root = await home($)
  return `${root}/.claude/docs-watch`
}

const slug = (key: string) => key.replace(/[^A-Za-z0-9]+/g, '-')

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
  await run($, ['osascript', '-e', script])
}

// The repository this session works in, so the poller knows where to make worktrees.
async function registerRepo($: Engine): Promise<void> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    return
  }
  const checkout = top.stdout.trim()
  const name = await run($, ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], checkout)
  if (name.exitCode !== 0) {
    return
  }
  await $.store.set(`repo:${name.stdout.trim()}`, checkout)
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
  return tracked.filter((t) => SHOWN.includes(t.status))
}

async function holdsLease($: Engine, now: number): Promise<boolean> {
  const lease = (await $.store.get('lease')) as { owner: string; until: number } | undefined
  if (lease && lease.owner !== me && lease.until > now) {
    return false
  }
  await $.store.set('lease', { owner: me, until: now + 2 * TICK_MS })
  return true
}

async function readResult($: Engine, file: string): Promise<Record<string, unknown> | null> {
  const out = await run($, ['cat', file])
  if (out.exitCode !== 0) {
    return null
  }
  try {
    return JSON.parse(out.stdout) as Record<string, unknown>
  } catch {
    return null
  }
}

async function removeWorktree($: Engine, t: Tracked): Promise<void> {
  if (t.checkout && t.work) {
    await run($, ['git', '-C', t.checkout, 'worktree', 'remove', '--force', t.work])
  }
}

async function defaultBase($: Engine, checkout: string): Promise<string> {
  const head = await run($, ['git', '-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
}

const lastLine = (out: { stderr: string; stdout: string }) => (out.stderr.trim() || out.stdout.trim()).split('\n').pop() ?? ''

async function branchState($: Engine, repo: string): Promise<BranchState> {
  return ((await $.store.get(`branch:${repo}`)) as BranchState | undefined) ?? {}
}

async function saveBranchState($: Engine, repo: string, state: BranchState): Promise<void> {
  await $.store.set(`branch:${repo}`, state)
}

async function branchWorktree($: Engine, repo: string): Promise<string> {
  return `${await stateDir($)}/branch/${slug(repo)}`
}

// The worktree on the shared branch, created from the default branch the first time.
async function ensureBranch($: Engine, repo: string, checkout: string): Promise<string | null> {
  const work = await branchWorktree($, repo)
  if ((await run($, ['git', '-C', work, 'rev-parse', '--git-dir'])).exitCode === 0) {
    return work
  }
  await run($, ['mkdir', '-p', `${await stateDir($)}/branch`])
  await run($, ['git', '-C', checkout, 'worktree', 'prune'])
  const hasBranch = await run($, ['git', '-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`])
  const added = hasBranch.exitCode === 0
    ? await run($, ['git', '-C', checkout, 'worktree', 'add', work, BRANCH])
    : await run($, ['git', '-C', checkout, 'worktree', 'add', '-b', BRANCH, work, await defaultBase($, checkout)])
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
  await run($, ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const base = await defaultBase($, checkout)
  await run($, ['git', '-C', branch, 'reset', '-q', '--hard', base])
  for (const t of keep) {
    await save($, { ...t, status: 'applying' })
  }
  return (await run($, ['git', '-C', checkout, 'rev-parse', base])).stdout.trim()
}

// Lands approvals on the shared branch one at a time, oldest first. A conflict goes to the docs-merge agent and the
// queue waits for it. Once nothing is left to land, the branch is pushed.
async function applyNext($: Engine, repo: string): Promise<void> {
  const checkout = (await $.store.get(`repo:${repo}`)) as string | undefined
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
    if (next.commit && (await replay($, branch, next.commit)) === 'applied') {
      await save($, { ...next, status: 'approved', landedAt: Date.now() })
      continue
    }
    if (!next.commit) {
      await save($, { ...next, status: 'failed', error: 'its commit is missing; clear it and it drafts again after the next merge' })
      continue
    }
    await startResolve($, next, branch)
    return
  }
}

async function startResolve($: Engine, t: Tracked, branch: string): Promise<void> {
  const result = `${await stateDir($)}/results/${slug(t.key)}.merge.json`
  await run($, ['rm', '-f', result])
  await save($, { ...t, status: 'resolving', startedAt: Date.now() })
  const prompt = [
    `Repository ${t.repo}. In this worktree (${branch}), branch ${BRANCH} has a cherry-pick in progress that conflicts:`,
    `the documentation update after merged pull request #${t.number} ("${t.title ?? ''}"; ${t.summary ?? ''}) against updates`,
    `already on the branch. Write your result file to ${result}.`,
  ].join(' ')
  $.agent.spawn({ prompt, subagentType: 'docs-watch:docs-merge', description: `Resolve docs conflict for ${t.key}`, cwd: branch }).catch(() => undefined)
  await notify($, `Resolving a docs conflict for ${t.key}…`)
}

async function checkResolve($: Engine, t: Tracked): Promise<void> {
  const branch = await branchWorktree($, t.repo)
  const result = await readResult($, `${await stateDir($)}/results/${slug(t.key)}.merge.json`)
  if (!result && Date.now() - (t.startedAt ?? 0) <= DRAFT_TIMEOUT_MS) {
    return
  }
  if (result?.ok === true && !(await picking($, branch))) {
    await save($, { ...t, status: 'approved', landedAt: Date.now() })
  } else {
    await run($, ['git', '-C', branch, 'cherry-pick', '--abort'])
    const reason = result ? String(result.error ?? 'the conflict was not resolved') : 'the conflict was not resolved in time'
    await save($, { ...t, status: 'failed', error: reason })
    await notify($, `A docs conflict for ${t.key} could not be resolved: ${reason}`)
  }
  await applyNext($, t.repo)
}

async function startDraft($: Engine, t: Tracked): Promise<void> {
  const checkout = (await $.store.get(`repo:${t.repo}`)) as string | undefined
  if (!checkout) {
    return
  }
  const dir = await stateDir($)
  const work = `${dir}/work/${slug(t.key)}`
  await run($, ['mkdir', '-p', `${dir}/work`, `${dir}/results`])
  await run($, ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const base = await defaultBase($, checkout)
  await run($, ['git', '-C', checkout, 'worktree', 'remove', '--force', work])
  const added = await run($, ['git', '-C', checkout, 'worktree', 'add', '--detach', work, base])
  if (added.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: added.stderr.trim().split('\n').pop() })
    return
  }
  const result = `${dir}/results/${slug(t.key)}.json`
  await save($, { ...t, status: 'drafting', checkout, work, startedAt: Date.now() })
  const prompt = `Repository ${t.repo}, merged pull request #${t.number} ("${t.title ?? ''}"). Draft the documentation update in this worktree (${work}). Write your result file to ${result}.`
  $.agent.spawn({ prompt, subagentType: 'docs-watch:docs-writer', description: `Docs after ${t.key}`, cwd: work }).catch(() => undefined)
}

// For a draft made before the writer returned a title: the merged PR's title without its own type prefix.
function docsTitleFrom(t: Tracked): string {
  const subject = (t.title ?? `pull request #${t.number}`).replace(/^\w+(\([^)]*\))?!?:\s*/, '')
  return `docs: cover ${subject}`.slice(0, 72)
}

async function checkDraft($: Engine, t: Tracked): Promise<void> {
  const dir = await stateDir($)
  const result = await readResult($, `${dir}/results/${slug(t.key)}.json`)
  if (!result) {
    if (Date.now() - (t.startedAt ?? 0) > DRAFT_TIMEOUT_MS) {
      await save($, { ...t, status: 'failed', error: 'the draft did not finish' })
    }
    return
  }
  const work = t.work ?? ''
  await run($, ['git', '-C', work, 'add', '-A'])
  const changes = await run($, ['git', '-C', work, 'diff', '--cached'])
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

async function checkApproval($: Engine, t: Tracked): Promise<void> {
  const dir = await stateDir($)
  const result = await readResult($, `${dir}/results/${slug(t.key)}.pr.json`)
  if (!result) {
    return
  }
  if (typeof result.url === 'string') {
    await removeWorktree($, t)
    await save($, { ...t, status: 'pr-open', prUrl: result.url })
    await notify($, `Docs PR opened: ${result.url}`)
    return
  }
  await save($, { ...t, status: 'failed', error: String(result.error ?? 'the PR was not opened') })
}

async function onlyDocsTestsCi(files: string[]): Promise<boolean> {
  return files.length > 0 && files.every((file) => NO_DOCS_NEEDED.test(file))
}

// One poll: track the person's open PRs in every repository a session registered, and move each tracked PR on.
async function tick($: Engine): Promise<void> {
  if ((await setupProblem($)) !== null) {
    return
  }
  const now = Date.now()
  if (!(await holdsLease($, now))) {
    return
  }
  const keys = await $.store.keys()
  const repos = keys.filter((k) => k.startsWith('repo:')).map((k) => k.slice('repo:'.length))
  for (const repo of repos) {
    const open = await run($, ['gh', 'pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--json', 'number,title,url'])
    if (open.exitCode !== 0) {
      continue
    }
    for (const pr of JSON.parse(open.stdout) as { number: number; title: string; url: string }[]) {
      const key = `${repo}#${pr.number}`
      if (!(await $.store.get(`pr:${key}`))) {
        await save($, { key, repo, number: pr.number, title: pr.title, url: pr.url, status: 'open' })
      }
    }
  }
  for (const t of await allTracked($)) {
    if (t.status === 'open') {
      const view = await run($, ['gh', 'pr', 'view', String(t.number), '--repo', t.repo, '--json', 'state,files'])
      if (view.exitCode !== 0) {
        continue
      }
      const info = JSON.parse(view.stdout) as { state: string; files: { path: string }[] }
      if (info.state === 'CLOSED') {
        await save($, { ...t, status: 'closed' })
      } else if (info.state === 'MERGED') {
        const files = info.files.map((f) => f.path)
        const skip = await onlyDocsTestsCi(files)
        await (skip ? save($, { ...t, status: 'skipped' }) : startDraft($, t))
      }
    } else if (t.status === 'drafting') {
      await checkDraft($, t)
    } else if (t.status === 'approving') {
      await checkApproval($, t)
    } else if (t.status === 'resolving') {
      await checkResolve($, t)
    }
  }
  for (const repo of repos) {
    await checkBranch($, repo)
  }
}

// Moves a repository's shared branch on with GitHub: a push finishing, its PR merged or closed, and main moving while
// nothing is pushed.
async function checkBranch($: Engine, repo: string): Promise<void> {
  const state = await branchState($, repo)
  if (state.pushing) {
    await checkPush($, repo, state)
    return
  }
  const checkout = (await $.store.get(`repo:${repo}`)) as string | undefined
  const branch = await branchWorktree($, repo)
  if (!checkout || (await run($, ['git', '-C', branch, 'rev-parse', '--git-dir'])).exitCode !== 0) {
    return
  }
  if (state.prUrl) {
    const view = await run($, ['gh', 'pr', 'view', state.prUrl, '--json', 'state', '-q', '.state'])
    const prState = view.stdout.trim()
    if (view.exitCode !== 0 || (prState !== 'MERGED' && prState !== 'CLOSED')) {
      return
    }
    // Merged: its updates are done. Closed unmerged: they go back to approved and the next Push opens a new PR.
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
  await run($, ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const head = (await run($, ['git', '-C', checkout, 'rev-parse', await defaultBase($, checkout)])).stdout.trim()
  if (head && head !== state.baseSha) {
    const keep = (await allTracked($)).filter((t) => t.repo === repo && t.status === 'approved')
    const baseSha = await rebuild($, branch, checkout, keep)
    await saveBranchState($, repo, { ...state, baseSha: baseSha || state.baseSha })
  }
  await applyNext($, repo)
}

// A press returns at once and the work runs after it, so the surface never waits on git, an agent spawn or the store.
function inBackground($: Engine, action: string, work: () => Promise<void>): void {
  void work().catch((error) => $.ui.toast(`${action} failed: ${error instanceof Error ? error.message : String(error)}`))
}

// Approve, dismiss and clear change the list before their slow work; the next refresh shows the real state.
async function showStatus($: Engine, t: Tracked, status: Tracked['status'] | null): Promise<void> {
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
}

// Commits the draft in its own worktree and queues it to land on the shared branch (applyNext). A ref keeps the commit
// alive after its worktree is removed, for later rebuilds.
async function approve($: Engine, t: Tracked): Promise<void> {
  const branch = t.checkout ? await ensureBranch($, t.repo, t.checkout) : null
  if (!branch || !t.work || !t.checkout) {
    await save($, { ...t, status: 'failed', error: 'the shared docs branch could not be created' })
    return
  }
  await run($, ['git', '-C', t.work, 'add', '-A'])
  const body = `${t.summary ?? ''}\n\nAfter #${t.number}${t.url ? ` (${t.url})` : ''}.`
  const committed = await run($, ['git', '-C', t.work, 'commit', '-q', '-m', t.docsTitle ?? docsTitleFrom(t), '-m', body])
  const head = await run($, ['git', '-C', t.work, 'rev-parse', 'HEAD'])
  if (committed.exitCode !== 0 || head.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: lastLine(committed) })
    return
  }
  const commit = head.stdout.trim()
  await run($, ['git', '-C', t.checkout, 'update-ref', `refs/docs-watch/${slug(t.key)}`, commit])
  await removeWorktree($, t)
  await save($, { ...t, status: 'applying', commit, approvedAt: Date.now() })
}

// One docs-pr run per repository pushes the shared branch and opens its PR, or updates the open one.
async function startPush($: Engine, repo: string): Promise<void> {
  const state = await branchState($, repo)
  const checkout = (await $.store.get(`repo:${repo}`)) as string | undefined
  const branch = checkout ? await ensureBranch($, repo, checkout) : null
  if (state.pushing || !branch) {
    return
  }
  const included = (await allTracked($)).filter((t) => t.repo === repo && (t.status === 'approved' || t.status === 'pushed'))
  const result = `${await stateDir($)}/results/push-${slug(repo)}.json`
  await run($, ['rm', '-f', result])
  await saveBranchState($, repo, { ...state, pushing: true, pushStartedAt: Date.now(), pushAgain: false, lastError: undefined, announce: false })
  const prompt = [
    `Repository ${repo}. Branch ${BRANCH} in this worktree (${branch}) holds one commit per merged pull request:`,
    ...included.map((t) => `- #${t.number} ${t.title ?? ''} (${t.url ?? ''}): ${t.summary ?? ''}`),
    state.prUrl ? `Its open pull request: ${state.prUrl}.` : 'It has no open pull request yet.',
    `Write your result file to ${result}.`,
  ].join('\n')
  $.agent.spawn({ prompt, subagentType: 'docs-watch:docs-pr', description: `Docs PR for ${repo}`, cwd: branch }).catch(() => undefined)
  await notify($, `Pushing the docs updates for ${repo}…`)
}

// Approving ships at once: a push starts now, or right after the one already running.
async function requestPush($: Engine, repo: string): Promise<void> {
  const state = await branchState($, repo)
  if (state.pushing) {
    await saveBranchState($, repo, { ...state, pushAgain: true })
    return
  }
  await startPush($, repo)
}

async function retryPush($: Engine): Promise<void> {
  for (const repo of await registeredRepos($)) {
    if ((await branchState($, repo)).lastError) {
      await startPush($, repo)
    }
  }
}

async function registeredRepos($: Engine): Promise<string[]> {
  return (await $.store.keys()).filter((k) => k.startsWith('repo:')).map((k) => k.slice('repo:'.length))
}

async function openPr($: Engine, url: string): Promise<void> {
  await run($, ['open', url])
}

// Checked every few seconds by the session holding the poll lease, so a push's PR link and a resolved conflict show
// soon after they finish.
async function checkPushes($: Engine): Promise<void> {
  const lease = (await $.store.get('lease')) as { owner: string } | undefined
  if (lease?.owner !== me) {
    return
  }
  for (const repo of await registeredRepos($)) {
    const state = await branchState($, repo)
    if (state.pushing) {
      await checkPush($, repo, state)
    }
  }
  for (const t of await allTracked($)) {
    if (t.status === 'resolving') {
      await checkResolve($, t)
    }
  }
}

// An update that landed while a push ran is not in what was pushed, so it stays approved for the next push.
async function checkPush($: Engine, repo: string, state: BranchState): Promise<void> {
  const result = await readResult($, `${await stateDir($)}/results/push-${slug(repo)}.json`)
  if (!result) {
    if (Date.now() - (state.pushStartedAt ?? 0) > PUSH_TIMEOUT_MS) {
      await finishPush($, repo, { ...state, pushing: false, lastError: 'the push did not finish' })
    }
    return
  }
  if (typeof result.url !== 'string') {
    await finishPush($, repo, { ...state, pushing: false, lastError: String(result.error ?? 'no reason given') })
    return
  }
  for (const t of await allTracked($)) {
    if (t.repo === repo && t.status === 'approved' && (t.landedAt ?? 0) <= (state.pushStartedAt ?? 0)) {
      await save($, { ...t, status: 'pushed', prUrl: result.url })
    }
  }
  await finishPush($, repo, { ...state, pushing: false, prUrl: result.url, announce: true })
}

async function finishPush($: Engine, repo: string, state: BranchState): Promise<void> {
  await saveBranchState($, repo, state)
  await notify($, state.lastError ? `The docs push for ${repo} failed: ${state.lastError}` : `Docs PR updated: ${state.prUrl ?? ''}`)
  if (state.pushAgain || !state.lastError) {
    await applyNext($, repo)
  }
}

async function dismiss($: Engine, t: Tracked): Promise<void> {
  await removeWorktree($, t)
  await save($, { ...t, status: 'dismissed' })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'docs-watch', description: 'Review documentation updates drafted after your PRs merged' })
    const problem = await setupProblem($)
    await update($, setup, () => problem)
    if (problem) {
      $.ui.toast(problem)
    }
    await registerRepo($)
    await refreshShown($)
    $.clock.after(FIRST_TICK_MS, async () => {
      await tick($)
      await refreshShown($)
    })
    $.clock.every(TICK_MS, async () => {
      await tick($)
      await refreshShown($)
    })
    $.clock.every(PUSH_CHECK_MS, async () => {
      await checkPushes($)
      await refreshShown($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refreshShown($)

    return next(e)
  })

  on('command.run', { command: 'docs-watch' }, async ($) => {
    await refreshShown($)
    await $.ui.open({ id: PANE, title: 'Docs updates' })

    return { text: 'Docs updates opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = (await read($, shown)) ?? []
    const problem = await read($, setup)
    const waiting = current.filter((t) => t.status === 'suggested').length
    const states = Object.entries((await read($, branches)) ?? {})
    const announced = states.filter(([, b]) => b.announce && b.prUrl)
    const failed = states.filter(([, b]) => b.lastError && !b.pushing)
    const pushing = states.some(([, b]) => b.pushing)
    if (e.props.hasSurvey || (waiting === 0 && announced.length === 0 && failed.length === 0 && !pushing && !problem)) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    if (problem) {
      return (
        <Box>
          <Text color="yellow">{`${problem} `}</Text>
          <Button
            key="recheck"
            label="Check again"
            onPress={() =>
              inBackground($, 'Check', async () => {
                const again = await setupProblem($)
                await update($, setup, () => again)
                if (again === null) {
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
      failed.length > 0 ? `Docs push failed: ${failed[0][1].lastError}` : '',
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
                for (const [repo, b] of announced) {
                  await saveBranchState($, repo, { ...(await branchState($, repo)), announce: false })
                }
                await refreshShown($)
              })
            }
          />
        )}
        {failed.length > 0 && <Button key="retry" label="Retry" onPress={() => inBackground($, 'Retry', async () => { await retryPush($); await refreshShown($) })} />}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const current = (await read($, shown)) ?? []
    const open = await read($, diff)
    if (current.length === 0) {
      return <Text dimColor>No documentation updates waiting.</Text>
    }

    const suggested = current.filter((t) => t.status === 'suggested')
    return (
      <Box flexDirection="column">
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
            {t.status === 'applying' && <Text>Approved, adding to the docs branch…</Text>}
            {t.status === 'resolving' && <Text>Resolving a conflict with another update…</Text>}
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
            {(t.status === 'pr-open' || t.status === 'failed') && (
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
      </Box>
    )
  })
}
