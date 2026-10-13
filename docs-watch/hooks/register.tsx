import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Missing, Status, Tracked } from '../types'
import { bandIsEmpty, bandView } from './band'
import type { BandActions, BandModel } from './band'
import { advanceQueues, approve, clearPushErrors } from './branch'
import { dismiss, redo } from './draft'
import type { Host, Kit } from './host'
import { clearErrors, logError, recentErrors, runLogged } from './log'
import { paneView } from './pane'
import type { PaneActions } from './pane'
import { startPending, tick } from './poll'
import { blocking, checkRequirements, describeMissing, dueForPopup, popupText } from './requirements'
import { branchState, branchStates, registerRepo, saveBranchState, toplevel, tracked, visible } from './store'
import { describe } from './text'

const PANE = 'docs-watch'
const TICK_MS = 5 * 60 * 1000
const FIRST_TICK_MS = 20 * 1000
const RESOLVE_CHECK_MS = 15 * 1000
const RECHECK_MS = 30 * 1000
const POPUP_MS = 15 * 1000

const shown = atom({ plugin: 'docs-watch', key: 'shown' } as const, null)
const diff = atom({ plugin: 'docs-watch', key: 'diff' } as const, null)
const setup = atom({ plugin: 'docs-watch', key: 'setup' } as const, null)
const errors = atom({ plugin: 'docs-watch', key: 'errors' } as const, null)
const branches = atom({ plugin: 'docs-watch', key: 'branches' } as const, null)
const popups = atom({ plugin: 'docs-watch', key: 'popups' } as const, null)

// The checkout this session runs in, for registering its repository and checking access to it; set at session start.
let sessionCheckout: string | undefined
let lastRecheck = Number.NEGATIVE_INFINITY

function host($: Engine): Host {
  return {
    run: async (argv, cwd) => {
      try {
        return await $.process.run(argv, { cwd, timeoutMs: 120000 })
      } catch (error) {
        return { exitCode: 127, stdout: '', stderr: describe(error) }
      }
    },
    get: (key) => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    keys: () => $.store.keys(),
    toast: (text, timeoutMs) => (timeoutMs === undefined ? $.ui.toast(text) : $.ui.toast(text, { timeoutMs })),
    debug: (text) => {
      try {
        $.ui.log(text, { to: 'debug' })
      } catch {
        // the debug log is best effort
      }
    },
    spawn: (spec) => $.agent.spawn(spec),
    commandFailed: (tool) => recheckAfterFailure($, tool),
  }
}

function kitOf(el: Omit<Kit, 'Input'> & Partial<Pick<Kit, 'Input'>>): Kit {
  return { Box: el.Box, Text: el.Text, Button: el.Button, Markdown: el.Markdown, Input: el.Input ?? null }
}

// The band shows what blocks the mod; a toast pops up each missing requirement once per session, and again when an
// action using its tool failed.
async function showRequirements($: Engine, missing: Missing[], failedTool?: string): Promise<void> {
  await update($, setup, () => missing)
  const now = await $.clock.now()
  let due: Missing[] = []
  await update($, popups, (seen) => {
    const shownAt = seen ?? {}
    due = dueForPopup(missing, shownAt, now, failedTool)
    return { ...shownAt, ...Object.fromEntries(due.map((m) => [m.id, now])) }
  })
  if (due.length > 0) {
    $.ui.toast(popupText(due), { timeoutMs: POPUP_MS })
  }
}

async function recheckAfterFailure($: Engine, tool: 'git' | 'gh'): Promise<void> {
  const now = await $.clock.now()
  if (now - lastRecheck < RECHECK_MS) {
    return
  }
  lastRecheck = now
  const missing = await checkRequirements(host($), sessionCheckout)
  await showRequirements($, missing, tool)
}

async function setUp($: Engine): Promise<Missing[]> {
  const io = host($)
  const missing = await checkRequirements(io, sessionCheckout)
  await showRequirements($, missing)
  const blocked = blocking(missing)
  if (blocked.length === 0) {
    await registerRepo(io, sessionCheckout)
  }
  return blocked
}

// Polling goes ahead only when nothing blocks it.
async function ready($: Engine): Promise<boolean> {
  const blocked = await setUp($)
  if (blocked.length > 0) {
    await logError(host($), 'setup', blocked.map(describeMissing).join('; '))
  }
  return blocked.length === 0
}


// A press returns at once and the work runs after it, so the surface never waits on git, an agent spawn or the store.
function inBackground($: Engine, action: string, work: () => Promise<unknown>): void {
  void work().catch(async (error) => {
    await logError(host($), action, error)
    $.ui.toast(`${action} failed: ${describe(error)}`)
  })
}

// Approve, dismiss and redo change the list before their slow work; the next refresh shows the real state.
async function showStatus($: Engine, t: Tracked, status: Status | null): Promise<void> {
  await update($, shown, (current) =>
    (current ?? []).flatMap((item) => (item.key !== t.key ? [item] : status === null ? [] : [{ ...item, status }])),
  )
}

async function refreshShown($: Engine): Promise<void> {
  const io = host($)
  const latest = await visible(io)
  await update($, shown, () => latest)
  const states = await branchStates(io)
  await update($, branches, () => states)
  const log = await recentErrors(io)
  await update($, errors, () => log)
}

async function openPane($: Engine): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Docs updates' })
}

function paneActions($: Engine): PaneActions {
  const io = host($)
  const approveThem = async (items: Tracked[]) => {
    for (const t of items) {
      await showStatus($, t, 'applying')
    }
    for (const t of items) {
      await approve(io, t)
    }
    await refreshShown($)
  }
  return {
    approve: (t) => inBackground($, 'Approve', () => approveThem([t])),
    approveAll: (items) => inBackground($, 'Approve all', () => approveThem(items)),
    toggleDiff: (t) => inBackground($, 'Diff', () => update($, diff, (open) => (open?.key === t.key ? null : { key: t.key, text: t.diff ?? '' }))),
    dismiss: (t) =>
      inBackground($, 'Dismiss', async () => {
        await showStatus($, t, null)
        await dismiss(io, t)
        await refreshShown($)
      }),
    redo: (t, note) =>
      note.trim() !== '' &&
      inBackground($, 'Redo', async () => {
        await showStatus($, t, 'drafting')
        await redo(io, t, note.trim())
        await refreshShown($)
      }),
    openPr: (url) => inBackground($, 'Open', () => runLogged(io, 'open', ['open', url])),
    clearErrors: () =>
      inBackground($, 'Clear errors', async () => {
        await clearErrors(io)
        await update($, errors, () => [])
      }),
  }
}

function bandActions($: Engine, announced: string[]): BandActions {
  const io = host($)
  return {
    recheck: () =>
      inBackground($, 'Check', async () => {
        const blocked = await setUp($)
        if (blocked.length === 0) {
          $.ui.toast('docs-watch is set up.')
        }
      }),
    review: () => inBackground($, 'Review', () => openPane($)),
    openPr: (url) => inBackground($, 'Open', () => runLogged(io, 'open', ['open', url])),
    hide: () =>
      inBackground($, 'Hide', async () => {
        for (const repo of announced) {
          await saveBranchState(io, repo, { ...(await branchState(io, repo)), announce: false })
        }
        await refreshShown($)
      }),
    retry: () =>
      inBackground($, 'Retry', async () => {
        await clearPushErrors(io)
        await refreshShown($)
      }),
  }
}

async function redoCommand($: Engine, key: string, note: string): Promise<{ text: string }> {
  const io = host($)
  const target = await tracked(io, key)
  if (!target || target.status !== 'suggested') {
    return { text: `No suggestion waiting for ${key}.` }
  }
  await redo(io, target, note.trim())
  await refreshShown($)
  return { text: `Redrafting ${key}.` }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const io = host($)
    await $.command.register({ name: 'docs-watch', description: 'Review documentation updates drafted after your PRs merged' })
    sessionCheckout = await toplevel(io)
    await setUp($)
    await startPending(io)
    await refreshShown($)
    const poll = async () => {
      await tick(io, () => ready($))
      await refreshShown($)
    }
    $.clock.after(FIRST_TICK_MS, poll)
    $.clock.every(TICK_MS, poll)
    $.clock.every(RESOLVE_CHECK_MS, async () => {
      await advanceQueues(io)
      await refreshShown($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await startPending(host($))
    await refreshShown($)

    return next(e)
  })

  // `/docs-watch redo <owner/repo#number> <note>` redrafts one suggestion with a note; anything else opens the list.
  on('command.run', { command: 'docs-watch' }, async ($, e) => {
    const redoArgs = /^redo\s+(\S+)\s+([\s\S]+)$/.exec(e.args.trim())
    if (redoArgs) {
      return redoCommand($, redoArgs[1] ?? '', redoArgs[2] ?? '')
    }
    await startPending(host($))
    await refreshShown($)
    await openPane($)

    return { text: 'Docs updates opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = (await read($, shown)) ?? []
    const states = Object.entries((await read($, branches)) ?? {})
    const model: BandModel = {
      blocked: blocking((await read($, setup)) ?? []),
      waiting: current.filter((t) => t.status === 'suggested').length,
      announced: states.filter(([, b]) => b.announce && b.prUrl),
      failed: states.filter(([, b]) => b.lastError && !b.pushing),
      pushing: states.some(([, b]) => b.pushing),
    }
    if (e.props.hasSurvey || bandIsEmpty(model)) {
      return next(e)
    }
    const announced = model.announced.map(([repo]) => repo)
    return bandView(kitOf($.ui.resolve(e)), model, bandActions($, announced))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const model = {
      current: (await read($, shown)) ?? [],
      open: await read($, diff),
      log: (await read($, errors)) ?? [],
      missing: (await read($, setup)) ?? [],
    }
    return paneView(kitOf($.ui.resolve(e)), model, paneActions($))
  })
}
