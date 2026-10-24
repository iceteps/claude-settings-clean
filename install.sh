#!/usr/bin/env bash
# install.sh — install this Claude Code / Codex configuration.
#
#   ./install.sh           show what would change (dry run)
#   ./install.sh --apply   copy claude/ -> ~/.claude and codex/ -> ~/.codex
#
# Existing files that differ are kept as <file>.pre-install-<date>. Nothing
# in the target is deleted.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

stamp=$(date +%Y%m%d-%H%M%S)
flags=(-rlpt --itemize-changes --backup --suffix=".pre-install-$stamp")
[ "${1:-}" = "--apply" ] || flags+=(--dry-run)

mkdir -p "$HOME/.claude" "$HOME/.codex"
rsync "${flags[@]}" claude/ "$HOME/.claude/"
rsync "${flags[@]}" codex/ "$HOME/.codex/"

[ "${1:-}" = "--apply" ] && echo "installed; restart Claude Code" ||
  echo "dry run only; re-run with --apply"
