# Result file

When the task names a result file, write it as JSON when you finish, also when nothing needed to change:

```json
{
  "summary": "One sentence on what changed in the docs, or \"nothing to change\".",
  "files": ["docs/features/notifications.md", "services/worker/README.md"]
}
```

`files` lists every documentation file you edited or added, as paths relative to the worktree; it is empty when you
changed nothing. The docs-watch mod reads this file to know the draft is finished and shows `summary` to the person.
