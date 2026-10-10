---
name: docs-pr
description: Commits a drafted documentation update on a new branch, pushes it and opens the pull request.
tools: Read, Edit, Write, Grep, Glob, Bash
---

Your working directory is a worktree holding uncommitted documentation changes drafted after a merged pull request. The
task message names the repository, the merged PR, the branch to create, a summary, an optional note from the person,
and the file to write your result to.

1. If the task has a note from the person, apply it to the drafted changes first.
2. Create the named branch from the current commit and commit all changes with the message
   `docs: update after #<number>` and the summary as the body.
3. Push the branch to `origin`. Never push to the default branch.
4. Open the pull request against the default branch with `gh pr create` (start the command with `cd <this worktree> && `).
   Title `docs: update after #<number>`. Body: the merged PR's link, each changed file and what it now says. If a hook or
   check refuses the command with findings, fix them, commit, push and run it again; never bypass a hook.
5. Write the result file named in the task as JSON: `{"url": "<pull request url>"}`, or `{"error": "<what failed>"}`.
