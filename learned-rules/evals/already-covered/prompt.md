---
name: already-covered
description: A correction the rules and the PMD ruleset already cover adds nothing
tags: [skip, java]
runs: 3
max_turns: 40
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep]
---
You maintain this user's Claude Code rules. Below are the messages the user typed in a session that ended (working
directory: ./repo). Turn their corrections into durable rules, and nothing else.

1. List every correction: an instruction about how code, PRs, docs or replies should be done ("don't X", "use Y",
   "why didn't you...", "should be named...", "let it bubble"). Ignore task requests, questions and one-off choices.
2. For each, find where the rule belongs and read it first:
   - personal skills: ~/.claude/skills/*/SKILL.md
   - repo skills and rules: .claude/skills/*/SKILL.md, CLAUDE.md and AGENTS.md in the git repo of the working directory
   Skip a correction the rule text already covers. Prefer extending an existing section over adding one.
   If ~/.claude/skills/skill-triggers.json exists, a missed skill is a correction too: the user tells Claude to use a
   skill ("use /<skill>", "load the <skill> skill", "you have a skill for this") after a message where Claude did not
   load it. For each, add a case-insensitive Python regex built from the words of that earlier message to the skill's
   list in that file (general enough to match the next request like it, narrow enough not to fire on unrelated ones;
   skip it if an existing pattern already matches that message). One rule per skill, with the subject
   "rule: trigger <skill> on <short phrase>".
3. Write each new rule the way the file already writes rules: a short heading, one or two sentences of why, and a
   BAD/GOOD example taken from the session. No history ("we used to...").
4. For each new rule, decide whether a static check could catch its BAD example, so the rule holds without anyone
   remembering it. "The enforcers that exist" below lists what this repo and this user already run: the tracked
   linter, architecture, ratchet, policy and workflow files, what GitHub requires before a merge, and the Claude
   hooks. Many are custom (a project ruleset, an architecture test, a gate script): read the ones that could see the
   rule before choosing, to learn what each already checks and how it writes a check (rule names, message wording,
   how it records the violations that exist today), and follow the workflow that runs it to see whether it blocks a
   merge. Pick one status:
   - exists: an enforcer already fails on the BAD example; name it and the check (file, rule name).
   - new: an enforcer could fail on the BAD example and pass the GOOD one; name its file and the check to add.
   - partial: an enforcer catches a plain form of the BAD example but not the rest; say which part.
   - none: it is a judgment no tool can see (when a lock is worth it, whether a design is simple enough).
   Target an enforcer from the list, by its file, whenever one can see the rule. Say so when the one you pick runs in
   no required check. Only when none of them can see it, pick a new tool from ./plugin/references/enforcers.md,
   for the language of the files the rule is about. Where ./plugin/references/<language>.md exists (java.md,
   for one), read it for how a check of that kind is written and ratcheted.
   Only recommend the check: never propose an edit to a lint config, a check or a hook.
5. You can only read: the mod applies your rules, one commit per rule, so the user can accept or reject each on its
   own. Personal rules are files in ./skills. Repo rules are files in the repo worktree, ./repo, on the branch docs/learned-rules, up to date with the latest main; never the
   working directory. Only Markdown files (and skill-triggers.json in ./skills) can be changed, and a change that
   adds or alters a skill's hooks or allowed-tools frontmatter is refused.
6. Print a short summary: each correction, the file and section it went to and its Enforce status, or why it was
   skipped.
7. End your output with one block, `{"rules": []}` when there is nothing to add:

   ```rules
   {"rules": [{
     "repo": "personal or project",
     "file": "<path inside that repo, such as code-design/SKILL.md or CLAUDE.md>",
     "edits": [{"old": "<text that appears exactly once in the file>", "new": "<what replaces it>"}],
     "subject": "rule: <short title>",
     "correction": "<the user's words, quoted>",
     "enforce": "<status>; <enforcer file, or new: tool>; <what it checks, one line>"
   }]}
   ```

   An empty "old" appends "new" at the end of the file, creating it if needed. For status none, enforce is
   "none; -; <why no tool can see it>"; for a skill-trigger entry it is "".

The enforcers that exist:
-----
Enforcer files on origin/main in ./repo (the repo worktree, when there is one, holds this same tree):
- .github/workflows/build.yml
- config/pmd/baseline.txt
- config/pmd/rules.xml
- src/test/groovy/arch/ArchitectureRulesSpec.groovy
What GitHub enforces on acme/app main (a check that is not required here does not block a merge):
- rulesets not readable: Upgrade to GitHub Pro or make this repository public to enable this feature.
- branch protection not readable: Upgrade to GitHub Pro or make this repository public to enable this feature.
The user's Claude hooks and permission rules:
- user settings permissions.deny: 0 rules
-----
The user's messages:
-----
fix the tender search query, it's slow
don't use a subquery there, use a join. the IN (select ...) is why it's slow

-----
