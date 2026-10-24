---
name: honest-numbers
description: Rules for displaying data a person will act on or be paid against — naming a figure so it cannot be misread, absent vs zero, stated vs derived vs verified, and one grammar per quantity. Use when building any surface that shows totals, money, hours, counts or metrics; when a number appears on more than one screen; when writing an export or report; or when a figure could be read as a claim about someone's work.
---

# honest-numbers — a figure that can be misread will be

Built on the reference project 2026-08 (a worklog whose entire product claim is that its numbers
can be trusted). Every rule is a real defect, and several were found only because
a human read the screen rather than the code.

## 1. Never render a bare quantity without saying WHOSE and WHICH KIND

The failure that generated this: one product had **three different numbers all
called "hours"**.

- **Sum across everyone** (man-hours) — the only correct basis for cost and
  payroll. 10 people × 8h × 100 days = 8,000, which reads as absurd on a screen
  labelled "hours on this site".
- **Coverage** — the UNION of overlapping periods. Two people working the same 8
  hours is 8 hours of activity, not 16. This is what "how much work happened
  here" actually means, and it is usually not computed at all.
- **Personal** — what one person did. The only kind that may appear on a public
  profile.

An audit found the app contained **zero** occurrences of the honest label while
displaying the summed figure as plain "Hours" on its headline stat. Name the kind
at the point of render. A site summary should lead with span and crew size ("ran
4 months with a 6-person crew"), never a five-digit total.

**Public surfaces are where this is fatal.** Aggregating other people's work onto
someone's profile is both a credibility problem and a legal one — a worker's
record is their data, not their employer's marketing.

## 2. Absent is not zero — and which absence mark depends on the surface

Blank beats a fake `0.00`. An "answered zero" is distinct from "never asked": if a
prompt was dismissed, write nothing rather than a zero, and never auto-fill an
answer nobody gave.

Then, the split most people miss:

- **Machine-readable export (CSV)** → **blank**. A dash in a spreadsheet cell is
  a *string*, and it poisons a column someone will sum.
- **Rendered document or screen** → **em dash**. A blank cell there reads as
  forgotten rather than not-applicable.

Same doctrine, two surfaces. A report that prints `0.00` for a row that has no
hours by nature says the person showed up and did nothing.

## 3. Stated, derived and verified must never wear the same clothes

Three tiers, and collapsing them destroys the value of the strong one:

- **Stated** — someone typed it.
- **Derived** — the system computed it from records.
- **Corroborated / verified** — two independent parties' records agree.

Concrete failure: app bookkeeping ("Break taken on site") was appended to a
worker's own free-text note and sent to his employer as one run-on sentence **in
his voice**. Give machine-authored text its own field and its own label. A user's
account of their work and the system's account of their work are different
fields, permanently.

Corollary: **provenance is a fact, not a correction.** If a record reached the
system late, say so — do not silently backdate and do not hide it. "Logged from
site at 06:58" and "typed in on Friday for Tuesday" are both legitimate and are
not the same evidence.

**But show provenance only where there is a counterparty.** A flag is evidence,
and evidence needs someone to show it to. On a person's own private record it is
bureaucracy, and that noise is what teaches people to ignore the flags that
matter. Decide from the RECORD (author vs owner), never from who is currently
looking — a flag that appears or vanishes per viewer looks like concealment.

## 4. One grammar per quantity, and documents get the words

A fraction, a duration, a count: pick ONE rendering per quantity and use it
everywhere a person reads words. A glyph form (`1½`, `¾`) is legitimate **only**
in dense matrix cells where a percent will not fit — never in a document.

Caught in review one minute from shipping: a PDF was about to print "¾ day" while
the screen the worker had just been looking at said "75%". The same number
wearing two names is how "which figure is right?" starts, and a client-facing
document is the last place to invent vocabulary.

## 5. Counts and interpolation in a mirrored language

- A count reads best as a fixed noun plus a **parenthesised numeral** —
  `הודעות (3)` — which needs no gender or plural agreement at all, so the entire
  plural surface disappears.
- **Never interpolate user-typed text into a sentence** in an RTL locale. The
  text may be Latin, native or mixed, and embedding a mixed-direction run inside
  a sentence hands the bidi algorithm an ambiguity at the boundary, where it can
  reorder in ways neither language reads correctly. Give it its own labelled row.
- A digits-only format (`1½`) is direction-safe by construction. That is
  load-bearing, not incidental — the moment a letter enters, it needs the full
  i18n treatment. Say so where the format is defined.

## 6. The ledger is exact; the summary is human

Rounding, day-fractions and friendly phrasings are a DISPLAY transform, never a
mutation. Keep exact values in the record and exact minutes/agorot in the money
path. Nobody may derive pay by dividing a rounded display figure.

## 7. Do not decide the user's financial model for them

If a figure depends on a policy (does an owner cost their own labour? is "left"
contracted or collected?), that is a **setting**, not an assumption — with a
default that is honest when unset. An absent rate produces an **absent line**,
not a zero and not a placeholder pretending to be data.

The pattern that fits: a global default plus a **nullable per-instance override**
where null means *inherit*, never a copied value that goes stale when the default
changes.

## 8. What no gate can see

Automatic checks catch hardcoded strings and missing tokens. They cannot see a
number wearing the wrong name, a lost invariant in a moved comment, or a bidi
boundary inside an interpolated sentence. **Read the screen.** Every rule above
except one was found by a person looking at output, not by a linter.
