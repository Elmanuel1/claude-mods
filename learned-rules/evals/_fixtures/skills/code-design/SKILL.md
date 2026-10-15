---
name: code-design
description: Review code for SOLID, DRY and testability before a PR.
---
# Code design

## No else
Return early instead of writing else; the happy path stays unindented.

BAD: `if (found) { return x } else { throw e }`
GOOD: `if (!found) { throw e }` then `return x`

## One version per repository method
A repository method exists once, not as a pair with and without a transaction argument.
