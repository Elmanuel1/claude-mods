import type { Host } from './host'
import { markReviewed } from './rules'

const RUN_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'
const POWER_KEY = /^\s*["']?(hooks|allowed-tools)["']?\s*:/m
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

// The typed text steers the run, pasted text included. --restricted ignores the user's settings files (which may
// allow every command) and confines the file tools to the added directories; the run may write only Markdown rules
// and the skill-trigger list, and its only commands are git add and commit on the two repos the mod prepared.
export function runArgs(io: Host, skills: string, worktree: string): string[] {
  const commits = [skills, worktree].flatMap(repo => [`Bash(git -C ${repo} add *)`, `Bash(git -C ${repo} commit *)`])
  // A path rule's leading / is read relative to the settings file, so the editable paths are written from ~.
  const editable = ['~/.claude/skills/**/*.md', '~/.claude/skills/skill-triggers.json', '~/.claude/learned/repo-worktree/**/*.md']
    .flatMap(path => [`Edit(${path})`, `Write(${path})`])
  const denied = ['Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(**/.git)', 'Write(**/.git)', 'Bash(git * -c *)', 'Bash(git * push*)']
  return [
    '-p', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--tools', RUN_TOOLS,
    '--add-dir', `${io.home}/.claude`, '--add-dir', io.pluginRoot, '--permission-mode', 'default',
    '--allowedTools', ['Read', 'Grep', 'Glob', ...editable, ...commits].join(','),
    '--disallowedTools', denied.join(','),
  ]
}

// git commit runs the repo's hooks, and a relative core.hooksPath (husky's) reads them from files the run can edit.
export function runEnv(io: Host): Record<string, string> {
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: `${io.home}/.claude/learned/no-hooks` }
}

// The skills folder as it stands, uncommitted edits included, without touching it.
export async function snapshot(io: Host, skills: string): Promise<string> {
  const stashed = (await io.run(['git', '-C', skills, 'stash', 'create'])).stdout.trim()
  return stashed || (await io.run(['git', '-C', skills, 'rev-parse', 'HEAD'])).stdout.trim()
}

// Personal rules are live as soon as they are written, and a skill's frontmatter can run commands (hooks) or widen
// what it may do (allowed-tools). A file whose frontmatter gained or changed either since the snapshot, committed or
// not, goes back to the snapshot, and the rule commits that touched it are marked rejected.
export async function undoSkillPowers(io: Host, skills: string, before: string): Promise<number> {
  const changed = await io.run(['git', '-C', skills, 'diff', '--name-only', before])
  const added = await io.run(['git', '-C', skills, 'ls-files', '--others', '--exclude-standard'])
  const files = [...changed.stdout.split('\n'), ...added.stdout.split('\n')].filter(file => file.endsWith('.md'))
  const offending: string[] = []
  for (const file of files) {
    const was = await io.run(['git', '-C', skills, 'show', `${before}:${file}`])
    const now = powers(await io.read(`${skills}/${file}`))
    if (now !== '' && now !== powers(was.exitCode === 0 ? was.stdout : null)) {
      offending.push(file)
      await restore(io, skills, before, file, was.exitCode === 0)
    }
  }
  if (offending.length === 0) {
    return 0
  }
  const touched = await io.run(['git', '-C', skills, 'log', '--format=%s', `${before}..HEAD`, '--', ...offending])
  for (const subject of touched.stdout.split('\n').filter(line => line.startsWith('rule:'))) {
    await markReviewed(io, `personal:${subject}`, 'rejected')
  }
  await io.run(['git', '-C', skills, 'commit', '-q', '-m', 'Undo skill hooks or allowed-tools a learning run added', '--', ...offending])
  return offending.length
}

function powers(text: string | null): string {
  const front = text?.match(FRONTMATTER)?.[1] ?? ''
  return POWER_KEY.test(front) ? front : ''
}

async function restore(io: Host, skills: string, before: string, file: string, existed: boolean): Promise<void> {
  if (existed) {
    await io.run(['git', '-C', skills, 'checkout', before, '--', file])
    return
  }
  await io.run(['git', '-C', skills, 'rm', '-q', '-f', '--ignore-unmatch', '--', file])
  await io.run(['git', '-C', skills, 'clean', '-q', '-f', '--', file])
}
