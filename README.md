# claude-settings-clean

A working Claude Code (and Codex) configuration: global rules, skills, agents,
hooks and helper scripts built up over months of daily use. It is generated
from a private backup with personal information and machine-specific
preferences removed, so it updates whenever the source does.

## What is inside

| Path | What it is |
|---|---|
| `claude/CLAUDE.md` | Global rules loaded in every session: acceptance process, verification bar, mobile-first web, git hygiene, output style |
| `claude/settings.json` | Hooks, status line, plugin and model settings |
| `claude/skills/` | Skills: `gauntlet`, `verify-deep`, `lane-sprint`, `gate-scripts`, `run-gates`, `honest-numbers`, `offline-first-writes`, `resilient-long-op`, `vet-install`, React Native RTL/i18n, CAD and EPLAN drawing tools, and more |
| `claude/agents/` | Generic `lane` and `lane-reviewer` agents for parallel work |
| `claude/hooks/` | Pre-commit verification, append-only log guard, doctrine nudges |
| `claude/bin/` | `gates` (run quality gates without installing into a repo), `pack-skills` |
| `codex/` | The same rules wired for Codex (`AGENTS.md` points at `CLAUDE.md`) |
| `tools/impeccable-engine/` | Build the impeccable plugin's engine from pinned source instead of letting it download a binary |

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
