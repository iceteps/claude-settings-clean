#!/usr/bin/env -S python3 -I
"""Agent launch guard: an agent's shell may not start Codex, or Claude headless, by hand.

The owner's rules reached OpenAI because an agent ran an ad-hoc Codex probe: ~/.codex/AGENTS.md told
it to read them and an approve-all script let it. Deliberate routes keep working: `cross-review` and
`agent-check` jail Codex, a project's `npm run` is that project's own, and information commands are
harmless. The owner's own `! codex ...` never passes through this hook.

It reads the command line, nested shell text (`bash -c`, `eval`, `env -S`, `$(...)`, backticks), one
variable assignment and one level of script. Not airtight: `./script` run directly, `find -exec`, an
unquoted heredoc's substitutions and a name built at run time are not seen. It catches the mistake,
not an adversary. A parse failure or hook error denies.
Disable: remove its PreToolUse entry from ~/.claude/settings.json.
"""
import json
import os
import re
import shlex
import sys

AGENTS = {"codex", "claude"}
WRAPPERS = {"env", "nohup", "timeout", "exec", "command", "time", "nice", "ionice", "setsid", "stdbuf", "sudo",
            "npx", "pnpx", "bunx", "agent-scope", "run", "systemd-run", "xargs", "unbuffer", "script", "watch", "flock",
            "if", "then", "elif", "else", "while", "until", "do", "!"}
# Wrapper options that take a value, so the value is not mistaken for the program.
VALUE_OPTIONS = {
    "sudo": {"-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D", "-R", "--user", "--group", "--host", "--prompt", "--chdir"},
    "env": {"-u", "-C", "--unset", "--chdir"},
    "timeout": {"-k", "-s", "--kill-after", "--signal"},
    "nice": {"-n", "--adjustment"},
    "ionice": {"-c", "-n", "-p", "--class", "--classdata", "--pid"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "xargs": {"-I", "-L", "-P", "-a", "-d", "-E", "-n", "-s"},
    "systemd-run": {"-u", "-p", "-d", "--unit", "--property", "--working-directory", "--description", "--slice"},
    "npx": {"-p", "--package"},
    "watch": {"-n", "--interval"},
}
# Wrapper options whose value is itself shell text.
CODE_OPTIONS = {"env": {"-S", "--split-string"}, "script": {"-c", "--command"}, "npx": {"-c", "--call"}}
INFO = {"--version", "-v", "-V", "--help", "-h", "help", "mcp", "login", "logout", "doctor", "completion", "completions"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
INTERPRETERS = SHELLS | {"node", "bun", "deno", "tsx", "ts-node", "python", "python3", "source", "."}
SHELL_CODE_FLAG = re.compile(r"-[A-Za-z]*c[A-Za-z]*")
INLINE_CODE_FLAG = re.compile(r"-[A-Za-z]*[cep][A-Za-z]*|--eval|--print")
ASSIGNMENT = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)", re.S)
VARIABLE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
# A launch, not a mention: the agent quoted as a program, or named with a running subcommand.
STARTS = re.compile(r"""(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|run|Popen|call|check_output|check_call|system)\s*\(\s*\[?\s*f?['"`](?:\S*/)?(?:codex|claude)\b|^\s*(?:\S*/)?codex\s+(?:exec|app-server|review)\b|^\s*(?:\S*/)?claude\s+(?:-p|--print)\b""", re.M)
SEPARATORS = {"{", "}"}
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?^\s*\2[ \t]*$", re.S | re.M)
FALLBACK = re.compile(r"(?:^|[;&|(]\s*)(?:\S*/)?codex\s+(?!--version|--help|-h\b|-v\b|help\b|mcp\b|login\b|logout\b)|(?:^|[;&|(]\s*)(?:\S*/)?claude\s[^\n]*(?:\s-p\b|--print\b)", re.M)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
    sys.exit(0)


MESSAGE = ("Starting {agent} by hand is blocked: an unsandboxed session reads the owner's rules and sends them "
           "to its provider. Use cross-review, agent-check or the project's sandboxed runner, or ask the owner to run it with `!`.")


def closing(command, start):
    """Where the $( opened just before start closes, or the end of the text."""
    depth = 1
    for index in range(start, len(command)):
        depth += {"(": 1, ")": -1}.get(command[index], 0)
        if depth == 0:
            return index
    return len(command)


def flatten(command):
    """Return the text with unquoted line ends as `;`, comments dropped and substitutions as `_`, plus the code lifted out.

    Single quotes protect a substitution; double quotes do not, because the shell still runs it.
    """
    out, lifted = [], []
    index, quote = 0, None
    while index < len(command):
        char = command[index]
        pair = command[index:index + 2]
        if quote == "'":
            quote = None if char == "'" else quote
        elif pair == "\\\n":
            out.append(" ")
            index += 2
            continue
        elif char == "\\":
            out.append(pair)
            index += 2
            continue
        elif char == '"':
            quote = None if quote else '"'
        elif char == "'" and not quote:
            quote = "'"
        elif pair == "$(":
            end = closing(command, index + 2)
            lifted.append(command[index + 2:end])
            out.append("_")
            index = end + 1
            continue
        elif char == "`":
            found = re.compile(r"(?<!\\)`").search(command, index + 1)
            end = found.start() if found else len(command)
            lifted.append(command[index + 1:end])
            out.append("_")
            index = end + 1
            continue
        elif not quote and char == "#" and (index == 0 or command[index - 1] in " \t\n;&|("):
            found = command.find("\n", index)
            index = found if found != -1 else len(command)
            continue
        elif not quote and char == "\n":
            char = ";"
        out.append(char)
        index += 1
    return "".join(out), lifted


def segments(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    current = []
    for token in lexer:
        if token in SEPARATORS or (token and set(token) <= set(";&|()")):
            if current:
                yield current
            current = []
        else:
            current.append(token)
    if current:
        yield current


def program(words):
    """The word in command position, past assignments and wrappers and their options."""
    index = 0
    wrapper = None
    while index < len(words):
        word = words[index]
        name = os.path.basename(word)
        if ASSIGNMENT.fullmatch(word):
            index += 1
        elif word.startswith("-"):
            if word in CODE_OPTIONS.get(wrapper, ()):
                if index + 1 < len(words):
                    judge(words[index + 1])
                index += 2
            else:
                index += 2 if word in VALUE_OPTIONS.get(wrapper, ()) else 1
        elif name in WRAPPERS:
            wrapper = name
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
    if name == "eval":
        judge(" ".join(rest))
    elif name == "codex":
        if not rest or rest[0] not in INFO:
            deny(MESSAGE.format(agent="Codex"))
    elif name == "claude":
        if any(word == "--print" or re.fullmatch(r"-[A-Za-z]*p[A-Za-z]*", word) or word.startswith("--output-format") for word in rest):
            deny(MESSAGE.format(agent="Claude headless"))
    elif name in INTERPRETERS:
        for index, word in enumerate(rest):
            code = rest[index + 1] if index + 1 < len(rest) else None
            if name in SHELLS and code is not None and SHELL_CODE_FLAG.fullmatch(word):
                judge(code)
                break
            if code is not None and INLINE_CODE_FLAG.fullmatch(word) and starts_agent(f" {code} "):
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


def expand(word, variables):
    match = VARIABLE.fullmatch(word)
    return variables[match[1]].split() if match and match[1] in variables else [word]


def judge(command):
    """Deny if this shell text starts an agent, at any depth of substitution or nested shell."""
    text = HEREDOC.sub("", command)
    flat, lifted = flatten(text)
    for code in lifted:
        judge(code)
    try:
        parsed = list(segments(flat))
    except ValueError:
        # Unbalanced quotes are ordinary in shell text. Judge each line by its command position.
        if FALLBACK.search(text):
            deny(MESSAGE.format(agent="an agent"))
        return
    variables = {}
    for words in parsed:
        for word in words:
            match = ASSIGNMENT.fullmatch(word)
            if match:
                variables[match[1]] = match[2]
        check([part for word in words for part in expand(word, variables)])


def main():
    payload = json.load(sys.stdin)
    judge(payload.get("tool_input", {}).get("command", ""))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        deny(f"agent-launch-guard could not read this command ({type(error).__name__}); split it into simpler commands.")
