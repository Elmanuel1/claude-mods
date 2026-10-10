import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Status, Tracked } from '../types'

const PANE = 'docs-watch'
const TICK_MS = 5 * 60 * 1000
const FIRST_TICK_MS = 20 * 1000
const DRAFT_TIMEOUT_MS = 45 * 60 * 1000
const DIFF_LIMIT = 60000
const SHOWN: readonly Status[] = ['suggested', 'approving', 'pr-open', 'failed']
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

async function notify($: Engine, text: string): Promise<void> {
  $.ui.toast(text)
  const os = await run($, ['uname'])
  if (os.stdout.trim() === 'Darwin') {
    const script = `display notification ${JSON.stringify(text)} with title "Claude: docs"`
    await run($, ['osascript', '-e', script])
  }
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

async function startDraft($: Engine, t: Tracked): Promise<void> {
  const checkout = (await $.store.get(`repo:${t.repo}`)) as string | undefined
  if (!checkout) {
    return
  }
  const dir = await stateDir($)
  const work = `${dir}/work/${slug(t.key)}`
  await run($, ['mkdir', '-p', `${dir}/work`, `${dir}/results`])
  await run($, ['git', '-C', checkout, 'fetch', '-q', 'origin'])
  const head = await run($, ['git', '-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const base = head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
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
}

async function approve($: Engine, t: Tracked, note: string): Promise<void> {
  const dir = await stateDir($)
  const result = `${dir}/results/${slug(t.key)}.pr.json`
  await save($, { ...t, status: 'approving' })
  const branch = `docs/after-pr-${t.number}`
  const prompt = [
    `Repository ${t.repo}; merged pull request #${t.number} (${t.url ?? ''}).`,
    `Branch to create: ${branch}. Summary: ${t.summary ?? ''}.`,
    note ? `Note from the person, apply it first: ${note}` : 'No note from the person.',
    `Worktree: ${t.work}. Write your result file to ${result}.`,
  ].join('\n')
  $.agent.spawn({ prompt, subagentType: 'docs-watch:docs-pr', description: `Docs PR after ${t.key}`, cwd: t.work }).catch(() => undefined)
  await notify($, `Opening the docs PR for ${t.key}…`)
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
    if (e.props.hasSurvey || (waiting === 0 && !problem)) {
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
            onPress={async () => {
              const again = await setupProblem($)
              await update($, setup, () => again)
              if (again === null) {
                await registerRepo($)
                $.ui.toast('docs-watch is set up.')
              }
            }}
          />
        </Box>
      )
    }

    return (
      <Box>
        <Text>{`${waiting} docs update(s) suggested `}</Text>
        <Button key="review" label="Review" onPress={() => $.ui.open({ id: PANE, title: 'Docs updates' })} />
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

    return (
      <Box flexDirection="column">
        {current.map((t) => (
          <Box key={t.key} flexDirection="column">
            <Text bold>{`${t.key}: ${t.title ?? ''}`}</Text>
            <Text dimColor>{t.summary ?? ''}</Text>
            {t.status === 'approving' && <Text>Opening the PR…</Text>}
            {t.status === 'pr-open' && <Text>{`PR: ${t.prUrl}`}</Text>}
            {t.status === 'failed' && <Text color="red">{`Failed: ${t.error ?? ''}`}</Text>}
            {t.status === 'suggested' && (
              <Box>
                <Button
                  key={`approve-${t.key}`}
                  label="Approve"
                  onPress={async () => {
                    await approve($, t, '')
                    const latest = await visible($)
                    await update($, shown, () => latest)
                  }}
                />
                <Button
                  key={`diff-${t.key}`}
                  label={open && open.key === t.key ? 'Hide diff' : 'Diff'}
                  onPress={async () => {
                    const isOpen = open !== null && open.key === t.key
                    await update($, diff, () => (isOpen ? null : { key: t.key, text: t.diff ?? '' }))
                  }}
                />
                <Button
                  key={`dismiss-${t.key}`}
                  label="Dismiss"
                  onPress={async () => {
                    await dismiss($, t)
                    const latest = await visible($)
                    await update($, shown, () => latest)
                  }}
                />
              </Box>
            )}
            {(t.status === 'pr-open' || t.status === 'failed') && (
              <Button
                key={`clear-${t.key}`}
                label="Clear"
                onPress={async () => {
                  await dismiss($, t)
                  const latest = await visible($)
                  await update($, shown, () => latest)
                }}
              />
            )}
            {open && open.key === t.key && <Markdown text={`\`\`\`diff\n${open.text}\n\`\`\``} />}
          </Box>
        ))}
      </Box>
    )
  })
}
