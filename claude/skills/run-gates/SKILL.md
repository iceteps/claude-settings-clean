---
name: run-gates
description: Run the verification gates against ANY project without installing anything into it — hardcoded strings, RTL invariants, i18n parity, design tokens, font pairing, declared conventions. Use before committing in a repo with no verification chain, when auditing a codebase you do not own or must not add tooling to, or when asked to "check this project" / "run the gates". Nothing is written into the repo; per-project state lives in ~/.claude.
---

# run-gates — check a project without leaving anything in it

```
~/.claude/bin/gates              # every applicable gate, against this project
~/.claude/bin/gates --update     # restamp the design baseline (it can only shrink)
~/.claude/bin/gates --where      # where this project's state is kept
```

Run it from anywhere inside the repo. It finds the git root itself.

## Why this exists rather than installing the scripts

**The tooling is the owner's, not the repo's.** Copying gate scripts into a
project puts them in its history, its pull requests, and its collaborators'
checkouts. That is fine for a repo you own and want CI to enforce; it is wrong
for a client's repo, a fork, an audit, or anything you did not write.

So the gates run from `~/.claude/skills/gate-scripts/scripts/`, and per-project
state — the design baseline, the declared conventions — lives in
`~/.claude/gate-state/<slug>`, keyed by the repo's absolute path. **A repo can
have a checked convention without having a file.** Verify with `--where`.

## Which mode for which repo

| Repo | Use | Because |
|---|---|---|
| Yours, wants CI enforcement | `bootstrap.sh` (in `gate-scripts`) | the bar should travel with the code and run for every contributor |
| Someone else's, a fork, an audit, a client's | `gates` | nothing enters their tree or their PR |
| Unsure | `gates` | it is reversible; installing is a decision |

## What it runs

Per source directory found (`src`, `app`, `lib`, `source`): hardcoded strings,
RTL invariants, font pairing. Once per project: i18n parity (if an `i18n`
directory exists), design tokens, declared conventions. Each is a plain text
scanner — no model, no network, no judgement, `file:line` on failure.

## Declaring a convention for a repo you cannot touch

`gates --where` prints the state directory; put a `conventions.json` there:

```json
{ "dirs": ["src"], "rules": [
  { "id": "no-raw-error-string", "kind": "pattern",
    "pattern": "String\\(\\s*(err|error)\\s*\\)",
    "why": "Many HTTP clients reject with a plain object, not an Error — String(obj) is '[object Object]' and matches nothing.",
    "fix": "Read .message structurally." } ] }
```

`kind` is `pattern` (regex over CODE — comments and strings are stripped, so a
rule never fires on the comment explaining it) or `call-arity` (flags a call
passing more than `maxArgs`, handling trailing commas and multi-line member
chains). Suppress a sanctioned case with `// convention-ok(<id>): reason`.

## The first run on an existing codebase will fail

That is the expected result, not a problem — it is the backlog becoming visible.
Read `gate-scripts` for the FAIL vs frozen-ratchet vs zero-baseline decision
before fixing anything, and prove one gate by re-injecting a violation.

## Honest limits

- Node/TS/JS-shaped: it scans `.ts/.tsx/.js/.jsx/.mjs`.
- `hardcode-check` carries a legacy allow-list from the project it was written
  for; harmless elsewhere, but it is not a general-purpose i18n linter.
- These catch SHAPES, never meaning. A number wearing the wrong name, a lost
  invariant, a bidi boundary inside an interpolated sentence — all invisible
  here. See `honest-numbers` and `verify-deep` for what must be read by a person.
