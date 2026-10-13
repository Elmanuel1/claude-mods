---
name: update-docs
description: Updates a repository's documentation after a pull request merged, so the docs describe the code as it is now. Reads the merged PR and its diff, finds the pages, READMEs and contract files that cover the changed code, and edits only documentation, matching the repository's own conventions. Use when asked to "update the docs for PR 123", "document what this PR changed", "bring the docs in line with main", or when the docs-watch mod asks for a draft.
license: MIT
compatibility: Requires git and the GitHub CLI (gh), signed in. Designed for Claude Code.
metadata:
  author: Elmanuel1
  version: "0.2.0"
---

# Update docs after a merged pull request

Bring a repository's documentation in line with a merged pull request. Edit documentation only.

## Inputs

- **PR**: a number or URL. The repository is the one you run in unless the input names `owner/name`.
- **Worktree** (optional): a clean checkout of the default branch to edit in. Without one, edit the current checkout.
- **Result file** (optional): where to write the result when you finish. Its format is in
  [references/result-file.md](references/result-file.md).
- **Note** (optional): what the person asked for after reading an earlier draft. Apply it.

## Steps

1. Read the PR and its change:
   `gh pr view <number> --repo <repo> --json title,body,files,mergeCommit`, then `git show <mergeCommit>`.
2. Find the documentation that covers the changed code. How to search is in
   [references/finding-docs.md](references/finding-docs.md).
3. Read the repository's conventions (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, any writing guide) and edit the docs
   by the rules in [references/writing-rules.md](references/writing-rules.md).
4. Leave code, tests and configuration alone. Do not commit, push or open a pull request.
5. Finish: write the result file if one was given; otherwise reply with a one-sentence summary and the files you changed.

## Edge cases

- **Nothing needs to change**: change no files and say so (an empty `files` list in the result file).
- **The PR adds something no page covers**: add one page, in the place and shape the existing docs use.
- **The PR removed a feature**: remove or rewrite what describes it; do not leave a note that it was removed.
