---
type: llm
---
PASS if the rules block holds exactly one rule for the user's correction, and its "new" text reads like the
target file's other rules: a short heading, one or two sentences of why, and a BAD/GOOD example taken from the
user's messages, with no history ("we used to", "reversed from").
FAIL if the rule restates the correction without a why, has no BAD/GOOD example, or invents an example the messages
do not support.
