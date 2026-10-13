# Result file

When the task names a result file, write it as JSON when you finish, also when nothing needed to change:

```json
{
  "title": "docs: document failing the build on APIs marked for removal",
  "summary": "One sentence on what changed in the docs, or \"nothing to change\".",
  "files": ["docs/features/notifications.md", "services/worker/README.md"]
}
```

`title` is the commit subject: `docs: ` and what the documentation now covers, in the imperative, under 72 characters.
It names the subject matter, never only the PR number. GOOD: `docs: document failing the build on APIs marked for
removal`. BAD: `docs: update after #858`, `docs: update documentation`.

`files` lists every documentation file you edited or added, as paths relative to the worktree; it is empty when you
changed nothing. The docs-watch mod reads this file to know the draft is finished, shows `summary` to the person and
commits the draft under `title` when they approve it.
