---
name: device-cost-audit
description: Audit what a mobile (or long-open web) app costs the device in battery, radio, CPU and storage while it sits open or in the background — location (watchers, geofences, one-shot fixes), background tasks, polling intervals and their fan-out, cache persistence, media scans, uploads and retries — and return a ranked verdict (CLEAN / LOW / MEDIUM / HIGH) with file:line evidence and measured or estimated rates. Use when a user reports battery drain or heat, before adding a timer, poll, background task or location feature, before a store submission, and when someone asserts that a subsystem (usually GPS) is the drain without having measured it.
---

# device-cost-audit — find the real drain, not the feared one

Built on a field-work app audited 2026-09 (geofenced clock-in, photo auto-attach,
live shift status). Everyone feared the GPS story. The audit found the location
subsystem **CLEAN** (no standing watchers, opt-in, capped, cooled down) and the
real steady-state cost in a place nobody was looking: a **30-second poll that
fanned out into 4 + W + P sequential requests per tick, app-wide**, with a second
screen polling the same facts again per card. The biggest win was collapsing
that to one query, not touching location at all.

## 0. Doctrine

1. **Inventory every wake source before judging any.** A verdict on one
   subsystem without the inventory is a guess about which one matters.
2. **Steady state beats spikes.** Cost that runs every N seconds while the app
   is merely open, or every wake in the background, dominates cost that runs
   once per user action. Rank by requests (or wakeups, or bytes) per HOUR of
   ordinary use.
3. **Multiply it out.** Per-tick cost = requests per tick x mounted instances x
   ticks per hour. An N+1 inside a poll is a multiplier on a multiplier.
4. **Label measured vs estimated** (see `honest-numbers`). A rate read off a
   network log for ten idle minutes is measured; one derived from reading code
   is estimated. Say which.
5. **Every finding cites file:line** and names the fix and its risk. Offline
   flows often depend on the very persistence and retry that cost the most;
   a fix that breaks offline is not a fix (see `offline-first-writes`).

## 1. Inventory — grep for every wake source

| source | look for (adapt to the stack) |
|---|---|
| timers | `setInterval`, recursive `setTimeout`, `refetchInterval`, `pollInterval`, `useInterval` |
| query fan-out | per-tick sequential awaits; one hook calling N reads; several consumers of the SAME fact with their own keys or intervals |
| location | `watchPosition*` / `requestLocationUpdates` (continuous), geofencing / region monitoring, significant-change, one-shot `getCurrentPosition*`; requested accuracy; `maximumAge` / cache; timeouts |
| background | task managers / `BGTaskScheduler` / `WorkManager` / background fetch; background modes / foreground services declared; what each task body does |
| app-state hooks | work on every foreground (`AppState`, `visibilitychange`, `focusManager`): throttled or not |
| realtime | websockets, SSE, realtime subscriptions: one per screen or shared, reconnect policy |
| persistence | cache persisters (whole cache serialized per change?), throttle, which keys are persisted |
| invalidation | which mutations invalidate which queries; any invalidation that refetches FULL history |
| media | camera-roll / library scans, per-open rescans, info calls per asset, thumbnails vs full-size images mounted at once |
| uploads | retry policy, idempotency (a retry that duplicates), timeouts, abort |
| notifications | scheduled local notifications, re-scheduling on every launch |

## 2. Verdict criteria

**HIGH** — fix before anything else:
- a timer that runs while the app is open on any screen (app-wide) and does
  network work, especially with sequential fan-out (N+1) per tick;
- a continuous location watcher, foreground or background, where a geofence or
  one-shot fix would serve;
- background work not scheduled by the OS (self-rescheduling loops, keep-alive
  services) or with no cap;
- per-tick work that grows with the user's data size (reads full history every
  tick).

**MEDIUM** — event-driven but unbounded:
- an action that refetches full history (bound it by a date floor, or move the
  aggregation server-side);
- persisting the whole query cache on every change, several times per poll
  cycle (throttle; exclude poll and bulk keys, carefully, keeping what offline
  needs);
- reconcile passes that read full history (scope the read: recent window OR
  still open);
- library scans with no per-open budget or cursor, rescanning on every open;
- every full-size image mounted at once (thumbnails at upload; virtualize).

**LOW** — bounded inefficiency:
- a retry that can duplicate a write (deterministic storage path, timeout with
  abort, no automatic retry on non-idempotent uploads);
- a small idle poll with no time box;
- arbitrary truncation at an OS cap (e.g. region limits) that should prioritize
  and surface "watching N of M".

**CLEAN** — what good looks like, and enough to close a subsystem:
- opt-in, OS-scheduled (geofences, significant-change), with no standing
  watcher;
- one-shot fixes at balanced accuracy with a cached max age and a timeout;
- capped (OS region limits respected), floored (minimum radius), cooled down
  (per-site notification cooldowns absorb GPS boundary oscillation);
- throttled foreground reconciles, deferred until after interactions;
- background task bodies wrapped so a throw is a no-op, not a crash loop.

## 3. Location specifics (the usual suspect)

- Continuous watching is almost never needed for "is the user at X":
  geofences or region monitoring wake the app only on transitions.
- Platform region caps: iOS monitors at most 20 regions per app; Android
  geofencing allows 100 per app (platform documentation as of 2026-10;
  re-verify). When the candidate set exceeds the cap,
  choose by priority (open work first, then nearest or most recent) and say
  how many are watched.
- GPS jitter at a boundary fires repeated enter/exit: per-region cooldowns and
  a minimum radius are part of the battery story AND the notification story.
- Request the lowest accuracy that answers the question; cache the last fix.
- Ask for background permission only for an opt-in feature, with the Play
  prominent disclosure (see `store-readiness`).

## 4. Polling specifics (the usual real drain)

- One fact, one query: every consumer of "what is open right now" reads the
  same query key; per-card and per-screen intervals of the same fact go.
- Collapse N+1: one select with the filter (owner, still open, not deleted)
  replaces per-entity sequential reads.
- Pause when backgrounded (focus manager / app state) and when offline.
- Pick the interval from the freshness the user needs; replace with push or
  realtime when tick cost x users x hours is large.

## 5. Measure

- **Network rate:** open the main screens and leave the app idle 10 minutes
  with a proxy or the network inspector recording; count requests per minute
  per endpoint. Repeat in the background.
- **Android:** `adb shell dumpsys batterystats --reset`, use, then
  `adb shell dumpsys batterystats` (or Battery Historian);
  `adb shell dumpsys alarm` and `adb shell dumpsys jobscheduler` for wakeups;
  `adb shell dumpsys location` for active location requests.
- **iOS:** Xcode Organizer energy reports; Instruments Energy Log and Network
  templates; the location arrow in the status bar while backgrounded.
- **Web:** the performance and network panels with the tab idle; timers and
  `visibilitychange` behaviour when hidden.

## 6. Report template

```
DEVICE COST — <app> <build> — <date> — basis: measured | estimated (per row)
Headline: <subsystem> CLEAN | the real steady-state cost is <x>

| sev | wake source | file:line | rate (per hour, idle) | fix | risk |
| HIGH | 30s poll, 4+W+P sequential reads | ... | ~<n> req/h (estimated) | one open-items select shared by all consumers | none to offline |
...
CLEAN: <subsystem> — why (no watchers, opt-in, capped, cooled)
```

Record each HIGH as a task with its rate, and any "deliberately left" item in
the decision ledger so nobody "fixes" it blind.
