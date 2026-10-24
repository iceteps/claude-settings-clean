#!/bin/sh
# build.sh — rebuild the impeccable plugin's native engine from vetted source.
#
# The impeccable Claude Code plugin needs a native engine its launcher would
# otherwise DOWNLOAD as a prebuilt binary. This builds it from a pinned,
# vetted tag instead and installs it where settings.json's IMPECCABLE_BIN
# points, so the launcher never fetches anything.
#
#   ./build.sh              clone (if missing), verify the pin, build, install
#
# Idempotent: a finished build is reused; the install step always re-runs.
# A new plugin release that wants a new engine version: vet the new tag, then
# bump VERSION and COMMIT below (see README.md "Updating").
set -eu

VERSION=0.1.16
TAG="engine-v$VERSION"
COMMIT=24bdeb776a66a3c36d493072a04541287a327408
REPO=https://github.com/pbakaus/impeccable.git
# sha256 of the 2026-10-22 build on the original machine. Rust builds are not
# guaranteed bit-identical across toolchains, so a mismatch is reported, not
# fatal: the trust anchor is the commit pin plus --locked.
RECORDED_SHA256=195cbb26cb2084610595ddc4c5b05469dc09db64d541b46a7e3d66825e335752

SRC="${IMPECCABLE_SRC:-$HOME/.local/src/impeccable-engine-$VERSION}"
BIN_DIR="${IMPECCABLE_BIN_DIR:-$HOME/.local/bin}"
done_marker="$SRC/.build-DONE-$COMMIT"

command -v cargo >/dev/null || { echo "needs a Rust toolchain (cargo)" >&2; exit 1; }

if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --depth 1 --branch "$TAG" "$REPO" "$SRC"
fi
head=$(git -C "$SRC" rev-parse HEAD)
[ "$head" = "$COMMIT" ] || {
  echo "REFUSING: $SRC is at $head, pinned commit is $COMMIT" >&2; exit 1; }

if [ ! -f "$done_marker" ]; then
  (cd "$SRC" && cargo build --release --locked -p impeccable)
  "$SRC/target/release/impeccable" engine-probe
  touch "$done_marker"
fi

mkdir -p "$BIN_DIR"
install -m 755 "$SRC/target/release/impeccable" "$BIN_DIR/impeccable-engine"

# The engine's own telemetry switch (the env flags in settings.json cover the launcher).
mkdir -p "$HOME/.impeccable"
[ -f "$HOME/.impeccable/config.json" ] || printf '{\n  "telemetry": false\n}\n' > "$HOME/.impeccable/config.json"

sum=$(sha256sum "$BIN_DIR/impeccable-engine" | cut -d' ' -f1)
echo "installed $BIN_DIR/impeccable-engine ($("$BIN_DIR/impeccable-engine" --version))"
if [ "$sum" = "$RECORDED_SHA256" ]; then
  echo "sha256 matches the recorded build"
else
  echo "sha256 $sum differs from the recorded build (different toolchain?)"
fi
