import type { Host } from './host'
import { markReviewedKey } from './rules'

const RUN_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'
const SKILL_POWERS = /^\+\s*(hooks|allowed-tools)\s*:/m

// The typed text steers the run, pasted text included, so the run loads no settings, MCP servers or skills (the
// user's own settings may allow every command), may write only Markdown rules and the skill-trigger list, and runs
// only git add and commit on the two repos the mod prepared.
export function runArgs(skills: string, worktree: string): string[] {
  const commits = [skills, worktree].flatMap(repo => [`Bash(git -C ${repo} add *)`, `Bash(git -C ${repo} commit *)`])
  // A path rule's leading / is read relative to the settings file, so the editable paths are written from ~.
  const editable = ['~/.claude/skills/**/*.md', '~/.claude/skills/skill-triggers.json', '~/.claude/learned/repo-worktree/**/*.md']
    .flatMap(path => [`Edit(${path})`, `Write(${path})`])
  const denied = ['Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(**/.git)', 'Write(**/.git)', 'Bash(git * -c *)', 'Bash(git * push*)']
  return [
    '-p', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', RUN_TOOLS,
    '--permission-mode', 'default',
    '--allowedTools', ['Read', 'Grep', 'Glob', ...editable, ...commits].join(','),
    '--disallowedTools', denied.join(','),
  ]
}

// git commit runs the repo's hooks, and a relative core.hooksPath (husky's) reads them from files the run can edit.
export function runEnv(io: Host): Record<string, string> {
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: `${io.home}/.claude/learned/no-hooks` }
}

// A personal rule is live once committed, and a skill's frontmatter can run commands (hooks) or widen what it may do
// (allowed-tools), so a rule commit that adds either is reverted, and marked rejected, before a session loads it.
export async function revertSkillPowers(io: Host, skills: string, since: string): Promise<number> {
  const made = await io.run(['git', '-C', skills, 'rev-list', `${since}..HEAD`])
  let reverted = 0
  for (const sha of made.stdout.split('\n').filter(line => line.length > 0)) {
    const shown = await io.run(['git', '-C', skills, 'show', '--format=%s', '-U0', sha])
    if (!SKILL_POWERS.test(shown.stdout) || (await io.run(['git', '-C', skills, 'revert', '--no-edit', sha])).exitCode !== 0) {
      continue
    }
    await markReviewedKey(io, `personal:${shown.stdout.split('\n')[0] ?? ''}`, 'rejected')
    reverted += 1
  }
  return reverted
}
