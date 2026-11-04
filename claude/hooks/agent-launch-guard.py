#!/usr/bin/env python3
"""Agent launch guard: an agent's shell may not start Codex, or Claude headless, by hand.

The owner's rules reached OpenAI because an agent ran an ad-hoc Codex probe: ~/.codex/AGENTS.md told
it to read them and an approve-all script let it. Deliberate routes keep working: `cross-review` and
`agent-check` jail Codex, a project's `npm run` is that project's own, and information commands are
harmless. The owner's own `! codex ...` never passes through this hook.

Not airtight: it reads the command line and one level of script, so a launch hidden deeper is not
seen. It catches the mistake, not an adversary. A parse failure or hook error denies.
Disable: remove its PreToolUse entry from ~/.claude/settings.json.
"""
import json
import os
import re
import shlex
import sys

AGENTS = {"codex", "claude"}
WRAPPERS = {"env", "nohup", "timeout", "exec", "command", "time", "nice", "ionice", "setsid", "stdbuf", "sudo",
            "npx", "pnpx", "bunx", "agent-scope", "run", "systemd-run", "xargs", "unbuffer", "script"}
INFO = {"--version", "-v", "-V", "--help", "-h", "help", "mcp", "login", "logout", "doctor", "completion", "completions"}
INTERPRETERS = {"node", "bun", "deno", "tsx", "ts-node", "python", "python3", "bash", "sh", "zsh"}
# A launch, not a mention: the agent quoted as a program, or named with a running subcommand.
STARTS = re.compile(r"""(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|run|Popen|call|check_output|check_call|system)\s*\(\s*\[?\s*f?['"`](?:\S*/)?(?:codex|claude)\b|^\s*(?:\S*/)?codex\s+(?:exec|app-server|review)\b|^\s*(?:\S*/)?claude\s+(?:-p|--print)\b""", re.M)
SEPARATORS = {";", "&&", "||", "|", "&", "|&", "(", ")", "{", "}", "\n"}
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?^\s*\2[ \t]*$", re.S | re.M)
FALLBACK = re.compile(r"(?:^|[;&|(]\s*)(?:\S*/)?codex\s+(?!--version|--help|-h\b|-v\b|help\b|mcp\b|login\b|logout\b)|(?:^|[;&|(]\s*)(?:\S*/)?claude\s[^\n]*(?:\s-p\b|--print\b)", re.M)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
    sys.exit(0)


MESSAGE = ("Starting {agent} by hand is blocked: an unsandboxed session reads the owner's rules and sends them "
           "to its provider. Use cross-review, agent-check or the project's sandboxed runner, or ask the owner to run it with `!`.")


def segments(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    current = []
    for token in lexer:
        if token.strip() == "" or set(token) <= set(";&|()\n") or token in SEPARATORS:
            if current:
                yield current
            current = []
        elif "\n" in token:
            for part in token.split("\n"):
                if part:
                    current.append(part)
                yield current
                current = []
        else:
            current.append(token)
    if current:
        yield current


def program(words):
    """The word in command position, past assignments and wrappers and their options."""
    index = 0
    while index < len(words):
        word = words[index]
        name = os.path.basename(word)
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", word) or word.startswith("-"):
            index += 1
        elif name in WRAPPERS:
            index += 1
            if name == "timeout" and index < len(words) and not words[index].startswith("-"):
                index += 1
        elif index > 0 and re.fullmatch(r"[0-9.]+[smhd]?", word):
            index += 1
        else:
            return name, words[index + 1:]
    return None, []


def starts_agent(text):
    return bool(STARTS.search(text))


def check(words):
    name, rest = program(words)
    if name == "codex":
        if not rest or rest[0] not in INFO:
            deny(MESSAGE.format(agent="Codex"))
    elif name == "claude":
        if any(word in ("-p", "--print") or word.startswith("--output-format") for word in rest):
            deny(MESSAGE.format(agent="Claude headless"))
    elif name in INTERPRETERS:
        for index, word in enumerate(rest):
            if word in ("-e", "-c", "--eval", "-p") and index + 1 < len(rest) and starts_agent(f" {rest[index + 1]} "):
                deny(MESSAGE.format(agent="an agent from inline code"))
            if not word.startswith("-") and os.path.isfile(word):
                # The owner's own tools sandbox what they start, and test files only use fakes.
                real = os.path.realpath(word)
                if real.startswith(os.path.expanduser("~/.claude/skills/")) or "/tests/" in real or ".test." in real:
                    break
                with open(word, errors="replace") as handle:
                    if starts_agent(handle.read(1_000_000)):
                        deny(MESSAGE.format(agent=f"an agent from {word}"))
                break


def main():
    payload = json.load(sys.stdin)
    command = HEREDOC.sub("", payload.get("tool_input", {}).get("command", ""))
    try:
        parsed = list(segments(command))
    except ValueError:
        # Unbalanced quotes are ordinary in shell text. Judge each line by its command position.
        if FALLBACK.search(command):
            deny(MESSAGE.format(agent="an agent"))
        return
    for words in parsed:
        check(words)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        deny(f"agent-launch-guard could not read this command ({type(error).__name__}); split it into simpler commands.")
