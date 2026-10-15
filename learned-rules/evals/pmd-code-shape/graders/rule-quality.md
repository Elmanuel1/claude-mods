---
type: llm
---
PASS if the rules block holds exactly one rule for the user's correction, and its "new" text reads like the
target file's other rules: a short heading, one or two sentences of why, and a BAD/GOOD example, with no history
("we used to", "reversed from"). The example may be built from the session's context (its tasks, names and code)
when the messages quote no code themselves.
FAIL if the rule has no why or no BAD/GOOD example, if the example contradicts the correction or describes code
unrelated to the session, or if the rule adds requirements the user did not state.
