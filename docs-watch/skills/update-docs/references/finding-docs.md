# Finding the documentation a change affects

Start from the PR's changed files and work outwards.

1. **Pages that name the changed code.** Search the docs for the changed file paths, class, function, endpoint, event
   and table names: `grep -rn "<name>" docs/ README.md **/README.md`.
2. **READMEs next to the code.** A README in the changed file's folder or any parent folder up to the repository root.
3. **Contracts.** API descriptions (OpenAPI files, `api.md`), event or message contracts (`EVENTS.md`, schema docs),
   configuration references and environment-variable tables that list a changed setting.
4. **Architecture and feature pages.** In repositories that split docs by kind (for example `docs/<area>/architecture.md`,
   `concepts/`, `features/`), the page for the feature the PR touched and any concept page it relies on.
5. **Indexes.** A docs index, sidebar or table of contents that must list a page you add.

Skip generated docs (files with a "generated" header, `build/`, `dist/`), changelogs written by release tooling, and
historical documents such as ADRs and postmortems: those record a moment, not the current design.
