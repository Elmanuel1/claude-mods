# learned-rules

A Claude Code mod that turns your corrections into rules. When you tell Claude how something should be done ("don't
catch and rethrow", "use the version catalog"), it writes that down as a rule in the right skill or `CLAUDE.md`, and
says how a linter or architecture test you already run could enforce it. You accept or reject each rule in `/learned`.

## Install

```
/plugin install learned-rules --marketplace Elmanuel1/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. Work in Claude Code as usual; after a session with corrections
ends, the next session you open says `N learned rule(s) to review: /learned`.

## Requirements

`git` and the Claude Code CLI (`claude`) on `PATH`. The GitHub CLI (`gh`), logged in, is needed to read GitHub's merge
rules and to open the rules pull request. It runs the same on macOS, Linux and Windows: the mod uses no shell, `jq` or
OS notification tool.

## Terms

- **Correction**: something you typed about how code, PRs, docs or replies should be done, as opposed to a task or a
  question.
- **Rule**: a correction written into a skill (`~/.claude/skills/*/SKILL.md`) or a repo file (`CLAUDE.md`,
  `AGENTS.md`, `.claude/skills/`), with a short why and a BAD/GOOD example. Each rule is one git commit, so you can
  accept or reject it on its own.
- **Enforcer**: anything that already fails a build or blocks an action when a rule is broken: a linter config, an
  architecture test, a baseline ratchet, a CI workflow, a GitHub required check, a Claude Code hook or permission rule.
- **Enforce line**: what each rule's commit says about enforcing it, `Enforce: <status>; <enforcer>; <what it checks>`.

## How it works

1. **Recording.** The mod keeps what you type in each session: at the terminal, in the desktop app, or through Remote
   Control. Notifications, scheduled prompts, other sessions' messages and slash commands are left out.
2. **Queueing.** When a session ends, it is queued if you typed at least a few lines.
3. **Learning.** The next open session runs `claude -p` on the queue, one session at a time across all your open
   sessions. The run gets your typed text and an inventory of the enforcers that exist where the session ran:
   - the enforcer files on the repo's default branch (linter, architecture-test, ratchet, policy and workflow configs);
   - what GitHub requires before a merge (rulesets, branch protection), or why it cannot be read;
   - your Claude Code hooks and permission rules, user-wide and in the repo.
4. **Writing rules.** The run lists your corrections, skips the ones a rule already covers, and commits each new rule:
   personal ones in `~/.claude/skills` (made a git repo on first use), repo ones on the branch `docs/learned-rules` in
   a worktree at `~/.claude/learned/repo-worktree` that the mod brings up to date with main before the run. The run
   may write only those two places, outside any `.git` directory, and its only commands are `git add` and
   `git commit` on those two repositories, so text pasted into a session cannot make it run anything else. It never
   pushes. The run's summary is saved in `~/.claude/learned/<session id>.md`. A run that fails (an expired login, a
   usage limit) keeps the session queued and tries again 30 minutes later, three times at most.
5. **Enforcement.** For each rule the run reads the enforcers that could see it and writes its Enforce line:

   | Status | Meaning |
   |---|---|
   | `exists` | an enforcer already fails on the rule's BAD example; the line names it |
   | `new` | an enforcer you run could check it; the line names its file and the check to add |
   | `partial` | an enforcer can catch a plain form of it; the line says which part |
   | `none` | a judgment no tool can see |

   It targets an enforcer you already run, following how that file writes its checks. Only when none can see the rule
   does it name a new tool, from [references/enforcers.md](references/enforcers.md), with worked examples per language
   in [references/](references/) ([java.md](references/java.md): ArchUnit and PMD with baselines).

## Reviewing

`/learned` opens the list. Each rule shows where it came from, its file and its Enforce line:

- **Accept** keeps it. **Reject** drops the commit. **Correct** puts a prompt in the box to reword it in place.
  **Diff** shows the change.
- **Enforce** (for `new` and `partial`) puts a prompt in the box to add the check: read that enforcer, add the check
  the way it writes its others, record the violations that exist today so only new ones fail, and show it fails on the
  BAD example and passes on the GOOD one. You send it in a normal session, so the check is built and reviewed like any
  change.
- Once every repo rule is reviewed, **Push accepted rules and open the PR** pushes `docs/learned-rules` and opens one
  pull request to `main`.

## Limits

- A learning run stops if the session running it closes; its session stays queued and the next session runs it again.
- The repo worktree serves one repository at a time: a session from another repository waits until that
  repository's rules PR is merged. The rules PR targets `main`.
