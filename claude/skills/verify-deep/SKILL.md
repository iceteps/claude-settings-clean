---
name: verify-deep
description: The full verification pass for ANY project — the project's automatic gates PLUS the hand audits gates are blind to, honest exit-code capture, drift checks that include test helpers, and the standing principle that every audit lens gets turned into a cheap mechanical gate. Run before every commit batch. A project-local verify-deep skill takes precedence and carries the project's concrete bar.
---

# verify-deep — the gates, plus what the gates are blind to (global standard)

Automatic gates are necessary, never sufficient. This is the method that made "verify is
green" mean something (established on the reference project 2026-08; the owner's standing bar since).

## 1. Run the project's gates — and READ them, don't exit-code them

- Every gate's output, not just its status: attribute each error to the file that owns it.
- Warning COUNTS are a ratchet: know the baseline, account for every delta (up OR down).
  The strongest position is a ZERO-warning baseline enforced with the linter's
  max-warnings=0 — then any warning is a regression and nobody memorizes baselines.
- **Capture the real exit code.** Piping a suite through `tail`/`grep`/`head` makes the
  pipeline's exit the LAST command's — a 19-failure run once printed as green this way.
  Pattern: `suite > out.txt 2>&1; echo "EXIT=$?" >> out.txt` and read both.

## 2. Hand-audit the DIFF for what gates can't see

Scope to the change (`git diff <base>` + untracked new files), not the tree:
- Hardcoded user-visible strings — in JSX/markup text AND in props/arguments (placeholders,
  dialog titles, accessibility labels, share/notification/export content, filenames).
- Hardcoded colors/styles outside the design system; every hit needs a justification.
- For each i18n key the diff touches: exists in EVERY locale file, placeholders match, the
  non-source values are real translations (not copied source language).
- Raw error objects reaching users (`e.message` in an alert/setter) — the policy is stable
  codes translated at the catch site.
- Assertion drift: grep the WHOLE test dir — specs AND helpers — for every changed
  user-visible VALUE and for every changed display BEHAVIOR (what a failure shows is drift
  too, not just key renames).

## 3. The mechanical-gate principle (this is the token-saver)

**When an audit finds a violation CLASS, do not schedule another audit — encode the lens as
a fast, dependency-free script** (plain node/python, file walk + compiled regexes, per-finding
file:line output) wired into the project's verify chain:
- FAIL classes = high-precision patterns, calibrated to ZERO false positives on the current
  clean tree (achieved by tightening patterns, never by weakening rules).
- WARN classes = advisory lenses that need a human call.
- An inline suppression comment grammar (`// <check>-ok(<class>): <reason>`) for the few
  sanctioned exceptions — every suppression carries its written reason and is reviewable.
- Prove the gate by INJECTION: recreate each violation class the audit caught and show the
  script catches every one; a gate you haven't proven blind-spot-free is decoration.
Agent audits are then reserved for discovering NEW classes — after which those become gates
too. Audit once, gate forever.

## 3b. Native-runtime behavior is NOT provable by code review or a web suite

Some correctness lives only on the device. A change can be type-clean, lint-clean,
reviewer-approved and green in a browser-based e2e suite and still be dead on the phone.
The class that has actually bitten: a platform API whose resolution is scoped to a native
view hierarchy (iOS `InputAccessoryView` cannot be found across a `Modal` boundary — an
accessory mounted at the app root is invisible to every input inside a modal, so a
"shipped" keyboard toolbar was missing on ~every form in the app). Rules:
- When a change depends on a NATIVE mechanism (keyboard accessories, permissions,
  background tasks, calendar/notification APIs, deep links, share targets), say plainly in
  the report that the automated bar does NOT cover it, and name the device check the owner
  must do. Never let "gates green" imply device-verified.
- Native modules cannot arrive by OTA — verify the capability exists in the INSTALLED
  binary before promising a JS-only fix.
- Prefer a mechanism whose failure is visible in review (a rendered element) over one whose
  failure is silent (an ID lookup that resolves to nothing).

## 4. Deploys and destructive ops are PROVEN, not assumed

Schema/infra changes ship with a proof chain: baseline query showing the before-state →
surgical apply (never a whole-schema replay against live) → verify query showing the exact
after-state → a second idempotent pass proving re-runnability. Apply BEFORE shipping code
that writes the new columns (a client that sends unknown columns breaks EXISTING flows, not
just the new feature). Diagnose from live data before coding any fix whose cause is unproven.

## 5. Report format

State each layer's result separately — gates, hand audits, suite (with its exit code),
deploy proofs. Never collapse to "verify is green"; say what green actually covered, and
name anything (device-only behavior, unexercised platforms) that is NOT covered rather than
implying it.

## Companion skills for the hand audit

The audit in §2 is where these pay off — each carries a class no gate can see:

- **`honest-numbers`** — figures, exports, anything a person is paid against.
- **`offline-first-writes`** — queues, retries, and "saved but not sent" states.
- **`gate-scripts`** — when the audit finds a CLASS, this is how it becomes a
  check that runs forever instead of a note somebody re-derives next quarter.
