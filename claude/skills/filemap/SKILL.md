---
name: filemap
description: Keep a project's THIN FILEMAP: `.claude/FILEMAP.md` as an index of cross-file traps (two files that must move together), never per-file profiles. Invariants live as code comments at their binding sites; the map only says where a coupling spans files. Use when two files must change together, when a review finds a coupling no single file can show, when starting work in a repo that has a map, and when retiring an old per-file-profile ("fat") map.
---

# filemap: a cross-file traps index, never per-file profiles (global standard)

> **THE MODEL** (owner decision 2026-09-03, superseding the 2026-08-29 per-file-profile
> model). An invariant lives as a CODE COMMENT at the site it binds. A CROSS-FILE coupling,
> meaning two files that must move together, gets that comment at BOTH sites plus ONE index
> line in `.claude/FILEMAP.md`. API and purpose summaries are banned from the map. The only
> mechanical check is dead cited paths. The code always wins; cite files and lines, never
> the map.

## Why the fat map died

The retired model kept a profile per file (purpose, API, invariants, links) and a hash
checker that flagged profiles whose file had changed. Measured on a real project: an
adversarial distillation verified 191 profiles against source and ten claims survived.
The rest were API summaries the code states better, or invariants already written as a
comment at the exact site they bind. Two of the ten were live bugs the map had been
DESCRIBING instead of anyone fixing them.

What that measurement teaches:

- **A description of code is a second copy of it, and copies drift.** Prose cannot be
  compiled, and a confident stale profile steers an agent into a bug.
- **A note about a defect is not a fix.** Writing the trap down made it feel handled.
- **The restamp was a laundering trap.** "Re-profile and restamp" turned a stale profile
  into a fresh-looking one with one command, whether or not anyone re-read the file.
- **The upkeep tax was paid on every commit** to maintain an artefact whose value
  collapsed once agents could cheaply read the real tree.

## When a line belongs in the map

Add an index line only when ALL of these hold:

1. **Two or more files must change together**, or something breaks.
2. **No single file can carry it**: each file read on its own looks complete.
3. **No gate catches the drift.** If the compiler, a test or a gate would fail on a
   mismatch, that check is the guard and the map line is noise.

Typical shapes:

- **A duplicated literal** that cannot be imported (an import would close a cycle, or
  the two sides are different languages): a storage key, an event name, a header.
- **One rule in two languages**: a permission predicate in client code and in a
  database policy; a response shape mirrored by a client type.
- **Platform twins**: a native file and its web variant whose props or styles are
  duplicated, where the type checker resolves callers against only one of them.
- **Load-bearing anchors**: test IDs, route names or selectors that an end-to-end suite
  locates by, so a rename passes every gate and breaks the suite.
- **A contract chosen at the caller**: a component option that is unsafe for some
  content, where the rule must be visible where the choice is made.

Before writing the line, ask whether the coupling can be REMOVED instead: import the
constant, share the type, generate one side from the other. A deleted coupling needs no
index line. And if the trap is a bug, fix the bug; never index it.

**Not a map line:** an invariant inside one file (that is a comment at its site), an
API summary, a file's purpose, an architecture overview (belongs in project docs), a
to-do or known bug (belongs in the tracker), a decision (belongs in the ledger).

## The two-site comment convention

Each binding site carries a comment that names the OTHER site and says what moves
together. Write it where the next editor will be standing when they make the change.

```ts
/** COUPLING: src/providers/session.ts owns this key (SESSION_CACHE_KEY).
 *  Duplicated by literal because importing it would close a require cycle.
 *  Rename both together. Indexed in .claude/FILEMAP.md. */
const SESSION_CACHE_KEY = 'app-session-cache';
```

```sql
-- COUPLING: mirrors canManage() in src/hooks/usePermissions.ts. One predicate,
-- two languages: change one and the client and the policy disagree silently.
```

Rules:

- **`COUPLING:` prefix**, so `grep -rn "COUPLING:"` lists every site in the tree.
- **Name the partner by repo-relative path**, plus the symbol when the file is large.
- **Say WHY it cannot be one copy**, so nobody "fixes" it by deleting one side.
- **Both sites, same commit.** A comment on one side only is a trap for whoever edits
  the other.

## The index line

```markdown
- `src/providers/session.ts` ↔ `src/providers/auth.ts` — the cache key is duplicated
  by literal (an import would close a require cycle). Rename together. Comments at
  both sites.
```

- **Paths in backticks, repo-relative, in full.** A bare basename is ambiguous and the
  check fails it.
- **One to three lines**: which files, what moves together, why it cannot be one copy.
  The detail lives in the comments; the line is a pointer.
- **Group by shape** (coupled pairs, load-bearing anchors, caller-chosen contracts) when
  the map grows past a screen.
- **A short header** stating the rules, so a reader who lands on the map knows it is an
  index, not documentation.

Banned in the map: API lists, purpose lines, per-file sections, invariants of a single
file, staleness hashes, generated content, and any claim not also present at a code site.

## Maintenance

- **A commit that creates a coupling** writes both comments AND the index line.
- **A commit that removes a coupling** deletes the comments AND the line.
- **A rename** updates the line and the partner's comment; the check catches the line.
- **When the map and the code disagree, the code wins.** Fix the map in the same commit.
- **Cite code, never the map**, in reports and reviews: `file:line`.

## The check: dead cited paths, nothing else

`gate-scripts/scripts/filemap-check.mjs` reads the map and fails when a cited path no
longer exists. That is the one failure an index can suffer mechanically: a rename
leaves a line pointing at nothing, and the coupling it guarded is forgotten.

```sh
node ~/.claude/skills/gate-scripts/scripts/filemap-check.mjs [map=.claude/FILEMAP.md]
```

- Run from the repo root; paths resolve against the CWD.
- Exit 1 on a dead path, printed as `map:line  path`. Exit 0 otherwise, and exit 0 with
  one line when the repo has no map.
- Only backticked, path-shaped spans outside fenced blocks are checked; globs, URLs and
  package specifiers are skipped. A trailing `:42`, `:42-60` or `#L42` is stripped first.
- Suppress a sanctioned citation (an example path, a file generated at build time) with
  `<!-- filemap-ok: reason -->` on the line or the line above. No reason, no suppression.

It runs from outside through `gates`; copy it in with `bootstrap.sh` only for a repo you
own. There is no `--update` and no hash file, by design.

## Retiring a fat map

For a repo still carrying per-file profiles, a hash file or a restamping checker:

1. **Extract every claim** from the profiles (an invariant, a link, a warning). Ignore
   purpose and API lines; they are discarded by definition.
2. **Verify each claim against source.** Split the work by directory across reviewers
   when the map is large; a claim is kept only with a `file:line` that proves it.
3. **Triage each surviving claim:**
   - **A bug** → fix it in this commit. Do not index it.
   - **A removable duplication** → remove it (import, share the type). Do not index it.
   - **A single-file invariant** → a comment at its binding site, if the code does not
     already say it.
   - **A true cross-file coupling** → comments at BOTH sites plus one index line.
   - **Already stated at the site, or false** → dropped.
4. **Delete** the profiles, the hash file and any `--update`/restamp machinery. Replace
   the project's checker with the dead-path check. Git history keeps the old map.
5. **Measure and record.** Count profiles in, claims verified, claims surviving, and how
   each survivor was resolved (fixed, deduped, commented, indexed). Write the numbers
   into the decision ledger with the retirement. The measurement is the evidence that
   nothing was lost; a retirement without it is a deletion.
6. **Run the check** and confirm zero dead paths, then update the project's CLAUDE.md
   so its reading order and maintenance rule describe the thin model.

## Using a map

Read it before editing a file it names, then open the partner it points to. It tells
you which other file to open; it never tells you what either file does. Read the code
for that.
