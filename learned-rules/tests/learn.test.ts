import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const CORRECTION = "don't call OffsetDateTime.now() without a zone, always take it as OffsetDateTime.now(ZoneOffset.UTC). "
const SKILL = '---\nname: lint\ndescription: lint rules\n---\nBody.\n'

const ran = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const rule = (fields: Record<string, unknown> = {}) => ({
  repo: 'personal',
  file: 'lint/SKILL.md',
  edits: [{ old: 'Body.\n', new: 'Body.\n\n## Time in UTC\nTake the time as now(ZoneOffset.UTC).\n' }],
  subject: 'rule: time in UTC',
  correction: '"always take it as OffsetDateTime.now(ZoneOffset.UTC)"',
  enforce: 'new; config/pmd/rules.xml; flag OffsetDateTime.now() without UTC',
  ...fields,
})

const answer = (rules: unknown[]) => `Summary.\n\`\`\`rules\n${JSON.stringify({ rules })}\n\`\`\`\n`

type Spawned = { argv: string[]; input?: string; cwd?: string }

type Options = { env?: Record<string, string>; exitCode?: number; leaseTakenAt?: number; output?: string }

type World = { spawned: Spawned[]; notified: string[]; calls: string[][]; written: Map<string, string>; settle: (ms?: number) => Promise<void> }

// A repo with one custom PMD ruleset on a GitHub plan without rulesets; the run answers with `output`.
function world(on: On, { env = {}, exitCode = 0, leaseTakenAt, output = answer([rule()]) }: Options = {}): World {
  const clock = mock.clock(on)
  mock.store(on, { reviewed: {} })
  mock.env(on, { HOME: '/home/tester', ...env })
  on('session.id', () => ({ value: 'open-session' }))
  const spawned: Spawned[] = []
  const calls: string[][] = []
  const written = new Map<string, string>()
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
  on('fs.read', ($, e) => ({ value: e.path.endsWith('prompts/learn.md') ? 'Learn from {{CWD}}.' : e.path.endsWith('lint/SKILL.md') ? SKILL : '' }))
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], input: e.input, cwd: e.cwd })
    yield { stream: 'stdout' as const, text: exitCode === 0 ? output : 'Not logged in.\n' }
    return { value: { code: exitCode, signal: null } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
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
  return { spawned, notified, calls, written, settle: (ms = 1) => clock.advance(ms) }
}

const scanned = ($: Engine) => $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

async function endTypedSession($: Engine): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await $.prompt.submit(typed(CORRECTION))
  }
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 'open-session', cwd: '/work/repo' })
}

async function learned($: Engine, settle: World['settle']): Promise<void> {
  await endTypedSession($)
  await scanned($)
  await settle()
}

const commits = (calls: string[][]) => calls.filter(argv => argv.includes('commit') && argv.includes('-m'))

test('a session with corrections is queued when it ends and learned from by a read-only run', async ($, on) => {
  const { spawned, notified, settle } = world(on)
  await learned($, settle)

  expect(spawned).toHaveLength(1)
  const run = spawned[0]
  expect(run?.argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(run?.argv).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands']))
  expect(run?.argv[run.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
  expect(run?.argv[run.argv.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob')
  expect(run?.cwd).toBe('/home/tester/.claude/learned/run')
  expect(run?.input).toMatch(/^Learn from \/work\/repo\./)
  expect(run?.input).toMatch(/- config\/pmd\/rules\.xml\n- \.github\/workflows\/build\.yml/)
  expect(run?.input).not.toMatch(/src\/Main\.java/)
  expect(run?.input).toMatch(/rulesets not readable: Upgrade to GitHub Pro/)
  expect(run?.input).toMatch(/user settings Stop: gate\.sh/)
  expect(run?.input).toContain(CORRECTION)
  expect(notified).toEqual(['1 rule(s) suggested. Accept or reject each with /learned.'])

  await scanned($)
  await settle()
  expect(spawned).toHaveLength(1)
})

test('the mod applies each returned rule and commits it with its Correction, File and Enforce lines', async ($, on) => {
  const { calls, written, settle } = world(on)
  await learned($, settle)

  expect(written.get('/home/tester/.claude/skills/lint/SKILL.md')).toBe(`${SKILL}\n## Time in UTC\nTake the time as now(ZoneOffset.UTC).\n`)
  expect(commits(calls)).toEqual([[
    'git', '-C', '/home/tester/.claude/skills', 'commit', '-q', '-m', 'rule: time in UTC', '-m',
    'Correction: "always take it as OffsetDateTime.now(ZoneOffset.UTC)"\nFile: lint/SKILL.md\nEnforce: new; config/pmd/rules.xml; flag OffsetDateTime.now() without UTC',
    '--', 'lint/SKILL.md',
  ]])
})

test('a rule that adds hooks to a skill, leaves its repo or edits no unique text is not applied', async ($, on) => {
  const rules = [
    rule({ subject: 'rule: lint on save', edits: [{ old: 'description: lint rules\n', new: 'description: lint rules\n"hooks":\n  Stop: []\n' }] }),
    rule({ subject: 'rule: escape', file: '../../.bashrc.md' }),
    rule({ subject: 'rule: missing', edits: [{ old: 'not in the file', new: 'x' }] }),
    rule({ subject: 'rule: repo rule', repo: 'project', file: 'CLAUDE.md', edits: [{ old: '', new: '## Rule\n' }] }),
  ]
  const { calls, written, notified, settle } = world(on, { output: answer(rules) })
  await learned($, settle)

  const ruleFiles = [...written.keys()].filter(path => !path.endsWith('open-session.md') && !path.includes('/learned/run/'))
  expect(ruleFiles).toEqual(['/home/tester/.claude/learned/repo-worktree/CLAUDE.md'])
  expect(commits(calls).map(argv => argv[6])).toEqual(['rule: repo rule'])
  expect(notified).toContain('3 learned rule(s) were not applied. See /home/tester/.claude/learned/open-session.md')
  const summary = written.get('/home/tester/.claude/learned/open-session.md') ?? ''
  expect(summary).toContain('Not applied: rule: lint on save: it adds or changes hooks or allowed-tools')
  expect(summary).toContain('Not applied: rule: escape: not a rule file or rule subject: ../../.bashrc.md')
  expect(summary).toContain('Not applied: rule: missing: an edit does not match the file exactly once')
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
  await learned($, settle)

  expect(spawned).toHaveLength(0)
})

test('a failed run keeps the corrections and tries again 30 minutes later', async ($, on) => {
  const { spawned, notified, settle } = world(on, { exitCode: 1 })
  await learned($, settle)
  await scanned($)
  await settle()

  expect(spawned).toHaveLength(1)
  expect(notified[0]).toMatch(/^The learning run failed; it tries again in 30 minutes/)
  await settle(30 * 60 * 1000)
  await scanned($)
  await settle()
  expect(spawned).toHaveLength(2)
})

test('a run whose answer has no rules block counts as failed', async ($, on) => {
  const { notified, settle } = world(on, { output: 'I added the rules.\n' })
  await learned($, settle)

  expect(notified[0]).toMatch(/^The learning run failed; it tries again in 30 minutes/)
})

test('a lease another session took in the last hour keeps this session from running', async ($, on) => {
  const { spawned, settle } = world(on, { leaseTakenAt: 0 })
  await learned($, settle)

  expect(spawned).toHaveLength(0)
})
