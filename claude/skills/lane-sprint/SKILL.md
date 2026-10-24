---
name: lane-sprint
description: Run a batch of 2+ independent work items as parallel workflow lanes with an adversarial reviewer per lane — file-ownership partition, single-owner shared resources, the concurrency block, reviewer norms, and parent integration duties. The standard for any multi-item implementation batch in ANY project; a project-local lane-sprint skill takes precedence and carries project specifics.
---

# lane-sprint — batch work as reviewed parallel lanes (global standard)

Proven at scale 2026-08-19→29 (the reference project): dozens of lanes over shared working trees with ZERO
merge conflicts, and reviewer-caught defects in a majority of lanes — including money-math
and data-loss bugs that would have shipped. The rules below are why it worked. Use the
Workflow tool; a project may define its own `lane`/`<project>-lane` agent types carrying its
conventions.

## 1. Partition by FILES, not by features

- List every file each item touches BEFORE designing lanes. Two items sharing a file go in
  the SAME lane or run SEQUENTIALLY. When a dependency exists (UI needs a data layer), run
  foundation → review → UI → review as one sequential workflow.
- Treat tightly-coupled clusters (a data layer's interface + all its implementations + its
  types) as ONE ownership unit — any lane touching one claims all.
- Check what is ALREADY in flight: a new workflow must not touch a running lane's files.
  Split the batch into "safe now" and "fire when lane X lands" rather than waiting on
  everything.
- Scout the tree YOURSELF before writing lane prompts: verify every claim a plan makes
  against today's code (plans rot in days), and put the verified facts INTO the prompt —
  a lane that must rediscover architecture wastes its budget and guesses wrong.

## 2. Shared single-owner resources are pre-allocated

Any file every lane would want (translation catalogs, shared constants, a schema file) gets
EXACTLY ONE owner per sprint. Default: the parent pre-allocates everything lanes will need
in one commit BEFORE firing, and prompts say "these exist at HEAD <sha>". A lane needing an
unplanned item REPORTS it; the parent adds it at integration. When the shared machinery
itself needs building, make it a sequential FOUNDATION lane whose api report becomes the
contract downstream prompts quote.

## 3. Adversarial review — always for risky work, skipped for trivial (the dial)

Owner directive 2026-08-29 ("the reviewer dial got a little redundant"): review is a cost,
not a ritual. Spend it where a defect is expensive or invisible, skip it where the diff is
its own proof.

**Review is MANDATORY when the change touches:** money/arithmetic (allocation, totals,
rounding), data or schema (providers, migrations, anything persisted), shared primitives and
anything with many call sites, auth/permissions/RLS, native mechanisms (keyboard, permissions,
background, deep links), concurrency/caching/invalidation, or anything a gate cannot see.

**Review may be SKIPPED for:** copy and translation edits, single-screen layout/styling,
doc-only changes, mechanical renames the compiler proves, and reverts. Say in the report that
review was skipped and why — never silently.

**Never skip on a repeat offender**: if a class of bug has already shipped once (it has), that
class keeps its reviewer regardless of diff size.

- The reviewer verifies against `git diff HEAD -- <lane files>` (new files read directly),
  NEVER the lane's report; prompt it to assume at least one claim is wrong, and to list
  refuted claims explicitly.
- Reviewer judges ONLY the lane's own diff. Other lanes' transient type errors are noise —
  say so in the prompt or the reviewer burns tokens chasing them.
- Demand the reviewer's standard output (format and severities defined in
  `~/.claude/agents/lane-reviewer.md`): VERDICT `SHIP` / `SHIP_WITH_FIXES`; DEFECTS ranked
  blocker/should/nit, each with a concrete failing input and a fix mechanical enough for the
  parent to apply without respawning; REFUTED; CONFIRMED with evidence; PRIOR FIXES; NOTES.
- On a re-review round the reviewer re-verifies every prior finding's fix against the
  current diff — the parent's or lane's change summary is just another claim.
- For code whose correctness is arithmetic (money, allocation, dates), require the reviewer
  to RE-DERIVE independently — its own fuzz/property test against the real code, not a read
  of the lane's test. (This caught a settlement engine twice-over: 20k-case fuzz by the
  lane, independent 50k-case fuzz by the reviewer.)
- Cross-lane reports ("fix needed in a file I don't own") are GOLD — collect and apply them
  at integration; never let a lane edit outside its ownership.

## 4. The concurrency block (paste into every parallel lane prompt)

```
=== HARD RULES — other lanes are editing this same working tree RIGHT NOW ===
1. Touch ONLY files under YOUR FILES; report needed out-of-file changes instead of making
them. 2. No git write commands. 3. No whole-tree verify/test suites or e2e (they race).
Type-check, the linter scoped to your files, and the read-only gates are race-free: run
them. Ignore transient errors in files that are not yours; YOUR files must contribute
zero. 4. Shared single-owner files are PARENT-OWNED — never edit them.
```
Sequential lanes may run the full project bar instead.

## 5. Parent integration duties (after the workflow returns)

1. Apply reviewer fixes + cross-lane fixes yourself — never respawn a lane for a two-line fix.
2. Run the project's FULL verification bar on the whole tree (see the global `verify-deep`
   skill), including the end-to-end suite with its own exit code captured.
3. One commit: code + docs (changelog, task list, index/filemap) together.
4. Ops the lanes can't do: production schema/deploys applied WITH PROOF (baseline query →
   apply → verify → idempotent second pass) BEFORE shipping code that depends on them.
5. If a result looks empty, read the run's journal before diagnosing — never assume.
6. Track progress in the project's task list and the chat. A live artifact task board was
   tried 2026-08-19 and retired by the owner the same day — do not rebuild one unless asked.

## 6. Meta-audit the reviewers periodically (owner asked for this 2026-08-19)

A reviewer that CONFIRMS something false is worse than no reviewer, and no lane reviewer
checks rules ACROSS lanes. Every few shipped batches, run a read-only meta-audit while
implementation continues:
- Parallel auditors, one per RULE FAMILY (e.g. i18n, layout/direction, design system and
  data-layer parity), each auditing COMMITTED code only (`git show HEAD:<path>`) — the
  working tree is half-written while lanes are live, and auditing it produces noise.
- One auditor whose lens is the REVIEWERS: it reads their saved reports and run journals,
  samples their "CONFIRMED" claims against source, lists what they MISSED, flags
  overcalls, and checks that the parent actually applied the fixes it said it applied.
- An ADJUDICATOR that re-verifies every code-changing finding from source and names its
  refutations explicitly. Auditors overcall; unrefuted findings become fix work.
- Every auditor prompt forbids whole-tree verify/test scripts while lanes are running.

## 7. Traps already paid for

- Plans written days ago cite line numbers that moved — lanes must trust the tree.
- An extraction that leaves the original behind (duplicate component, dead form) hides from
  every gate; greps for "who else defines/renders this" belong in lane briefs.
- Test HELPERS are product-coupled code: a behavior change (e.g. an error-message policy)
  can break the login helper and cascade 19 spec failures — audit e2e helpers with specs.
- Piping a test suite through `tail`/`grep` EATS its exit code — always capture and print
  the suite's own exit explicitly.
- Two lanes coordinating a hand-off (one retires a control, the other provides its
  replacement) must agree the seam IN THE PROMPTS (e.g. a route param contract) — never
  leave it to discovery.
- Workflow scripts: no Date.now(); sequential = await in order; big context goes in the
  prompt string, not files the lane must hunt for.
- Reviewers reading code catch logic, not layout. A layout that renders on web can collapse
  to nothing on a native target (percentage width + aspect ratio did); layout-risky lanes
  need a device check or measured pixel sizing, and the report says which.
- A lane running a package install may leave an untracked lockfile — decide deliberately
  at integration (committing it pins the verified versions); never sweep it in by accident.
- **NEVER put a backtick inside a workflow prompt** (three parse failures in one session).
  Prose containing code identifiers goes in a [...].join('\n') array of single-quoted lines,
  not a template literal — one stray backtick around a column or flag name kills the whole
  script, the persisted copy is never written, and the fix costs a full re-send.
- **Never `git add -A` while any lane is running** — it sweeps their in-flight files into
  your commit (happened: a half-written 494-line script landed in an unrelated commit).
  While lanes are live, the parent stages EXPLICIT paths only.
- **Never run the e2e/integration suite while lanes are editing** — a dev-server-backed
  suite hot-reloads mid-run and fails on unrelated screens, wasting the whole run and
  manufacturing a phantom regression to chase. Suites run on a QUIET tree, after the last
  lane returns. (Type-check and read-only scanners are safe; anything that boots the app
  is not.)
