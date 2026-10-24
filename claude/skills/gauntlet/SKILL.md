---
name: gauntlet
description: The owner's standing acceptance process for EVERY non-trivial change batch, in ANY project — loop implementation → adversarial review → fixes until SHIP, then the project's full verification bar (static gates + tests, every check proven able to fail, errored runs never counted as passes) before any commit. Use whenever a batch is about to be reviewed, verified, or committed. A project-local gauntlet skill (e.g. the reference project's) takes precedence and carries the project-specific bar.
---

# gauntlet — loop until it passes the bar, including tests

Owner's standing rule (established on the reference project 2026-08-28 — *"gauntlet loop the works until
it passes the bar, including testings"* — made global 2026-08-29):
one review pass is not acceptance, and "the linter is green" is not the bar —
the bar includes the project's tests and honest reporting.

## The loop

1. **Implement** — inline, a lane, or a workflow Fix phase.
2. **Adversarial review** — a reviewer agent that verifies claims against the
   REAL diff, not the implementer's summary, and runs whatever checks it can.
   Verdict SHIP / SHIP_WITH_FIXES, with file-exact findings graded
   blocker / should / nit (defined in `~/.claude/agents/lane-reviewer.md`);
   any open blocker means the batch does not ship.
3. **Apply every finding** — or justify each skip explicitly in the report.
   Blocker and should findings are never skipped.
4. **Re-review the fixed state.** The reviewer re-verifies EVERY prior
   finding's fix against the current diff — the change summary is just another
   claim. Repeat 2–4 until SHIP with zero blocker/should findings open. A nit
   fix may land without a full re-review round IF the fix itself is verified
   (run the affected test/gate).

## The bar (before any commit)

Discover and run the PROJECT'S OWN verification stack — do not invent one:
package scripts (`verify`, `lint`, `test`, `typecheck`), CI workflow steps,
a Makefile, a project verification skill. Run all of it, and read outputs
against known baselines rather than trusting exit codes. If the project
defines its own gauntlet/verify skill, that skill's bar wins.
The bar always includes the test suite when one exists; "tests are broken as
a gate" is a finding to FIX (pin the env, repair the drift), not an excuse.
Suite bar: 0 failed; the only tolerated skips are pre-existing, annotated ones.
A run that errored, timed out or hit a usage limit is an ERROR to rerun, never
a pass (see `verify-deep` §1).

## Rules learned the hard way

- **Failure triage is stash-proven, never assumed.** A failing test after your
  change is yours until `git stash` + rerun on clean HEAD proves the failure
  identical. Pre-existing failures don't excuse the batch — the gauntlet fixes
  them too (spec drift → update the test to CURRENT behavior without weakening
  its intent; real regression → fix or escalate to the owner).
- **A test wrapped in `if (visible/exists)` guards is vacuous** — it passes
  when the feature vanishes. Replace with hard assertions whenever you touch
  one; expect the hard assertion to FAIL first (that is it proving the old
  test never ran), then make the scenario real (fresh fixtures, reach the
  collapsed or hidden state the assertion targets).
- **Green on the first run is suspect, not a win.** 100% passing on a new
  check more often means a weak check than a perfect target: prove each check
  can fail with a known-bad fixture before counting its pass. Probes that rely
  on a model's willingness (sandbox escapes, permission probes) are planted as
  scripts it runs, never commands it is asked to type (`verify-deep` §3a).
- **A reviewer's suggested fix is a claim too** — verify it against source
  before applying (a suggested "canonical example" once did not match the real
  call site's shape).
- **Report each iteration honestly**: findings, fixes, explicit skips. State
  each verification layer's result separately — never collapse to "green".
- **Docs and design batches run the same loop** — adversarial review catches
  off-spec values, broken references, direction (RTL) violations, and bad copy
  or translation grammar the same way it catches bugs.

## Then, and only then

Commit per the project's convention, docs updated in the same commit, and push.

## Doctrine skills the reviewer should load

Match the diff to the ground it touches — `honest-numbers` (figures, money,
exports), `offline-first-writes` (queues, retries, sync), `gate-scripts` (a
violation CLASS, which wants a gate rather than a correction). A reviewer that
has not read the relevant one will pass code that violates a rule already paid
for once.
