import type { Tracked } from '../types'

// A PR that touched only these needs no documentation update.
const NO_DOCS_NEEDED = /(^|\/)docs?\/|\.mdx?$|(^|\/)(test|tests|__tests__|spec)\/|(Spec|Test)\.(groovy|java|kt)$|\.(test|spec)\.[cm]?[jt]sx?$|^\.github\/|^\.claude\//
const MAX_TITLE = 72

export const onlyDocsTestsCi = (files: string[]) => files.length > 0 && files.every((file) => NO_DOCS_NEEDED.test(file))

export const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

export const slug = (key: string) => key.replace(/[^A-Za-z0-9]+/g, '-')

// git ends a failure with a generic summary ("error: failed to push some refs"); the cause is on an earlier
// `! [rejected] ref -> ref (reason)`, `fatal:` or `remote: error:` line.
const CAUSE_LINE = /^! \[|^fatal:|^remote: (error|fatal)/
const PUSH_CAUSES: [RegExp, string][] = [
  [/\(stale info\)/, 'the remote branch moved since the last fetch (deleted after its PR merged, or pushed from elsewhere)'],
  [/\(fetch first\)|\(non-fast-forward\)/, 'the remote branch has commits the local one does not'],
  [/GH006|protected branch/, 'the branch is protected on GitHub'],
]

export function failureReason(out: { stderr: string; stdout: string }): string {
  const lines = (out.stderr.trim() || out.stdout.trim()).split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => CAUSE_LINE.test(l)) ?? lines.at(-1) ?? ''
  const cause = PUSH_CAUSES.find(([pattern]) => pattern.test(line))?.[1]
  return cause ? `${line}: ${cause}` : line
}

export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// For a draft whose result gave no title: the merged PR's title without its own type prefix.
export function docsTitleFrom(t: Tracked): string {
  const subject = (t.title ?? `pull request #${t.number}`).replace(/^\w+(\([^)]*\))?!?:\s*/, '')
  return `docs: cover ${subject}`.slice(0, MAX_TITLE)
}

// The docs PR's title, from the branch's commit subjects (oldest first): what the docs cover, never only PR numbers.
export function prTitle(subjects: string[]): string {
  const topics = subjects.map((s) => s.replace(/^docs:\s*/, ''))
  const joined = `docs: ${topics.join('; ')}`
  if (topics.length === 1 || joined.length <= MAX_TITLE) {
    return joined.slice(0, MAX_TITLE)
  }
  const more = ` (+${topics.length - 1} more)`
  return `docs: ${topics[0]}`.slice(0, MAX_TITLE - more.length) + more
}

export function prBody(included: Tracked[]): string {
  const lines = included.map((t) => `- #${t.number} ${t.title ?? ''} (${t.url ?? t.key}): ${t.summary ?? ''}`)
  return ['Documentation updates after these merged pull requests:', '', ...lines].join('\n')
}
