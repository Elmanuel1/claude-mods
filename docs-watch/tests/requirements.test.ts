import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

type Machine = { claude: boolean; gh: boolean; loggedIn: boolean }

const ALL_PRESENT: Machine = { claude: true, gh: true, loggedIn: true }
const HOME = '/home/me'
const CHECKOUT = '/work/repo'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'docs-watch',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  plugin: 'docs-watch',
  component: 'Pane',
  requestId: 'docs-watch',
  props: { title: 'Docs updates', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const SUGGESTED = {
  key: 'o/r#7',
  repo: 'o/r',
  number: 7,
  status: 'suggested',
  title: 'Add retries',
  url: 'https://github.com/o/r/pull/7',
  checkout: CHECKOUT,
  work: `${HOME}/.claude/docs-watch/work/o-r-7`,
  summary: 'Documents retries.',
  docsTitle: 'docs: document retries',
  diff: '+retries',
}

const ok = (stdout = ''): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = (exitCode: number, stderr: string): ProcessRunResult => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

// A machine as the mod's commands see it; a missing binary exits 127 as a shell reports it.
function answer(argv: readonly string[], machine: Machine): ProcessRunResult {
  const command = argv.join(' ')
  if (command === 'claude --version') {
    return machine.claude ? ok('2.1.296 (Claude Code)') : fail(127, 'claude: command not found')
  }
  if (argv[0] === 'gh' && !machine.gh) {
    return fail(127, 'gh: command not found')
  }
  if (command.startsWith('gh auth status')) {
    return machine.loggedIn ? ok('Logged in to github.com') : fail(1, 'You are not logged into any GitHub hosts. token: gho_SECRET')
  }
  const fixed: Record<string, ProcessRunResult> = {
    uname: ok('Darwin'),
    'printenv HOME': ok(HOME),
    'git rev-parse --show-toplevel': ok(CHECKOUT),
    [`git -C ${CHECKOUT} remote get-url origin`]: ok('git@github.com:o/r.git'),
    'gh repo view o/r --json viewerPermission -q .viewerPermission': ok('WRITE'),
    'gh repo view --json nameWithOwner -q .nameWithOwner': ok('o/r'),
    [`git -C ${CHECKOUT} symbolic-ref --short refs/remotes/origin/HEAD`]: ok('origin/main'),
    [`git -C ${SUGGESTED.work} rev-parse HEAD`]: ok('abc123'),
    [`git -C ${HOME}/.claude/docs-watch/branch/o-r rev-parse -q --verify CHERRY_PICK_HEAD`]: fail(1, ''),
    [`git -C ${HOME}/.claude/docs-watch/branch/o-r log --reverse --format=%s origin/main..HEAD`]: ok('docs: document retries'),
  }
  if (command.startsWith('gh pr create')) {
    return ok('https://github.com/o/r/pull/9')
  }
  if (command.startsWith('gh pr list') && !machine.loggedIn) {
    return fail(4, 'HTTP 401: Bad credentials')
  }
  return fixed[command] ?? ok()
}

function world(on: On, machine: Machine, store: Record<string, unknown> = {}) {
  const toasts: string[] = []
  const ran: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    return { value: answer(e.argv, machine) }
  })
  const clock = mock.clock(on)
  mock.store(on, store)
  return { toasts, ran, clock }
}

const START = { cwd: CHECKOUT, surface: 'terminal', isInteractive: true } as const

test('all present: no popup and nothing blocks', async ($, on) => {
  const { toasts, ran } = world(on, ALL_PRESENT)
  await $.session.start(START)

  expect(toasts).toEqual([])
  expect(ran).toContain('gh repo view --json nameWithOwner -q .nameWithOwner')
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: 'Setup needed' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'No documentation updates waiting.' })).toBeDefined()
    await pane.unmount()
  }
})

test('missing claude: the popup names it and how to install it, and the mod keeps working', async ($, on) => {
  const { toasts, ran } = world(on, { ...ALL_PRESENT, claude: false })
  await $.session.start(START)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('the Claude Code CLI (`claude`) is not on PATH')
  expect(toasts[0]).toContain('curl -fsSL https://claude.ai/install.sh | bash')
  expect(ran).toContain('gh repo view --json nameWithOwner -q .nameWithOwner')
})

test('missing gh: the popup and the band name it and `brew install gh`, once per session', async ($, on) => {
  const { toasts, ran } = world(on, { ...ALL_PRESENT, gh: false })
  await $.session.start(START)
  await $.session.start(START)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('the GitHub CLI (`gh`) is not installed or not on PATH: run `brew install gh`')
  expect(ran.some((c) => c.startsWith('gh auth status'))).toBe(false)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: 'brew install gh' }))?.text).toContain('Then press Check again.')
    expect(await band.find({ key: 'recheck' })).toBeDefined()
    await band.unmount()
  }
})

test('gh not logged in: the popup and the band say `gh auth login`, never the token', async ($, on) => {
  const { toasts } = world(on, { ...ALL_PRESENT, loggedIn: false })
  await $.session.start(START)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('gh is not logged in to github.com: run `gh auth login --hostname github.com`')
  expect(toasts.join(' ')).not.toContain('gho_')
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: 'gh auth login' })).toBeDefined()
    await band.unmount()
  }
})

test('gh not logged in: an approval whose gh command fails brings the popup back', async ($, on) => {
  const { toasts, clock } = world(on, { ...ALL_PRESENT, loggedIn: false }, { 'repo:o/r': CHECKOUT, [`pr:${SUGGESTED.key}`]: SUGGESTED })
  const loginPopups = () => toasts.filter((t) => t.includes('gh auth login'))
  await $.session.start(START)
  await clock.advance(61 * 1000)
  expect(loginPopups()).toHaveLength(1)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: `approve-${SUGGESTED.key}` })

  expect(loginPopups()).toHaveLength(2)
  await pane.unmount()
})

test('all present: Approve pushes docs/updates with git and opens one PR with gh, titled by what the docs cover', async ($, on) => {
  const { toasts, ran } = world(on, ALL_PRESENT, { 'repo:o/r': CHECKOUT, [`pr:${SUGGESTED.key}`]: SUGGESTED })
  await $.session.start(START)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `approve-${SUGGESTED.key}` })

  expect(ran).toContain(`git -C ${HOME}/.claude/docs-watch/branch/o-r push --force-with-lease -u origin docs/updates`)
  expect(ran.find((c) => c.startsWith('gh pr create'))).toContain('--base main --head docs/updates --title docs: document retries')
  expect(toasts).toContain('Docs PR updated: https://github.com/o/r/pull/9')
  expect(await pane.find({ type: 'Text', text: 'In the docs PR: https://github.com/o/r/pull/9' })).toBeDefined()
  await pane.unmount()
})
