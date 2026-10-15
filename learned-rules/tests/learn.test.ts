import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const CORRECTION = "don't call OffsetDateTime.now() without a zone, always take it as OffsetDateTime.now(ZoneOffset.UTC). "

const ran = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

type Spawned = { argv: string[]; input?: string; env?: Record<string, string> }

// A repo with one custom PMD ruleset on a GitHub plan without rulesets; the learning run makes one rule commit.
type Options = { env?: Record<string, string>; exitCode?: number; leaseTakenAt?: number; addsHooks?: boolean }

function world(on: On, { env = {}, exitCode = 0, leaseTakenAt, addsHooks = false }: Options = {}): { spawned: Spawned[]; notified: string[]; calls: string[][]; settle: (ms?: number) => Promise<void> } {
  const clock = mock.clock(on)
  mock.store(on, { reviewed: {} })
  mock.env(on, { HOME: '/home/tester', ...env })
  on('session.id', () => ({ value: 'open-session' }))
  const spawned: Spawned[] = []
  const calls: string[][] = []
  const notified: string[] = []

  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.SessionEnd', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', ($, e) => {
    notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('settings.read', () => ({ value: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gate.sh' }] }] } } }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('prompts/learn.md') ? 'Learn from {{CWD}}.' : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield { stream: 'stdout' as const, text: exitCode === 0 ? 'Added one rule.\nSUGGESTED: 1\n' : 'Not logged in.\n' }
    return { value: { code: exitCode, signal: null } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv.includes('rev-list') && argv.some(arg => arg.endsWith('..HEAD'))) {
      return ran(addsHooks ? 'r1ce\n' : '')
    }
    if (argv.includes('show') && argv.includes('r1ce')) {
      return ran('rule: lint on save\n+hooks:\n+  PostToolUse: []\n')
    }
    if (argv.includes('commit-tree')) {
      return ran('1ea5e\n')
    }
    if (argv.includes('refs/learned/lease') && argv.includes('log')) {
      return leaseTakenAt === undefined ? ran('', 128) : ran(`0ther ${leaseTakenAt}\n`)
    }
    if (argv.includes('--git-common-dir')) {
      return ran('/work/repo/.git\n')
    }
    if (argv.includes('--show-toplevel')) {
      return ran('/work/repo\n')
    }
    if (argv.includes('ls-tree')) {
      return ran('config/pmd/rules.xml\nsrc/Main.java\n.github/workflows/build.yml\n')
    }
    if (argv.includes('get-url')) {
      return ran('git@github.com:acme/app.git\n')
    }
    if (argv[0] === 'gh') {
      return ran('{"message":"Upgrade to GitHub Pro"}', 1)
    }
    return ran('')
  })

  // turn.complete starts the learning run without waiting for it; advancing the clock lets it finish.
  return { spawned, notified, calls, settle: (ms = 1) => clock.advance(ms) }
}

const scanned = ($: Engine) => $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

test('a session with corrections is queued when it ends and learned from by an open session', async ($, on) => {
  const { spawned, notified, settle } = world(on)
  for (let i = 0; i < 6; i++) {
    await $.prompt.submit(typed(CORRECTION))
  }
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 'open-session', cwd: '/work/repo' })

  await scanned($)
  await settle()

  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(spawned[0]?.env?.LEARN_FROM_CORRECTIONS).toBe('1')
  const allowed = spawned[0]?.argv[spawned[0].argv.indexOf('--allowedTools') + 1] ?? ''
  expect(allowed).toContain('Bash(git -C /home/tester/.claude/learned/repo-worktree commit *)')
  expect(allowed).toContain('Edit(~/.claude/skills/**/*.md)')
  expect(spawned[0]?.argv).toEqual(expect.arrayContaining(['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']))
  expect(spawned[0]?.env).toMatchObject({ GIT_CONFIG_KEY_0: 'core.hooksPath' })
  expect(allowed).not.toContain('Bash(git -C *)')
  expect(spawned[0]?.input).toMatch(/^Learn from \/work\/repo\./)
  expect(spawned[0]?.input).toMatch(/- config\/pmd\/rules\.xml\n- \.github\/workflows\/build\.yml/)
  expect(spawned[0]?.input).not.toMatch(/src\/Main\.java/)
  expect(spawned[0]?.input).toMatch(/rulesets not readable: Upgrade to GitHub Pro/)
  expect(spawned[0]?.input).toMatch(/user settings Stop: gate\.sh/)
  expect(spawned[0]?.input).toContain(CORRECTION)
  expect(notified).toEqual(['1 rule(s) suggested. Accept or reject each with /learned.'])
  await scanned($)
  await settle()
  expect(spawned).toHaveLength(1)
})

test('a notification is not a correction', async ($, on) => {
  const { spawned, settle } = world(on)
  for (let i = 0; i < 6; i++) {
    await $.prompt.submit({ text: CORRECTION, wait: false, origin: { kind: 'task-notification' } })
  }
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 'open-session', cwd: '/work/repo' })

  await scanned($)
  await settle()

  expect(spawned).toHaveLength(0)
})

test('a session with almost nothing typed is not queued', async ($, on) => {
  const { spawned, settle } = world(on)
  await $.prompt.submit(typed('fix the test'))
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 'open-session', cwd: '/work/repo' })

  await scanned($)
  await settle()

  expect(spawned).toHaveLength(0)
})

test("the learning run's own session records and queues nothing", async ($, on) => {
  const { spawned, settle } = world(on, { env: { LEARN_FROM_CORRECTIONS: '1' } })
  for (let i = 0; i < 6; i++) {
    await $.prompt.submit(typed(CORRECTION))
  }
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 'open-session', cwd: '/work/repo' })

  await scanned($)
  await settle()

  expect(spawned).toHaveLength(0)
})

async function endTypedSession($: Engine): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await $.prompt.submit(typed(CORRECTION))
  }
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 'open-session', cwd: '/work/repo' })
}

test('a failed run keeps the corrections and tries again 30 minutes later', async ($, on) => {
  const { spawned, notified, settle } = world(on, { exitCode: 1 })
  await endTypedSession($)

  await scanned($)
  await settle()
  await scanned($)
  await settle()

  expect(spawned).toHaveLength(1)
  expect(notified[0]).toMatch(/^The learning run failed; it tries again in 30 minutes/)
  await settle(30 * 60 * 1000)
  await scanned($)
  await settle()
  expect(spawned).toHaveLength(2)
})

test('a lease another session took in the last hour keeps this session from running', async ($, on) => {
  const { spawned, settle } = world(on, { leaseTakenAt: 0 })
  await endTypedSession($)

  await scanned($)
  await settle()

  expect(spawned).toHaveLength(0)
})

test('a personal rule that adds hooks to a skill is reverted and marked rejected', async ($, on) => {
  const { notified, calls, settle } = world(on, { addsHooks: true })
  await endTypedSession($)

  await scanned($)
  await settle()

  expect(calls).toContainEqual(['git', '-C', '/home/tester/.claude/skills', 'revert', '--no-edit', 'r1ce'])
  expect(notified).toContain('Reverted 1 personal rule(s) that added hooks or allowed-tools to a skill.')
})
