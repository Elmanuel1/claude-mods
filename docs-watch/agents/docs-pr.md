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
2. Write a title that says what the documentation changes cover, under 72 characters, read from the branch's commit
   subjects (`git log --format=%s <default branch>..HEAD`). One commit: use its subject. Several: `docs: ` and the main
   topics, for example `docs: Jackson 3 config and deprecated-API build failures`. Never a title that only names PR
   numbers or says "update" without the subject (BAD: `docs: update after #858`, `docs: updates after merged pull
   requests`).
3. If the task names an open pull request, update it with `gh pr edit`: the title from step 2 and a body listing every
   merged pull request the branch covers. Otherwise open one against the default branch with `gh pr create` (start the
   command with `cd <this worktree> && `): the title from step 2, body listing each merged pull request with its link and
   what its commit changed in the docs. If a hook or check refuses the command with findings, fix
   them, commit, push and run it again; never bypass a hook.
4. Write the result file named in the task as JSON: `{"url": "<pull request url>"}`, or `{"error": "<what failed>"}`.
