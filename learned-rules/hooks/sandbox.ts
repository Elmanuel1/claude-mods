import type { Host } from './host'
import { markReviewed } from './rules'

const RUN_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'
const POWER_KEY = /^["']?(hooks|allowed-tools)["']?\s*:/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

// The typed text steers the run, pasted text included. It loads only project settings, from an empty folder it runs
// in, so none of the user's settings (which may allow every command), hooks or plugins apply; it may edit only
// Markdown rules and the skill-trigger list, and its only commands are git add and commit on the repos the mod
// prepared. (--restricted would refuse its edits: it treats SKILL.md and CLAUDE.md as sensitive, and -p has nobody to
// approve them.)
export function runArgs(repos: string[]): string[] {
  const commits = repos.flatMap(repo => [`Bash(git -C ${repo} add *)`, `Bash(git -C ${repo} commit *)`])
  // An Edit rule covers every file-editing tool. A path rule's leading / is read relative to the settings file, so
  // the editable paths are written from ~.
  const editable = ['~/.claude/skills/**/*.md', '~/.claude/skills/skill-triggers.json', '~/.claude/learned/repo-worktree/**/*.md']
  const denied = ['Edit(**/.git/**)', 'Edit(**/.git)', 'Bash(git * -c *)', 'Bash(git * push*)']
  return [
    '-p', '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands', '--tools', RUN_TOOLS,
    ...repos.flatMap(repo => ['--add-dir', repo]), '--permission-mode', 'default',
    '--allowedTools', ['Read', 'Grep', 'Glob', ...editable.map(path => `Edit(${path})`), ...commits].join(','),
    '--disallowedTools', denied.join(','),
  ]
}

// git commit runs the repo's hooks, and a relative core.hooksPath (husky's) reads them from files the run can edit.
export function runEnv(io: Host): Record<string, string> {
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: `${io.home}/.claude/learned/no-hooks` }
}

// The skills folder as it stands, uncommitted and untracked files included, as a commit no branch points to. A
// separate index keeps the folder's own index as it was.
export async function snapshot(io: Host, skills: string): Promise<string> {
  const env = { GIT_INDEX_FILE: `${io.home}/.claude/learned/snapshot-index` }
  await io.run(['git', '-C', skills, 'add', '-A'], { env })
  const tree = (await io.run(['git', '-C', skills, 'write-tree'], { env })).stdout.trim()
  return (await io.run(['git', '-C', skills, 'commit-tree', tree, '-m', 'skills before a learning run'])).stdout.trim()
}

// Personal rules are live as soon as they are written, and a skill's hooks or allowed-tools frontmatter can run
// commands or widen what it may do. A file where the run added or changed either, committed or not, goes back to the
// snapshot, and the rule commits that touched it are marked rejected.
export async function undoSkillPowers(io: Host, skills: string, before: string): Promise<number> {
  const changed = await io.run(['git', '-C', skills, 'diff', '--name-only', before])
  const untracked = await io.run(['git', '-C', skills, 'ls-files', '--others', '--exclude-standard'])
  const files = [...new Set([...changed.stdout.split('\n'), ...untracked.stdout.split('\n')])].filter(file => file.endsWith('.md'))
  const offending: string[] = []
  for (const file of files) {
    const was = await io.run(['git', '-C', skills, 'show', `${before}:${file}`])
    const now = powers(await io.read(`${skills}/${file}`))
    if (now !== '' && now !== powers(was.exitCode === 0 ? was.stdout : null)) {
      offending.push(file)
      await restore(io, skills, file, was.exitCode === 0 ? was.stdout : null)
    }
  }
  if (offending.length === 0) {
    return 0
  }
  const touched = await io.run(['git', '-C', skills, 'log', '--format=%s', `${before}..HEAD`, '--', ...offending])
  for (const subject of touched.stdout.split('\n').filter(line => line.startsWith('rule:'))) {
    await markReviewed(io, `personal:${subject}`, 'rejected')
  }
  await commitUndo(io, skills, offending)
  return offending.length
}

// Only the hooks and allowed-tools entries: each key's line and the indented lines under it.
function powers(text: string | null): string {
  const front = text?.match(FRONTMATTER)?.[1] ?? ''
  let isPower = false
  return front
    .split(/\r?\n/)
    .filter(line => {
      isPower = /^\S/.test(line) ? POWER_KEY.test(line) : isPower
      return isPower
    })
    .join('\n')
}

// The content goes back without staging it, so a file that was never committed stays uncommitted.
async function restore(io: Host, skills: string, file: string, content: string | null): Promise<void> {
  if (content !== null) {
    await io.write(`${skills}/${file}`, content)
    return
  }
  await io.run(['git', '-C', skills, 'rm', '-q', '-f', '--ignore-unmatch', '--', file])
  await io.run(['git', '-C', skills, 'clean', '-q', '-f', '--', file])
}

// HEAD may hold the powers the run committed; the undo commits the files HEAD tracks, so a checkout cannot bring them
// back.
async function commitUndo(io: Host, skills: string, offending: string[]): Promise<void> {
  const tracked = (await io.run(['git', '-C', skills, 'ls-files', '--', ...offending])).stdout.split('\n').filter(line => line.length > 0)
  const deleted = (await io.run(['git', '-C', skills, 'ls-tree', '-r', '--name-only', 'HEAD', '--', ...offending])).stdout.split('\n')
  const paths = [...new Set([...tracked, ...deleted])].filter(line => line.length > 0)
  if (paths.length === 0) {
    return
  }
  const committed = await io.run(['git', '-C', skills, 'commit', '-q', '-m', 'Undo skill hooks or allowed-tools a learning run added', '--', ...paths])
  if (committed.exitCode !== 0) {
    io.notify(`Could not commit the undo of skill hooks in ${skills}: ${committed.stderr.trim().split('\n').pop()}`)
  }
}
