# Writing rules for documentation updates

- **Current fact.** Describe the code as it is on the default branch. No history: avoid "now", "used to", "was replaced",
  "new in this PR".
- **Match the page.** Keep each page's structure, heading levels, terminology and tone. Use the names the code uses.
- **Concrete.** Show real commands, request and response bodies, file paths and setting names in code blocks, copied from
  the code, not paraphrased.
- **Cite where the docs already cite.** If a page cites `path/to/file.ts:42`, cite the lines that changed the same way.
- **Smallest correct change.** Edit the sentences the PR made wrong; do not rewrite pages it did not affect.
- **Repository rules win.** When `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` or a writing guide says otherwise, follow it.
