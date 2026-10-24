---
name: gate-scripts
description: Portable mechanical gates that turn an audit finding into a check that runs forever — hardcoded user-visible strings, RTL invariants, i18n key parity, single-source design values, font-weight pairing, and the pre-commit hook that runs them. Use when a review or audit finds a violation CLASS in any project, when setting up a new project's verification chain, or when "the gates are green" needs to mean something. Carries the scripts themselves, ready to copy.
---

# gate-scripts — audit once, gate forever

The standing rule this implements: **when an audit finds a violation CLASS, the lens becomes a
cheap mechanical script in the project's verify chain.** Agent audits are then for discovering
NEW classes only — nobody re-reads the tree for a class already covered.

`verify-deep` is the method (what to check, how to read output honestly). This skill is the
**tooling**: working scripts, and the judgement about when and how to install one.

Every script here was written against a real defect that had already shipped. They are
dependency-free Node ESM, take a directory argument, and exit non-zero with the offending
`file:line`.

---

## 1. Is this class worth a gate?

A gate earns its place when the class is **mechanically detectable**, **recurring**, and
**invisible in review**. Three failures from one project, each of which became a script below:

- A colour literal pasted into a component looked fine in review and was one of 150 copies of
  a value that later had to change for a WCAG failure.
- A `fontWeight` with no `fontFamily` renders the SYSTEM face in React Native, which is
  invisible in a simulator and obvious on a device. 46 of them had accumulated.
- A `String(err)` on a non-Error object yields `"[object Object]"`, silently disabling an
  entire offline queue. No test could reach it; only a mechanical check could.

**Do NOT gate** taste, architecture, or anything needing a human call — those belong in review.
A gate that cries wolf teaches people to ignore it, which is worse than no gate.

## 2. FAIL vs WARN vs frozen ratchet

- **FAIL** — calibrated to **zero false positives**. If it fires, it is wrong. This is the
  only setting anyone respects.
- **WARN** — advisory, for classes needing a human call (e.g. a physical CSS edge that may be
  geometric rather than directional). Never blocks.
- **Frozen ratchet** — for a class too large to fix today: baseline the current set, FAIL on
  anything NEW, and make `--update` REFUSE to grow the baseline. Use when the count is in the
  hundreds. When it is small enough to fix the same day, **drive it to zero instead** — a zero
  baseline needs no file and nobody memorises numbers.

## 3. Prove the gate

**Re-inject a violation the gate is supposed to catch, watch it fail, revert.** A gate nobody
has seen fail is a gate nobody knows works. Do this in the same session you install it — and
prefer injecting the ORIGINAL bug, not an invented one: an injection that fails to compile
proves the compiler works, not your gate.

## 4. Suppressions carry a written reason

`// <gate>-ok(<class>): why this is correct here` on the line or the line above. Reasons are
reviewed like code. Sanctioned exceptions exist and pretending otherwise just gets the gate
disabled — e.g. white text drawn over a user PHOTO is correct in both themes, so a theme token
would be wrong half the time.

---

## The scripts

All take an optional directory (default `src`) resolved against the CWD, so run them from the
project root. Copy into the project's `scripts/`, add to the verify chain.

| Script | Catches | Notes |
|---|---|---|
| `hardcode-check.mjs` | User-visible strings outside i18n: bare JSX text, string props, dialog titles, validators, raw `e.message` display, `locale === 'x'` branches, device-locale `toLocale*` | The big one. Carries a legacy frozen list. |
| `i18n-check.mjs` | Key parity gaps, orphaned keys, interpolation mismatches | Two brand/acronym allowlists to edit per project. |
| `rtl-check.mjs` | `row-reverse`, `textAlign` derived from an rtl flag, bare `textAlign` literals, rtl-derived flex alignment, direct `I18nManager` reads; WARNs on physical edges | RN + web. |
| `design-check.mjs` | Colour/breakpoint/radius/spacing literals outside the token files | Frozen ratchet; scans multiple trees. |
| `font-check.mjs` | `fontWeight` with no `fontFamily` | RN-specific: each static weight is its own family name, so a weight alone silently leaves the type system. Zero baseline. |
| `pre-commit-gate.sh` | Runs the chain and **blocks the commit** | PreToolUse hook on Bash, matches `git commit`, exempts `--amend`. |

Two more patterns worth rebuilding rather than copying, because their content is
project-specific:

- **Error-shape check.** Extract error predicates into a DEPENDENCY-FREE module, then compile
  that one file with a single `tsc` call from a script and assert against REAL error shapes
  (your HTTP client's actual rejection object, your providers' actual guard messages). This
  needs no test runner and no new dependency, and it is the only coverage such code can have
  when the test suite runs against a mock that never produces those failures.
- **FILEMAP staleness.** See the `filemap` skill — advisory, never in the blocking chain.

## Companion skills

- **`verify-deep`** — the method: what to check, and how to read output honestly.
- **`honest-numbers`** — the display rules no gate can enforce (naming a figure, absent vs
  zero, stated vs derived, one grammar per quantity).
- **`offline-first-writes`** — the outbox pattern and the failure modes no test can reach.
- **`gauntlet`** / **`lane-sprint`** — the review and parallel-work processes these gates sit
  inside.

## Wiring

```json
"verify": "npm run typecheck && npm run lint && npm run i18n:check && npm run hardcode:check && npm run rtl:check && npm run design:check && npm run font:check"
```

**A global hook already runs this everywhere** (`~/.claude/hooks/pre-commit-verify.sh`,
wired into `~/.claude/settings.json`): before any `git commit`, in any repo, it runs
`scripts/hooks/pre-commit-gate.sh` if the project has one, else `npm run verify` if
package.json defines it, else nothing. Fail-open by design — silent in the great majority of
repos that have no bar. So a project only needs the `verify` script; the enforcement is free.

A project-local hook is still worth adding when the bar differs from `npm run verify`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash",
  "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/hooks/pre-commit-gate.sh", "timeout": 300 } ] } ] } }
```

**Check the PERIMETER, not just the chain.** The most expensive lesson here: gates reported
green for months while answering a narrower question than they appeared to. `lint` was
`eslint src/`, and the checks hardcoded `src/` — a second app directory added later was
scanned by nothing, and shipped with violations the first tree would never have permitted.
Whenever a project grows a new source tree, every gate needs pointing at it, **including
`tsc`**: a shared type changed in one tree can break another tree's build with no gate able to
see it.
