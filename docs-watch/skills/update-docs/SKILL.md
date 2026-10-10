---
name: update-docs
description: Update a repository's documentation after a pull request merged, so the docs describe the code as it is now. Use when asked to "update the docs for PR <n>", "document what <PR> changed", or when the docs-watch mod asks for a draft. Arguments - a PR number or URL, and optionally the repository, a worktree to edit in, a result file to write, and a note from the person.
---

# Update docs after a merged pull request

You bring a repository's documentation in step with a merged pull request. Edit documentation only.

## Inputs

- **PR**: a number or URL. The repository is the one you run in unless one is named (`owner/name`).
- **Worktree** (optional): a clean checkout of the default branch to edit in. Without one, edit the current checkout and
  tell the person which files you changed.
- **Result file** (optional): a JSON file to write when you finish (the docs-watch mod reads it).
- **Note** (optional): what the person asked for after reading an earlier draft. Apply it.

## Steps

1. Read the PR: `gh pr view <number> --repo <repo> --json title,body,files,mergeCommit`, then the change itself with
   `git show <mergeCommit>`.
2. Find the documentation that describes what changed: a `docs/` folder, READMEs next to the changed code, API or event
   contract files (for example `EVENTS.md`, OpenAPI descriptions), architecture and feature pages.
3. Read the repository's own conventions first: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` and any writing guide, and
   match the style of the files you edit.
4. Edit only documentation files so they describe the code as it is now. Add a new page only when the PR adds a feature or
   concept no page covers, in the place and shape the existing docs use. State the design as current fact, with no
   history ("used to", "now", "replaced"). Cite file paths for concrete claims where the docs already do.
5. Do not touch code, tests or configuration. Do not commit, push or open a pull request.
6. If a result file was given, write it as JSON: `{"summary": "<one sentence on what you changed, or nothing to change>",
   "files": ["<path>", ...]}`, also when nothing needed to change (an empty `files` list). Otherwise end with that
   summary and the list of files.
