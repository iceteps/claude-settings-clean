#!/usr/bin/env python3
"""Boundary fence — the "stay inside the declared boundary" rule (CLAUDE.md,
Doing the work), enforced instead of remembered.

When the owner fences the work ("we dont touch the web at all", "only mobile
files"), the agent writes the fence into the project as .claude/fence.json:

    {"allow": ["mobile/**"], "deny": ["mobile/vendor/**"],
     "why": "mobile app only; web is Niv's", "declared": "2026-08-30"}

Before any Write/Edit/MultiEdit/NotebookEdit, this finds the nearest fence above
the target file. An edit outside `allow`, inside `deny`, or to the fence itself
is not refused: it is put to the owner as a question ("ask"), because the rule is
that crossing the fence needs a fresh yes, not that it can never happen.

Not covered: files written through Bash. No fence file means no fence.
Reads only the tool input and the fence file, so it is safe in comply sessions.
Disable: remove its PreToolUse entry from ~/.claude/settings.json.
"""
import json
import os
import sys
from pathlib import Path, PurePosixPath

WRITERS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
FENCE = Path(".claude/fence.json")


def ask(reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "ask",
        "permissionDecisionReason": reason}}))
    sys.exit(0)


def find_fence(target: Path) -> Path | None:
    for parent in target.parents:
        if (parent / FENCE).is_file():
            return parent
        if (parent / ".git").exists():
            return None  # the repo root has no fence
    return None


def matches(rel: PurePosixPath, globs: list[str]) -> bool:
    return any(rel.full_match(g) for g in globs)


def main() -> None:
    payload = json.load(sys.stdin)
    if payload.get("tool_name") not in WRITERS:
        return
    args = payload.get("tool_input") or {}
    path = args.get("file_path") or args.get("notebook_path")
    if not path:
        return
    target = Path(os.path.realpath(os.path.join(payload.get("cwd") or ".", os.path.expanduser(path))))
    root = find_fence(target)
    if root is None:
        return
    rel = PurePosixPath(target.relative_to(root).as_posix())
    if rel == PurePosixPath(FENCE.as_posix()):
        ask(f"This edits the declared work boundary itself ({root / FENCE}). Moving the fence needs the owner's yes.")
    try:
        fence = json.loads((root / FENCE).read_text())
        allow, deny = fence.get("allow", []), fence.get("deny", [])
    except (OSError, json.JSONDecodeError, AttributeError) as exc:
        ask(f"The work boundary {root / FENCE} is unreadable ({exc}); confirm this edit to {rel}.")
    why = fence.get("why", "no reason recorded")
    if (allow and not matches(rel, allow)) or matches(rel, deny):
        ask(f"{rel} is outside the declared work boundary ({why}; {root / FENCE}). "
            "Crossing it needs a fresh yes from the owner.")


# (expected, tool, path) against a fence of allow mobile/**, deny mobile/vendor/**.
SELFTEST = [
    ("pass", "Write", "mobile/src/a.ts"),
    ("ask", "Write", "web/index.ts"),
    ("ask", "Edit", "README.md"),
    ("ask", "Write", "mobile/vendor/x.js"),
    ("ask", "Edit", ".claude/fence.json"),
    ("pass", "Read", "web/index.ts"),
    ("pass", "Write", "/tmp/outside-any-repo.txt"),
]


def selftest() -> None:
    import io
    import tempfile
    from contextlib import redirect_stdout
    bad = 0
    with tempfile.TemporaryDirectory() as repo:
        Path(repo, ".git").mkdir()
        Path(repo, ".claude").mkdir()
        Path(repo, FENCE).write_text(json.dumps({"allow": ["mobile/**"], "deny": ["mobile/vendor/**"]}))
        for want, tool, path in SELFTEST:
            sys.stdin = io.StringIO(json.dumps({"tool_name": tool, "tool_input": {"file_path": path}, "cwd": repo}))
            out = io.StringIO()
            with redirect_stdout(out):
                try:
                    main()
                except SystemExit:
                    pass
            got = "ask" if out.getvalue() else "pass"
            bad += got != want
            if got != want:
                print(f"FAIL  want {want}, got {got}: {tool} {path}")
    print(f"boundary-fence selftest: {len(SELFTEST) - bad}/{len(SELFTEST)}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main()
