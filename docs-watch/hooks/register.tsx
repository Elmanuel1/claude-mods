import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { LogEntry, Status, Tracked } from '../types'

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
const errors = atom({ plugin: 'docs-watch', key: 'errors' } as const, null)

// This session's id for the poller lease: only one open session polls GitHub at a time.
const me = Math.random().toString(36).slice(2)

const LOG_KEY = 'log'
const LOG_LIMIT = 100

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

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

// A command whose failure matters: a non-zero exit is logged with the command and the last line of its stderr.
async function runLogged($: Engine, where: string, argv: string[], cwd?: string, key?: string) {
  const result = await run($, argv, cwd)
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split('\n').pop() ?? ''
    await logError($, where, `\`${argv.join(' ').slice(0, 200)}\` exited ${result.exitCode}: ${tail}`, key)
  }
  return result
}

async function recentErrors($: Engine): Promise<LogEntry[]> {
  const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  return log.slice(-10).reverse()
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
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
  const env = await runLogged($, 'home', ['printenv', 'HOME'])
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
    await runLogged($, 'notify', ['osascript', '-e', script])
  }
}

// The repository this session works in, so the poller knows where to make worktrees.
async function registerRepo($: Engine): Promise<void> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    return
  }
  const checkout = top.stdout.trim()
  const name = await runLogged($, 'register repo', ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], checkout)
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

async function startDraft($: Engine, t: Tracked): Promise<void> {
  const checkout = (await $.store.get(`repo:${t.repo}`)) as string | undefined
  if (!checkout) {
    await logError($, 'draft', `no local checkout registered for ${t.repo}: open a Claude Code session in it`, t.key)
    return
  }
  const dir = await stateDir($)
  const work = `${dir}/work/${slug(t.key)}`
  await runLogged($, 'draft', ['mkdir', '-p', `${dir}/work`, `${dir}/results`], undefined, t.key)
  await runLogged($, 'draft', ['git', '-C', checkout, 'fetch', '-q', 'origin'], undefined, t.key)
  const head = await run($, ['git', '-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const base = head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
  await run($, ['git', '-C', checkout, 'worktree', 'remove', '--force', work])
  const added = await runLogged($, 'draft', ['git', '-C', checkout, 'worktree', 'add', '--detach', work, base], undefined, t.key)
  if (added.exitCode !== 0) {
    await save($, { ...t, status: 'failed', error: added.stderr.trim().split('\n').pop() })
    return
  }
  const result = `${dir}/results/${slug(t.key)}.json`
  const drafting: Tracked = { ...t, status: 'drafting', checkout, work, base, startedAt: Date.now() }
  await save($, drafting)
  await startWriter($, drafting, result, '')
}

// Drafting runs only as a subagent of a session. When the engine refuses or fails to start it (as it may from a timer),
// the draft waits with `pendingStart` and the next turn, `/docs-watch` or session start tries again; each refusal is logged.
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
  let problem = ''
  try {
    const started = await $.agent.spawn({ prompt, subagentType: 'general-purpose', description: `Docs after ${t.key}`, cwd: t.work })
    if ('deny' in started && started.deny) {
      problem = `subagent refused: ${JSON.stringify(started.deny)}`
    } else if (!started.agentId) {
      problem = 'subagent did not start (no agent id)'
    } else {
      await save($, { ...t, agentId: started.agentId, pendingStart: undefined, note: undefined, startedAt: Date.now() })
      return
    }
  } catch (error) {
    problem = `subagent failed to start: ${describe(error)}`
  }
  await logError($, 'draft', problem, t.key)
  await save($, { ...t, pendingStart: true, note: note || undefined, error: problem })
}

// Starts the drafts that are waiting for a session to take them.
async function startPending($: Engine): Promise<void> {
  try {
    const dir = await stateDir($)
    for (const t of await allTracked($)) {
      if (t.status === 'drafting' && t.pendingStart) {
        await startWriter($, t, `${dir}/results/${slug(t.key)}.json`, t.note ?? '')
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
  await save($, { ...t, status: 'suggested', summary, diff: text.slice(0, DIFF_LIMIT) })
  await notify($, `${t.key} merged: docs update suggested. Review with /docs-watch.`)
}

async function onlyDocsTestsCi(files: string[]): Promise<boolean> {
  return files.length > 0 && files.every((file) => NO_DOCS_NEEDED.test(file))
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
  const problem = await setupProblem($)
  if (problem !== null) {
    await logError($, 'setup', problem)
    return
  }
  const now = Date.now()
  if (!(await holdsLease($, now))) {
    return
  }
  const keys = await $.store.keys()
  const repos = keys.filter((k) => k.startsWith('repo:')).map((k) => k.slice('repo:'.length))
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
      const view = await runLogged($, 'check PR', ['gh', 'pr', 'view', String(t.number), '--repo', t.repo, '--json', 'state,files'], undefined, t.key)
      if (view.exitCode !== 0) {
        continue
      }
      const info = parseJson<{ state: string; files: { path: string }[] }>(view.stdout)
      if (info === null) {
        await logError($, 'check PR', `gh returned something that is not JSON: ${view.stdout.slice(0, 200)}`, t.key)
        continue
      }
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
  const changed = await runLogged($, 'approve', ['git', '-C', work, 'diff', '--cached', '--name-only'], undefined, t.key)
  const files = changed.stdout.trim().split('\n').filter(Boolean).map((f) => `- \`${f}\``).join('\n')
  const body = `Documentation update after ${t.url ?? `#${t.number}`}.\n\n${t.summary ?? ''}\n\nChanged:\n${files}`
  const steps: string[][] = [
    ['git', '-C', work, 'checkout', '-b', branch],
    ['git', '-C', work, 'add', '-A'],
    ['git', '-C', work, 'commit', '-m', title, '-m', t.summary ?? ''],
    ['git', '-C', work, 'push', '-u', 'origin', branch],
  ]
  for (const step of steps) {
    const done = await runLogged($, 'approve', step, undefined, t.key)
    if (done.exitCode !== 0) {
      await save($, { ...t, status: 'failed', error: `${step.slice(3).join(' ')}: ${lastLine(done.stderr)}` })
      await notify($, `Docs PR for ${t.key} failed: ${lastLine(done.stderr)}`)
      return
    }
  }
  const pr = await runLogged($, 'approve', ['gh', 'pr', 'create', '--repo', t.repo, '--base', base, '--head', branch, '--title', title, '--body', body], work, t.key)
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
  await runLogged($, 'redo', ['git', '-C', work, 'reset', '-q', '--hard'], undefined, t.key)
  await runLogged($, 'redo', ['git', '-C', work, 'clean', '-fdq'], undefined, t.key)
  await runLogged($, 'redo', ['rm', '-f', result], undefined, t.key)
  const drafting: Tracked = { ...t, status: 'drafting', startedAt: Date.now(), diff: undefined, summary: undefined }
  await save($, drafting)
  await startWriter($, drafting, result, note)
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
    await startPending($)
    const found = await visible($)
    await update($, shown, () => found)
    const log = await recentErrors($)
    await update($, errors, () => log)
    $.clock.after(FIRST_TICK_MS, async () => {
      await tick($)
      const latest = await visible($)
      await update($, shown, () => latest)
      const log = await recentErrors($)
      await update($, errors, () => log)
    })
    $.clock.every(TICK_MS, async () => {
      await tick($)
      const latest = await visible($)
      await update($, shown, () => latest)
      const log = await recentErrors($)
      await update($, errors, () => log)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await startPending($)
    const found = await visible($)
    await update($, shown, () => found)
    const log = await recentErrors($)
    await update($, errors, () => log)

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
      const log = await recentErrors($)
      await update($, errors, () => log)
      return { text: `Redrafting ${key}.` }
    }
    await startPending($)
    const found = await visible($)
    await update($, shown, () => found)
    const log = await recentErrors($)
    await update($, errors, () => log)
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
    const log = (await read($, errors)) ?? []
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
          onPress={async () => {
            await $.store.set(LOG_KEY, [])
            await update($, errors, () => [])
          }}
        />
      </Box>
    )
    if (current.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No documentation updates waiting.</Text>
          {errorList}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {current.map((t) => (
          <Box key={t.key} flexDirection="column">
            <Text bold>{`${t.key}: ${t.title ?? ''}`}</Text>
            <Text dimColor>{t.summary ?? ''}</Text>
            {t.status === 'drafting' && t.pendingStart && <Text color="yellow">{`Waiting to start the draft: ${t.error ?? ''}`}</Text>}
            {t.status === 'approving' && <Text>Opening the PR…</Text>}
            {t.status === 'pr-open' && <Text>{`PR: ${t.prUrl}`}</Text>}
            {t.status === 'failed' && <Text color="red">{`Failed: ${t.error ?? ''}`}</Text>}
            {t.status === 'suggested' && (
              <Box>
                <Button
                  key={`approve-${t.key}`}
                  label="Approve"
                  onPress={async () => {
                    try {
                      await approve($, t)
                    } catch (error) {
                      await logError($, 'approve', error, t.key)
                      $.ui.toast(`Approve failed for ${t.key}: ${describe(error)}`)
                    }
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
                    try {
                      await dismiss($, t)
                    } catch (error) {
                      await logError($, 'dismiss', error, t.key)
                      $.ui.toast(`Dismiss failed for ${t.key}: ${describe(error)}`)
                    }
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
                  try {
                    await redo($, t, value.trim())
                  } catch (error) {
                    await logError($, 'redo', error, t.key)
                    $.ui.toast(`Redo failed for ${t.key}: ${describe(error)}`)
                  }
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
        {errorList}
      </Box>
    )
  })
}
