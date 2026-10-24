# impeccable engine, built from source

The [impeccable](https://github.com/pbakaus/impeccable) Claude Code plugin (design
critique and polish) needs a native engine. Its launcher downloads a prebuilt binary
from GitHub releases. This recipe builds that engine from a pinned, vetted tag instead,
and the settings make the launcher fail closed rather than fetch.

## Use

```
./build.sh
```

Needs git and a Rust toolchain (`cargo`). It clones tag `engine-v0.1.16` into
`~/.local/src/impeccable-engine-0.1.16`, refuses unless the checkout is the pinned
commit, builds with `cargo build --release --locked`, runs the engine's self-probe,
and installs `~/.local/bin/impeccable-engine`. Re-running is safe: a finished build is
reused. Override the locations with `IMPECCABLE_SRC` and `IMPECCABLE_BIN_DIR`.

Then in `~/.claude/settings.json`:

```json
"env": {
  "IMPECCABLE_BIN": "/home/<you>/.local/bin/impeccable-engine",
  "IMPECCABLE_DOWNLOAD_BASE": "https://download-blocked.invalid",
  "IMPECCABLE_NO_TELEMETRY": "1",
  "IMPECCABLE_NO_UPDATE_CHECK": "1"
}
```

`IMPECCABLE_BIN` must be an absolute path (settings do not expand `~`). The download
base points at a reserved `.invalid` name, so a missing engine is an error, never a
silent download. The script also writes `~/.impeccable/config.json` with telemetry off.

## Updating

When a plugin update wants a new engine (its `skills/impeccable/scripts/VERSION`):

1. Read the new tag's changes; check for a `build.rs`, git or path dependencies, and
   that `Cargo.lock` is committed.
2. Set `VERSION`, `COMMIT` (the tag's commit) and `RECORDED_SHA256` (after the
   first build) in `build.sh`.
3. Run `./build.sh` and confirm `impeccable-engine --version`.

## Vetting record (engine-v0.1.16, 2026-10-22)

Commit 24bdeb77. No `build.rs`; 193 crates.io dependencies only; `Cargo.lock`
honoured with `--locked`. This removes the tampered-download risk, not a malicious
author: it is a targeted check, not a full audit.
