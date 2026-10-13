import type { LogEntry } from '../types'
import type { Host } from './host'
import { describe, lastLine, parseJson } from './text'

const LOG_KEY = 'log'
const LOG_LIMIT = 100
const CLAUDE_APP = 'com.anthropic.claudefordesktop'

// Every failure goes to the debug log and to the mod's own log, which the pane shows; logging itself never throws.
export async function logError(io: Host, where: string, detail: unknown, key?: string): Promise<void> {
  const message = describe(detail).slice(0, 2000)
  io.debug(`docs-watch ${where}${key ? ` (${key})` : ''}: ${message}`)
  try {
    const log = ((await io.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
    const entry: LogEntry = { at: Date.now(), where, message, key }
    await io.set(LOG_KEY, [...log.slice(-(LOG_LIMIT - 1)), entry])
  } catch {
    // the store failing leaves the debug log line as the only record
  }
}

// A command whose failure matters: a non-zero exit is logged with the command and the last line of its output, and a
// failed git or gh command re-checks the requirements.
export async function runLogged(io: Host, where: string, argv: string[], cwd?: string, key?: string) {
  const result = await io.run(argv, cwd)
  if (result.exitCode === 0) {
    return result
  }
  await logError(io, where, `\`${argv.join(' ').slice(0, 200)}\` exited ${result.exitCode}: ${lastLine(result)}`, key)
  const tool = argv[0]
  if (tool === 'git' || tool === 'gh') {
    await io.commandFailed(tool)
  }
  return result
}

export async function recentErrors(io: Host): Promise<LogEntry[]> {
  const log = ((await io.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  return log.slice(-10).reverse()
}

export async function clearErrors(io: Host): Promise<void> {
  await io.set(LOG_KEY, [])
}

export async function stateDir(io: Host): Promise<string> {
  const env = await runLogged(io, 'home', ['printenv', 'HOME'])
  return `${env.stdout.trim()}/.claude/docs-watch`
}

// macOS: with terminal-notifier a click brings Claude to the front, where the line above the prompt has the action, and
// a newer notice replaces the last one. Without it a click does nothing, so the text names the step.
export async function notify(io: Host, text: string): Promise<void> {
  io.toast(text)
  const os = await io.run(['uname'])
  if (os.stdout.trim() !== 'Darwin') {
    return
  }
  const notifier = await io.run(['terminal-notifier', '-title', 'Claude: docs', '-message', text, '-activate', CLAUDE_APP, '-group', 'docs-watch'])
  if (notifier.exitCode === 0) {
    return
  }
  const script = `display notification ${JSON.stringify(`${text} Open Claude and run /docs-watch.`)} with title "Claude: docs"`
  await runLogged(io, 'notify', ['osascript', '-e', script])
}

// Null while the file does not exist yet; a file that is there but not JSON is logged.
export async function readResult(io: Host, file: string, key: string): Promise<Record<string, unknown> | null> {
  const out = await io.run(['cat', file])
  if (out.exitCode !== 0) {
    return null
  }
  const parsed = parseJson<Record<string, unknown>>(out.stdout)
  if (parsed === null) {
    await logError(io, 'result file', `${file} is not JSON: ${out.stdout.slice(0, 200)}`, key)
  }
  return parsed
}
