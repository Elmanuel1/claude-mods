import type { Tracked } from '../types'

// A PR that touched only these needs no documentation update.
const NO_DOCS_NEEDED = /(^|\/)docs?\/|\.mdx?$|(^|\/)(test|tests|__tests__|spec)\/|(Spec|Test)\.(groovy|java|kt)$|\.(test|spec)\.[cm]?[jt]sx?$|^\.github\/|^\.claude\//
const MAX_TITLE = 72

export const onlyDocsTestsCi = (files: string[]) => files.length > 0 && files.every((file) => NO_DOCS_NEEDED.test(file))

export const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

export const slug = (key: string) => key.replace(/[^A-Za-z0-9]+/g, '-')

export const lastLine = (out: { stderr: string; stdout: string }) => (out.stderr.trim() || out.stdout.trim()).split('\n').pop() ?? ''

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

export function prBody(t: Tracked): string {
  return [`Documentation update after #${t.number} ${t.title ?? ''} (${t.url ?? t.key}).`, '', t.summary ?? ''].join('\n')
}
