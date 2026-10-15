import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

const PLUGIN = 'learned-rules'
const PUSH_MS = 1000
const PR_URL = 'https://github.com/example/repo/pull/9'
const SURFACES = ['terminal', 'desktop'] as const

type PushOutcome = { exitCode: number; stderr: string } | { deny: string }

type World = {
  clock: MockClock
  toasts: string[]
  calls: string[][]
  isPushDone: () => boolean
}

const ran = (stdout: string, exitCode = 0, stderr = ''): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// A worktree whose rules are all reviewed and one commit ahead of main: the state that draws Push.
// git push sleeps on the mocked clock, so it stays running until the test advances it.
function world(on: On, pushOutcome: PushOutcome = { exitCode: 0, stderr: '' }): World {
  const clock = mock.clock(on)
  mock.store(on, { reviewed: {} })
  mock.env(on, { HOME: '/home/tester' })
  const toasts: string[] = []
  const calls: string[][] = []
  let isPushDone = false

  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  // What the engine draws in the band when the plugin has nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv.includes('rev-list')) {
      return ran('1\n')
    }
    if (argv.includes('push')) {
      await clock.sleep(PUSH_MS)
      isPushDone = true
      if ('deny' in pushOutcome) {
        return { deny: pushOutcome.deny }
      }
      return ran('', pushOutcome.exitCode, pushOutcome.stderr)
    }
    if (argv[0] === 'gh' && argv[2] === 'view') {
      return ran('', 1, 'no pull requests found for branch "docs/learned-rules"')
    }
    if (argv[0] === 'gh' && argv[2] === 'create') {
      return ran(`${PR_URL}\n`)
    }
    return ran('')
  })

  return { clock, toasts, calls, isPushDone: () => isPushDone }
}

const scanned = ($: Engine) => $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

const scroll = { offset: 0, bodyRows: 10 }

const band = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll, view: {} },
  })

const pane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: 'learned-rules',
    props: { title: 'Learned rules', isFocused: true, bodyColumns: 80, placement: 'dock', scroll, view: {} },
  })

const pushes = (calls: string[][]) => calls.filter(argv => argv.includes('push')).length

// The pane's list is drawn by a Client on both surfaces.
// The terminal draws the pane's list in a Client; the desktop draws it with its own buttons.
const rulesOn = (surface: string) => (surface === 'terminal' ? { in: 'rules' } : {})

for (const surface of SURFACES) {
  describe(surface, () => {
    const RULES = rulesOn(surface)
    test('Push returns before git push finishes and both sites show the working state', async ($, on) => {
      const { clock, toasts, isPushDone } = world(on)
      await scanned($)
      const shownBand = await band($, surface)
      const shownPane = await pane($, surface)

      await shownPane.press({ key: 'pane-push' })

      expect(isPushDone()).toBe(false)
      expect((await shownBand.find({ type: 'Text', text: 'Pushing' }))?.text).toContain('Pushing learned rules')
      expect(await shownPane.find({ text: /Pushing accepted rules/, ...RULES })).toBeDefined()
      expect(await shownPane.find({ key: 'pane-push', ...RULES })).toBeUndefined()

      await clock.advance(PUSH_MS)

      expect(isPushDone()).toBe(true)
      expect(toasts).toContain(`Pushed. PR opened: ${PR_URL}`)
      expect(await shownBand.find({ type: 'Text', text: 'Pushing' })).toBeUndefined()
      expect(await shownPane.find({ key: 'pane-push', ...RULES })).toBeDefined()
    })

    test('a second press while a push runs is ignored', async ($, on) => {
      const { clock, calls, toasts } = world(on)
      await scanned($)
      const shownPane = await pane($, surface)

      // Both presses leave before either redraw, as two clicks on a tree not yet replaced do.
      await Promise.all([shownPane.press({ key: 'pane-push' }), shownPane.press({ key: 'pane-push' })])
      await clock.advance(PUSH_MS)

      expect(pushes(calls)).toBe(1)
      expect(toasts.filter(text => text.startsWith('Pushed.'))).toHaveLength(1)
    })

    test('a failed push shows its error and brings Push back', async ($, on) => {
      const { clock, toasts } = world(on, {
        exitCode: 1,
        stderr: ' ! [rejected] docs/learned-rules -> docs/learned-rules (stale info)\nerror: failed to push some refs',
      })
      await scanned($)
      const shownPane = await pane($, surface)

      await shownPane.press({ key: 'pane-push' })
      await clock.advance(PUSH_MS)

      expect(toasts).toContain('Push failed: error: failed to push some refs')
      expect(await shownPane.find({ key: 'pane-push', ...RULES })).toBeDefined()
    })

    test('a push that cannot run shows why and brings Push back', async ($, on) => {
      const { clock, toasts } = world(on, { deny: 'git push timed out after 120000 ms' })
      await scanned($)
      const shownPane = await pane($, surface)

      await shownPane.press({ key: 'pane-push' })
      await clock.advance(PUSH_MS)

      expect(toasts.some(text => text.startsWith('Push failed:') && text.includes('timed out'))).toBe(true)
      expect(await shownPane.find({ key: 'pane-push', ...RULES })).toBeDefined()
    })
  })
}
