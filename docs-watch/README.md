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
   of the default branch under `~/.claude/docs-watch/work/`, and a subagent runs the bundled `docs-watch:update-docs`
   skill there. It edits only documentation files, following the repository's own `CLAUDE.md`, `AGENTS.md` or
   `CONTRIBUTING.md`. Nothing is committed. You can also run the skill yourself: `/docs-watch:update-docs 848`.
4. **Review.** A line above the prompt says "N docs update(s) suggested" in every open session, with a desktop
   notification on macOS. `/docs-watch` (or Review) opens the list: the summary, the diff, **Approve** and **Dismiss**.
5. **Pull request.** **Approve** commits the draft on `docs/after-pr-<number>`, pushes it and runs `gh pr create`; you
   get the link as a toast and a notification. **Redo with a note** drafts it again with your comment (for example "also
   update the README"); where the pane has no text field, `/docs-watch redo <owner/repo#number> <note>` does the same. It never pushes to the default branch and never merges.

## Limits

- It checks only while a Claude Code session is open; a merge while none is open is picked up at the next session start.
- Drafting runs as a subagent in your session, on your plan. Approving runs `git` and `gh` only.
