---
name: offline-first-writes
description: Make writes survive no connection in a mobile or field app — an outbox that queues the action, replays it in order, and records WHEN THE USER PRESSED rather than when the network returned. Use when adding offline support, when a write can be lost on a flaky connection, when building a sync queue or retry, or when a "saved" state must be honest about not having reached the server yet. Carries the invariants and the four failure modes that are invisible until production.
---

# offline-first-writes — the queue, and the five things that make it wrong

Built on the reference project 2026-08-31 (clock in/out for workers in basements and stairwells).
Every rule below is a defect that shipped or was one review away from shipping.

## 0. The one that makes offline support WORSE than no offline support

**Capture the time the user PRESSED, and replay it.** If the write stamps
`now()` server-side or inside the queued function, an action replayed two hours
later records as having happened two hours late.

For a timesheet, an inspection, a delivery signature or a meter reading, that
does not merely fail to help — **it writes a false record**, which is worse than
the error it replaces. The press time is captured at the tap, carried as an
argument through the queue, and written explicitly. The server's own
`created_at` stays untouched, so the row holds two separate facts: when it
happened, and when it was recorded.

## 1. Why an explicit outbox, not the query library's paused mutations

React Query (and equivalents) can pause a mutation offline and resume it. Right
tool for a refetch, wrong tool here, for two reasons:

- Restoring a paused mutation across an **app restart** requires every mutation
  function to be registered on the client rather than in the component that owns
  it — a large refactor that spreads.
- A paused mutation is **invisible**. It cannot be counted, shown, or explained
  to the person standing there wondering whether their action registered. Any
  requirement of the form "let them see what is still waiting" rules it out.

An outbox is a persisted array with `enqueue` / `resolve` / `fail`. That is all.

## 2. Invariants — each of these was a bug first

1. **Press time never re-stamped.** See §0.
2. **FIFO, and a failed item BLOCKS the queue.** Do not skip ahead: a "close"
   action that overtakes its "open" closes the wrong thing.
3. **Remove only on a DEFINITE success.** A failure keeps the item with its
   attempt count, so a drain dying mid-flush loses nothing.
4. **"Already exists" is a SUCCESS, not a failure.** The write reached the
   server; the response did not reach the device. Treating the retry's collision
   as an error pins a permanent "not synced" badge on work that is safely
   recorded. **But** — see §3, this one has a trap inside it.
5. **Record WHY a failure happened.** Connectivity clears itself; a rejection
   does not. "3 waiting for signal" and "1 needs you" are different sentences,
   and showing the hopeful one for a dead item is the lie that costs someone.
6. **Never persist the `draining` flag.** A crash mid-flush would leave the
   queue permanently "already draining" and nothing would ever send again.
7. **Scope the queue to the signed-in user.** The store is per-DEVICE and
   outlives a sign-out. Two people sharing a phone is normal in the field;
   replaying one person's write under another's session is rejected
   non-retryably and wedges the queue.
8. **The queue never bypasses a server guard.** A queued action still meets the
   duplicate check when it lands. It waited; it did not earn an exemption.

## 3. The four failure modes that are invisible until production

**A. Your HTTP client does not throw `Error` objects.** supabase-js sets
`shouldThrowOnError: false`, so a fetch rejection arrives as a plain
`{ message, details, hint, code }`. `String(err)` on that is `"[object Object]"`,
which matches no pattern — so the retryable check returns false, nothing is ever
queued, and **the entire feature is dead while looking correct**. No test can
catch it if the test suite runs against a mock that never produces network
errors. Read the message structurally, and prefer a structural signal
(PostgREST sets `status === 0` on every fetch failure) over matching English.

**B. "Already exists" resolution can orphan a linked follow-up.** If item B
references item A by a temporary id, and A is resolved via the already-exists
path **without looking up the real id**, B keeps a placeholder forever, the FIFO
guard stops on it every pass, and every write behind it dies — while the
indicator says "waiting for signal". Look the real record up before resolving,
and fail an orphan non-retryably so it reads as "needs you".

**C. A timeout is NOT a definite failure.** A timeout that races a timer does not
abort the request, so the write may have committed. Never roll back, never
"undo", never mark failed-and-discard on a timeout. An orphan is recoverable;
destroying live data is not.

**D. Adding the queue can break the app at boot.** A store that was dead code has
never been bundled. The moment it is imported, everything it imports enters the
bundle — and a library whose ESM build uses `import.meta` will not evaluate in
some bundlers. Symptom: a white screen and every test failing for reasons
unrelated to the feature. Persist by hand if the middleware costs this much.

## 4. Letting the user act on a queued state

If an "open" action is queued, the app shows nothing open — so the user cannot
"close" it. Overlay a **synthetic record** from the pending item (a marked id
like `outbox:<itemId>`) so the state is visible and actionable, and make the
close path recognise that id and queue a LINKED follow-up instead of hitting the
network.

**Then trace every consumer of that synthetic record.** It must never reach a
write, an export, a report or a calendar sync. This is the single most dangerous
part of the design and the one worth an adversarial review.

## 5. Honesty in the UI

A queued action rides the ERROR channel, because the call did not complete — but
its message must say **"saved, will send"**, never "failed". Telling someone
their action failed when it is safely queued sends them back to do it again,
creating the duplicate the queue exists to prevent.

Check every catch on the path, not just the obvious one. A `catch { showFixed() }`
that discards the error will report the queued case as a failure, and that catch
is usually on the busiest button in the app.

## 6. Test what the suite cannot reach

The queue's decisions are made from error SHAPES the mock provider never
produces. Extract the predicates into a **dependency-free module** and assert
against real shapes — the actual rejection object, the actual guard sentences —
in a tiny script. No test runner needed. See the `gate-scripts` skill; that one
check would have caught failure mode A in under a second.
