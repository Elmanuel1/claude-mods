import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { BranchState, Status, Tracked } from '../types'

const PANE = 'docs-watch'
const TICK_MS = 5 * 60 * 1000
const FIRST_TICK_MS = 20 * 1000
const DRAFT_TIMEOUT_MS = 45 * 60 * 1000
const DIFF_LIMIT = 60000
const PUSH_TIMEOUT_MS = 45 * 60 * 1000
const REMIND_MS = 60 * 60 * 1000
// One branch per repository collects every approved update, so many merged PRs ship as one docs PR.
const BRANCH = 'docs/updates'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const SHOWN: readonly Status[] = ['suggested', 'approved', 'pushed', 'approving', 'pr-open', 'failed']
// A PR that touched only these needs no documentation update.
const NO_DOCS_NEEDED = /(^|\/)docs?\/|\.mdx?$|(^|\/)(test|tests|__tests__|spec)\/|(Spec|Test)\.(groovy|java|kt)$|\.(test|spec)\.[cm]?[jt]sx?$|^\.github\/|^\.claude\//

const shown = atom({ plugin: 'docs-watch', key: 'shown' } as const, null)
const diff = atom({ plugin: 'docs-watch', key: 'diff' } as const, null)
const setup = atom({ plugin: 'docs-watch', key: 'setup' } as const, null)

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

async function replay($: Engine, branch: string, commit: string): Promise<boolean> {
  const picked = await run($, ['git', '-C', branch, 'cherry-pick', '--allow-empty', commit])
  if (picked.exitCode === 0) {
    return true
  }
  await run($, ['git', '-C', branch, 'cherry-pick', '--abort'])
  return false
}

// Rebuilds the branch on the latest default branch from the approvals still to ship, oldest first. An approval that no
// longer applies is marked failed instead of being left half-applied. Returns the base commit it built on.
async function rebuild($: Engine, branch: string, checkout: string, keep: Tracked[]): Promise<string> {
  if ((await run($, ['git', '-C', branch, 'status', '--porcelain'])).stdout.trim() !== '') {
    return ''
  }
  await run($, ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const base = await defaultBase($, checkout)
  await run($, ['git', '-C', branch, 'reset', '-q', '--hard', base])
  for (const t of [...keep].sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))) {
    if (!t.commit || !(await replay($, branch, t.commit))) {
      await save($, { ...t, status: 'failed', error: 'no longer applies on the latest main; clear it and it drafts again after the next merge' })
    }
  }
  return (await run($, ['git', '-C', checkout, 'rev-parse', base])).stdout.trim()
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
  await save($, { ...t, status: 'suggested', summary, diff: text.slice(0, DIFF_LIMIT) })
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
    }
  }
  for (const repo of repos) {
    await checkBranch($, repo)
  }
  await remind($)
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
}

// Only the session holding the poll lease gets here, so one reminder an hour reaches the person, not one per session.
async function remind($: Engine): Promise<void> {
  const approved = (await allTracked($)).filter((t) => t.status === 'approved').length
  const last = ((await $.store.get('remindedAt')) as number | undefined) ?? 0
  if (approved === 0 || Date.now() - last < REMIND_MS) {
    return
  }
  await $.store.set('remindedAt', Date.now())
  await notify($, `${approved} docs update(s) approved, not pushed. Push them from the line above the prompt.`)
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
}

// Commits the draft in its own worktree and replays the commit onto the shared branch. Nothing is pushed: Push ships
// every approval at once. A ref keeps the commit alive after its worktree is removed, for later rebuilds.
async function approve($: Engine, t: Tracked): Promise<void> {
  const branch = t.checkout ? await ensureBranch($, t.repo, t.checkout) : null
  if (!branch || !t.work || !t.checkout) {
    await save($, { ...t, status: 'failed', error: 'the shared docs branch could not be created' })
    return
  }
  await run($, ['git', '-C', t.work, 'add', '-A'])
  const committed = await run($, ['git', '-C', t.work, 'commit', '-q', '-m', `docs: update after #${t.number}`, '-m', t.summary ?? ''])
  const head = await run($, ['git', '-C', t.work, 'rev-parse', 'HEAD'])
  if (committed.exitCode !== 0 || head.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: lastLine(committed) })
    return
  }
  const commit = head.stdout.trim()
  await run($, ['git', '-C', t.checkout, 'update-ref', `refs/docs-watch/${slug(t.key)}`, commit])
  if (!(await replay($, branch, commit))) {
    await save($, { ...t, status: 'failed', error: 'conflicts with an update already approved; clear it and it drafts again after the next merge' })
    return
  }
  await removeWorktree($, t)
  await save($, { ...t, status: 'approved', commit, approvedAt: Date.now() })
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
  await saveBranchState($, repo, { ...state, pushing: true, pushStartedAt: Date.now() })
  const prompt = [
    `Repository ${repo}. Branch ${BRANCH} in this worktree (${branch}) holds one commit per merged pull request:`,
    ...included.map((t) => `- #${t.number} ${t.title ?? ''} (${t.url ?? ''}): ${t.summary ?? ''}`),
    state.prUrl ? `Its open pull request: ${state.prUrl}.` : 'It has no open pull request yet.',
    `Write your result file to ${result}.`,
  ].join('\n')
  $.agent.spawn({ prompt, subagentType: 'docs-watch:docs-pr', description: `Docs PR for ${repo}`, cwd: branch }).catch(() => undefined)
  await notify($, `Pushing the docs updates for ${repo}…`)
}

async function pushAll($: Engine): Promise<void> {
  const repos = new Set((await allTracked($)).filter((t) => t.status === 'approved').map((t) => t.repo))
  for (const repo of repos) {
    await startPush($, repo)
  }
}

// An approval made while a push ran is not in what was pushed, so it stays approved for the next Push.
async function checkPush($: Engine, repo: string, state: BranchState): Promise<void> {
  const result = await readResult($, `${await stateDir($)}/results/push-${slug(repo)}.json`)
  if (!result) {
    if (Date.now() - (state.pushStartedAt ?? 0) > PUSH_TIMEOUT_MS) {
      await saveBranchState($, repo, { ...state, pushing: false })
      await notify($, `The docs push for ${repo} did not finish. Push again from /docs-watch.`)
    }
    return
  }
  if (typeof result.url !== 'string') {
    await saveBranchState($, repo, { ...state, pushing: false })
    await notify($, `The docs push for ${repo} failed: ${String(result.error ?? 'no reason given')}`)
    return
  }
  for (const t of await allTracked($)) {
    if (t.repo === repo && t.status === 'approved' && (t.approvedAt ?? 0) <= (state.pushStartedAt ?? 0)) {
      await save($, { ...t, status: 'pushed', prUrl: result.url })
    }
  }
  await saveBranchState($, repo, { ...state, pushing: false, prUrl: result.url })
  await notify($, `Docs PR: ${result.url}`)
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
    const found = await visible($)
    await update($, shown, () => found)
    $.clock.after(FIRST_TICK_MS, async () => {
      await tick($)
      const latest = await visible($)
      await update($, shown, () => latest)
    })
    $.clock.every(TICK_MS, async () => {
      await tick($)
      const latest = await visible($)
      await update($, shown, () => latest)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const found = await visible($)
    await update($, shown, () => found)

    return next(e)
  })

  on('command.run', { command: 'docs-watch' }, async ($) => {
    const found = await visible($)
    await update($, shown, () => found)
    await $.ui.open({ id: PANE, title: 'Docs updates' })

    return { text: 'Docs updates opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = (await read($, shown)) ?? []
    const problem = await read($, setup)
    const waiting = current.filter((t) => t.status === 'suggested').length
    const approved = current.filter((t) => t.status === 'approved').length
    if (e.props.hasSurvey || (waiting === 0 && approved === 0 && !problem)) {
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

    const parts = [waiting > 0 ? `${waiting} docs update(s) suggested` : '', approved > 0 ? `${approved} approved, not pushed` : '']
    return (
      <Box>
        <Text>{`${parts.filter(Boolean).join(', ')} `}</Text>
        <Button key="review" label="Review" onPress={() => $.ui.open({ id: PANE, title: 'Docs updates' })} />
        {approved > 0 && (
          <Button key="push" label="Push" onPress={() => inBackground($, 'Push', async () => { await pushAll($); await refreshShown($) })} />
        )}
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
    const approvedCount = current.filter((t) => t.status === 'approved').length
    return (
      <Box flexDirection="column">
        {suggested.length > 1 && (
          <Button
            key="approve-all"
            label={`Approve all ${suggested.length}`}
            onPress={() =>
              inBackground($, 'Approve all', async () => {
                for (const t of suggested) {
                  await showStatus($, t, 'approved')
                }
                for (const t of suggested) {
                  await approve($, t)
                }
                await refreshShown($)
              })
            }
          />
        )}
        {current.map((t) => (
          <Box key={t.key} flexDirection="column">
            <Text bold>{`${t.key}: ${t.title ?? ''}`}</Text>
            <Text dimColor>{t.summary ?? ''}</Text>
            {t.status === 'approved' && <Text>Approved, not pushed yet</Text>}
            {t.status === 'pushed' && <Text>{`In the docs PR: ${t.prUrl ?? ''}`}</Text>}
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
                      await showStatus($, t, 'approved')
                      await approve($, t)
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
                      const latest = await visible($)
                      await update($, shown, () => latest)
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
                    const latest = await visible($)
                    await update($, shown, () => latest)
                  })
                }
              />
            )}
            {open && open.key === t.key && <Markdown text={`\`\`\`diff\n${open.text}\n\`\`\``} />}
          </Box>
        ))}
        {approvedCount > 0 && (
          <Button
            key="pane-push"
            label={`Push ${approvedCount} approved update(s)`}
            onPress={() => inBackground($, 'Push', async () => { await pushAll($); await refreshShown($) })}
          />
        )}
      </Box>
    )
  })
}
