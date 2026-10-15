#!/bin/bash
# Builds a case's workspace: the user's skills, the plugin's references, and a fixture repo (java, ts, rust) or a
# plain folder (none). Called from each case's scaffold.sh, which runs in the empty workspace.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -R "$here/skills" ./skills
mkdir -p plugin && cp -R "$here/../../references" ./plugin/references
if [ "$1" = none ]; then
  mkdir -p notes
  exit 0
fi
cp -R "$here/repo-$1" ./repo
git -C repo init -q -b main
git -C repo add -A
git -C repo -c user.name=eval -c user.email=eval@example.invalid commit -q -m 'fixture'
