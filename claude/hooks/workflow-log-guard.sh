#!/usr/bin/env bash
# WORKFLOW_LOG guard — the logs are append-only, so a Write (full overwrite) to an
# EXISTING WORKFLOW_LOG.md is blocked. Creating a new one is allowed; appends go
# through `cat >>` or Edit. Bound by the WORKFLOW_LOG rule in ~/.claude/CLAUDE.md.
set -uo pipefail

path=$(jq -r '.tool_input.file_path // empty')

[ "$(basename -- "$path")" = "WORKFLOW_LOG.md" ] || exit 0
[ -e "$path" ] || exit 0

echo "WORKFLOW_LOG.md is append-only: append with \`cat >> $path\` or Edit, never Write." >&2
exit 2
