import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

type Machine = { claude: boolean; gh: boolean; loggedIn: boolean; logoutOnList?: boolean; pushFails?: boolean }

const ALL_PRESENT: Machine = { claude: true, gh: true, loggedIn: true }
const HOME = '/home/me'
const CHECKOUT = '/work/repo'
const SURFACES = ['terminal', 'desktop'] as const
const FIRST_TICK = 20 * 1000
const POLL = 5 * 60 * 1000
const SHIP = 15 * 1000
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

const DOCS_PR = 'https://github.com/o/r/pull/9'

const ok = (stdout = ''): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = (exitCode: number, stderr: string): ProcessRunResult => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

// A machine as the mod's commands see it; a missing binary exits 127 as a shell reports it. With `logoutOnList`, the
// token stops working when the poll lists PRs.
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
    [`gh pr view ${DOCS_PR} --json state -q .state`]: ok('MERGED'),
  }
  if (command.startsWith(`git -C ${CHECKOUT} push`) && machine.pushFails) {
    return fail(1, ' ! [rejected]        docs/updates-7 -> docs/updates-7 (fetch first)')
  }
  if (command.startsWith('gh pr create')) {
    return ok('https://github.com/o/r/pull/9')
  }
  if (command.startsWith('gh pr list --repo o/r --author') && machine.logoutOnList) {
    machine.loggedIn = false
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

test('gh logged out mid-session: a failing gh command brings the popup back', async ($, on) => {
  const machine = { ...ALL_PRESENT, loggedIn: false }
  const { toasts, clock } = world(on, machine, { 'repo:o/r': CHECKOUT })
  const loginPopups = () => toasts.filter((t) => t.includes('gh auth login'))
  await $.session.start(START)
  await clock.advance(FIRST_TICK)
  expect(loginPopups()).toHaveLength(1)

  machine.loggedIn = true
  machine.logoutOnList = true
  await clock.advance(POLL - FIRST_TICK)

  expect(loginPopups()).toHaveLength(2)
})

test('Approve pushes the update on its own branch, suffixed with the merged PR, and opens its own PR', async ($, on) => {
  const { toasts, ran, clock } = world(on, ALL_PRESENT, { 'repo:o/r': CHECKOUT, [`pr:${SUGGESTED.key}`]: SUGGESTED })
  await $.session.start(START)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `approve-${SUGGESTED.key}` })
  await clock.advance(FIRST_TICK + SHIP)

  expect(ran).toContain(`git -C ${SUGGESTED.work} switch -q -C docs/updates-7`)
  expect(ran).toContain(`git -C ${CHECKOUT} push -u origin docs/updates-7`)
  expect(ran.find((c) => c.startsWith('gh pr create'))).toContain('--base main --head docs/updates-7 --title docs: document retries')
  expect(toasts).toContain(`Docs PR opened: ${DOCS_PR}`)
  expect(await pane.find({ type: 'Text', text: `Docs PR: ${DOCS_PR}` })).toBeDefined()
  await pane.unmount()
})

test('a failed push keeps the update approved with its reason, and Retry pushes it again', async ($, on) => {
  const machine = { ...ALL_PRESENT, pushFails: true }
  const { ran, clock } = world(on, machine, { 'repo:o/r': CHECKOUT, [`pr:${SUGGESTED.key}`]: SUGGESTED })
  await $.session.start(START)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `approve-${SUGGESTED.key}` })
  await clock.advance(FIRST_TICK + SHIP)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'Docs push failed for o/r#7' })).toBeDefined()
  expect(ran.some((c) => c.startsWith('gh pr create'))).toBe(false)

  machine.pushFails = false
  await band.press({ key: 'retry' })
  await clock.advance(SHIP)
  expect(ran.find((c) => c.startsWith('gh pr create'))).toContain('--head docs/updates-7')
  await band.unmount()
  await pane.unmount()
})

test('a merged docs PR takes its update off the list and deletes its local branch', async ($, on) => {
  const pushed = { ...SUGGESTED, status: 'pushed', prUrl: DOCS_PR }
  const { ran, clock } = world(on, ALL_PRESENT, { 'repo:o/r': CHECKOUT, [`pr:${SUGGESTED.key}`]: pushed })
  await $.session.start(START)
  await clock.advance(FIRST_TICK)

  expect(ran).toContain(`git -C ${CHECKOUT} branch -D docs/updates-7`)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'No documentation updates waiting.' })).toBeDefined()
  await pane.unmount()
})
