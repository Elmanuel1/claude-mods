# docs-watch

A Claude Code mod that keeps documentation in step with merged code. When one of your pull requests merges, it drafts the
documentation update in a worktree of the main branch, shows it to you in Claude Code, and opens it as a pull request
once you approve.

## Install

```
/plugin install docs-watch --marketplace Elmanuel1/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## Requirements

It needs `git`, the GitHub CLI (`gh`) logged in to github.com, and the Claude Code CLI (`claude`) on `PATH`. When a
session starts, before each 5-minute check, and whenever a `git` or `gh` command fails, the mod checks each one and
whether `gh`'s login can reach and push to the session's repository. Anything missing pops up as a toast naming it and
the command that fixes it:

| Missing | Fix shown |
|---|---|
| `git` | `xcode-select --install` (macOS), or https://git-scm.com/downloads |
| `gh` | `brew install gh` (macOS), or https://cli.github.com |
| `gh` not logged in | `gh auth login --hostname github.com` |
| `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| repository not reachable or read-only | `gh auth refresh --hostname github.com --scopes repo`, or log in as an account with write access |

Each popup shows once per session, and again only when an action fails for that reason (at most once a minute). A
missing `git` or `gh`, or `gh` not logged in, also keeps a line above the prompt with a **Check again** button, and
nothing polls or drafts until it passes; the pane lists everything still missing under **Setup needed**. The checks read
only exit codes and the repository permission, so no token is ever shown.

## How it works

1. **Repositories.** Each Claude Code session registers the GitHub repository it runs in. Nothing to configure.
2. **Watching.** While any Claude Code session is open, one of them checks GitHub every 5 minutes (20 seconds after a
   session starts, then every 5 minutes) for your open pull requests in those repositories, and notices when one merges.
   Only one session polls at a time.
3. **Drafting.** A merged pull request that changed more than docs, tests or CI gets a draft: the mod creates a worktree
   of the default branch under `~/.claude/docs-watch/work/`, and a subagent runs the bundled `docs-watch:update-docs`
   skill there. It edits only documentation files, following the repository's own `CLAUDE.md`, `AGENTS.md` or
   `CONTRIBUTING.md`. Nothing is committed. You can also run the skill yourself: `/docs-watch:update-docs 848`.
4. **Review.** A line above the prompt says "N docs update(s) suggested" in every open session, with a desktop
   notification on macOS. `/docs-watch` (or Review) opens the list: the summary, the diff, **Approve**, **Dismiss**,
   **Approve all** when more than one is waiting, and **Redo with a note**, which drafts it again with your comment (for
   example "also update the README"). Where the pane has no text field, `/docs-watch redo <owner/repo#number> <note>`
   does the same.
5. **Approve ships.** Approve (or Approve all) commits the draft under the title the skill wrote (what the docs now
   cover) and queues it for one branch per repository, `docs/updates`. Within 15 seconds the session that holds the poll lease lands them on the branch, one at a time; when one
   conflicts with an update already there, the `docs-watch:docs-merge` agent resolves the doc files so both updates'
   content stays, and the queue carries on. Once the queue is empty the mod pushes the branch with `git` and opens one
   pull request for every approved update with `gh pr create`, or updates the one already open with `gh pr edit`. Its
   title is built from the branch's commit subjects. The line above the prompt then says "Docs PR updated" with
   **Open PR** and **Hide**; a failed push shows its reason with **Retry**. It never pushes to the default branch and
   never merges: the pull request is where you review the combined change.
6. **Keeping up.** The 5-minute check also follows the docs pull request: once it merges (squash or merge), its updates
   leave the list and the branch starts again from the default branch; if it is closed unmerged, its updates go back to
   approved and are pushed again. While nothing is pushed, the branch is rebuilt whenever the default branch moves,
   through the same queue, so a conflict with the new default branch is resolved the same way.
7. **Notifications.** On macOS each step also posts a notification. With `terminal-notifier` installed
   (`brew install terminal-notifier`), a newer one replaces the last instead of stacking.
8. **Errors.** Every failed `git` or `gh` command, refused subagent start and unreadable result file goes to the debug
   log and to the pane's **Recent errors** list. A draft or conflict resolution whose subagent the engine refused to
   start waits, and the next turn, `/docs-watch` or session start tries again.

## Limits

- It checks only while a Claude Code session is open; a merge while none is open is picked up at the next session start.
- Drafting and resolving a conflict run as subagents in your session, on your plan. Pushing and opening the PR run
  `git` and `gh` only.
