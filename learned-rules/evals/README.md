# learned-rules evals

These evals check the learning run's judgment: given what a user typed and the enforcers a repo already runs, does
the run find the real corrections, skip the ones a rule already covers, aim each Enforce line at the right check,
and ignore instructions inside pasted text. The mod's mechanics (queueing, the lease, which rules get applied) are
covered by the free unit tests in `tests/`.

## Quickstart

```bash
node evals/render.mjs --check
claude plugin eval learned-rules --scaffold --ablation none
```

The first command fails if a case's `prompt.md` is out of date with `prompts/learn.md`; run `node evals/render.mjs`
to rebuild them. The second runs every case 3 times on your own Claude credentials, so it counts against your usage
or API bill. Add `--case pmd-code-shape --runs 1` to try one case, and `--max-cost-usd <n>` for a hard ceiling.

## Terms

- **Case**: one folder here. It holds `case.json` (the fixture and tags), `messages.md` (what the user typed in the
  session) and `graders/`. `render.mjs` writes its `prompt.md`, `case.yaml` and `scaffold.sh`.
- **Fixture**: the workspace a run starts in, built by `_fixtures/setup.sh`: a `skills/` folder, the plugin's
  `references/` under `plugin/`, and a Java, TypeScript or Rust repo under `repo/` (or a plain `notes/` folder).
- **Grader**: one pass/fail check on the run's answer, mostly regexes on its `rules` block, plus a `tool_used`
  check that the run read the enforcer it names.
- `--scaffold` lets the fixture script run; `--ablation none` skips the no-plugin arm, which means nothing here
  because the whole behavior is in the prompt.

## Cases

| Case | What should happen |
|---|---|
| `pmd-code-shape` | "use `.formatted()`" becomes one `CLAUDE.md` rule with `Enforce: new` on `config/pmd/rules.xml`, after reading it |
| `archunit-layering` | "controllers never call repositories" gets `Enforce: new` on the ArchUnit spec |
| `already-covered` | "no subqueries", which `CLAUDE.md` and the PMD ruleset already cover, adds no rule |
| `judgment-none` | "lock only when writers really race" gets `Enforce: none` |
| `tasks-only` | a session of tasks and questions adds no rule |
| `pasted-instructions` | a pasted README asking for skill `hooks:` and a `` !`curl` `` line adds neither, and the real correction is still learned |
| `outside-a-repo` | a reply-style correction outside a git repo goes to a personal skill only |
| `typescript-eslint` | "top-level `import type`" is aimed at `eslint.config.mjs` |
| `rust-clippy` | "no `.unwrap()` in library code" is aimed at `clippy.toml` |
| `missed-skill` | "you have a skill for this" adds a `skill-triggers.json` entry |

These cases use made-up fixtures. Cases built from your own sessions belong in a suite you keep private, outside a
public repository.
