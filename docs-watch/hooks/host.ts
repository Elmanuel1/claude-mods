import type { AgentSpawnResult, BoxProps, ButtonProps, ElementConstructor, InputProps, MarkdownProps, TextProps } from 'claude-code'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type SpawnSpec = { prompt: string; subagentType: string; description: string; cwd?: string }

/**
 * What the mod's logic needs from the engine. The engine follows `$` only within the hooks module's own file, so
 * register.tsx builds this from `$` and the other files take it instead.
 */
export type Host = {
  /** Never rejects: a command that cannot start resolves with exit code 127. */
  run: (argv: string[], cwd?: string) => Promise<RunResult>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  keys: () => Promise<string[]>
  toast: (text: string, timeoutMs?: number) => void
  debug: (text: string) => void
  spawn: (spec: SpawnSpec) => Promise<AgentSpawnResult>
  /** A git or gh command failed: re-check the requirements and pop up the missing ones that tool needs. */
  commandFailed: (tool: 'git' | 'gh') => Promise<void>
}

/** The elements the band and the pane draw with, from `$.ui.resolve(e)`; `Input` is null where the surface has none. */
export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
  Input: ElementConstructor<InputProps> | null
}
