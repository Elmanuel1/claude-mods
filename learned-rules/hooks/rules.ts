import type { EnforceStatus, Enforcement, Pending, Rule, RuleRepo } from '../types'
import type { Host } from './host'

export const BRANCH = 'docs/learned-rules'
const REVIEWED_KEY = 'reviewed'
const FIELD = '\u001f'
const RECORD = '\u001e'
const FETCH_EVERY_MS = 5 * 60 * 1000

let lastFetch = 0

export function repoPath(io: Host, repo: RuleRepo): string {
  return repo === 'project' ? `${io.home}/.claude/learned/repo-worktree` : `${io.home}/.claude/skills`
}

async function reviewedKeys(io: Host): Promise<Record<string, 'accepted' | 'rejected'>> {
  return ((await io.get(REVIEWED_KEY)) as Record<string, 'accepted' | 'rejected'> | undefined) ?? {}
}

export async function markReviewed(io: Host, key: string, verdict: 'accepted' | 'rejected'): Promise<void> {
  await io.set(REVIEWED_KEY, { ...(await reviewedKeys(io)), [key]: verdict })
}

export async function scan(io: Host): Promise<Pending> {
  const worktree = repoPath(io, 'project')
  await fetchMain(io, worktree)
  let unpushed = await aheadOfMain(io, worktree)
  if (unpushed > 0 && (await squashMerged(io, worktree)) && (await resetToMain(io, worktree))) {
    unpushed = 0
  }

  const reviewed = await reviewedKeys(io)
  const project = await ruleCommits(io, 'project')
  const personal = await ruleCommits(io, 'personal')
  const rules = [...project, ...personal].filter(rule => !reviewed[rule.key])

  return { rules, unpushed }
}

export async function hasOpenRules(io: Host, worktree: string): Promise<boolean> {
  return (await aheadOfMain(io, worktree)) > 0 && !(await squashMerged(io, worktree))
}

async function aheadOfMain(io: Host, worktree: string): Promise<number> {
  const ahead = await io.run(['git', '-C', worktree, 'rev-list', '--count', `origin/main..${BRANCH}`])
  return ahead.exitCode === 0 ? Number(ahead.stdout.trim()) : 0
}

async function ruleCommits(io: Host, repo: RuleRepo): Promise<Rule[]> {
  const path = repoPath(io, repo)
  const range = repo === 'project' ? [`origin/main..${BRANCH}`] : []
  const log = await io.run(['git', '-C', path, 'log', '--reverse', '--grep=^rule:', `--format=%H${FIELD}%s${FIELD}%b${RECORD}`, ...range])
  if (log.exitCode !== 0) {
    return []
  }
  return log.stdout
    .split(RECORD)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => {
      const [sha = '', subject = '', body = ''] = entry.split(FIELD)
      return {
        key: `${repo}:${subject}`,
        repo,
        sha,
        title: subject.replace(/^rule:\s*/, ''),
        correction: body.match(/^Correction: (.*)$/m)?.[1] ?? '',
        file: body.match(/^File: (.*)$/m)?.[1] ?? '',
        enforce: enforcementOf(body),
      }
    })
}

// "Enforce: <status>; <tool>; <check>", written by the learning run; the check may itself hold semicolons.
function enforcementOf(body: string): Enforcement | null {
  const line = body.match(/^Enforce: (exists|new|partial|none);([^;]*);?(.*)$/m)
  if (!line) {
    return null
  }
  const [, status = '', tool = '', check = ''] = line
  return { status: status as EnforceStatus, tool: tool.trim(), check: check.trim() }
}

// scan runs after every turn; fetching at most every five minutes keeps it off the network most turns.
async function fetchMain(io: Host, worktree: string): Promise<void> {
  if (Date.now() - lastFetch < FETCH_EVERY_MS) {
    return
  }
  lastFetch = Date.now()
  await io.run(['git', '-C', worktree, 'fetch', '-q', 'origin', 'main'], { timeoutMs: 30000 })
}

// The rules PR is squash-merged, so its commits stay "ahead" of main by hash forever. The branch is merged when
// merging it into main would leave main's tree unchanged.
async function squashMerged(io: Host, worktree: string): Promise<boolean> {
  const merged = await io.run(['git', '-C', worktree, 'merge-tree', '--write-tree', 'origin/main', BRANCH])
  const main = await io.run(['git', '-C', worktree, 'rev-parse', 'origin/main^{tree}'])
  const mainTree = main.exitCode === 0 ? main.stdout.trim() : ''
  return merged.exitCode === 0 && mainTree !== '' && merged.stdout.trim().split('\n')[0] === mainTree
}

// Only a clean worktree is reset, so a learning run that is mid-commit keeps its work.
export async function resetToMain(io: Host, worktree: string): Promise<boolean> {
  const status = await io.run(['git', '-C', worktree, 'status', '--porcelain'])
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    return false
  }
  return (await io.run(['git', '-C', worktree, 'reset', '-q', '--hard', 'origin/main'])).exitCode === 0
}

// Rejecting drops the rule: a project commit leaves the branch, a personal one is reverted.
export async function reject(io: Host, rule: Rule): Promise<void> {
  const path = repoPath(io, rule.repo)
  const command = rule.repo === 'project'
    ? ['git', '-C', path, 'rebase', '--onto', `${rule.sha}^`, rule.sha, BRANCH]
    : ['git', '-C', path, 'revert', '--no-edit', rule.sha]
  const undone = await io.run(command)
  if (undone.exitCode !== 0) {
    await io.run(['git', '-C', path, rule.repo === 'project' ? 'rebase' : 'revert', '--abort'])
    io.toast(`Could not reject "${rule.title}": ${undone.stderr.trim().split('\n').pop()}`)
    return
  }
  await markReviewed(io, rule.key, 'rejected')
  io.toast(`Rejected: ${rule.title}`)
}

export async function ruleDiff(io: Host, rule: Rule): Promise<string> {
  const shown = await io.run(['git', '-C', repoPath(io, rule.repo), 'show', '--format=', rule.sha])
  return shown.stdout.slice(0, 20000)
}
