import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'learned-rules'
const FIELD = '\u001f'
const RECORD = '\u001e'
const NEW = 'project:rule: outbox is plumbing'
const EXISTS = 'project:rule: no subqueries in SQL'
const UNMARKED = 'project:rule: no legacy complexity'

const ran = (stdout: string): { value: ProcessRunResult } => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const commit = (sha: string, subject: string, body: string) => `${sha}${FIELD}${subject}${FIELD}${body}${RECORD}`

// One rule a new ArchUnit rule could check, one an existing PMD rule already checks, one learned before Enforce lines.
function world(on: On): string[] {
  mock.clock(on)
  mock.store(on, { reviewed: {} })
  mock.env(on, { HOME: '/home/tester' })
  const filled: string[] = []

  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    if (argv.includes('log') && argv[2] === '/home/tester/.claude/learned/repo-worktree') {
      return ran(
        commit('sha1', 'rule: outbox is plumbing', 'File: CLAUDE.md\nEnforce: new; ArchUnit; outbox classes do not depend on services; or repositories\n') +
          commit('sha2', 'rule: no subqueries in SQL', 'File: CLAUDE.md\nEnforce: exists; PMD NoSubquery; asTable, EXISTS, IN select\n') +
          commit('sha3', 'rule: no legacy complexity', 'File: CLAUDE.md\n'),
      )
    }
    if (argv.includes('rev-list')) {
      return ran('3\n')
    }
    return ran('')
  })

  return filled
}

const scanned = ($: Engine) => $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'learned-rules',
    props: { title: 'Learned rules', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })

test('each rule shows its Enforce line; only a rule a new check could catch gets Enforce', async ($, on) => {
  world(on)
  await scanned($)
  const shown = await pane($)

  expect(await shown.find({ type: 'Text', text: /Enforce: new · ArchUnit: outbox classes do not depend on services; or repositories/ })).toBeDefined()
  expect(await shown.find({ type: 'Text', text: /Enforce: exists · PMD NoSubquery/ })).toBeDefined()
  expect(await shown.find({ key: `enforce-${NEW}` })).toBeDefined()
  expect(await shown.find({ key: `enforce-${EXISTS}` })).toBeUndefined()
  expect(await shown.find({ key: `enforce-${UNMARKED}` })).toBeUndefined()
})

test('Enforce fills the prompt with the check to build', async ($, on) => {
  const filled = world(on)
  await scanned($)
  const shown = await pane($)

  await shown.press({ key: `enforce-${NEW}` })

  expect(filled).toHaveLength(1)
  expect(filled[0]).toMatch(/learned rule "outbox is plumbing" \(CLAUDE\.md\) in this repo: ArchUnit, outbox classes do not depend on services; or repositories\./)
  expect(filled[0]).toMatch(/fails on the rule's BAD example/)
})
