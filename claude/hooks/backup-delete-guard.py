#!/usr/bin/env python3
"""Backup delete guard: an agent may not delete a backup without proof that another copy exists.

Owner directive 2026-11-05, after backups were deleted first and their copies checked afterwards.
Deleting a backup-looking path by shell is denied; `backup-retire` runs the proof, then deletes.
The owner's own `! rm ...` never passes through this hook.

Not airtight: it reads the command line and simple VAR=value assignments, so a deletion inside a
script or a Python call is not seen. It catches the mistake, not an adversary.
Disable: remove its PreToolUse entry from ~/.claude/settings.json.
"""
import json
import re
import shlex
import sys

DELETERS = {"rm", "unlink", "shred", "trash", "trash-put", "gio"}
WRAPPERS = {"env", "command", "exec", "nice", "ionice", "time", "timeout", "sudo", "xargs"}
BACKUP = re.compile(r"(\.bak(\b|[.\-_])|\.orig$|\.old$|~$|(^|/)snapshots?(/|$)|(^|/)[^/]*backups?[^/]*(/|$))", re.I)
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?^\s*\2[ \t]*$", re.S | re.M)
ASSIGNMENT = re.compile(r"(?:^|[\s;&|(])([A-Za-z_]\w*)=(\"[^\"]*\"|'[^']*'|[^\s;&|)]+)")
VARIABLE = re.compile(r"\$\{?([A-Za-z_]\w*)\}?")
MESSAGE = ("Deleting a backup by shell is blocked: {path}. Prove another copy first, with "
           "`backup-retire PATH --in REPO`, `--same-as COPY`, or, only if the owner approved losing it, "
           "`--discard \"reason\"`. It deletes nothing unless every file is proven.")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
    sys.exit(0)


def segments(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    current = []
    for token in lexer:
        if set(token) <= set(";&|()"):
            yield current
            current = []
            continue
        parts = token.split("\n")
        for index, part in enumerate(parts):
            if index:
                yield current
                current = []
            if part:
                current.append(part)
    yield current


def deletes_backup(words, variables):
    words = [VARIABLE.sub(lambda m: variables.get(m.group(1), m.group(0)), w) for w in words]
    while words and (words[0] in WRAPPERS or "=" in words[0].split("/")[0]):
        words = words[1:]
    if not words:
        return None
    program = words[0].rsplit("/", 1)[-1]
    is_find = program == "find" and ("-delete" in words or "rm" in words)
    if program not in DELETERS and not is_find:
        return None
    for word in words[1:]:
        if not word.startswith("-") and BACKUP.search(word.rstrip("/*") if not word.endswith("~") else word):
            return word
    return None


def main():
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")
    command = HEREDOC.sub("", command)
    variables = {name: value.strip("\"'") for name, value in ASSIGNMENT.findall(command)}
    for _ in range(3):
        variables = {k: VARIABLE.sub(lambda m: variables.get(m.group(1), m.group(0)), v) for k, v in variables.items()}
    try:
        parts = list(segments(command))
    except ValueError:
        parts = [line.split() for line in command.splitlines()]
    for words in parts:
        path = deletes_backup(words, variables)
        if path:
            deny(MESSAGE.format(path=path))
    sys.exit(0)


if __name__ == "__main__":
    main()
