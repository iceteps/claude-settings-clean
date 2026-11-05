#!/usr/bin/env -S python3 -I
"""Agent launch guard: an agent's shell may not start Codex, or Claude headless, by hand.

The owner's rules reached OpenAI because an agent ran an ad-hoc Codex probe: ~/.codex/AGENTS.md told
it to read them and an approve-all script let it. Deliberate routes keep working: `cross-review` and
`agent-check` jail Codex, a project's `npm run` is that project's own, and information commands are
harmless. The owner's own `! codex ...` never passes through this hook.

It reads the command line, nested shell text (`bash -c`, `eval`, `env -S`, `$(...)`, backticks, a
heredoc fed to a shell), one variable assignment and one level of script. Not airtight, and these are
examples, not a full list: `./script` run directly, `echo ... | bash`, `awk` and shell text inside
another language's strings, an unquoted heredoc's substitutions, a name built at run time. It catches
the mistake, not an adversary. A hook error denies; text the lexer cannot parse is judged line by line.
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
            "coproc", "busybox", "screen", "if", "then", "elif", "else", "while", "until", "do", "!"}
# Wrapper options that take a value, so the value is not mistaken for the program.
VALUE_OPTIONS = {
    "sudo": {"-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D", "-R", "--user", "--group", "--host", "--prompt", "--chdir"},
    "env": {"-u", "-C", "--unset", "--chdir"},
    "exec": {"-a"},
    "timeout": {"-k", "-s", "--kill-after", "--signal"},
    "time": {"-o", "-f", "--output", "--format"},
    "nice": {"-n", "--adjustment"},
    "ionice": {"-c", "-n", "-p", "--class", "--classdata", "--pid"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "xargs": {"-I", "-L", "-P", "-a", "-d", "-E", "-n", "-s"},
    "systemd-run": {"-u", "-p", "--unit", "--property", "--working-directory", "--description", "--slice"},
    "npx": {"-p", "--package"},
    "watch": {"-n", "--interval"},
    "screen": {"-S", "-c", "-X", "-p", "-t", "-T", "-e", "-h", "-Logfile"},
    "flock": {"-w", "-E", "--wait", "--timeout", "--conflict-exit-code"},
    # agent-scope run's own options; it limits resources and does not jail.
    "run": {"--name", "--mem", "--tasks"},
}
# Wrapper options whose value is itself shell text.
CODE_OPTIONS = {"env": {"-S", "--split-string"}, "script": {"-c", "--command"}, "flock": {"-c", "--command"},
                "npx": {"-c", "--call"}}
ATTACHED_SPLIT = re.compile(r"(?:-[i0v]*S|--split-string=)(.+)", re.S)
PACKAGE_RUNNERS = {"npx", "pnpx", "bunx"}
PACKAGE_TOOLS = {"npm", "pnpm", "yarn", "bun"}
PACKAGE_NAMES = {"claude-code": "claude"}
# Programs that run text they are handed, where a bare name is too often a mere argument.
HANDED_TEXT = {"tmux", "parallel", "trap", "find"}
TMUX_RUNS = {"new", "new-session", "neww", "new-window", "splitw", "split-window", "respawn-window", "respawn-pane", "send", "send-keys", "run", "run-shell"}
TMUX_VALUES = {"-s", "-n", "-c", "-t", "-x", "-y", "-e", "-F", "-l", "-f", "-L", "-S"}
INFO = {"--version", "-v", "-V", "--help", "-h", "help", "mcp", "login", "logout", "doctor", "completion", "completions"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
INTERPRETERS = SHELLS | {"node", "bun", "deno", "tsx", "ts-node", "python", "python3", "perl", "ruby", "source", "."}
SHELL_CODE_FLAG = re.compile(r"-[A-Za-z]*c[A-Za-z]*")
INLINE_CODE_FLAG = re.compile(r"-[A-Za-z]*[cep][A-Za-z]*|--eval|--print")
CLAUDE_PRINT_FLAG = re.compile(r"-[A-Za-z]*p[A-Za-z]*")
ASSIGNMENT = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)", re.S)
VARIABLE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
REDIRECT = re.compile(r"\d*[<>]+")
# A launch, not a mention: the agent quoted as a program, or named with a running subcommand.
STARTS = re.compile(r"""(?:spawn\w*|exec(?:[lv]p?e?|Sync|File|FileSync)?|fork|run|Popen|call|check_output|check_call|system)\s*\(\s*\[?\s*f?['"`](?:\S*/)?(?:codex|claude)\b|^\s*(?:[~./]\S*/)?codex\s+(?:exec|app-server|review)\b|^\s*(?:[~./]\S*/)?claude\s+(?:-p|--print)\b""", re.M)
SEPARATORS = {"{", "}"}
HEREDOC = re.compile(r"(?<!<)<<(?!<)-?\s*\\?(['\"]?)([\w.-]+)\1([^\n]*)\n(.*?)^\s*\2[ \t]*$", re.S | re.M)
STDIN_SHELL = re.compile(r"""(?:^|[;&|(\s"'])(?:\S*/)?(?:bash|sh|zsh|dash|ksh|fish)(?:\s+-\w*s\b.*|(?:\s+-(?![A-Za-z]*c)\S*)*)\s*$""")
OPENER_REDIRECT = re.compile(r"\d*[<>]+&?\s*\S+")
STDIN_INTERPRETER = re.compile(r"""(?:^|[;&|(\s"'])(?:\S*/)?(?:python3?(?:\.\d+)?|node|bun|deno(?:\s+run)?|perl|ruby)(?:\s+-\S+)*(?:\s+-(?:\s.*)?)?\s*$""")
FALLBACK = re.compile(r"(?:^|[;&|(]\s*)(?:\S*/)?codex\s+(?!--version|--help|-h\b|-v\b|help\b|mcp\b|login\b|logout\b)|(?:^|[;&|(]\s*)(?:\S*/)?claude\s[^\n]*(?:\s-p\b|--print\b)", re.M)
UNESCAPED_BACKTICK = re.compile(r"(?<!\\)`")
ANSI_QUOTE_END = re.compile(r"(?:[^'\\]|\\.)*'", re.S)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
    sys.exit(0)


MESSAGE = ("Starting {agent} by hand is blocked: an unsandboxed session reads the owner's rules and sends them "
           "to its provider. Use cross-review, agent-check or the project's sandboxed runner, or ask the owner to run it with `!`.")


def strip_heredocs(command):
    """Drop each heredoc body, keeping the rest of its opener line. A body fed to an interpreter is its script."""
    while True:
        match = HEREDOC.search(command)
        if not match:
            return command
        before = OPENER_REDIRECT.sub("", command[command.rfind("\n", 0, match.start()) + 1:match.start()])
        after = OPENER_REDIRECT.sub("", match[3])
        if STDIN_SHELL.search(before) or STDIN_SHELL.search(after):
            judge(match[4])
        elif (STDIN_INTERPRETER.search(before) or STDIN_INTERPRETER.search(after)) and starts_agent(match[4]):
            deny(MESSAGE.format(agent="an agent from a script on stdin"))
        command = command[:match.start()] + match[3] + command[match.end():]


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
            out.append("_" if pair[1:] in ("(", ")", ";", "|", "&") else pair)
            index += 2
            continue
        elif char == '"':
            quote = None if quote else '"'
        elif pair == "$'" and not quote:
            found = ANSI_QUOTE_END.match(command, index + 2)
            out.append("_")
            index = found.end() if found else len(command)
            continue
        elif char == "'" and not quote:
            quote = "'"
        elif pair == "$(":
            end = closing(command, index + 2)
            lifted.append(command[index + 2:end])
            out.append("_")
            index = end + 1
            continue
        elif char == "`":
            found = UNESCAPED_BACKTICK.search(command, index + 1)
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
    array = False
    for token in lexer:
        if array:
            array = ")" not in token
        elif token.startswith("(") and current and current[-1].endswith("="):
            array = True
        elif token in SEPARATORS or (token and set(token) <= set(";&|()")):
            # A bare agent name before `)` or `|` is a case label or a regex alternative, not a launch.
            if current and not (len(current) == 1 and current[0] in AGENTS and (token[0] == ")" or token == "|")):
                yield current
            current = []
        else:
            current.append(token)
    if current:
        yield current


def takes(table, wrapper, word):
    """Whether this option, alone or last in a cluster such as -qc, is listed for the wrapper."""
    options = table.get(wrapper, ())
    if word in options or word.startswith("--"):
        return word in options
    for position, letter in enumerate(word[1:], 1):
        if f"-{letter}" in options:
            return position == len(word) - 1
    return False


def program(words):
    """The word in command position, past assignments and wrappers and their options."""
    index = 0
    wrapper = None
    locked = False
    while index < len(words):
        word = words[index]
        name = os.path.basename(word)
        if wrapper == "command" and word in ("-v", "-V"):
            return None, []
        if ASSIGNMENT.fullmatch(word):
            index += 1
        elif REDIRECT.match(word):
            index += 2 if REDIRECT.fullmatch(word) else 1
        elif word.startswith("-"):
            attached = ATTACHED_SPLIT.fullmatch(word) if wrapper == "env" and len(word) > 2 and not word.endswith("S") else None
            if attached:
                judge(attached[1])
                return None, []
            if word.startswith("--") and "=" in word and word.split("=", 1)[0] in CODE_OPTIONS.get(wrapper, ()):
                judge(word.split("=", 1)[1])
                return None, []
            if takes(CODE_OPTIONS, wrapper, word):
                if index + 1 < len(words):
                    judge(words[index + 1])
                return None, []
            index += 2 if takes(VALUE_OPTIONS, wrapper, word) else 1
        elif wrapper == "watch" and " " in word:
            judge(word)
            return None, []
        elif wrapper == "script":
            # script's only other positional is its log file.
            index += 1
        elif wrapper == "flock" and not locked:
            locked = True
            index += 1
        elif name in WRAPPERS:
            wrapper = name
            index += 1
            if name == "timeout" and index < len(words) and not words[index].startswith("-"):
                index += 1
        elif index > 0 and re.fullmatch(r"[0-9.]+[smhd]?", word):
            index += 1
        else:
            if wrapper in PACKAGE_RUNNERS:
                name = name.split("@")[0]
                name = PACKAGE_NAMES.get(name, name)
            return name, words[index + 1:]
    return None, []


def starts_agent(text):
    return bool(STARTS.search(text))


def handed(name, rest):
    """Judge only the words each program runs, so its other arguments stay mentions."""
    if name == "trap":
        if rest:
            judge(rest[0])
    elif name == "parallel":
        judge(" ".join(rest[:rest.index(":::")] if ":::" in rest else rest))
    elif name == "find":
        for index, word in enumerate(rest):
            if word in ("-exec", "-execdir", "-ok", "-okdir"):
                check(rest[index + 1:])
    else:
        words, index = [], 0
        while index < len(rest):
            if rest[index].startswith("-"):
                index += 2 if takes({"tmux": TMUX_VALUES}, "tmux", rest[index]) else 1
            else:
                words.append(rest[index])
                index += 1
        if not words or words[0] not in TMUX_RUNS:
            return
        for word in words[1:] if words[0] in ("send", "send-keys") else [" ".join(words[1:])]:
            judge(word)


def check(words):
    name, rest = program(words)
    if name == "eval":
        judge(" ".join(rest))
    elif name in HANDED_TEXT:
        handed(name, rest)
    elif name in PACKAGE_TOOLS and rest and rest[0] in ("exec", "dlx", "x"):
        check(["npx", *rest[1:]])
    elif name == "codex":
        if not rest or rest[0] not in INFO:
            deny(MESSAGE.format(agent="Codex"))
    elif name == "claude":
        if rest and rest[0] in INFO:
            return
        if any(word == "--print" or CLAUDE_PRINT_FLAG.fullmatch(word) or word.startswith("--output-format") for word in rest):
            deny(MESSAGE.format(agent="Claude headless"))
    elif name in INTERPRETERS:
        for index, word in enumerate(rest):
            code = rest[index + 1] if index + 1 < len(rest) else None
            if name in SHELLS and word.startswith("<<<"):
                judge(word[3:] or code or "")
                break
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
                try:
                    with open(word, errors="replace") as handle:
                        script = handle.read(1_000_000)
                except OSError:
                    # The shell cannot read it either, so nothing starts from it.
                    break
                if starts_agent(script):
                    deny(MESSAGE.format(agent=f"an agent from {word}"))
                break


def expand(word, variables):
    match = VARIABLE.fullmatch(word)
    return variables[match[1]].split() if match and match[1] in variables else [word]


def judge(command):
    """Deny if this shell text starts an agent, at any depth of substitution or nested shell."""
    text = strip_heredocs(command)
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
