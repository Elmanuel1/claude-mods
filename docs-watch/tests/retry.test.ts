import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

const HOME = '/home/me'
const CHECKOUT = '/work/repo'
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
const WORK = `${HOME}/.claude/docs-watch/work/o-r-7`
const FAILED_DRAFT = {
  key: 'o/r#7',
  repo: 'o/r',
  number: 7,
  status: 'failed',
  title: 'Add retries',
  url: 'https://github.com/o/r/pull/7',
  checkout: CHECKOUT,
  work: WORK,
  error: 'the draft did not finish',
}
const START = { cwd: CHECKOUT, surface: 'desktop', isInteractive: true } as const

const ok = (stdout = ''): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = (exitCode: number, stderr: string): ProcessRunResult => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

function answer(argv: readonly string[]): ProcessRunResult {
  const fixed: Record<string, ProcessRunResult> = {
    'printenv HOME': ok(HOME),
    'git rev-parse --show-toplevel': ok(CHECKOUT),
    [`git -C ${CHECKOUT} remote get-url origin`]: ok('git@github.com:o/r.git'),
    'gh repo view o/r --json viewerPermission -q .viewerPermission': ok('WRITE'),
    'gh repo view --json nameWithOwner -q .nameWithOwner': ok('o/r'),
    [`git -C ${CHECKOUT} symbolic-ref --short refs/remotes/origin/HEAD`]: ok('origin/main'),
  }
  return fixed[argv.join(' ')] ?? ok()
}

function world(on: On, store: Record<string, unknown>, overrides: Record<string, ProcessRunResult> = {}) {
  const toasts: string[] = []
  const ran: string[] = []
  const spawned: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    return { value: overrides[e.argv.join(' ')] ?? answer(e.argv) }
  })
  on('agent.spawn', (_$, e) => {
    spawned.push(e.prompt)
    return { model: 'test', agentId: 'agent-1' }
  })
  // A store of its own rather than mock.store, so the test sees every write of the tracked item.
  const entries = new Map(Object.entries(store))
  const saved: Saved[] = []
  on('store.get', (_$, e) => ({ value: entries.get(e.key) }))
  on('store.set', (_$, e) => {
    entries.set(e.key, e.value)
    if (e.key === `pr:${FAILED_DRAFT.key}`) {
      saved.push(e.value as Saved)
    }
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...entries.keys()] }))
  mock.clock(on)
  return { toasts, ran, spawned, saved }
}

type Saved = { status: string; error?: string }

test('a failed update shows its reason, and the band counts it with a Review button', async ($, on) => {
  world(on, { 'repo:o/r': CHECKOUT, [`pr:${FAILED_DRAFT.key}`]: FAILED_DRAFT })
  await $.session.start(START)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: '1 docs update(s) failed' }))).toBeDefined()
  expect(await band.find({ key: 'review' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Failed: the draft did not finish' })).toBeDefined()
  expect(await pane.find({ key: `retry-${FAILED_DRAFT.key}` })).toBeDefined()
  await pane.unmount()
})

test('Retry on a failed draft drafts again from the default branch', async ($, on) => {
  const { ran, spawned, toasts, saved } = world(on, { 'repo:o/r': CHECKOUT, [`pr:${FAILED_DRAFT.key}`]: FAILED_DRAFT })
  await $.session.start(START)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `retry-${FAILED_DRAFT.key}` })

  expect(ran).toContain(`git -C ${CHECKOUT} worktree add --detach ${WORK} origin/main`)
  expect(spawned.some((p) => p.includes('PR: o/r#7'))).toBe(true)
  expect(saved.at(-1)?.status).toBe('drafting')
  // A hook's answer carries no agent id, so the writer counts as not started and the pane says why.
  expect(saved.at(-1)?.error).toBe('subagent did not start (no agent id)')
  expect(await pane.find({ type: 'Text', text: 'Waiting to start the draft: subagent did not start (no agent id)' })).toBeDefined()
  await pane.unmount()
  expect(toasts).toContain('Drafting the docs for o/r#7 again…')
})

test('Retry that cannot start a draft says why and keeps the item failed', async ($, on) => {
  const addFails = { [`git -C ${CHECKOUT} worktree add --detach ${WORK} origin/main`]: fail(128, `fatal: '${WORK}' already exists`) }
  const { toasts, spawned, saved } = world(on, { 'repo:o/r': CHECKOUT, [`pr:${FAILED_DRAFT.key}`]: FAILED_DRAFT }, addFails)
  await $.session.start(START)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `retry-${FAILED_DRAFT.key}` })

  expect(spawned).toEqual([])
  expect(toasts).not.toContain('Drafting the docs for o/r#7 again…')
  expect(toasts).toContain('Retry for o/r#7 failed; the reason is under Recent errors in /docs-watch.')
  expect(saved.at(-1)?.status).toBe('failed')
  expect(await pane.find({ type: 'Text', text: `Failed: fatal: '${WORK}' already exists` })).toBeDefined()
  await pane.unmount()
})
