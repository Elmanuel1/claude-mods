# Choosing a new enforcer

Use this page only when no enforcer the repo already runs can see the rule. A new tool is one more thing the repo has
to install, run in CI and keep up to date, so name it only for a rule that needs it.

Every new check follows the same shape, whatever the language:

1. **It fails on the rule's BAD example and passes on its GOOD one.** Add both as test cases where the tool supports
   them (ArchUnit and Error Prone tests, `ast-grep test`, `semgrep --test`, an ESLint `RuleTester`).
2. **It records the violations that exist today** (a freeze store, a baseline file, a lint-ignore list), so only new
   ones fail and the check can land without fixing the whole codebase first.
3. **A baseline fails when it is stale.** A file with fewer violations than its baseline fails until the baseline is
   lowered, so a fix cannot regrow.
4. **It runs in a required check.** A CI job nobody must pass before merging is advice, not enforcement.

## By what the rule is about

| The rule is about | Tool |
|---|---|
| Java or Kotlin class structure: layers, dependencies, naming, annotations, signatures, packages | ArchUnit (Kotlin: Konsist). See [java.md](java.md). |
| Java code inside a method: a call, a literal, a statement form | PMD XPath rule. See [java.md](java.md). |
| Java checks that need types or data flow | Error Prone custom `BugChecker` (runs on JDK 21+) |
| Java changes a tool can also fix | OpenRewrite recipe, `rewriteDryRun` with `failOnDryRunResults` |
| Kotlin code shape | detekt custom rule |
| C#: layers and dependencies | NetArchTest or ArchUnitNET; code shape: a Roslyn analyzer |
| TypeScript or JavaScript code shape | ESLint: `no-restricted-syntax`, `no-restricted-imports`, typescript-eslint rules |
| TypeScript import boundaries | dependency-cruiser, or eslint-plugin-boundaries |
| Python code shape | Ruff rule settings; layers and imports: import-linter |
| Go | golangci-lint: `depguard` for imports, `ruleguard` for code patterns |
| Rust | `clippy.toml` `disallowed-methods` / `disallowed-types`; a custom lint: dylint |
| A code pattern in any language, or one with no linter of its own | ast-grep or Semgrep rule, with test cases |
| Postgres migrations: locks, `CONCURRENTLY`, defaults, column types | Squawk |
| Other SQL style | SQLFluff |
| OpenAPI specs | Redocly configurable rules, or Spectral |
| Terraform source | tflint |
| Terraform planned actions or resolved values (no destroy, required tags) | conftest (OPA) on `terraform show -json` |
| GitHub Actions workflows | actionlint for correctness, zizmor for security |
| Docs and prose (`.md`, specs, ADRs) | Vale existence or substitution rule |
| Pull request description content (a required section, a table) | a CI job on `pull_request` `opened`/`edited` that reads the body, or Danger |
| What Claude itself runs: pushes, merges, commands to avoid | a Claude Code `PreToolUse` hook, or a `permissions.deny` rule |
| A judgment: when a lock is worth it, whether a design is simple enough | none; it stays a review item |
