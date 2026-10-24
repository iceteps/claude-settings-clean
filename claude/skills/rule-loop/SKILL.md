---
name: rule-loop
description: Find the owner's corrections in past Claude and Codex sessions, turn the recurring ones into rules or hooks, and MEASURE whether each rule is actually followed by running sandboxed headless sessions against it. Use when asked whether a rule works, why the agent keeps doing something the owner corrected, to tune CLAUDE.md, after adding or rewording a rule, or for a periodic rules review. Tools - `corrections` (mine) and `comply` (measure).
---

# rule-loop: corrections in, measured rules out

A rule in CLAUDE.md is a hope until it is measured. This skill closes the loop:

```
corrections  ->  triage  ->  rule or hook (owner approves)  ->  comply spec  ->  comply run
     ^                                                                              |
     +------------------- a low pass rate means: reword, move, or promote ---------+
```

Both tools are read-only toward the owner's work. `corrections` only reads
transcripts. `comply` runs real sessions in throwaway directories. Bash runs in
Claude Code's OS sandbox (no network, writes only in the session's directories,
the hook's secret list unreadable, no user sockets), and `scripts/sandbox_hook.py`
fences the other tools.
`comply selftest --live` proves the fence with a session that tries to escape.
README.md has the full guide; this file is the procedure.

## 1. Mine

```
corrections                # unreviewed candidates -> ~/.claude/state/rule-loop/corrections-<date>.md
corrections --since 2026-10-01
```

The match is a deliberate over-include. Read the report, not the count.

## 2. Triage

Sort every candidate into exactly one bucket:

1. **Violation of an existing rule** - the rule exists and was broken anyway. It
   needs a comply spec, because the text alone is evidently not enough.
2. **New class** - a correction that recurs (two or more messages, or one with
   strong signals such as "I shouldn't have to ask") and no rule covers. Draft
   the rule text with its WHY, quoting the owner's words and dates.
3. **Project-local** - true only for one project (the reference project's mobile-only boundary).
   It belongs in that project's CLAUDE.md or ledger, not the global file.
4. **Noise** - a question about the machine, pasted AI output, a one-off.

Present buckets 1-3 ranked by recurrence x cost, per the rank-never-list rule.
**The owner approves every rule before it is written into CLAUDE.md.** Never
edit the rules on your own judgement; that is the line between this and the
self-modifying "instinct" systems it was designed against. When the triage is
accepted, `corrections --ack` marks the report as reviewed.

## 3. Write a spec

One JSON file per rule in `specs/<id>.json` (format in README.md). Rules for a
good spec:

- **Three levels.** `supportive` reminds the rule, `neutral` is silent about it,
  `competing` pulls against it without ordering a violation. An explicit owner
  instruction overrides a rule by design, so a competing prompt that ORDERS the
  violation measures nothing.
- **Mechanical checks first** (`regex`, `tool_count`, `order`); `judge` (a
  Haiku grader) only for what no pattern can see.
- **A precondition** when the governed behaviour may not happen at all (no
  commit attempted, no page written). Those sessions score `no-signal`, never a
  pass: absent is not zero.
- **Fixtures are mandatory.** Give synthetic transcripts with the verdict each
  must get, at least one `fail`, and run `comply selftest`. A check that passes
  on every transcript is broken, and the selftest is what catches that.

## 4. Run and read

```
comply run all --dry-run   # the plan and the session count; costs nothing
comply run <id> [--repeat N] [--jobs J]
comply list                # last result per rule
comply history <id>        # trend
```

Each session is a full Claude Code session on the owner's default model and
counts against the usage limit; size `--repeat` accordingly. A batch over a few
minutes runs as a transient unit (resilient-long-op), resumable by `--run-id`:

```
systemd-run --user --unit=rule-loop-comply --collect --setenv=PATH="$PATH" ~/.claude/bin/comply run all --run-id <id>
```

`--setenv=PATH` matters: `claude` lives in a mise directory the user manager
does not know about. Progress: `journalctl --user -u rule-loop-comply -f`.

Read failing transcripts before concluding anything: the failure may be in the
spec. Read a sample of passing ones too: 100% on a first run more often means a
weak check than a perfect rule.

## 5. Act on the number

- **Fails at neutral or competing, and the behaviour is pattern-checkable** ->
  promote it to a hook (PreToolUse deny, or a doctrine-nudge trigger) or a gate.
  Executed code is the only guarantee.
- **Fails, not checkable** -> reword or move the rule (earlier, shorter, with
  the WHY), re-run, and keep the version that scores better.
- **Passes everywhere** -> keep the spec as a regression test; re-run after any
  CLAUDE.md edit or model change.

Record each promotion or rewording in `~/.claude/docs/decisions.md`, with the
before and after pass rates.
