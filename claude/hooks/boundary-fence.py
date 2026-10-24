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

Every fence from the file up to the repo root applies. An empty or missing
`allow` means no restriction (deny still applies). A malformed fence, or any
error in this hook, asks instead of failing open.
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


def find_fences(target: Path) -> list[Path]:
    """Every fenced directory from the target up to its repo root, nearest first.
    All of them apply: a fence nested inside an allowed area cannot cancel an
    outer deny."""
    fences = []
    for parent in target.parents:
        if (parent / FENCE).is_file():
            fences.append(parent)
        if (parent / ".git").exists():
            break
    return fences


def load(root: Path) -> tuple[list[str], list[str], str]:
    fence = json.loads((root / FENCE).read_text())
    if not isinstance(fence, dict):
        raise ValueError("not a JSON object")
    allow, deny = fence.get("allow", []), fence.get("deny", [])
    for name, globs in (("allow", allow), ("deny", deny)):
        if not isinstance(globs, list) or not all(isinstance(g, str) and g for g in globs):
            raise ValueError(f"{name} must be a list of non-empty glob strings")
    return allow, deny, str(fence.get("why", "no reason recorded"))


def check(payload: dict) -> None:
    if payload.get("tool_name") not in WRITERS:
        return
    args = payload.get("tool_input") or {}
    path = args.get("file_path") or args.get("notebook_path")
    if not path:
        return
    target = Path(os.path.realpath(os.path.join(payload.get("cwd") or ".", os.path.expanduser(path))))
    if target.name == FENCE.name and target.parent.name == FENCE.parent.name:
        ask(f"This edits a declared work boundary ({target}). Moving a fence needs the owner's yes.")
    for root in find_fences(target):
        rel = PurePosixPath(target.relative_to(root).as_posix())
        try:
            allow, deny, why = load(root)
        except (OSError, ValueError) as exc:
            ask(f"The work boundary {root / FENCE} is unreadable or malformed ({exc}); "
                f"confirm this edit to {rel}.")
        # An empty or missing allow list means no restriction; deny still applies.
        if (allow and not any(rel.full_match(g) for g in allow)) or any(rel.full_match(g) for g in deny):
            ask(f"{rel} is outside the declared work boundary ({why}; {root / FENCE}). "
                "Crossing it needs a fresh yes from the owner.")


def main() -> None:
    try:
        check(json.load(sys.stdin))
    except SystemExit:
        raise
    except Exception as exc:  # a crashed hook lets the edit through, so ask instead
        ask(f"boundary-fence could not check this edit ({type(exc).__name__}: {exc}); confirm it.")


# (expected, tool, path) against a fence of allow mobile/**, deny mobile/vendor/**.
SELFTEST = [
    ("pass", "Write", "mobile/src/a.ts"),
    ("ask", "Write", "web/index.ts"),
    ("ask", "Edit", "README.md"),
    ("ask", "Write", "mobile/vendor/x.js"),
    ("ask", "Edit", ".claude/fence.json"),
    ("pass", "Read", "web/index.ts"),
    ("pass", "Write", "/tmp/outside-any-repo.txt"),
    ("ask", "Write", "mobile/.claude/fence.json"),
    ("ask", "Write", "mobile/vendor/y.js"),   # with the nested fence below in place
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
        # A nested, permissive fence inside the allowed area must not cancel the outer deny.
        Path(repo, "mobile/.claude").mkdir(parents=True)
        Path(repo, "mobile/.claude/fence.json").write_text("{}")
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
