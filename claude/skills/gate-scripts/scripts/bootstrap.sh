#!/usr/bin/env bash
# bootstrap — install the gates into a project, in one command.
#
# A skill that says "copy these files and wire them up" relies on five manual
# steps going right. This does them, reports what it changed, and is safe to
# re-run: existing scripts are left alone unless --force.
#
#   bash ~/.claude/skills/gate-scripts/scripts/bootstrap.sh [--force] [srcdir]
#
# After it runs: `npm run verify`. The GLOBAL pre-commit hook then enforces that
# chain on every commit in this repo automatically — nothing further to wire.
set -euo pipefail

FORCE=0
SRCDIR="src"
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) SRCDIR="$arg" ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

[ -f package.json ] || { echo "no package.json in $ROOT — this installer is for Node projects"; exit 1; }
[ -d "$SRCDIR" ] || { echo "no $SRCDIR/ directory — pass the source dir as an argument"; exit 1; }

mkdir -p scripts scripts/hooks .claude

copied=()
for f in hardcode-check.mjs i18n-check.mjs rtl-check.mjs design-check.mjs font-check.mjs convention-check.mjs; do
  if [ -f "scripts/$f" ] && [ $FORCE -eq 0 ]; then continue; fi
  cp "$HERE/$f" "scripts/$f"
  copied+=("$f")
done
if [ ! -f scripts/hooks/pre-commit-gate.sh ] || [ $FORCE -eq 1 ]; then
  cp "$HERE/pre-commit-gate.sh" scripts/hooks/pre-commit-gate.sh
  chmod +x scripts/hooks/pre-commit-gate.sh
  copied+=("hooks/pre-commit-gate.sh")
fi

# A conventions file so the rule-shaped findings have somewhere to go on day one.
if [ ! -f .claude/conventions.json ]; then
  cat > .claude/conventions.json <<'JSON'
{
  "_comment": "Rules the compiler cannot enforce. kind: 'call-arity' | 'pattern'. Each rule carries its own why/fix so a failure explains itself. See the gate-scripts skill.",
  "dirs": ["src"],
  "rules": []
}
JSON
  copied+=(".claude/conventions.json")
fi

# Wire package.json — additively, never clobbering an existing verify chain.
node - "$SRCDIR" <<'NODE'
const fs = require('fs');
const src = process.argv[2];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts ??= {};
const add = {
  'i18n:check': 'node scripts/i18n-check.mjs',
  'hardcode:check': `node scripts/hardcode-check.mjs ${src}`,
  'rtl:check': `node scripts/rtl-check.mjs ${src}`,
  'design:check': 'node scripts/design-check.mjs',
  'font:check': 'node scripts/font-check.mjs',
  'convention:check': 'node scripts/convention-check.mjs',
};
const added = [];
for (const [k, v] of Object.entries(add)) {
  if (!pkg.scripts[k]) { pkg.scripts[k] = v; added.push(k); }
}
if (!pkg.scripts.verify) {
  // Only the checks that exist here; typecheck/lint are the project's own call.
  pkg.scripts.verify = Object.keys(add).map((k) => `npm run ${k}`).join(' && ');
  added.push('verify');
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(added.length ? `package.json: added ${added.join(', ')}` : 'package.json: already wired');
NODE

echo
if [ ${#copied[@]} -eq 0 ]; then
  echo "scripts: already present (use --force to overwrite)"
else
  printf 'scripts: installed %s\n' "${copied[*]}"
fi

cat <<'NEXT'

NEXT — in this order, because the first run of a gate on an existing codebase
almost always finds a backlog:

  1. npm run verify
  2. For a class too large to fix today, BASELINE it (design-check writes
     .claude/design-baseline.json; hardcode-check carries a legacy list) and
     make anything NEW fail. For a class small enough to fix today, fix it —
     a zero baseline needs no file and nobody memorises numbers.
  3. PROVE one gate: re-inject a violation it should catch, watch it fail,
     revert. A gate nobody has seen fail is a gate nobody knows works.

The global pre-commit hook picks this up automatically — it runs
scripts/hooks/pre-commit-gate.sh, or `npm run verify`, before every commit here.
NEXT
