Enforcer files on origin/main in ./repo (the repo worktree, when there is one, holds this same tree):
- .github/workflows/ci.yml
- eslint.config.mjs
What GitHub enforces on acme/app main (a check that is not required here does not block a merge):
- rulesets not readable: Upgrade to GitHub Pro or make this repository public to enable this feature.
- branch protection not readable: Upgrade to GitHub Pro or make this repository public to enable this feature.
The user's Claude hooks and permission rules:
- user settings permissions.deny: 0 rules
