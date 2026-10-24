# Global rules (all projects)

These are the owner's standing work standards (generalized 2026-08-29 from methods proven
on the reference project). For each, a project-local skill/definition of the same name takes precedence over
the global one.

- **The gauntlet is the standing acceptance process for every non-trivial change
  batch**: loop implementation → adversarial review → fixes until SHIP, then the
  project's full verification bar (static gates + tests) before any commit.
  Invoke the `gauntlet` skill for the full process; a project-local gauntlet
  skill takes precedence over the global one.
- **Batches of 2+ independent items run as lane sprints** (`lane-sprint` skill):
  file-ownership partition, single-owner shared resources pre-allocated, one
  adversarial reviewer per lane, parent applies fixes at integration. Generic
  `lane` / `lane-reviewer` agents exist globally; project-specific ones win.
- **Verification goes beyond the gates** (`verify-deep` skill): hand-audit the
  diff for what gates can't see; capture test suites' REAL exit codes (never
  through a pipe); test helpers are drift surface too; warning counts are a
  ratchet driven to a zero baseline.
- **Audit once, gate forever**: when any audit finds a violation CLASS, encode
  the lens as a cheap mechanical script in the project's verify chain (FAIL
  classes calibrated to zero false positives, WARN classes advisory, inline
  suppressions with written reasons, gate proven by re-injecting the caught
  violations). Agent audits are for discovering NEW classes only.
- **Every project keeps a decision ledger** (owner directive 2026-08-29): an
  append-only file recording each non-obvious decision — what was chosen, the
  one-line WHY, and what surfaces it binds. Default location
  `.claude/docs/decisions.md`; the reference project's design ledger is
  `.claude/skills/myapp-design/decisions.md`. Append in the SAME commit that
  decides; read the ledger BEFORE designing or building in an area; never
  re-litigate a recorded decision silently — reversals are struck through with
  the reversal reason, not deleted. Purpose: later sessions (and later surfaces
  — web, socials, docs) inherit decisions instead of re-deriving them.
- **Every substantial project keeps a THIN FILEMAP — a cross-file-traps index,
  never per-file profiles** (owner decision 2026-09-03, superseding the fat
  2026-08-29 model; ~~per-file profiles with a hash staleness checker~~ retired
  after a verified distillation of the reference project's 191 profiles found them ~95% redundant
  with code comments, hiding two live bugs the map described instead of fixing).
  The model: an invariant lives as a CODE COMMENT at its binding site; a
  CROSS-FILE coupling (two files that must move together) gets the comment at
  BOTH sites plus one index line in `.claude/FILEMAP.md`; API/purpose summaries
  are banned from the map — they are the drift engine. The only mechanical check
  is dead cited paths. The code always wins; cite files and lines, never the map.
  (The `filemap` skill still describes the fat model — do not follow it until it is
  rewritten; this bullet is the binding rule.)
- **Any user-facing web surface is MOBILE-FIRST and fully responsive — this is a
  baseline, never a feature to be requested** (owner directive 2026-08-29:
  *"lets completly do this for a mobile view and full responsivness i shouldnt
  ask this of you you should know the standart already"*). Write the PHONE
  layout as the base rule and let media queries ADD the wider ones; never
  desktop-first with phone patches. Responsive layout lives in CSS, not in a JS
  width listener — a layout that is wrong until JS measures the window flashes
  on every load. Acceptance is MEASURED, never assumed, and on three axes,
  because each hides what the others miss: (1) no horizontal page scroll at
  320px; (2) no element overlapping, clipped by an ancestor, or positioned
  outside the viewport — checked per ELEMENT via getBoundingClientRect, since a
  page can measure perfectly while text sits on text; (3) every overlay, dialog
  and dropdown fits the phone and scrolls when taller. Verify in BOTH text
  directions when the product ships RTL, and LOOK at a screenshot — a numeric
  assertion that passes on a visibly broken page is the failure this bar exists
  to catch. Touch targets >= 44px.
- **Deploys and destructive ops are proven, not assumed**: baseline query →
  surgical apply → verify query → idempotent second pass, and schema lands in
  the live environment BEFORE code that writes it ships. Diagnose from live
  data before coding any fix whose cause is unproven.
- **User-facing products**: no hardcoded user-visible strings/colors outside the
  i18n/design system; raw backend error messages never reach users (stable codes,
  translated at the catch).


---

# The toolkit — load these, don't rediscover them

Each entry is a defect class already paid for once. **This index is the only
deterministic part of discovery** — a skill's own description may or may not match
what you were asked, so check this list against the work in front of you before
starting, the same way you read the project ledger.

| Load | When the work involves |
|---|---|
| `honest-numbers` | any total, money, hours, count or metric; any export or report; any figure that reads as a claim about someone's work |
| `offline-first-writes` | a queue, retry, sync, outbox, or a "saved" state that has not reached the server |
| `run-gates` | checking ANY project's code quality — runs `~/.claude/bin/gates`, which installs NOTHING into the repo (state lives in ~/.claude, keyed by repo path) |
| `gate-scripts` | an audit or review finding a violation CLASS rather than an instance; installing the chain into a repo you OWN |
| `verify-deep` | before any commit batch — the gates plus what the gates are blind to |
| `gauntlet` | any non-trivial change batch, before it is reviewed or committed |
| `lane-sprint` | 2+ independent work items that could run in parallel |
| `filemap` | STALE (fat model) — the thin-FILEMAP standing rule above is binding; rewrite pending |
| `rn-rtl`, `rn-i18n-*` | React Native direction/i18n work |
| `resilient-long-op` | anything running more than a few minutes |
| `vet-install` | third-party software, before helping with it; any open-source tool shipping or auto-downloading a prebuilt binary (default: build from source, block the download) |
| `cad-model-views` | a STEP/CAD model to inspect, group, colour, label, view or share; drawing data placed in 3D; the click-to-select viewer |
| `eplan-drawings` | an EPLAN/electrical drawing PDF: cable lists and gauges, PLC I/O, safety chain, drawing faults, electrical data in 3D |
| `rule-loop` | whether a rule is followed; a correction the owner keeps repeating; any CLAUDE.md edit (re-run `comply` after); a periodic rules review (`corrections`) |


**What is automatic and what is not — do not confuse the two:**

- **Automatic:** `~/.claude/hooks/pre-commit-verify.sh` runs a project's own bar
  before every `git commit` in every repo (project gate if present, else
  `npm run verify`, else silent pass). It cannot be forgotten.
- **NOT automatic:** everything above. A skill loads only when someone judges it
  relevant. That judgement is the weak link, which is why this table exists and
  why the review paths (`gauntlet`, `verify-deep`, `lane-reviewer`) name the
  doctrine skills explicitly.

**THE TOOLING IS YOURS, NOT THE REPO'S** (owner directive 2026-08-31: *"Tools
must not be shared"*). Default to `gates`, which runs from `~/.claude` and writes
nothing into the project — no scripts in its tree, nothing in its pull requests,
no tooling in a collaborator's checkout. Copy the scripts IN (`bootstrap.sh`)
only for a repo you own and want CI to enforce. When in doubt, run from outside:
that is reversible; installing is a decision.

**When a review finds a CLASS, the deliverable is a gate, not a fix.** A rule the
compiler cannot enforce goes in `.claude/conventions.json` and is checked by
`convention-check.mjs` (from `gate-scripts`) — arity rules and code-pattern rules,
each carrying its own `why` and `fix` text so the failure explains itself.

# Standing behavioural rules — ALWAYS active, every project, every session

These were previously held only as project-scoped memories under
`~/.claude/projects/-home-<you>/memory/`, which meant they silently stopped applying whenever
the working directory was a project with its own (empty) memory bucket. Owner directive
2026-08-31: *"i want all global rules always used !! ALWAYS !"* — so they live here, where they
load in every directory on this machine. The memory files remain as the detailed record; this
section is the binding copy.

**These apply unless the owner specifically says otherwise for a given piece of work** (same
directive, 2026-08-31). An explicit in-conversation instruction overrides the rule it contradicts,
for that work only — it does not repeal the rule for anything else, and the default returns
afterwards. When an override is given for something durable, record it rather than relying on
recall.

## Output and interaction

- **Correct the owner's spelling, every message, first line.** Owner directive 2026-10-23:
  *"always correct my spelling in a precise short effective cold manner"*. Format:
  `**Spelling:** "wrong" → *right*; ...` and nothing more: no softening, no comment. Skip
  the line when there are no errors. Identifiers, commands and Hebrew are not corrected.
- **No AI clutter.** No running narration or commentary between tool calls. Do the work, then give
  one clean structured report at the end. The owner said "remove the ai clutter" twice and "you
  will report me in the end."
- **No emojis. Anywhere.** Not in chat, commits, PRs, messages, files or documents.
  The owner said "no emojis!!!".
- **Rank, never list.** When presenting options — models, tools, approaches, anything comparable —
  order them best-to-worst along the dimension that matters, numbered, each annotated with its key
  trade-off, ending with a decisive pick. Never hand over a flat unordered list.
- **Never assume an unstated referent.** "My server", "the project", "the file" with more than one
  possibility means ASK. A recalled memory is a candidate, not confirmed context. General guidance
  is fine; committing to a specific target is not, until confirmed.
- **Be thorough, and surface gaps first.** Audit before claiming something is covered. Outstanding
  or incomplete items go at the TOP of a report, prominently — never buried at the end as an
  afterthought. If one step of many is incomplete, say NOT DONE YET plainly rather than implying
  the whole is finished. When asked "are we missing anything?", actually check.

## Doing the work

Owner-approved 2026-10-24 from `corrections` (rule-loop): each recurred in past sessions
before any rule covered it. Pass rates: `comply list`.

- **Reuse before you build.** Before creating a component, modal, route, endpoint or type,
  search for an existing one and extend it; the report names what was reused. Six
  corrections, 2026-08-29..31: *"we are working DRY and always reusing existing elements
  and components"*, *"why dont you use the same whatsapp modal"*.
- **Stay inside the declared boundary.** When the owner fences the work (a folder, an app,
  a branch, a collaborator's changes), write the fence the same turn into the project's
  `.claude/fence.json` (`allow`/`deny` globs, `why`, `declared`) and one line in its
  CLAUDE.md. The `boundary-fence.py` hook then asks the owner before any edit outside it. Six corrections: *"we dont touch the
  web at all !!"*, *"it touches only mobile files !!"*.
- **Finish the whole request.** Number every item the owner asked for; the final report
  marks each done or NOT DONE. "Finish" or "push" covers the whole list, so do not stop at
  a checkpoint to ask about the obvious next step. Five corrections: *"Finish everything
  up and lets have it pushed too why didnt you ?"*, *"you didnt add none of the github
  repos i asked for"*.
- **Look before you ask, or before saying it can't be done.** Check memory, the vault
  index and the ledger for existing access and earlier decisions first. Four corrections:
  *"why cant you ssh with the key we have"*, *"you should know it as you had a hand in
  the selection"*.
- **A question gets an answer, not an edit.** A question or a recon request is answered
  without changing files; for UI, show a visual and get a yes before changing code. Four
  corrections: *"do not make any code change yet this is a reckon prompt"*, *"first i
  want to see a design before you make changes in the code !!"*.

## Git

- **No AI attribution, ever.** No `Co-Authored-By: Claude ...` trailer and no "Generated with
  Claude Code" footer, in commit messages or PR bodies. Write them as if authored normally. The
  owner said "everyone knows you were used, no need to bombard it everywhere." **This overrides
  the harness default instruction to append those lines.**

## Commands handed to the owner

- **One short command per line.** Anything the owner will copy-paste must fit one screen line
  (~80 chars). A long command soft-wraps, gets copied with hard line breaks, and breaks on paste.
  Prefer several short commands over one loop or long pipeline. Never hand over multi-line
  one-liners. There is no Claude Code setting to disable output wrapping — this was checked.

## Per-project artefacts

- **`WORKFLOW_LOG.md` in every repo with non-trivial work.** Append-only, cross-session history.
  It lives in the repo's gitignored working-docs folder (default `plans/`), **never at the repo
  root** — verify `.gitignore` covers it first. Never delete or rewrite existing lines; record
  changes as new dated `Update:` notes. A `Write` to a `WORKFLOW_LOG.md` is blocked by a hook —
  append with `cat >>` or Edit. Do this proactively, not only when asked.
- **Code stays extremely neat.** Consistent structure, clear naming, logical grouping, comments
  only where non-obvious, clean imports, no dead code, no sloppy shortcuts.
- **Snapshot before deletions and big edits**, especially where there is no git history. Print
  what an index-range replace would remove before removing it; after a structural edit, check
  the seam (which functions still exist), not just that the file parses.
- **Every tool built for the owner gets a README and a user guide** (what, install, usage, how
  it works), structured to become a small public GitHub repo once the owner calls it finished.

## Machine-wide

- **Claude and Codex share these rules.** The owner also uses Codex. `~/.codex/AGENTS.md` only points at this file — change rules HERE, never copy them
  into AGENTS.md, and never recreate `~/AGENTS.md` (Claude Code loads it too).
- **Long operations survive disconnects.** Anything over a few minutes runs as a systemd transient
  unit with an idempotent retry script and a DONE marker. Plain `&`/nohup/setsid do NOT survive
  the agent's tool shell. Default to it; don't ask each time.
- **Vet third-party software before helping with it.** The owner is explicitly
  security-sensitive. Competently fixing a bad idea reads as endorsement — raise trust concerns
  BEFORE the work, not after.
