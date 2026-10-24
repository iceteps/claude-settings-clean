#!/usr/bin/env bash
# ── THE COMMIT GUARDRAIL ────────────────────────────────────────────────────
# PreToolUse(Bash). Reads the tool call on stdin; if it is a `git commit`, runs
# the full verify chain and BLOCKS the commit when it fails. Anything else is
# waved straight through, so the hook costs nothing on ordinary commands.
#
# WHY THIS EXISTS (owner, 2026-08-30): the project had skills and gate scripts
# but no hook anywhere, so every check ran only because someone remembered to
# run it — and the gates' perimeter had never grown past src/, which is how the
# web app shipped ungated. A skill says what to check. This says it is not
# optional.
#
# Exit 0 = allow. Exit 2 = block, and stderr goes back to the agent as the reason.
set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")' 2>/dev/null)"

# Only guard real commits. `git commit` anywhere in the command line counts,
# including `a && git commit -F x`.
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac
# --amend on an already-verified tree is the message-fix case; do not re-run.
case "$cmd" in *"--amend"*) exit 0 ;; esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
log="$(mktemp)"; trap 'rm -f "$log"' EXIT

fail=0
run() { # run <label> <cmd...>
  local label="$1"; shift
  if ! "$@" >>"$log" 2>&1; then
    echo "  ✗ $label" >&2
    fail=1
  fi
}

run "tsc"                  npx tsc --noEmit
run "eslint src/"          npx eslint src/ --max-warnings 0
run "i18n src/"            node scripts/i18n-check.mjs
run "hardcode src/"        node scripts/hardcode-check.mjs
run "rtl src/"             node scripts/rtl-check.mjs
# BOTH surfaces. web/ is a user-facing surface and is held to the same bar.
if [ -d web/src ]; then
  run "hardcode web/src"   node scripts/hardcode-check.mjs web/src
  run "rtl web/src"        node scripts/rtl-check.mjs web/src
fi
[ -f scripts/design-check.mjs ] && run "design tokens" node scripts/design-check.mjs
[ -f scripts/font-check.mjs ]   && run "font pairing"  node scripts/font-check.mjs
[ -d web ] && run "typecheck web" sh -c "cd web && npx tsc --noEmit"
[ -f scripts/net-errors-check.mjs ] && run "net error shapes" node scripts/net-errors-check.mjs
[ -f scripts/filemap-check.mjs ]    && run "filemap cited paths" node scripts/filemap-check.mjs

if [ "$fail" -ne 0 ]; then
  {
    echo ""
    echo "COMMIT BLOCKED — the verify chain failed. Details:"
    echo ""
    tail -60 "$log"
    echo ""
    echo "Fix the findings, or add a written suppression where one is genuinely"
    echo "sanctioned. Do not bypass this hook."
  } >&2
  exit 2
fi
exit 0
