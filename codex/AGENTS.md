# Global rules (all projects)

The owner switches between Claude Code and Codex. The rules live in ONE place so they cannot
drift: before any work, read and follow these files in full.

1. `~/.claude/CLAUDE.md` — the binding global rules and the toolkit index.
2. `~/.claude/projects/-home-<you>/memory/MEMORY.md` — the memory index; open the
   linked files that bear on the task.
3. In a repo: its `CLAUDE.md`, `.claude/docs/decisions.md` (the decision ledger) and
   `plans/WORKFLOW_LOG.md`.

Translating Claude-specific terms:

- "Load the `<name>` skill" means read `~/.claude/skills/<name>/SKILL.md` (or the
  repo's `.claude/skills/<name>/SKILL.md`, which wins) and follow it.
- Project paths stay `.claude/...` — the ledger, FILEMAP and skills are shared files; never
  create a parallel `.codex/` copy of them.
- Memory: write new facts to the memory directory above in the same format, so both tools
  inherit them.
- Hooks do not run under Codex: before any `git commit`, run the project's verify bar by hand
  (what `~/.claude/hooks/pre-commit-verify.sh` would run).
- `WORKFLOW_LOG.md`, the system change log, the bug tracker and the decision ledgers are
  append-only (Claude hook-guards WORKFLOW_LOG.md only). Under Codex, never overwrite them.
