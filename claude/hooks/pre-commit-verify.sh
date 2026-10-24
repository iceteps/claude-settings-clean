#!/usr/bin/env bash
# Global pre-commit gate — runs a project's OWN verification bar before any
# `git commit`, in every repo, without each repo having to remember to wire it.
#
# WHY THIS IS A HOOK AND NOT A HABIT. An npm script is something you run at the
# right moment; a hook runs at the ONLY moment that counts. The failure it exists
# to stop is specific and common: you run the checks, make one more small edit,
# and commit on the strength of a result that is no longer current.
#
# FAIL-OPEN BY DESIGN. Most repos have no verification chain, and this must be
# invisible in those. It exits 0 unless it finds a bar to run and that bar fails.
# Order of preference — the project always wins:
#   1. scripts/hooks/pre-commit-gate.sh   (the project's own gate)
#   2. `npm run verify`                   (if package.json defines it)
#   3. nothing                            (silent pass)
#
# Disable: remove the PreToolUse entry from ~/.claude/settings.json.
set -uo pipefail

# Never inside a comply test session (rule-loop). Hooks run outside the OS
# sandbox, so running the test repo's own scripts here would execute code the
# test model wrote, unconfined. COMPLY_SANDBOX is set only by comply.py, in the
# claude process env, which the sandboxed model cannot change.
[ -n "${COMPLY_SANDBOX:-}" ] && exit 0

payload=$(cat)
cmd=$(printf '%s' "$payload" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')

# Only real commits. An --amend is usually a message fix on an already-verified
# tree, and re-running a multi-minute chain for it trains people to bypass.
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac
case "$cmd" in
  *"--amend"*) exit 0 ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# The project's own gate takes precedence — it knows its bar better than this does.
if [ -x scripts/hooks/pre-commit-gate.sh ]; then
  printf '%s' "$payload" | ./scripts/hooks/pre-commit-gate.sh
  exit $?
fi

[ -f package.json ] || exit 0

# NO BAR AT ALL — notice it, do not block it.
#
# bootstrap.sh stays a deliberate act because it WRITES INTO the repo, and a repo
# you cloned but do not own must never silently grow your tooling. But a source
# project with no verification chain should not be able to take a commit in
# SILENCE either — that silence is how a project goes a year without one.
#
# One line, non-blocking. Opt out permanently with: touch .claude/no-gates
if ! grep -q '"verify"[[:space:]]*:' package.json; then
  if [ ! -f .claude/no-gates ] && { [ -d src ] || [ -d lib ] || [ -d app ]; }; then
    echo "note: $(basename "$root") has no \`npm run verify\` chain." >&2
    echo "      Check it without touching the repo:  gates" >&2
    echo "      Install the chain into it (own repos): bootstrap.sh in the gate-scripts skill" >&2
    echo "      Silence for this repo:                 touch .claude/no-gates" >&2
  fi
  exit 0
fi

out=$(npm run --silent verify 2>&1)
status=$?
[ $status -eq 0 ] && exit 0

{
  echo "COMMIT BLOCKED — \`npm run verify\` failed in $(basename "$root")."
  echo
  printf '%s\n' "$out" | tail -40
  echo
  echo "Fix the findings, or commit with --amend if this is only a message change"
  echo "on an already-verified tree. Do not bypass by disabling the hook."
} >&2
exit 2
