import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Rule, RuleMessage, RulesView } from '../types'
import { ACTION_LABELS, act, pressedRule } from './actions'
import type { RulesUi } from './actions'
import { drain } from './host'
import type { Host } from './host'
import { enqueueEnded, isTypedPrompt, learnNext, recordTyped } from './learn'
import { push } from './push'
import { scan } from './rules'
import { bandView, hasRows, paneView } from './rules-view'

const PANE = 'learned-rules'

const pending = atom({ plugin: 'learned-rules', key: 'pending' } as const, null)
const diff = atom({ plugin: 'learned-rules', key: 'diff' } as const, null)
const isPushing = atom({ plugin: 'learned-rules', key: 'isPushing' } as const, false)
const isPushingRef = { plugin: 'learned-rules', key: 'isPushing' } as const

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function host($: Engine): Promise<Host> {
  return {
    run: async (argv, init) => {
      try {
        return await $.process.run(argv, { timeoutMs: 120000, ...init })
      } catch (error) {
        return { exitCode: 127, stdout: '', stderr: messageOf(error) }
      }
    },
    read: path => $.fs.read(path).catch(() => null),
    write: (path, text) => $.fs.write(path, text),
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    remove: key => $.store.delete(key),
    userSettings: () => $.settings.read({ source: 'user' }),
    claude: (args, prompt, cwd) =>
      drain($.process.spawn({ argv: ['claude', ...args], cwd, env: { LEARN_FROM_CORRECTIONS: '1' }, input: prompt })),
    toast: text => $.ui.toast(text),
    notify: text => {
      $.ui.toast(text)
      void $.ui.notify(text, { title: 'Learned rules' })
    },
    now: () => $.clock.now(),
    sessionId: () => $.session.id(),
    // USERPROFILE is Windows' home.
    home: (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '',
    pluginRoot: $.plugin.root,
  }
}

// The learning run's own headless session records and queues nothing.
async function isLearningRun($: Engine): Promise<boolean> {
  return (await $.env.get('LEARN_FROM_CORRECTIONS')) !== undefined
}

// Every redraw hands the surface new press handles; a press landing on a tree the desktop has not
// replaced yet reaches no handler. Skipping writes that change nothing keeps those windows rare.
async function refresh($: Engine): Promise<void> {
  const found = await scan(await host($))
  if (JSON.stringify(await read($, pending)) !== JSON.stringify(found)) {
    await update($, pending, () => found)
  }
}

// A press only claims the push and returns; the processes run after it. The compare-and-set on
// isPushing is what drops a second press, from either the band or the pane, while one runs.
async function startPush($: Engine): Promise<void> {
  const held = await $.state.get(isPushingRef)
  if (held.value === true || !(await $.state.set(isPushingRef, true, { ifVersion: held.version })).isSet) {
    return
  }
  void (async () => {
    try {
      await push(await host($))
      await refresh($)
    } finally {
      await $.state.set(isPushingRef, false)
    }
  })()
}

async function rulesUi($: Engine): Promise<RulesUi> {
  return {
    io: await host($),
    rule: async key => (await read($, pending))?.rules.find(r => r.key === key),
    hide: async (rule: Rule) => void (await update($, pending, current => (current ? { ...current, rules: current.rules.filter(r => r.key !== rule.key) } : current))),
    refresh: () => refresh($),
    fill: async text => void (await $.prompt.fill({ text })),
    diffKey: async () => (await read($, diff))?.key ?? null,
    showDiff: async shown => void (await update($, diff, () => shown)),
    startPush: () => startPush($),
  }
}

// A press returns at once and the work runs after it, so the surface never waits on git or the store.
function actInBackground($: Engine, message: RuleMessage): void {
  void rulesUi($).then(ui => act(ui, message)).catch(error => $.ui.toast(`${ACTION_LABELS[message.action]} failed: ${messageOf(error)}`))
}

async function learnInBackground($: Engine): Promise<void> {
  if (await isLearningRun($)) {
    return
  }
  try {
    await learnNext(await host($))
    await refresh($)
  } catch (error) {
    $.ui.toast(`Learning run failed: ${messageOf(error)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'learned', description: 'Accept or reject the rules learned from your corrections' })
    // A reload drops the module that ran an unfinished push, which would leave isPushing stuck.
    await update($, isPushing, () => false)
    const found = await scan(await host($))
    await update($, pending, () => found)
    if (found.rules.length > 0) {
      $.ui.toast(`${found.rules.length} learned rule(s) to review: /learned`)
    }
    void learnInBackground($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isTypedPrompt(e) && !(await isLearningRun($))) {
      await recordTyped(await host($), e.text)
    }

    return next(e)
  })

  // Ending only queues the session; a session that is open runs the learning, so nothing outlives its process.
  on('classic.SessionEnd', async ($, e, next) => {
    if (!(await isLearningRun($))) {
      await enqueueEnded(await host($), e.session_id, e.cwd)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    void learnInBackground($)

    return next(e)
  })

  on('command.run', { command: 'learned' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Learned rules' })

    return { text: 'Learned rules opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const toReview = (await read($, pending))?.rules.length ?? 0
    const pushing = await read($, isPushing)
    // Accepted rules leave the prompt at once; pushing them is in the /learned pane.
    if (e.props.hasSurvey || (toReview === 0 && !pushing)) {
      return next(e)
    }

    return bandView($.ui.resolve(e), toReview)
  })

  // Presses on the buttons the hooks draw (the band, and the pane outside the terminal) answer here, by key.
  on('ui.press', { plugin: 'learned-rules' }, async ($, e, next) => {
    if (e.element === 'review') {
      await $.ui.open({ id: PANE, title: 'Learned rules' })
      return { element: e.element }
    }
    const message = pressedRule(e.element)
    if (message === null) {
      return next(e)
    }
    actInBackground($, message)
    return { element: e.element }
  })

  on('ui.message', { element: 'rules' }, ($, e) => {
    actInBackground($, e.data as RuleMessage)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const current = await read($, pending)
    const rules = current ? current.rules : []
    const canPush = current !== null && rules.length === 0 && current.unpushed > 0
    const view: RulesView = { rules, diff: await read($, diff), canPush, isPushing: await read($, isPushing) }

    // The desktop draws a Client in terminal cells: its Buttons come out as plain text, so it gets its own.
    if (e.surface === 'terminal' && hasRows(view)) {
      const { Client } = $.ui.resolve(e)
      return <Client key="rules" module="./rules-client.tsx" props={view} />
    }
    return paneView($.ui.resolve(e), view)
  })
}
