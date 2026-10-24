#!/usr/bin/env bash
# Status line: model | context used | directory | git branch.
# Context falls back to a token count when the harness sends no percentage.
set -uo pipefail

input=$(cat)

model=$(jq -r '.model.display_name // "?"' <<<"$input")
dir=$(jq -r '.workspace.current_dir // .cwd // ""' <<<"$input")
pct=$(jq -r '.context_window.used_percentage // empty' <<<"$input")
size=$(jq -r '.context_window.context_window_size // empty' <<<"$input")
used=$(jq -r '(.context_window.current_usage // {})
  | ((.input_tokens // 0) + (.cache_creation_input_tokens // 0)
     + (.cache_read_input_tokens // 0)) | select(. > 0)' <<<"$input")

ctx=""
if [ -n "$pct" ]; then
  ctx="ctx ${pct%.*}%"
elif [ -n "$used" ] && [ -n "$size" ]; then
  ctx="ctx $((used * 100 / size))%"
fi

branch=""
if [ -n "$dir" ]; then
  branch=$(git -C "$dir" branch --show-current 2>/dev/null)
fi

out="$model"
[ -n "$ctx" ] && out="$out | $ctx"
[ -n "$dir" ] && out="$out | ${dir/#$HOME/\~}"
[ -n "$branch" ] && out="$out | $branch"
printf '%s' "$out"
