import type { Host } from './host'

// Tracked files that configure a linter, a structural check, a ratchet, a policy or a CI gate, in any language.
const ENFORCER_FILES = new RegExp(
  '(^|/)(' +
    [
      '(pmd|checkstyle|spotbugs|codenarc|detekt|lint|linters)/[^/]+',
      '[^/]*(pmd|checkstyle|spotbugs|codenarc|detekt)[^/]*\\.(xml|groovy|ya?ml)',
      '[^/]*(ArchitectureRules|ArchRule|Architecture(Test|Spec)|ArchitecturePredicates|Konsist)[^/]*',
      'archunit[^/]*',
      'rewrite\\.ya?ml',
      '[^/]*(ratchet|baseline|coverage-floors)[^/]*',
      'spotless\\.gradle',
      'sonar-project\\.properties',
      'eslint\\.config\\.[cm]?[jt]s',
      '\\.eslintrc[^/]*',
      'biome\\.jsonc?',
      '\\.dependency-cruiser[^/]*',
      'knip\\.jsonc?',
      '\\.?clippy\\.toml',
      'deny\\.toml',
      '\\.golangci\\.ya?ml',
      'ruff\\.toml',
      '\\.importlinter',
      '\\.editorconfig',
      '[^/]*\\.ruleset',
      '\\.squawk\\.toml',
      '\\.sqlfluff',
      '\\.redocly[^/]*',
      '\\.spectral[^/]*',
      '\\.tflint\\.hcl',
      '[^/]*\\.rego',
      '\\.checkov[^/]*',
      '\\.vale\\.ini',
      '\\.markdownlint[^/]*',
      '\\.pre-commit-config\\.ya?ml',
      'lefthook\\.ya?ml',
      '\\.husky/[^/]+',
      '[Dd]angerfile[^/]*',
      'CODEOWNERS',
      '\\.semgrep[^/]*',
      'sgconfig\\.ya?ml',
      '\\.gitleaks\\.toml',
      'zizmor\\.ya?ml',
      '\\.github/workflows/[^/]+',
      '\\.claude/hooks/[^/]+',
      '\\.claude/settings\\.json',
    ].join('|') +
    ')$',
)
const NOT_ENFORCERS = /\/archunit_store\/|\.sql$/
const MAX_FILES = 120

type HookGroup = { matcher?: string; hooks?: { command?: string }[] }
type SettingsHooks = { hooks?: Record<string, HookGroup[]>; permissions?: { deny?: unknown[] } }

// What already enforces rules where the session ran: the repo's checks, what GitHub requires before a merge, and the
// Claude hooks.
export async function enforcerInventory(io: Host, cwd: string): Promise<string> {
  const lines: string[] = []
  const top = await io.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  const root = top.exitCode === 0 ? top.stdout.trim() : ''
  if (root) {
    lines.push(...(await repoEnforcers(io, root)))
  }
  lines.push("The user's Claude hooks and permission rules:")
  lines.push(...settingsLines('user settings', await io.userSettings()))
  if (root) {
    lines.push(...settingsLines(`${root}/.claude/settings.json`, parsed(await io.read(`${root}/.claude/settings.json`))))
  }
  return lines.join('\n')
}

async function repoEnforcers(io: Host, root: string): Promise<string[]> {
  // Rules land on main (prepareWorktree has just fetched it), which a session's checkout can trail.
  const ref = (await io.run(['git', '-C', root, 'rev-parse', '-q', '--verify', 'origin/main'])).exitCode === 0 ? 'origin/main' : 'HEAD'
  const tree = await io.run(['git', '-C', root, 'ls-tree', '-r', '--name-only', ref])
  const files = tree.stdout.split('\n').filter(path => ENFORCER_FILES.test(path) && !NOT_ENFORCERS.test(path))
  const lines = [
    `Enforcer files on ${ref} in ${root} (read one the checkout lacks with git -C ${root} show ${ref}:<path>):`,
    ...files.slice(0, MAX_FILES).map(path => `- ${path}`),
  ]
  const remote = await io.run(['git', '-C', root, 'remote', 'get-url', 'origin'])
  const slug = remote.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1]
  if (slug) {
    lines.push(...(await githubRules(io, slug, 'main')))
  }
  return lines
}

async function githubRules(io: Host, slug: string, branch: string): Promise<string[]> {
  const lines = [`What GitHub enforces on ${slug} ${branch} (a check that is not required here does not block a merge):`]
  const rules = await io.run(['gh', 'api', `repos/${slug}/rules/branches/${branch}`])
  lines.push(...answered(rules, 'rulesets', body => {
    const found = (body as { type: string; parameters?: { required_status_checks?: { context: string }[] } }[]).map(rule => {
      const checks = rule.parameters?.required_status_checks?.map(check => check.context).join(', ')
      return `- ruleset rule ${rule.type}${checks ? `: ${checks}` : ''}`
    })
    return found.length > 0 ? found : ['- no ruleset rules']
  }))
  const protection = await io.run(['gh', 'api', `repos/${slug}/branches/${branch}/protection`])
  lines.push(...answered(protection, 'branch protection', body => {
    const contexts = (body as { required_status_checks?: { contexts?: string[] } }).required_status_checks?.contexts ?? []
    return [`- branch protection, required checks: ${contexts.join(', ')}`]
  }))
  return lines
}

// gh prints GitHub's error body on stdout too, so a refusal (a plan without rulesets, no access) names its reason.
function answered(run: { exitCode: number; stdout: string }, what: string, read: (body: unknown) => string[]): string[] {
  const body = parsed(run.stdout)
  if (run.exitCode === 0 && body !== null) {
    return read(body)
  }
  const reason = (body as { message?: string } | null)?.message ?? (run.exitCode === 127 ? 'gh is not installed' : 'no response')
  return [`- ${what} not readable: ${reason}`]
}

function settingsLines(source: string, settings: unknown): string[] {
  if (settings === null || typeof settings !== 'object') {
    return []
  }
  const { hooks = {}, permissions } = settings as SettingsHooks
  const hookLines = Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap(group =>
      (group.hooks ?? []).map(hook => `- ${source} ${event}${group.matcher ? ` [${group.matcher}]` : ''}: ${hook.command ?? ''}`),
    ),
  )
  return [...hookLines, `- ${source} permissions.deny: ${permissions?.deny?.length ?? 0} rules`]
}

function parsed(text: string | null): unknown {
  if (text === null) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
