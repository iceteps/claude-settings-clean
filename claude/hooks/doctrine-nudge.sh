#!/usr/bin/env bash
# Doctrine nudge — a MECHANICAL trigger for knowledge that would otherwise
# depend on remembering.
#
# The toolkit index in CLAUDE.md is loaded every session, but loading text and
# ACTING on it are different things. This moves the trigger from "did the model
# think to check the index" to "did the prompt contain one of these words" —
# a pattern match, which is deterministic.
#
# It does NOT guarantee the doctrine is applied. Nothing can; only executed code
# is a guarantee. It guarantees the reminder is PRESENT at the moment the work
# starts, which is the part that was failing.
#
# Deliberately narrow. A nudge that fires on everything is noise, and noise is
# how a person learns to skip the thing.
#
# Tuned 2026-08-31 after a live false positive: `export` matched `export PATH`,
# a shell builtin, and offered the data-export doctrine. Bare `sum`, `rate`,
# `cost`, `metric`, `report` and `export` were dropped for the same reason —
# they are ordinary English. Prefer a phrase ("day rate", "export the") over a
# word that has a second life in programming. Add a trigger only when a real defect
# class was missed for want of it.
#
# Disable: remove the UserPromptSubmit entry from ~/.claude/settings.json.
set -uo pipefail

payload=$(cat)
prompt=$(printf '%s' "$payload" | tr '\n' ' ' | tr '[:upper:]' '[:lower:]')

hits=()

case "$prompt" in
  *total*|*money*|*price*|*margin*|*profit*|*invoice*|*payout*|*earn*|*billing*|*wage*|*"day rate"*|*"csv"*|*"pdf report"*|*"export the"*|*"hours"*)
    hits+=("**honest-numbers** — name the figure (whose? which kind?), absent≠zero (blank in CSV, em dash on screen), stated vs derived vs verified, one grammar per quantity. A number on two screens under one name is the defect this exists for.") ;;
esac

case "$prompt" in
  *offline*|*queue*|*retry*|*sync*|*outbox*|*"no connection"*|*reconnect*|*"flaky"*)
    hits+=("**offline-first-writes** — capture the PRESS time not the send time (else you write false records), FIFO with a blocking failure, 'already exists' is success, a timeout is NOT a definite failure, and your HTTP client may not throw Error objects.") ;;
esac

case "$prompt" in
  *rtl*|*hebrew*|*arabic*|*i18n*|*locale*|*translat*|*mirror*)
    hits+=("**rn-rtl** (user-invocable only: ask the owner to run /rn-rtl for React Native work) / **honest-numbers §5** — inputStart on TextInput (it does not auto-mirror), never interpolate user text into a sentence in RTL, counts as a parenthesised numeral, glyphs flip by transform not by swapping names.") ;;
esac

case "$prompt" in
  *audit*|*review*|*"violation"*|*"class of"*|*lint*|*gate*)
    hits+=("**gate-scripts** — if this is a CLASS and not an instance, the deliverable is a GATE. Rules the compiler cannot enforce go in .claude/conventions.json; bootstrap.sh installs the rest.") ;;
esac


[ ${#hits[@]} -eq 0 ] && exit 0

echo "Doctrine reminders matched to this request (from ~/.claude/CLAUDE.md's toolkit index):"
for h in "${hits[@]}"; do echo "- $h"; done
echo "Load the skill if the work touches its ground; say so if you judge it does not apply."
exit 0
