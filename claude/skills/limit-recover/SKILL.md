---
name: limit-recover
description: A session or usage limit killed an agent, a workflow lane, a batch run or the main loop. Checkpoint the exact resume point, tell the owner immediately with the options (usage credits, one model rung down at max effort, wait for the reset), then resume from where it died without re-running what succeeded. Use the MOMENT a limit error appears ("hit your session limit", "usage limit reached", "resets at"), before doing anything else.
---

# limit-recover — a limit is a pause, never a loss

The limit is not the emergency; silently stalling after it is. The first time it hit, a
six-agent batch died on lane 5 of 6 with four lanes' work sitting uncommitted in the
tree and no record of what was missing.

## Doctrine

- **A run killed by a limit is an ERROR, never a pass and never a fail-on-merit.** It is
  recorded as an error and resumed. Any harness that counts results must treat it that
  way: `~/.claude/skills/rule-loop/scripts/comply.py` records a limit-killed session as
  `error`, cancels the remaining sessions instead of spending them on the same failure,
  and prints the exact resume command; its resume retries errored sessions as well as
  missing ones. A new batch tool copies that contract.
- **A limit error is not a code defect.** Never "fix" anything in response to it.
- **Long or unattended runs are built to be resumed** (`resilient-long-op`): a systemd
  transient unit, an idempotent retry script, per-item result files and a DONE marker,
  so a limit mid-run costs only the item that died.

## The drill (in this order)

### 1. Checkpoint before anything else

Limits arrive mid-write; an uncommitted tree plus a dead orchestrator is how work gets
redone. Append to the project's `WORKFLOW_LOG.md`:

- The run's resume handles: script path and run id (from the launch result and the
  failure notification's diagnostics), or the batch tool's run id.
- Which agents or items finished and which died, by name.
- `git status --short` at the moment of death, and whether the tree is gate-green.

Then decide the tree's fate deliberately:

- **Gate-green and coherent:** commit it, if committing is in scope. A commit is the
  cheapest checkpoint.
- **Mid-edit or unverified:** leave it, and write down exactly which files a resumed lane
  must not clobber.

### 2. Tell the owner immediately

Ask the moment the limit is seen; never wait out the reset silently. The owner cannot act
on a limit they do not know about. Include real status (what landed, what died, what each
choice costs), not a bare "hit a limit". Offer, ranked:

1. **Enable usage credits** (recommended): keeps the current model and effort; nothing
   degrades.
2. **One model rung down, at maximum effort**: continues now at a small capability cost.
   Name the current model and the next one in the question itself; "the next strongest"
   means nothing to an owner who does not know where they are. Step down exactly one
   rung, never further, and always pair it with maximum effort: a lower rung at high
   effort beats a higher rung at low effort for lane work.
3. **Wait for the reset**: nothing runs until the stated time.

### 3. Resume; do not re-run what succeeded

- Resume the same run with the same script and the same arguments: completed items
  replay from cache or are skipped by their result files. Editing the script
  invalidates every item from the first edited call onward; edit only the dead lane's
  prompt when you must.
- If the tree changed since the run started (you committed in step 1), say so in the
  resumed lane's prompt; its file-state assumptions may be stale.
- If a lane half-wrote its files before dying, tell the resumed lane to AUDIT the
  existing state first instead of assuming a clean slate.
- Before diagnosing anything, read the run's journal or per-item result files; they
  hold each agent's real return value.

## Failure modes already paid for

- **Lost partial work.** A batch died with several lanes' output uncommitted and
  unrecorded. Class: no checkpoint between parallel work and its integration. Fix:
  step 1 before anything else.
- **The main loop dies too.** Not only subagents hit the limit. Class: assuming the
  orchestrator is immune. Fix: the same drill; the checkpoint is the only thing that
  survives.
- **Limit counted as a result.** Class: a measurement harness that scores a killed run
  as a fail (or worse, a pass), corrupting the rate. Fix: record it as an error, resume
  it, report errors separately from passes and fails.
- **Duplicated work on resume.** Class: a re-run lane assuming a clean slate. Fix: audit
  first; one re-run lane found its own complete prior work and correctly audited
  instead of duplicating it.
- **Second cliff.** Fanning out a new big batch right after recovering re-creates the
  same limit. Class: spending a fresh budget before integrating. Fix: resume the dead
  lane, integrate, commit, then launch new work.
