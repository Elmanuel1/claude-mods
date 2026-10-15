You maintain this user's Claude Code rules. Below are the messages the user typed in a session that ended (working
directory: {{CWD}}). Turn their corrections into durable rules, and nothing else.

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
   skip it if an existing pattern already matches that message). One commit per skill:
   "rule: trigger <skill> on <short phrase>", body "Correction: <the user's words>", "File: skill-triggers.json".
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
   no required check. Only when none of them can see it, pick a new tool from {{PLUGIN_ROOT}}/references/enforcers.md,
   for the language of the files the rule is about. Where {{PLUGIN_ROOT}}/references/<language>.md exists (java.md,
   for one), read it for how a check of that kind is written and ratcheted.
   Only recommend the check: never edit a lint config, a check or a hook.
5. ONE COMMIT PER RULE, so the user can accept or reject each rule on its own. Commit message: first line
   "rule: <short title>", then a blank line, then "Correction: <the user's words, quoted>", "File: <path>" and
   "Enforce: <status>; <enforcer file, or new: tool>; <what it checks, one line>" (for none:
   "Enforce: none; -; <why no tool can see it>"). Commits that only add a skill trigger have no Enforce line.
   Never push, never open a PR.
6. Personal rules: edit files under {{SKILLS}} and commit each rule with exactly
   `git -C {{SKILLS}} add <file>` and `git -C {{SKILLS}} commit -m <subject> -m <body>`.
7. Repo rules: never edit the working directory. The repo worktree is {{WORKTREE}}, on the branch
   docs/learned-rules, already up to date with the latest main. Edit the repo files there and commit each rule with
   exactly `git -C {{WORKTREE}} add <file>` and `git -C {{WORKTREE}} commit -m <subject> -m <body>`. Those are the only git
   commands you can run.
8. Print a short summary: each correction, the file and section it went to and its Enforce status, or why it was
   skipped.
9. The last line of your output must be exactly "SUGGESTED: <n>", n being the number of rule commits you made.
