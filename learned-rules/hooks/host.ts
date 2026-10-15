export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type RunInit = { cwd?: string; timeoutMs?: number }

// The engine follows `$` only within the hooks module's own file, so register.tsx builds this from `$` and the
// other files take it instead.
export type Host = {
  /** Never rejects: a command that cannot start or outlives its timeout resolves with exit code 127. */
  run: (argv: string[], init?: RunInit) => Promise<RunResult>
  /** null when the file is missing or unreadable */
  read: (path: string) => Promise<string | null>
  write: (path: string, text: string) => Promise<void>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
  userSettings: () => Promise<unknown>
  /** Runs `claude` headless with the prompt on stdin; `code` is null when the child was killed. */
  claude: (args: string[], prompt: string, cwd: string) => Promise<{ code: number | null; output: string }>
  toast: (text: string) => void
  /** A toast, and the person's own notification channel */
  notify: (text: string) => void
  now: () => Promise<number>
  sessionId: () => Promise<string>
  home: string
  pluginRoot: string
}

export async function drain(child: AsyncGenerator<{ text: string }, { code: number | null }>): Promise<{ code: number | null; output: string }> {
  let output = ''
  let step = await child.next()
  while (!step.done) {
    output += step.value.text
    step = await child.next()
  }
  return { code: step.value.code, output }
}
