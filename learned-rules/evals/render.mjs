#!/usr/bin/env node
// Builds each case's prompt.md, case.yaml and scaffold.sh from its case.json and messages.md. The prompt is built
// the way hooks/learn.ts builds the learning run's prompt, from prompts/learn.md, because a case's prompt must be
// inline text. Run it after editing learn.md or a case; `--check` exits 1 when a generated file is stale.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const evals = dirname(fileURLToPath(import.meta.url))
const template = readFileSync(join(evals, '..', 'prompts', 'learn.md'), 'utf8')
// The workspace layout setup.sh builds, and the same wording as WORKTREE_NOTES and NO_WORKTREE in hooks/learn.ts.
const WORKTREE = {
  ready: 'repo, on the branch docs/learned-rules, up to date with the latest main',
  none: 'none: no repository worktree could be prepared for this session, so skip repo rules',
}

function render(name, { fixture, description, tags }, messages) {
  const instructions = template
    .replaceAll('{{CWD}}', fixture === 'none' ? 'notes' : 'repo')
    .replaceAll('{{PLUGIN_ROOT}}', 'plugin')
    .replaceAll('{{SKILLS}}', 'skills')
    .replaceAll('{{WORKTREE}}', fixture === 'none' ? WORKTREE.none : WORKTREE.ready)
  const inventory = readFileSync(join(evals, '_fixtures', `inventory-${fixture}.md`), 'utf8').trimEnd()
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `tags: [${tags.join(', ')}]`,
    'runs: 3',
    'max_turns: 40',
    'timeout_seconds: 600',
    'allowed_tools: [Read, Glob, Grep]',
    '---',
  ].join('\n')
  const body = [instructions, 'The enforcers that exist:', '-----', inventory, '-----', "The user's messages:", '-----', messages, '-----'].join('\n')
  return {
    'prompt.md': `${frontmatter}\n${body}\n`,
    'case.yaml': `schema_version: "1.1"\nname: ${name}\ncontext:\n  scaffold_script: scaffold.sh\n`,
    'scaffold.sh': `#!/bin/bash\nexec bash "$(dirname "\${BASH_SOURCE[0]}")/../_fixtures/setup.sh" ${fixture}\n`,
  }
}

const check = process.argv.includes('--check')
const stale = []
for (const name of readdirSync(evals).sort()) {
  const dir = join(evals, name)
  if (!existsSync(join(dir, 'case.json'))) {
    continue
  }
  const files = render(name, JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')), readFileSync(join(dir, 'messages.md'), 'utf8'))
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file)
    if (existsSync(path) && readFileSync(path, 'utf8') === text) {
      continue
    }
    stale.push(`${name}/${file}`)
    if (!check) {
      writeFileSync(path, text, { mode: file.endsWith('.sh') ? 0o755 : 0o644 })
    }
  }
}
if (check && stale.length > 0) {
  console.error(`Stale eval files; run node evals/render.mjs:\n${stale.join('\n')}`)
  process.exit(1)
}
console.log(check ? 'Eval prompts match prompts/learn.md.' : `Wrote ${stale.length} file(s).`)
