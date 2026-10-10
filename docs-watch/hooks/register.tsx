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
  const drafting: Tracked = { ...t, status: 'drafting', checkout, work, base, startedAt: Date.now() }
  await save($, drafting)
  spawnWriter(drafting, result, '', $)
}

function spawnWriter(t: Tracked, result: string, note: string, $: Engine): void {
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
  $.agent.spawn({ prompt, subagentType: 'general-purpose', description: `Docs after ${t.key}`, cwd: t.work }).catch(() => undefined)
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
    }
  }
}

const lastLine = (text: string) => text.trim().split('\n').pop() ?? ''

// Commits the draft on its own branch, pushes it and opens the pull request against the branch it was drafted from.
async function approve($: Engine, t: Tracked): Promise<void> {
  await save($, { ...t, status: 'approving' })
  const work = t.work ?? ''
  const branch = `docs/after-pr-${t.number}`
  const base = (t.base ?? 'origin/main').replace(/^origin\//, '')
  const title = `docs: update after #${t.number}`
  const changed = await run($, ['git', '-C', work, 'diff', '--cached', '--name-only'])
  const files = changed.stdout.trim().split('\n').filter(Boolean).map((f) => `- \`${f}\``).join('\n')
  const body = `Documentation update after ${t.url ?? `#${t.number}`}.\n\n${t.summary ?? ''}\n\nChanged:\n${files}`
  const steps: string[][] = [
    ['git', '-C', work, 'checkout', '-b', branch],
    ['git', '-C', work, 'add', '-A'],
    ['git', '-C', work, 'commit', '-m', title, '-m', t.summary ?? ''],
    ['git', '-C', work, 'push', '-u', 'origin', branch],
  ]
  for (const step of steps) {
    const done = await run($, step)
    if (done.exitCode !== 0) {
      await save($, { ...t, status: 'failed', error: `${step.slice(3).join(' ')}: ${lastLine(done.stderr)}` })
      await notify($, `Docs PR for ${t.key} failed: ${lastLine(done.stderr)}`)
      return
    }
  }
  const pr = await run($, ['gh', 'pr', 'create', '--repo', t.repo, '--base', base, '--head', branch, '--title', title, '--body', body], work)
  if (pr.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: `gh pr create: ${lastLine(pr.stderr)}` })
    await notify($, `Docs PR for ${t.key} failed: ${lastLine(pr.stderr)}`)
    return
  }
  const url = lastLine(pr.stdout)
  await removeWorktree($, t)
  await save($, { ...t, status: 'pr-open', prUrl: url })
  await notify($, `Docs PR opened: ${url}`)
}

// Starts the draft again from a clean worktree, with the person's note.
async function redo($: Engine, t: Tracked, note: string): Promise<void> {
  const work = t.work ?? ''
  const dir = await stateDir($)
  const result = `${dir}/results/${slug(t.key)}.json`
  await run($, ['git', '-C', work, 'reset', '-q', '--hard'])
  await run($, ['git', '-C', work, 'clean', '-fdq'])
  await run($, ['rm', '-f', result])
  const drafting: Tracked = { ...t, status: 'drafting', startedAt: Date.now(), diff: undefined, summary: undefined }
  await save($, drafting)
  spawnWriter(drafting, result, note, $)
  $.ui.toast(`Redrafting the docs for ${t.key}…`)
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

  // `/docs-watch redo <owner/repo#number> <note>` redrafts one suggestion with a note; anything else opens the list.
  on('command.run', { command: 'docs-watch' }, async ($, e) => {
    const redoArgs = /^redo\s+(\S+)\s+([\s\S]+)$/.exec(e.args.trim())
    if (redoArgs) {
      const [, key = "", note = ""] = redoArgs
      const target = (await $.store.get(`pr:${key}`)) as Tracked | undefined
      if (!target || target.status !== 'suggested') {
        return { text: `No suggestion waiting for ${key}.` }
      }
      await redo($, target, note.trim())
      const latest = await visible($)
      await update($, shown, () => latest)
      return { text: `Redrafting ${key}.` }
    }
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
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const Input = 'Input' in elements ? elements.Input : null
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
                    await approve($, t)
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
            {t.status === 'suggested' && Input && (
              <Input
                key={`note-${t.key}`}
                label="Redo with a note: "
                placeholder="e.g. also update the README"
                submitLabel="redo"
                onSubmit={async (value: string) => {
                  if (value.trim() === '') {
                    return
                  }
                  await redo($, t, value.trim())
                  const latest = await visible($)
                  await update($, shown, () => latest)
                }}
              />
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
