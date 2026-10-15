import type { Host } from './host'

export type RuleEdit = { old: string; new: string }

export type LearnedRule = {
  repo: 'personal' | 'project'
  file: string
  edits: RuleEdit[]
  subject: string
  correction: string
  enforce: string
}

/** `project` is null when no repo worktree was prepared for this run. */
export type RuleRoots = { personal: string; project: string | null }

export type Applied = { committed: number; refused: string[] }

const RULES_BLOCK = /```rules\s*\n([\s\S]*?)\n```/g
const POWER_KEY = /^["']?(hooks|allowed-tools)["']?\s*:/
// A skill runs !`cmd` and ```! blocks when it loads.
const SHELL_IN_SKILL = /(^|\s)!`[^`]+`|```!/g
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

/** The entries of the run's last ```rules block; null when there is none or it is not JSON with a rules list. */
export function parseRules(output: string): unknown[] | null {
  const block = [...output.matchAll(RULES_BLOCK)].pop()?.[1]
  try {
    const parsed = JSON.parse(block ?? '') as { rules?: unknown }
    return Array.isArray(parsed.rules) ? parsed.rules : null
  } catch {
    return null
  }
}

// The mod, not the run, writes and commits each rule, one commit per rule: the file must be a Markdown rule (or the
// skill-trigger list) inside its repo, each edit must match exactly once, and no edit may add or change a skill's
// hooks or allowed-tools, which would run commands or widen what the skill may do.
export async function applyRules(io: Host, entries: unknown[], roots: RuleRoots): Promise<Applied> {
  const refused: string[] = []
  for (const [index, entry] of entries.entries()) {
    const problem = isLearnedRule(entry) ? await applyRule(io, entry, roots) : 'not in the expected shape'
    if (problem) {
      refused.push(`${isLearnedRule(entry) ? entry.subject : `entry ${index + 1}`}: ${problem}`)
    }
  }
  return { committed: entries.length - refused.length, refused }
}

async function applyRule(io: Host, rule: LearnedRule, roots: RuleRoots): Promise<string | null> {
  const root = rule.repo === 'personal' ? roots.personal : roots.project
  if (!root) {
    return 'there is no repo worktree this run'
  }
  if (!isRuleFile(rule) || !rule.subject.startsWith('rule: ')) {
    return `not a rule file or rule subject: ${rule.file}`
  }
  const path = `${root}/${rule.file}`
  const existing = await io.read(path)
  const before = existing ?? ''
  const after = rule.edits.reduce<string | null>((text, edit) => (text === null ? null : applyEdit(text, edit)), before)
  if (after === null) {
    return 'an edit does not match the file exactly once'
  }
  if (powers(after) !== powers(before)) {
    return 'it adds or changes hooks or allowed-tools'
  }
  if (shellCount(after) > shellCount(before)) {
    return 'it adds a shell command a skill runs when it loads'
  }
  await io.write(path, after)
  await io.run(['git', '-C', root, 'add', '--', rule.file])
  const committed = await io.run(['git', '-C', root, 'commit', '-q', '-m', rule.subject, '-m', bodyOf(rule), '--', rule.file])
  if (committed.exitCode === 0) {
    return null
  }
  await undoWrite(io, root, rule.file, existing)
  return `commit failed: ${committed.stderr.trim().split('\n').pop()}`
}

// The file and the index go back to how they were, so neither repo is left dirty by a rule that did not land.
async function undoWrite(io: Host, root: string, file: string, existing: string | null): Promise<void> {
  await io.run(['git', '-C', root, 'reset', '-q', '--', file])
  if (existing !== null) {
    await io.write(`${root}/${file}`, existing)
    return
  }
  await io.run(['git', '-C', root, 'clean', '-q', '-f', '--', file])
}

function shellCount(text: string): number {
  return [...text.matchAll(SHELL_IN_SKILL)].length
}

function bodyOf(rule: LearnedRule): string {
  const lines = [`Correction: ${rule.correction}`, `File: ${rule.file}`, rule.enforce ? `Enforce: ${rule.enforce}` : '']
  return lines.filter(line => line.length > 0).join('\n')
}

// An empty `old` appends `new` at the end, which also creates a file.
function applyEdit(text: string, edit: RuleEdit): string | null {
  if (edit.old === '') {
    return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${edit.new}`
  }
  const at = text.indexOf(edit.old)
  if (at < 0 || text.indexOf(edit.old, at + 1) >= 0) {
    return null
  }
  return text.slice(0, at) + edit.new + text.slice(at + edit.old.length)
}

function isRuleFile({ repo, file }: LearnedRule): boolean {
  const parts = file.split('/')
  const isInside = !/^([/\\]|[A-Za-z]:)/.test(file) && !file.includes('\\') && !parts.includes('..') && !parts.includes('.git')
  return isInside && (file.endsWith('.md') || (repo === 'personal' && file === 'skill-triggers.json'))
}

// Only the hooks and allowed-tools entries of the frontmatter: each key's line and the indented lines under it.
function powers(text: string): string {
  const front = text.match(FRONTMATTER)?.[1] ?? ''
  let isPower = false
  return front
    .split(/\r?\n/)
    .filter(line => {
      isPower = /^\S/.test(line) ? POWER_KEY.test(line) : isPower
      return isPower
    })
    .join('\n')
}

function isLearnedRule(value: unknown): value is LearnedRule {
  const rule = value as Partial<LearnedRule> | null
  const isText = (field: unknown) => typeof field === 'string'
  return (
    (rule?.repo === 'personal' || rule?.repo === 'project') &&
    isText(rule.file) && isText(rule.subject) && isText(rule.correction) && isText(rule.enforce) &&
    Array.isArray(rule.edits) && rule.edits.every(edit => isText(edit?.old) && isText(edit?.new))
  )
}
