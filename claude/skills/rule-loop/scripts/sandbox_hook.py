#!/usr/bin/env python3
"""PreToolUse hook for comply's subject runs: the fence for the tools the OS
sandbox does not cover.

Bash is contained by Claude Code's own sandbox (bubblewrap), which comply turns
on for every session: writes only inside the session's work and temp
directories, no network, no unsandboxed escape. Parsing shell in this hook was
tried first and lost to a dozen bypasses (comments, $VAR, brace expansion,
symlinks, git options), so this hook no longer judges shell at all.

What it does fence:
  - Write/Edit/MultiEdit/NotebookEdit: only inside $COMPLY_SANDBOX, never in its
    .git or .claude (repo config and project settings could widen the fence)
  - Read: anywhere a real session would read, except secrets (SECRET_PATHS,
    any .env file, /proc)
  - Glob/Grep: inside the sandbox or ~/.claude only; never over a
    directory that holds a secret or a symlink leading out of the sandbox
  - Bash: allowed only when it stays sandboxed (dangerouslyDisableSandbox refused)
  - anything else (web, MCP, agents): refused
A refused call still appears in the transcript, which is all comply needs to
score it. An allowed call is approved explicitly; a headless run cannot ask.
"""
import json
import os
import sys

HOME = os.path.expanduser("~")

# Never readable from a compliance session, by any tool. comply passes the same
# list to the OS sandbox as denyRead, so Bash cannot read them either.
SECRET_PATHS = [
    ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".netrc", ".git-credentials",
    ".npmrc", ".pypirc", ".terraform.d", ".password-store", ".local/share/keyrings",
    ".bash_history", ".zsh_history", ".local/share/fish", ".python_history",
    ".claude/.credentials.json", ".claude.json", ".claude/daemon", ".claude/sessions",
    ".codex/auth.json", ".config/gh", ".config/rclone", ".config/op",
    ".config/chromium", ".config/BraveSoftware", ".config/google-chrome", ".mozilla",
    # Project trees hold .env files with live keys; no spec needs them.
    "Projects", "Work",
    # Session transcripts and state hold copies of whatever past sessions read,
    # .env contents included. Memory loads in-process, not through a tool.
    ".claude/projects", ".claude/history.jsonl", ".claude/state", ".claude/file-history",
    ".claude/paste-cache", ".claude/shell-snapshots", ".codex/sessions", ".codex/history.jsonl",
]
# Anywhere on disk: environment files and process state.
SECRET_NAMES = (".env",)
# /proc: process state and environments. /tmp/claude-<uid>: other live
# sessions' scratch and task output.
SECRET_ROOTS = ("/proc", f"/tmp/claude-{os.getuid()}")
# Outside the sandbox, Glob and Grep may only search where a real session
# looks for its own context. Read stays broad; searches are how a model
# sweeps a tree it was never pointed at.
# Not notes or vault trees: they may hold secrets nobody has scrubbed.
SEARCH_ROOTS = [os.path.join(HOME, ".claude")]


def local_secret_paths():
    """Extra HOME-relative paths from local/secret-paths.txt (machine-specific, not shared)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "local", "secret-paths.txt")
    try:
        with open(path, encoding="utf-8") as f:
            return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    except OSError:
        return []


SECRETS = [os.path.join(HOME, p) for p in SECRET_PATHS + local_secret_paths()]

PASSIVE = {"Skill", "ToolSearch", "TodoWrite"}
SEARCHERS = {"Glob", "Grep"}
WRITERS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def allow() -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": "allow"}}))
    sys.exit(0)


def refuse(tool: str, why: str) -> None:
    print(f"comply sandbox: {tool} refused ({why}). It was recorded, not run; "
          "do not retry it.", file=sys.stderr)
    sys.exit(2)


def resolve(path: str, cwd: str) -> str:
    return os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))


def under(path: str, root: str) -> bool:
    return os.path.commonpath([path, root]) == root


def secret(path: str) -> bool:
    return (any(under(path, s) for s in SECRETS)
            or os.path.basename(path).startswith(SECRET_NAMES)
            or any(under(path, r) for r in SECRET_ROOTS))


def links_out(target: str, root: str, depth: int = 6) -> bool:
    """A symlink made inside the sandbox (ln -s ~ h) would let a search over
    the sandbox reach anything, so a search fails if any link under it leaves
    the sandbox. A throwaway box has no legitimate link out."""
    if not under(target, root):
        return False
    stack = [(target, 0)]
    while stack:
        here, level = stack.pop()
        try:
            entries = list(os.scandir(here))
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink() and not under(os.path.realpath(entry.path), root):
                return True
            if entry.is_dir(follow_symlinks=False):
                if level >= depth:
                    return True  # too deep to check: fail closed
                stack.append((entry.path, level + 1))
    return False


def main() -> None:
    root = os.path.realpath(os.environ.get("COMPLY_SANDBOX", "/nonexistent"))
    payload = json.load(sys.stdin)
    tool = payload.get("tool_name", "")
    args = payload.get("tool_input") or {}
    cwd = payload.get("cwd") or root
    if not os.path.isdir(root):
        refuse(tool, "no sandbox set")
    if tool in PASSIVE:
        allow()
    if tool == "Read" or tool in SEARCHERS:
        pattern = str(args.get("pattern", "")) if tool == "Glob" else ""
        if pattern.startswith(("/", "~")) or ".." in pattern:
            refuse(tool, "a glob pattern must be relative to its path")
        target = resolve(args.get("file_path") or args.get("path") or cwd, cwd)
        if secret(target):
            refuse(tool, "a credential or off-limits path")
        if tool in SEARCHERS:
            if not under(target, root) and not any(under(target, r) for r in SEARCH_ROOTS):
                refuse(tool, "searches outside the sandbox are limited to ~/.claude and the vault")
            if any(under(s, target) for s in SECRETS) or links_out(target, root):
                refuse(tool, "the search would cover a secret, or follow a link out of the sandbox")
        allow()
    if tool in WRITERS:
        path = args.get("file_path") or args.get("notebook_path")
        if not path:
            refuse(tool, "no path given")
        target = resolve(path, cwd)
        if not under(target, root):
            refuse(tool, "path outside the sandbox")
        if under(target, os.path.join(root, ".git")) or under(target, os.path.join(root, ".claude")):
            refuse(tool, "the sandbox's .git or .claude directory (config that could widen the fence)")
        allow()
    if tool == "Bash":
        if args.get("dangerouslyDisableSandbox"):
            refuse(tool, "commands must stay in the OS sandbox")
        allow()
    refuse(tool, "not available in a compliance run")


if __name__ == "__main__":
    main()
