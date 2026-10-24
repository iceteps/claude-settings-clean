---
name: filemap
description: Build and maintain a project FILEMAP — a per-file profile map (purpose, relied-on API, non-obvious invariants, coupled files) with a hash-based staleness checker, so future changes start from knowledge instead of re-reading the tree. Use when starting work in any substantial repo that lacks one, and follow its maintenance rule in every commit.
---

# filemap — per-file profiles that make changes cheaper (global standard)

> **ADVISORY, NOT AUTHORITATIVE** (owner directive, 2026-08-29). A FILEMAP is a
> development and devops aid. It tells you WHICH code to read and what traps that
> code carries — it never stands in for reading it. The original rule ("read a
> file's profile before you open the file") started being read as *instead of*,
> and a confidently worded stale profile is worse than no profile: prose cannot
> be compiled, and it drifts silently between commits. So:
>
> - Verify in the SOURCE any claim you are about to act on.
> - Never cite a profile as evidence in a report or a review — cite file:line.
> - The code always wins; a contradicting profile is a doc bug, fix it.
> - Keep the staleness checker ADVISORY. Do not promote it to a build gate: an
>   artifact nothing relies on does not deserve to fail a build, and the friction
>   would buy no safety.


Most agent tokens go to RE-DERIVING what a file is, what depends on it, and which invisible
rule it carries. A FILEMAP converts that recurring cost into a one-time build plus cheap
upkeep. Owner directive 2026-08-29: standard for all projects.

## The artifact

`.claude/FILEMAP.md` — per-directory sections, one compact block per source file (≤7 lines):

```
### src/lib/thing.ts — one-line purpose
API: the exports/props OTHERS rely on — names + one-phrase semantics
Invariants: the NON-OBVIOUS — single-writer rules, ordering contracts, provider-parity
  duties, staleness traps, gate exceptions. THE money field; omit if genuinely none.
Links: files that must stay in sync with this one / main consumers
```

Write for agents, not humans: terse, factual, zero padding. A boring file gets a boring
3-line profile. Profile what a 10-second skim would NOT reveal; distill existing doc-comments
rather than duplicating them.

## The staleness rule (the design point that makes this safe)

A wrong profile is worse than none — it steers an agent into a bug with false confidence.
So staleness must be VISIBLE, never silent:

- `scripts/filemap-check.mjs` (plain node, no deps) keeps `.claude/filemap-hashes.json`
  (path → content hash). Default run prints `STALE:` / `MISSING:` / `UNMAPPED:` lines and
  ALWAYS exits 0 (advisory). `--update` restamps after re-profiling.
- Reading a STALE profile means: trust the code over the profile, then re-profile and
  restamp in your commit.

## Maintenance (same rule as every agent doc)

A commit that MATERIALLY changes a file updates its profile in the SAME commit, and new
files get profiled when created. The check script keeps everyone honest about drift.

## Building one from scratch

Parallel profiler agents, one per directory slice, returning structured per-file profiles;
an assembler writes the map + the checker + the initial hash stamp; a reviewer SPOT-CHECKS
profiles against source (wrong API names and false invariants are blockers — accuracy is the
whole product) and runs the checker's UNMAPPED logic for coverage.

## Using one

Before editing a file: read its profile (and its Links' profiles) first; open the file
already knowing the traps. Lane prompts should point lanes at the relevant profiles instead
of pasting architecture. If the profile contradicts the code, the code wins — flag and fix
the profile.
