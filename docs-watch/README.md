# docs-watch

A Claude Code mod that keeps documentation in step with merged code. When one of your pull requests merges, it drafts the
documentation update in a worktree of the main branch, shows it to you in Claude Code, and opens it as a pull request
once you approve.

## Install

```
/plugin install docs-watch --marketplace Elmanuel1/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. It needs `git` and the GitHub CLI (`gh`), signed in. If either is
missing or `gh` is not signed in, a line above the prompt says which step fixes it (for example `gh auth login`), with a
**Check again** button; nothing else runs until it passes.

## How it works

1. **Repositories.** Each Claude Code session registers the GitHub repository it runs in. Nothing to configure.
2. **Watching.** While any Claude Code session is open, one of them checks GitHub every 5 minutes (20 seconds after a
   session starts, then every 5 minutes) for your open pull requests in those repositories, and notices when one merges.
   Only one session polls at a time.
3. **Drafting.** A merged pull request that changed more than docs, tests or CI gets a draft: the mod creates a worktree
   of the default branch under `~/.claude/docs-watch/work/` and its `docs-watch:docs-writer` agent edits only
   documentation files there, following the repository's own `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING.md`. Nothing is
   committed.
4. **Review.** A line above the prompt says "N docs update(s) suggested" in every open session, with a desktop
   notification on macOS. `/docs-watch` (or Review) opens the list: the summary, the diff, **Approve**, **Dismiss**, and
   **Approve all** when more than one is waiting.
5. **Approve ships.** Approve (or Approve all) commits the draft and queues it for one branch per repository,
   `docs/updates`. Updates land on the branch one at a time; when one conflicts with an update already there, the
   `docs-watch:docs-merge` agent resolves the doc files so both updates' content stays, and the queue carries on. Once
   the queue is empty the `docs-watch:docs-pr` agent pushes the branch and opens one pull request for every approved
   update, or updates the one already open; any hook you have on `gh pr create` reviews it as usual. The line above the
   prompt then says "Docs PR updated" with **Open PR** and **Hide**; a failed push shows its reason with **Retry**. It
   never pushes to the default branch and never merges: the pull request is where you review the combined change.
6. **Keeping up.** The 5-minute check also follows the docs pull request: once it merges (squash or merge), its updates
   leave the list and the branch starts again from the default branch; if it is closed unmerged, its updates go back to
   approved and are pushed again. While nothing is pushed, the branch is rebuilt whenever the default branch moves,
   through the same queue, so a conflict with the new default branch is resolved the same way.
7. **Notifications.** On macOS each step also posts a notification. With `terminal-notifier` installed
   (`brew install terminal-notifier`), a newer one replaces the last instead of stacking.

## Limits

- It checks only while a Claude Code session is open; a merge while none is open is picked up at the next session start.
- Drafting and opening the PR run as subagents in your session, on your plan.
