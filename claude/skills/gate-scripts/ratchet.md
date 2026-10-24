# Ratchet gates: a count that may only go down

A ratchet gate is a FAIL gate installed on a codebase that already contains the
violation it checks for. The violations that exist on the day it goes in are
written into a **baseline**. Anything on the baseline passes and anything new
fails. The baseline may only shrink.

It exists because the two obvious alternatives both fail:

- **Gate at zero on day one.** The gate blocks work that has nothing to do with
  the backlog, so people bypass it, and a bypassed gate is worse than none.
- **Warn only.** A warning count nobody owns grows forever.

A ratchet blocks every new copy, lets the old ones be paid down at any pace,
and never lets the count rise again.

**Use a ratchet only when the backlog is too big to fix today** (tens to
hundreds of sites). If the backlog is small enough to fix in one sitting, fix it
and gate at zero. A zero baseline needs no file, and nobody has to remember a
number.

---

## 1. The forms in this toolkit

| Form | Where the baseline lives | Granularity | Used by |
|---|---|---|---|
| Baseline file | `design-baseline.json` | one row per finding (multiset) | `design-check.mjs` |
| Config list | `gate-config.json`, one gate section | per sentence, per slot, or per file | `hardcode-check.mjs`: `legacyThrows`, `errtextDisplay.baseline`, `kitCopy.baseline` |
| Allow list as burn-down | `conventions.json`, a rule's `allow` | per file | `convention-check.mjs` pattern rules |

All three follow the contract below. The third form needs no code at all, so
it is the quickest way to ratchet a new class:

1. Write the canonical replacement first: one module that does the thing
   correctly (for example a single `netMinutes()` in place of twenty
   hand-rolled `duration - break` copies that disagree with each other).
2. Declare a `pattern` rule matching the hand-rolled copy. Its `allow` list is
   the canonical module, followed by every file that still carries a copy.
3. Write in the rule's `why` that the list after the canonical module is a
   burn-down baseline that only shrinks. If the scanner cannot see a copy (for
   example a subtraction split across template lines), name that file there.
   It is still on the burn-down list, even though no gate can find it.

---

## 2. The baseline contract

Every ratchet, including a new one, must satisfy all of these rules.

1. **Key on content, never on line numbers.** For a finding, the key is
   `file::rule::offending text`. Key on the line number and the first unrelated
   edit above a finding turns it into a "new" violation. That noise teaches
   people to restamp without reading.
2. **The baseline is a multiset, not a set.** Two identical baselined lines in
   one file are two rows. If the gate dedupes keys, pasting a baselined line
   a second time passes for free, and the backlog grows behind a green gate.
   (The pre-merge `design-check` had exactly this hole; the fixture proof in
   the 2026-10-24 merge shows the old version passing a pasted copy.) Of the
   config lists, only `errtextDisplay.baseline` follows this rule: it takes one
   entry per slot. `legacyThrows` is keyed per sentence and `kitCopy.baseline`
   per file, so each admits any number of copies (see §5).
3. **Store rows sorted, with a `//` note** naming the class and saying
   "May only SHRINK". A review diff of a sorted list is readable, so a reviewer
   can see that a change only deletes rows.
4. **One location, with a stated precedence.** A baseline committed in the repo
   wins, because the repo carries its own bar. Otherwise the external runner's
   per-repo state is used (`$GATE_STATE_DIR`), so nothing is written into a
   repo you do not own. The gate never reads one location and writes the
   other.
5. **Report the count on every run** (`ℹ 46 on the ratchet baseline …`). A
   number nobody sees never goes down.
6. **Report stale rows.** A stale row is one whose violation is gone. Each
   stale row re-admits its exact violation if it ever comes back, so the gate
   lists stale rows (as advisory output, exit 0) until they are deleted. When a
   gate runs once per source tree, judge a file-keyed row only during the run
   whose tree contains that file. Otherwise every run reports the other
   trees' rows as stale.
7. **An inline suppression wins over the baseline.** When a burn-down moves a
   site to `// <gate>-ok(<class>): reason`, deleting its baseline row in the
   same change must not report the new suppression as unused.
8. **Reject malformed config loudly.** In `gate-config.json`, an unknown or
   mistyped key or section, a section that is not an object, or a top level
   that is not an object exits 2. A typo such as `kitcopy` or `hardcod` would
   otherwise switch the whole check off without a word. A malformed baseline
   file exits 2 the same way.

---

## 3. Seeding, restamping, and why they are separate

| Command | When | What it may do |
|---|---|---|
| `--seed` | once, when the gate is adopted | create the baseline from the current findings, in `$GATE_STATE_DIR`; **refuses if a repo or state baseline exists**; without `$GATE_STATE_DIR` refuses unless `--in-repo` is given |
| `--update` | after paying some of it down | drop rows whose finding is gone; **refuses if any FAIL finding is not on the baseline**; refuses if there is no baseline |
| (no flag) | every run | pass baselined findings, fail new ones, report count and stale rows |

**`--update` may restamp but never grow.** It writes only the findings it
matched against the existing baseline, so it can remove rows and never add one.
If a new FAIL finding exists, it refuses and lists the finding. Fix it, or
suppress it with a written reason, then restamp. A new WARN-class finding does
not block the restamp and is not written, so it stays visible as advisory
output.

**Seeding is a separate verb on purpose.** If `--update` also seeded when the
file was missing, deleting the baseline and running `--update` would re-bless
every violation in the tree: the ratchet would be bypassed with two commands
and nothing to show in review. With a separate `--seed` that refuses when a
baseline exists, re-seeding requires deleting a committed file, and that
deletion shows up in the diff.

**A seed must not create a second baseline.** A repo baseline wins over the
state one, so seeding a repo file beside an existing state baseline would
shadow it and re-admit everything the state baseline had already burned down.
`--seed` therefore refuses while either baseline exists. Without
`$GATE_STATE_DIR` it also refuses unless `--in-repo` says the repo is
deliberately meant to carry its own baseline.

Config-list ratchets (section 1) have no `--update`. Rows are deleted by hand,
in the same change that removes the violation. The stale-row report tells you
which rows to delete.

### What no gate can stop

A person can always edit the baseline or config by hand and add a row. Close
this gap in review: **a ratchet change's diff to the baseline must consist only
of deletions.** In a repo you own, this can be enforced mechanically with a
pre-commit check. Compare the rows as multisets, HEAD against the index. Do not
grep diff lines: a shrink rewrites the trailing commas of the rows around it,
so a text diff shows unchanged rows as added.

```sh
f=.claude/design-baseline.json
# Skipped on the seeding commit (no HEAD copy) and on a deletion (visible in
# review). The rows go through temp files, not argv: a large baseline exceeds
# the kernel's 128 KB limit on a single argument.
if git cat-file -e "HEAD:$f" 2>/dev/null && git cat-file -e ":$f" 2>/dev/null; then
  old=$(mktemp); new=$(mktemp)
  git show "HEAD:$f" > "$old"; git show ":$f" > "$new"
  node -e '
    const fs = require("fs");
    const [a, b] = process.argv.slice(1)
      .map((p) => JSON.parse(fs.readFileSync(p, "utf8")).known ?? []);
    const left = new Map();
    for (const k of a) left.set(k, (left.get(k) ?? 0) + 1);
    for (const k of b) {
      const n = left.get(k) ?? 0;
      if (!n) { console.error(`baseline row ADDED: ${k}`); process.exit(1); }
      left.set(k, n - 1);
    }' "$old" "$new"
  rc=$?; rm -f "$old" "$new"
  [ "$rc" -eq 0 ] || exit 1
fi
```

---

## 4. Running a burn-down as lanes

A large baseline gets paid down as a lane sprint (see the `lane-sprint` skill).
The ratchet decides how the work is split:

1. **Foundation first, in one commit:** the canonical replacement, the gate,
   and the baseline. Lanes start only once the gate is green on the baseline.
   It is the gate each lane will be held to.
2. **Partition by file.** Each baseline row names a file, so files are the
   lane boundaries. No two lanes own the same file.
3. **The baseline file is a single-owner shared resource, owned by the
   parent.** Lanes never edit it. Each lane reports the rows it cleared. At
   integration the parent deletes those rows, or runs `--update`, which drops
   them itself.
4. **A lane is done when its rows are gone and the gate stays green**: green
   with the lane's rows removed from the baseline, not merely green while the
   rows are still listed.
5. **Each lane's reviewer checks two things in its diff:** every removed copy
   now goes through the canonical replacement (the copy was not just deleted),
   and no figure on screen changed except where the canonical version fixes a
   bug the old copies had. Write those bug fixes down, because they change
   numbers people read.
6. **Verify the count went down.** Record it before and after (the gate prints
   it). The integration commit's baseline diff consists only of deletions.
7. **At zero, delete the mechanism.** Delete the baseline file and the burn-down
   part of the `allow` list. A zero ratchet is just a gate.

---

## 5. Pitfalls, each one already paid for

- **Line-number keys.** These cause constant false "new" findings, and people
  learn to restamp blindly.
- **Set-keyed baselines.** Pasting a baselined line a second time passes for
  free (section 2, rule 2).
- **`--update` that seeds when the file is missing.** Deleting the file
  bypasses the ratchet (section 3).
- **Reading the baseline from one path and writing it to another.** The
  pre-merge `design-check` read `$GATE_STATE_DIR/design-baseline.json` but on
  `--update` tested and wrote `join(repo, <absolute state path>)`. The restamp
  crashed, and if that directory had existed it would have re-seeded instead
  of shrinking.
- **A repo-committed baseline ignored by the external runner.** With the state
  directory set, the old precedence read an empty state baseline instead of
  the repo's own, so the whole backlog failed. A committed baseline now wins.
- **Directory globs in an allow list.** A glob silently admits the next file
  added under it. List explicit paths.
- **Stale rows left in place.** Each one is a pre-approved violation waiting to
  come back.
- **Scanner blind spots.** If the pattern cannot see a copy, name the copy in
  the rule's `why` and keep it on the burn-down list by name.
- **Suppression laundering.** Moving a baselined site to an inline suppression
  only counts as burn-down when the written reason says why that site is
  genuinely correct. Otherwise it is the same violation under another name.
- **Ratcheting a WARN class.** A ratchet exists to make FAIL tolerable on a
  backlog. If the class is advisory, it needs no ratchet, and a baseline only
  hides it.
- **A per-file or per-sentence allowance where a per-site allowance was
  possible.** A file on a file-granular baseline (`kitCopy.baseline`, a
  convention `allow` list) can add any number of new copies without failing.
  The same holds for a sentence listed in `legacyThrows`: any number of new
  throws of that exact sentence pass. Prefer content keys counted per site.
  When only a file or sentence list is practical, keep the burn-down short.
- **A baseline that never moves.** If the count printed on every run is
  the same as last month, the burn-down has no owner. Put it on the plan or
  drive it to zero.

---

## 6. Adding a ratchet to a new gate: checklist

- [ ] Findings carry a stable content key (`file::rule::text`), not a line.
- [ ] Baseline loaded as a multiset; matched findings decrement it.
- [ ] Location precedence: repo file, then `$GATE_STATE_DIR`; reads and writes
      use the same resolved path.
- [ ] `--seed` creates once, and refuses while any baseline (repo or state)
      exists; `--update` shrinks only, refuses on a new FAIL finding or a
      missing baseline, and keeps the file's `//` note.
- [ ] A malformed baseline or config is a clean exit 2, not a stack trace.
- [ ] Every run prints the baselined count and lists stale rows, scoped to the
      tree being scanned.
- [ ] An inline suppression wins over a baseline row.
- [ ] Unknown config keys exit non-zero.
- [ ] Proven with a fixture: a new violation FAILS, a pasted copy of a baselined
      line FAILS, `--update` refuses to grow, a fix plus `--update` shrinks the
      count, and a check run writes nothing into the repo.
