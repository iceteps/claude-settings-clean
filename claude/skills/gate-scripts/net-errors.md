# net-errors — the gate for code that classifies failures

Script: `scripts/net-errors-check.mjs`. Doctrine it enforces: the
`offline-first-writes` skill, section 3, failure modes **A** (the HTTP client
does not throw `Error` objects) and **C** (a timeout is not a definite failure).

## The defect class

Any code that decides what KIND of failure an error is: retry it, discard it,
or treat it as already done. A retry queue, an outbox drain, a session-purge
decision, an error-to-message mapper.

It fails silently. Many HTTP clients reject with a **plain object**
(`{ message, details, hint, code }`), not an `Error`. Then:

- `String(err)` is `"[object Object]"`. A regex over it matches nothing, so the
  "this is a network failure, queue it" branch never fires. The feature is dead
  while every screen looks correct.
- `err instanceof Error ? err.message : ''` reads the empty string, so every
  real backend message falls through to the generic fallback.

Nothing else can see it. The types are `unknown`, so the compiler is silent. A
test suite backed by a mock never produces a network error, so it never reaches
the branch. One adversarial reader found it once; this gate finds it every time.

## The fix the gate expects

1. **One dependency-free classification module** (for example
   `src/lib/net-errors.ts`) exporting a message reader (`errText`), a
   connectivity predicate (`isRetryable`) and, where the backend has duplicate
   guards, a lost-response predicate (`isAlreadyRecorded`). Every classifier in
   the app calls these; nothing re-derives them. Dependency-free is
   load-bearing: the gate loads that one file alone. An import in it removes the
   only coverage this logic has.
2. **Read messages structurally.** Any object resolves through its `message`
   field or to `''`, never through `String(obj)`. Empty is the honest answer
   for "no message here"; `"[object Object]"` looks like content.
3. **Prefer a structural signal over English** where the client gives one
   (PostgREST sets `status === 0` on every fetch failure).
4. **A timeout is retryable, never a definite failure** (mode C). A raced timer
   does not abort the request; the write may have landed. The project declares
   what its timeout wrapper throws and the gate asserts it classifies as
   retryable.
5. **"Already exists" covers every duplicate guard**, both directions (an open
   AND a close). Matching only one of them wedges a replayed item in the queue
   forever under a "needs attention" badge for work that is safely recorded.

## Classes

| Class | Level | Catches |
|---|---|---|
| `stringified-classify` | FAIL | a PROVEN caught error turned into a string (`String(x)`, `String(x as T)`, `x.toString()`, `x?.toString()`, `x + ''`, `'' + x`, `JSON.stringify(x)`, any template containing `${x}`) and fed straight to a matcher (`.test`, `.includes`, `.match`, `.startsWith`, ..., also through `.toLowerCase()`), or coerced implicitly by `re.test(x)` / `re.exec(x)` |
| `fixture` | FAIL | the classification module answers wrongly for a real error shape |
| `module` | FAIL | the declared module does not exist, does not compile under `--strict`, cannot be loaded alone (an import it cannot resolve from a temp dir), or lacks the declared export |
| `bare-suppression` | FAIL | a `neterr-ok` comment without a written reason |
| `stringified-error` | WARN | the same stringification where the value is not PROVEN a caught error, or a proven one not fed to a matcher on the spot (it may reach one through a variable, or reach a user) |
| `instanceof-only` | WARN | `x instanceof Error ? x.message : ...` |
| `timeout-unchecked` | WARN | a module is declared but `timeoutError` is not |

"PROVEN caught error" is deliberately narrow; it is the calibration that keeps
the FAIL class at zero false positives:

- the binding of a `catch (x) { }` block, or of a `.catch(x => ...)` /
  `.catch(function (x) { })` handler, scoped to that block or argument list;
- a parameter annotated `: unknown` or `: any` whose NAME says it is an error,
  scoped to the function body. The name is split into camelCase / snake_case
  segments. A segment `err`, `error`, `errors`, `exc`, `exception` or
  `rejection` (or a whole name in `errorNames`) proves it under either type:
  `fetchErr` counts, `referrer`, `terrain` and `interrupt` do not. The
  ambiguous segments `e`, `ex`, `reason` and `cause` prove it only under
  `: unknown`, the type a catch binding has; `(e: any)` may be a number and
  `(cause: any)` a diagnosis, so those are WARN at most. `(val: unknown)` is a
  value, not a rejection, and is never proven;
- only up to the first REBINDING of the name inside the scope (a nested
  `(x) =>`, `function (x)`, `catch (x)`, `const x`). After that, hits are WARN;
- only when the scope's closing bracket was found and no `'`/`"` string or
  regex literal inside it ran to a newline unclosed. Either sign means the lexer may have lost sync
  (a JSX `Users' data`, a stray `"`), so every hit in that scope is WARN rather
  than a guess that could run the scope past its real end.

An UNTYPED plain-JS classifier such as `function isRetryable(err) { return
/fetch/.test(String(err)); }` is therefore WARN only: an untyped `err` parameter
is just as often a Node callback's real `Error`. That is why the fixture half
exists: declare the module and the predicate itself is asserted against a
plain-object rejection, which is where this bug actually shows.

Names in `errorNames` (default `err`, `error`, `exception`) are checked
file-wide, but at WARN only: `const [error, setError] = useState('')` and a
Node callback's `(err, data)` are not rejections the scan can prove.

The scan runs on a view of the source with comments, `'`/`"` string contents
and regex-literal contents blanked, and template contents kept (`${x}` is
evidence). So a test title such as `it('flags String(err).includes(x)')` cannot
FAIL. The lexer does not open a `'` string between two letters (JSX prose such
as `Can't`), ends `'`/`"` strings at a newline, and skips regex literals
(including right after `=>`), so a quote inside `/'/` or the `//` inside
`/https?:\/\//` does not desync it.

The declared module is exempt from the scan; the fixtures test it instead.

`node net-errors-check.mjs --selftest` re-runs the whole calibration: the false
positives and false negatives an adversarial review found, the shipped defects,
each re-injected predicate bug, and the edge cases, each a tiny repo in a temp
dir, compared against the EXACT expected FAIL and WARN file:line sets. A new
false positive breaks it as surely as a missed violation. Run it after any
change to the script.

Why the WARN classes are not FAIL: a stringified error that ends up in a log
line is harmless, and an `instanceof` read is correct when the source is known
to throw real `Error`s. The scan cannot tell those apart, so a human decides.
Data flow through a variable (`const msg = String(e); ... .test(msg)`) is also
WARN-only for the same reason.

## Config

An explicit path as the first argument, else `.claude/net-errors.json` in the
repo, else `$GATE_STATE_DIR/net-errors.json` (set by `~/.claude/bin/gates`, so a
repo you do not own needs no file). With no config the static scan still runs
over whichever of `src`, `app`, `lib`, `source` exist; with neither files nor a
module it prints "nothing to check" and exits 0, never a success line.
`--json` prints the findings as one JSON object (same exit code).

| Key | Default | Meaning |
|---|---|---|
| `dirs` | existing of `src app lib source` | scan roots |
| `allow` | `[]` | path substrings exempt from the scan |
| `errorNames` | `err error exception` | identifiers checked file-wide at WARN, and counted as error names for typed parameters |
| `module` | none | the classification module; absent means no fixtures run |
| `exports` | `errText`, `isRetryable`, `isAlreadyRecorded` | export names, keyed `text`, `retryable`, `alreadyRecorded`; only `retryable` is required |
| `presets` | `["fetch"]` | built-in real shapes: `fetch` (browser, React Native and Node fetch failures, as `TypeError`s and as a plain object; `null`, a bare string, `{}`), `postgrest` (plain-object offline, `status: 0`, RLS `42501`, not-null `23502`) |
| `timeoutError` | none | what the project's timeout wrapper throws: a message string, or a value spec |
| `cases` | `[]` | project shapes: `{ label, value, retryable?, alreadyRecorded? }` |

Every preset shape also asserts `alreadyRecorded: false`: a network failure or
a refusal is never a success. Predicates are judged by truthiness (callers
branch on them with `if`); a predicate that throws on a shape fails. The message
reader, when exported, must return a plain object's `message`, an `Error`'s
`message`, and exactly `''` for `{}`: empty is the honest answer for "no message
here", and `"[object Object]"` looks like content.

A value spec is plain JSON, except an object carrying `"$error"` becomes a real
`Error`: `{ "$error": "Failed to fetch", "$name": "TypeError", "status": 0 }`.
Use the project's REAL shapes: the duplicate-guard sentences its providers
actually throw, the object its client actually rejects with. Invented shapes
prove nothing.

```json
{
  "dirs": ["src", "web/src"],
  "module": "src/lib/net-errors.ts",
  "presets": ["fetch", "postgrest"],
  "timeoutError": "NETWORK_TIMEOUT: save (20s)",
  "cases": [
    { "label": "duplicate close", "value": { "$error": "Already closed" },
      "retryable": false, "alreadyRecorded": true },
    { "label": "duplicate as a plain object", "value": { "message": "Already closed" },
      "retryable": false, "alreadyRecorded": true }
  ]
}
```

A `.ts` module is compiled with the project's own `node_modules/.bin/tsc`
(`--strict`, into a temp dir marked `{"type":"module"}`, never a download);
without one it is imported through Node's type stripping, which needs Node 22.6
or newer (behind a flag until 23.6, the default since) and handles erasable
syntax only, so an `enum` without tsc is a `module` FAIL. A `.js`/`.mjs` module
is imported directly.

Trust: loading the module, and running the repo's own tsc, executes the repo's
code. Run the fixture half only on a repo whose code you would run anyway.

## Suppression

On the line, or on a comment-only line directly above; the reason is mandatory:

```js
// neterr-ok(stringified-error): the value is a numeric id, never a rejection
```

A suppression with no reason suppresses nothing and FAILs. An unused one is
listed so it cannot rot in place.

## Proof

Re-injecting each defect into a fixed module, one at a time, fails the gate
with the line that names it:

- the original dead queue, `isRetryable` over `String(err)`:
  `PostgREST offline, plain object (failure mode A): isRetryable -> false, expected true (errText: "[object Object]")`
- `errText({})` leaking `String(obj)`:
  `errText: object without a message must read as '', never "[object Object]"`
- the duplicate guard matching only the open direction:
  `duplicate CLOSE ...: isAlreadyRecorded -> false, expected true`

Prove it again in any project that adopts it: inject one of these, watch it
fail, revert.
