import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'learned-rules'
const FIELD = '\u001f'
const RECORD = '\u001e'
const SURFACES = ['terminal', 'desktop', 'vscode'] as const
const FIRST = 'project:rule: no subqueries in SQL'
const SECOND = 'project:rule: no legacy complexity'

type Surface = (typeof SURFACES)[number]

const ran = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const commit = (sha: string, subject: string, file: string) => `${sha}${FIELD}${subject}${FIELD}File: ${file}${RECORD}`

// Two project rules on the branch, none reviewed; every git call is recorded and succeeds.
function world(on: On): string[][] {
  mock.clock(on)
  mock.store(on, { reviewed: {} })
  mock.env(on, { HOME: '/home/tester' })
  const calls: string[][] = []

  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv.includes('log') && argv[2] === '/home/tester/.claude/learned/repo-worktree') {
      return ran(commit('sha1', 'rule: no subqueries in SQL', 'a.md') + commit('sha2', 'rule: no legacy complexity', 'b.md'))
    }
    if (argv.includes('rev-list')) {
      return ran('2\n')
    }
    if (argv.includes('show')) {
      return ran('+ never a subquery\n')
    }
    return ran('')
  })

  return calls
}

const scanned = ($: Engine) => $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

const paneProps = (isFocused: boolean) => ({
  title: 'Learned rules',
  isFocused,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})

// The person's click gives the pane the keyboard, which draws it again before the press arrives.
async function focusedPane($: Engine, surface: Surface) {
  const shown = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'learned-rules', props: paneProps(false) })
  await shown.redraw(paneProps(true))
  return shown
}

// The terminal draws the list in a Client; desktop and vscode draw it in the pane itself, with their own buttons.
const rows = (surface: Surface) => (surface === 'terminal' ? { in: 'rules' } : {})

for (const surface of SURFACES) {
  test(`${surface}: the first row's Accept accepts it on the first press`, async ($, on) => {
    world(on)
    await scanned($)
    const shown = await focusedPane($, surface)

    await shown.press({ key: `accept-${FIRST}` })

    expect(await shown.find({ key: `accept-${FIRST}`, ...rows(surface) })).toBeUndefined()
    expect(await shown.find({ key: `accept-${SECOND}`, ...rows(surface) })).toBeDefined()
    await scanned($)
    expect(await shown.find({ key: `accept-${FIRST}`, ...rows(surface) })).toBeUndefined()
  })

  test(`${surface}: the first row's Reject drops its commit on the first press`, async ($, on) => {
    const calls = world(on)
    await scanned($)
    const shown = await focusedPane($, surface)

    await shown.press({ key: `reject-${FIRST}` })

    expect(calls).toContainEqual(['git', '-C', '/home/tester/.claude/learned/repo-worktree', 'rebase', '--onto', 'sha1^', 'sha1', 'docs/learned-rules'])
    expect(await shown.find({ key: `reject-${FIRST}`, ...rows(surface) })).toBeUndefined()
    expect(await shown.find({ key: `reject-${SECOND}`, ...rows(surface) })).toBeDefined()
    await scanned($)
    expect(await shown.find({ key: `reject-${FIRST}`, ...rows(surface) })).toBeUndefined()
  })

  test(`${surface}: the first row's Diff expands it on the first press`, async ($, on) => {
    world(on)
    await scanned($)
    const shown = await focusedPane($, surface)

    await shown.press({ key: `diff-${FIRST}` })

    expect((await shown.find({ key: `diff-${FIRST}`, ...rows(surface) }))?.text).toBe('Hide diff')
    expect(await shown.find({ type: 'Markdown', text: /never a subquery/, ...rows(surface) })).toBeDefined()
  })
}

test('desktop: the rule buttons are the desktop\'s own buttons, not a Client region', async ($, on) => {
  world(on)
  await scanned($)
  const shown = await focusedPane($, 'desktop')

  expect(await shown.find({ type: 'Client' })).toBeUndefined()
  expect((await shown.find({ type: 'Button', key: `accept-${FIRST}` }))?.text).toBe('Accept')
})
