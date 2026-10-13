# Claude Code mods

| Mod | What it does |
|---|---|
| [docs-watch](docs-watch/README.md) | When one of your pull requests merges, drafts the documentation update and opens it as a PR once you approve. |

## Install

The mod (watching, review pane, PR on approve), in Claude Code:

```
/plugin install docs-watch --marketplace Elmanuel1/claude-mods
```

The `update-docs` skill alone, for any agent that reads [Agent Skills](https://agentskills.io/specification)
([skills.sh](https://skills.sh)):

```
npx skills add Elmanuel1/claude-mods
```
