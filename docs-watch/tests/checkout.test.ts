import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

const HOME = '/home/me'
const MAIN = '/work/repo'
const SESSION = `${MAIN}/.claude/worktrees/feature-1a2b3c`
const WORK = `${HOME}/.claude/docs-watch/work/o-r-7`
const PANE = {
  plugin: 'docs-watch',
  component: 'Pane',
  requestId: 'docs-watch',
  props: { title: 'Docs updates', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const FAILED_DRAFT = {
  key: 'o/r#7',
  repo: 'o/r',
  number: 7,
  status: 'failed',
  title: 'Add retries',
  url: 'https://github.com/o/r/pull/7',
  checkout: SESSION,
  work: WORK,
  error: 'the draft did not finish',
}
const LIST = `git -C ${SESSION} worktree list --porcelain -z`
const worktrees = (main: string) =>
  [`worktree ${main}`, 'HEAD 1111', 'branch refs/heads/main', '', `worktree ${SESSION}`, 'HEAD 2222', 'branch refs/heads/feature', ''].join('\0')

const ok = (stdout = ''): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = (exitCode: number, stderr: string): ProcessRunResult => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

function answer(argv: readonly string[]): ProcessRunResult {
  const fixed: Record<string, ProcessRunResult> = {
    'printenv HOME': ok(HOME),
    'git rev-parse --show-toplevel': ok(SESSION),
    [`git -C ${SESSION} remote get-url origin`]: ok('git@github.com:o/r.git'),
    [LIST]: ok(worktrees(MAIN)),
    'gh repo view o/r --json viewerPermission -q .viewerPermission': ok('WRITE'),
    'gh repo view --json nameWithOwner -q .nameWithOwner': ok('o/r'),
    [`git -C ${MAIN} symbolic-ref --short refs/remotes/origin/HEAD`]: ok('origin/main'),
  }
  return fixed[argv.join(' ')] ?? ok()
}

function world(on: On, store: Record<string, unknown>, overrides: Record<string, ProcessRunResult> = {}) {
  const ran: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    return { value: overrides[e.argv.join(' ')] ?? answer(e.argv) }
  })
  on('agent.spawn', () => ({ model: 'test', agentId: 'agent-1' }))
  const entries = new Map(Object.entries(store))
  on('store.get', (_$, e) => ({ value: entries.get(e.key) }))
  on('store.set', (_$, e) => {
    entries.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...entries.keys()] }))
  mock.clock(on)
  return { ran, entries }
}

test('a session in a worktree registers the main checkout, which outlives the worktree', async ($, on) => {
  const { entries } = world(on, {})
  await $.session.start({ cwd: SESSION, surface: 'desktop', isInteractive: true })

  expect(entries.get('repo:o/r')).toBe(MAIN)
})

test('a draft started after registering makes its worktree from the main checkout and pushes from it later', async ($, on) => {
  const { ran, entries } = world(on, { 'repo:o/r': SESSION, [`pr:${FAILED_DRAFT.key}`]: FAILED_DRAFT })
  await $.session.start({ cwd: SESSION, surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `retry-${FAILED_DRAFT.key}` })
  await pane.unmount()

  expect(ran).toContain(`git -C ${MAIN} worktree add --detach ${WORK} origin/main`)
  expect((entries.get(`pr:${FAILED_DRAFT.key}`) as { checkout?: string }).checkout).toBe(MAIN)
})

test('when git cannot list the worktrees, the session checkout is registered as before', async ($, on) => {
  const { entries } = world(on, {}, { [LIST]: fail(128, 'fatal: not a git repository') })
  await $.session.start({ cwd: SESSION, surface: 'desktop', isInteractive: true })

  expect(entries.get('repo:o/r')).toBe(SESSION)
})

test('a main checkout whose path holds a newline is registered whole', async ($, on) => {
  const main = '/work/repo\narchive'
  const { entries } = world(on, {}, { [LIST]: ok(worktrees(main)) })
  await $.session.start({ cwd: SESSION, surface: 'desktop', isInteractive: true })

  expect(entries.get('repo:o/r')).toBe(main)
})
