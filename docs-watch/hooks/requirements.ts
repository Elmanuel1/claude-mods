import type { Missing } from '../types'
import type { Host } from './host'

// A requirement's popup comes back after a failed action at most this often, so one action's several failing
// commands raise it once.
const REPEAT_MS = 60 * 1000
const CAN_PUSH = ['ADMIN', 'MAINTAIN', 'WRITE']

// What the checks found; `null` where a check did not run because an earlier one failed.
export type Facts = {
  os: string
  git: boolean
  claude: boolean
  gh: boolean
  ghAuth: boolean | null
  // this session's GitHub repository; `permission` is null when gh cannot reach it
  repo: { name: string; permission: string | null } | null
}

// What this machine lacks: git, claude and gh on PATH, gh logged in to github.com, and the session's repository
// reachable and pushable with that login. Only exit codes and the permission name are read, so no token is ever shown.
export async function checkRequirements(io: Host, checkout: string | undefined): Promise<Missing[]> {
  const os = (await io.run(['uname'])).stdout.trim()
  const git = (await io.run(['git', '--version'])).exitCode === 0
  const claude = (await io.run(['claude', '--version'])).exitCode === 0
  const gh = (await io.run(['gh', '--version'])).exitCode === 0
  const ghAuth = gh ? (await io.run(['gh', 'auth', 'status', '--hostname', 'github.com'])).exitCode === 0 : null
  const repo = git && ghAuth && checkout ? await repoAccess(io, checkout) : null
  return missingRequirements({ os, git, claude, gh, ghAuth, repo })
}

async function repoAccess(io: Host, checkout: string): Promise<Facts['repo']> {
  const remote = await io.run(['git', '-C', checkout, 'remote', 'get-url', 'origin'])
  const name = remote.exitCode === 0 ? githubRepoOf(remote.stdout) : null
  if (!name) {
    return null
  }
  const view = await io.run(['gh', 'repo', 'view', name, '--json', 'viewerPermission', '-q', '.viewerPermission'])
  return { name, permission: view.exitCode === 0 ? view.stdout.trim() : null }
}

export const blocking = (missing: Missing[]) => missing.filter((m) => m.blocks)

export function missingRequirements(facts: Facts): Missing[] {
  const mac = facts.os === 'Darwin'
  const missing: Missing[] = []
  if (!facts.git) {
    missing.push({
      id: 'git',
      tool: 'git',
      blocks: true,
      what: 'git is not installed or not on PATH',
      fix: mac ? 'run `brew install git` (no Homebrew yet: `xcode-select --install`)' : 'install it from https://git-scm.com/downloads',
    })
  }
  if (!facts.claude) {
    missing.push({
      id: 'claude',
      tool: 'claude',
      blocks: false,
      what: 'the Claude Code CLI (`claude`) is not on PATH',
      fix: 'install it with `curl -fsSL https://claude.ai/install.sh | bash`',
    })
  }
  if (!facts.gh) {
    missing.push({
      id: 'gh',
      tool: 'gh',
      blocks: true,
      what: 'the GitHub CLI (`gh`) is not installed or not on PATH',
      fix: mac ? 'run `brew install gh`' : 'install it from https://cli.github.com',
    })
  }
  if (facts.ghAuth === false) {
    missing.push({
      id: 'gh-auth',
      tool: 'gh',
      blocks: true,
      what: 'gh is not logged in to github.com',
      fix: 'run `gh auth login --hostname github.com`',
    })
  }
  const repo = repoMissing(facts.repo)
  if (repo) {
    missing.push(repo)
  }
  return missing
}

function repoMissing(repo: Facts['repo']): Missing | null {
  if (!repo) {
    return null
  }
  if (repo.permission === null) {
    return {
      id: `repo:${repo.name}`,
      tool: 'gh',
      blocks: false,
      what: `gh's github.com login cannot reach ${repo.name}`,
      fix: 'run `gh auth refresh --hostname github.com --scopes repo`, or `gh auth login` as an account with access',
    }
  }
  if (CAN_PUSH.includes(repo.permission)) {
    return null
  }
  return {
    id: `repo:${repo.name}`,
    tool: 'gh',
    blocks: false,
    what: `gh's github.com login can read ${repo.name} but not push to it`,
    fix: 'ask for write access, or run `gh auth login --hostname github.com` as an account that has it',
  }
}

// `owner/name` from a GitHub remote URL (https or ssh); null for any other host.
function githubRepoOf(remote: string): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?\/?$/.exec(remote.trim())
  return match?.[1] ?? null
}

export const describeMissing = (m: Missing) => `${m.what}: ${m.fix}`

export const popupText = (due: Missing[]) => `docs-watch: ${due.map(describeMissing).join('. ')}.`

// Each missing requirement pops up once per session, and again when an action using its tool failed.
export function dueForPopup(missing: Missing[], shownAt: Record<string, number>, now: number, failedTool?: string): Missing[] {
  return missing.filter((m) => {
    const last = shownAt[m.id]
    if (last === undefined) {
      return true
    }
    return m.tool === failedTool && now - last >= REPEAT_MS
  })
}
