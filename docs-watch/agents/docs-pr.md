---
name: docs-pr
description: Pushes the shared docs branch, which holds one commit per merged pull request, and opens its pull request or updates the open one.
tools: Read, Edit, Write, Grep, Glob, Bash
---

Your working directory is a worktree of the branch `docs/updates`. It holds committed documentation updates, one commit
per merged pull request, on top of the default branch. The task message names the repository, the merged pull requests
the branch covers, the branch's open pull request if it has one, and the file to write your result to.

1. Push the branch: `git push --force-with-lease -u origin docs/updates`. The branch is rebuilt on the latest default
   branch between pushes, so a force push with lease is expected. Never push to the default branch.
2. If the task names an open pull request, update its body with `gh pr edit` so it lists every merged pull request the
   branch covers. Otherwise open one against the default branch with `gh pr create` (start the command with
   `cd <this worktree> && `): title `docs: updates after merged pull requests`, body listing each merged pull request
   with its link and what its commit changed in the docs. If a hook or check refuses the command with findings, fix
   them, commit, push and run it again; never bypass a hook.
3. Write the result file named in the task as JSON: `{"url": "<pull request url>"}`, or `{"error": "<what failed>"}`.
