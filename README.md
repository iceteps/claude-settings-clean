# claude-settings-clean

A working Claude Code (and Codex) configuration: global rules, skills, agents,
hooks and helper scripts built up over months of daily use. It is generated
from a private backup with personal information and machine-specific
preferences removed, so it updates whenever the source does.

## What is inside

| Path | What it is |
|---|---|
| `claude/CLAUDE.md` | Global rules loaded in every session: acceptance process, verification bar, mobile-first web, git hygiene, output style, and an index of which skill to load for which work |
| `claude/settings.json` | Hooks, status line, plugin and model settings |
| `claude/skills/`, `agents/`, `hooks/`, `bin/` | Listed below |
| `codex/` | The same rules wired for Codex (`AGENTS.md` points at `CLAUDE.md`) |
| `tools/impeccable-engine/` | Build the impeccable plugin's engine from pinned source instead of letting it download a binary |

<!-- inventory:start -->

Generated from the files in this repo: 23 skills, 2 agents, 4 hooks, 4 commands.

### Skills (`claude/skills/`)

| Name | What it does |
|---|---|
| `cad-model-views` | Turn a large, unnamed CAD export (STEP/STP, often hundreds of MB from SolidWorks) into fast, labelled, shareable views — split it into identifiable groups by geometry, build quick-load glTF files for ... |
| `deploy-and-prove` | Deploy any artifact (server process, serverless or edge function, container, static site, schema change) and then PROVE the new code is live and behaving, including the staleness check that catches ... |
| `device-cost-audit` | Audit what a mobile (or long-open web) app costs the device in battery, radio, CPU and storage while it sits open or in the background — location (watchers, geofences, one-shot fixes), background ... |
| `eplan-drawings` | Read, extract and audit an EPLAN electrical drawing set (PDF schematics with =function+location-device tags, PLC I/O overviews, device/cable/terminal reports) — page index, device list, cable list ... |
| `filemap` | Keep a project's THIN FILEMAP: `.claude/FILEMAP.md` as an index of cross-file traps (two files that must move together), never per-file profiles. |
| `gate-scripts` | Portable mechanical gates that turn an audit finding into a check that runs forever — hardcoded user-visible strings, RTL invariants, i18n key parity, single-source design values, font-weight ... |
| `gauntlet` | The owner's standing acceptance process for EVERY non-trivial change batch, in ANY project — loop implementation → adversarial review → fixes until SHIP, then the project's full verification bar ... |
| `hebrew-msg` | Write a ready-to-send Hebrew message to the team, a manager, a permissions/access owner, or a client — status update, access request, blocker escalation, handoff note. |
| `honest-numbers` | Rules for displaying data a person will act on or be paid against — naming a figure so it cannot be misread, absent vs zero, stated vs derived vs verified, and one grammar per quantity. |
| `lane-sprint` | Run a batch of 2+ independent work items as parallel workflow lanes with an adversarial reviewer per lane — file-ownership partition, single-owner shared resources, the concurrency block, reviewer ... |
| `limit-recover` | A session or usage limit killed an agent, a workflow lane, a batch run or the main loop. Checkpoint the exact resume point, tell the owner immediately with the options (usage credits, one model rung ... |
| `offline-first-writes` | Make writes survive no connection in a mobile or field app — an outbox that queues the action, replays it in order, and records WHEN THE USER PRESSED rather than when the network returned. |
| `prod-check` | Query the live (production) environment directly to diagnose a bug from data instead of reasoning, verify that a migration or deploy actually landed, detect schema drift between code and the live ... |
| `resilient-long-op` | Run any long or large operation so it SURVIVES a disconnect and is fully resumable — multi-GB downloads (ollama/model pulls, docker pulls, dataset/HuggingFace fetches, wget/curl of big files), long ... |
| `rn-i18n-retrofit` | Add or repair i18n + RTL in an EXISTING React Native / Expo app — audit hardcoded strings and physical style props, migrate incrementally without breaking shipped screens, and fix a half-working ... |
| `rn-i18n-scaffold` | Scaffold i18n + RTL into a NEW React Native / Expo project from scratch — translation files with compiler-enforced key parity, a locale provider that gets RTL right on native and web, per-locale ... |
| `rn-rtl` | Make right-to-left layout actually work in a React Native / Expo app, on native AND web — or diagnose why it renders left-to-right, mirrors twice, refuses to center, or gets stuck after a language ... |
| `rule-loop` | Find the owner's corrections in past Claude and Codex sessions, turn the recurring ones into rules or hooks, and MEASURE whether each rule is actually followed by running sandboxed headless sessions ... |
| `run-gates` | Run the verification gates against ANY project without installing anything into it — hardcoded strings, RTL invariants, i18n parity, design tokens, font pairing, declared conventions, FILEMAP cited ... |
| `store-readiness` | Audit a mobile app against the Apple App Store and Google Play submission walls before anyone promises a release — permissions and purpose strings, privacy manifest, account deletion, privacy policy, ... |
| `verify-deep` | The full verification pass for ANY project — the project's automatic gates PLUS the hand audits gates are blind to, honest exit-code capture (an errored run is never a pass), proof that every check ... |
| `vet-install` | Trust assessment before installing, fixing, integrating, or debugging third-party software — any `curl \| sh` installer, root install, closed binary, a plugin or launcher that downloads a prebuilt ... |
| `web-acceptance` | Measured phone acceptance for any user-facing web surface. Runs a Playwright script that measures the three binding axes per element (no horizontal scroll at 320px; nothing overlapping, clipped by an ... |

### Agents (`claude/agents/`)

| Name | What it does |
|---|---|
| `lane-reviewer` | Generic adversarial reviewer for an implementation lane in any project — verifies the lane's claims against the real git diff (never the report), runs the checks it safely can, and returns SHIP / ... |
| `lane` | Generic implementation lane for any project — receives a task, a list of files it OWNS, and possibly a concurrency block; loads the project's own conventions before writing code; delivers working ... |

### Hooks (`claude/hooks/`, wired in `settings.json`)

| Name | What it does |
|---|---|
| `boundary-fence.py` | The "stay inside the declared boundary" rule (CLAUDE.md, Doing the work), enforced instead of remembered. |
| `doctrine-nudge.sh` | A MECHANICAL trigger for knowledge that would otherwise depend on remembering. |
| `pre-commit-verify.sh` | Runs a project's OWN verification bar before any `git commit`, in every repo, without each repo having to remember to wire it. |
| `workflow-log-guard.sh` | The logs are append-only, so a Write (full overwrite) to an EXISTING WORKFLOW_LOG.md is blocked. Creating a new one is allowed; appends go through `cat >>` or Edit. |

### Commands (`claude/bin/`)

| Name | What it does |
|---|---|
| `comply` | Command-line entry point of the `rule-loop` skill (see its README). |
| `corrections` | Command-line entry point of the `rule-loop` skill (see its README). |
| `gates` | Run the verification gates against a project WITHOUT installing anything into it. |
| `pack-skills` | Package global Claude Code skills to share with another person. |

<!-- inventory:end -->

## Install

Read `claude/CLAUDE.md` first: it is opinionated, and it speaks of "the owner"
(the person whose rules these are). Edit it to fit you.

```
git clone <this repo URL> claude-settings-clean
cd claude-settings-clean
./install.sh            # dry run: lists what would change
./install.sh --apply    # copy into ~/.claude and ~/.codex
```

Existing files are kept as `<file>.pre-install-<date>`. Restart Claude Code.

## Requirements

bash, rsync, git, python3. Some skills need more (each `SKILL.md` lists its
tools): Node for the gate scripts, poppler/FreeCAD/F3D for the CAD skills.

## How it is made

A sync job copies an allowlist of configuration files into a private backup,
then derives this repository from it by dropping personal files (memories,
plans, machine logs), stripping personal sections, rewriting names and paths,
and refusing to publish if any personal or OS-specific marker survives. A
secret scan runs on every commit.

## License

MIT (see `LICENSE`). Third-party code bundled inside a skill keeps its own
licence, for example three.js under `claude/skills/cad-model-views/viewer/vendor/`.
Issues and pull requests are welcome.
