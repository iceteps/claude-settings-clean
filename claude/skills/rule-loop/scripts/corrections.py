#!/usr/bin/env python3
"""corrections -- find the owner's corrections in past sessions.

Every rule in CLAUDE.md started as a correction someone happened to notice. This
reads every session on the machine and lists the messages that look like one
("no, don't", "I said", "why did you", "again", "!!"), each with what the agent
had just done, so the ones never turned into a rule can be found.

Sources, read only:
  ~/.claude/projects/*/*.jsonl   Claude Code transcripts (with the agent's last move)
  ~/.claude/history.jsonl        prompts of sessions whose transcript is gone
  ~/.codex/sessions/**/*.jsonl   Codex sessions (the fallback shares the rules)

The match is a deterministic pre-filter, tuned to over-include: deciding what a
message means is the triage step in SKILL.md, not this script's job.

Usage:
  corrections               list corrections not reviewed yet, write the report
  corrections --all         include reviewed ones
  corrections --since DATE  only messages on or after YYYY-MM-DD
  corrections --ack         mark everything in the last report as reviewed
  corrections --selftest    check the patterns against known messages
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

HOME = Path.home()
CLAUDE_PROJECTS = HOME / ".claude/projects"
CLAUDE_HISTORY = HOME / ".claude/history.jsonl"
CODEX_SESSIONS = HOME / ".codex/sessions"
STATE = HOME / ".claude/state/rule-loop"
SEEN = STATE / "corrections-seen.json"
LAST = STATE / "corrections-last.json"

# (weight, label, pattern). A message is a candidate at THRESHOLD or above.
SIGNALS = [
    (3, "i-said", r"\bi (said|told you|asked( you)?|already (said|told))\b"),
    (3, "why-did-you", r"\b(why|how) (did|do|would|are|could|dare) you\b|\bwhy (didn'?t|dont|don'?t) you\b"),
    (3, "dont-do", r"\b(don'?t|dont|do not|never|stop|quit) (do|doing|add|adding|use|using|put|ask|asking|assume|write|make|create|touch|commit|push|run|change|delete|remove|install|narrat|bombard)"),
    (3, "not-what", r"\bnot what i\b|\bthat'?s not (it|what|right)\b|\bthat'?s wrong\b"),
    (3, "should-know", r"\b(i )?shouldn'?t (have to )?ask\b|\byou should (know|have)\b|\bi had to ask\b|"
                       r"\bexplain yourself\b|\bare you serious\b|\byou just cost"),
    (3, "again", r"\bagain\s*[?!]|\bonce again\b|\bstill (not|doesn'?t|isn'?t|broken|wrong)\b"),
    (3, "emphasis", r"!!|\bALWAYS\b|\bNEVER\b"),
    (2, "from-now-on", r"\bfrom now on\b|\bnext time\b|\bgoing forward\b|\bin the future\b|\bevery time\b"),
    (2, "no-lead", r"^\s*(no|nope|wrong|wait|stop)\b[,.!\s]"),
    (2, "instead", r"\binstead\b|\brather than\b"),
    (2, "missed", r"\b(you )?(missed|forgot|forget|skipped|ignored)\b|\bdidn'?t (you|we)\b"),
    (2, "remove", r"\b(remove|undo|revert|roll ?back) (the|that|this|it|all)\b"),
    (2, "feeling", r"\bdisappoint|\bannoy|\bfrustrat|\bclutter\b|\bsloppy\b|\blazy\b"),
    (1, "always-never", r"\b(always|never|must)\b"),
    # A bare "why is that ??" is usually a question about the machine, not the agent.
    (1, "question", r"\?\?|\bwhy (is|does|did) (it|this|that)\b"),
]
THRESHOLD = 3
COMPILED = [(w, label, re.compile(p, 0 if label == "emphasis" else re.IGNORECASE))
            for w, label, p in SIGNALS]

# Text the harness injects into a user turn; never the owner's words. Named
# explicitly so owner-typed markup survives. A slash command's arguments are
# the owner's words: the tags go, the text stays.
INJECTED = re.compile(
    r"<(system-reminder|command-name|command-message|local-command-[a-z]+|bash-[a-z]+|"
    r"pasted_content|task-notification|agent-message|user-prompt-submit-hook|"
    r"tools-used-before-summary|recommended_plugins|environment_context|user_instructions)"
    r"\b[^>]*>.*?</\1>", re.DOTALL)
COMMAND_ARGS = re.compile(r"</?command-args>")
NOT_OWNER = re.compile(
    r"^(This session is being continued|\[Request interrupted|Your claude\.ai usage limit|"
    r"Caveat:|# AGENTS\.md instructions|<environment_context>|<user_instructions>|"
    r"The following is the Codex agent history|A process crashed on this)")


# Claude transcripts and Claude prompt history are the same tool.
FAMILY = {"history": "claude"}
CARRY_OVER_DAYS = 3


def days_apart(a: str, b: str) -> int:
    try:
        return abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days)
    except ValueError:
        return 0


def owner_text(raw: str) -> str:
    text = COMMAND_ARGS.sub(" ", INJECTED.sub(" ", raw)).strip()
    return "" if NOT_OWNER.match(text) else text


def score(text: str) -> tuple[int, list[str]]:
    hits = [(w, label) for w, label, rx in COMPILED if rx.search(text)]
    return sum(w for w, _ in hits), [label for _, label in hits]


def key(text: str, ts: str) -> str:
    """Stable across copies of one message, distinct when it is said again on
    another day: a correction repeated weeks later is the recurrence signal."""
    return hashlib.sha1(f"{text}|{ts[:10]}".encode()).hexdigest()[:16]


def iter_jsonl(path: Path):
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def claude_transcripts():
    """Yield (source, project, session, timestamp, text, agent_before) per owner turn."""
    for path in sorted(CLAUDE_PROJECTS.glob("*/*.jsonl")):
        project = path.parent.name
        last_text, tools = "", []
        for rec in iter_jsonl(path):
            msg = rec.get("message") or {}
            content = msg.get("content")
            if rec.get("type") == "assistant" and isinstance(content, list):
                for part in content:
                    if part.get("type") == "text" and part.get("text", "").strip():
                        last_text, tools = part["text"], []
                    elif part.get("type") == "tool_use":
                        tools.append(part.get("name", "?"))
                continue
            if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain"):
                continue
            if isinstance(content, list):
                if any(p.get("type") == "tool_result" for p in content):
                    continue
                raw = "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
            else:
                raw = content or ""
            text = owner_text(raw)
            if text:
                before = last_text[-400:] + (f"\n[then: {', '.join(tools[-8:])}]" if tools else "")
                yield "claude", project, rec.get("sessionId", path.stem), rec.get("timestamp", ""), text, before


def claude_history(have_transcript: set[str]):
    """Prompts from sessions with no transcript left. No agent context exists for these."""
    for rec in iter_jsonl(CLAUDE_HISTORY):
        session = rec.get("sessionId", "")
        if session in have_transcript:
            continue
        text = owner_text(rec.get("display", ""))
        if not text:
            continue
        ts = dt.datetime.fromtimestamp(rec.get("timestamp", 0) / 1000, dt.timezone.utc).isoformat()
        yield "history", rec.get("project", ""), session, ts, text, ""


def codex_sessions():
    for path in sorted(CODEX_SESSIONS.glob("**/*.jsonl")):
        last_text, cwd = "", ""
        for rec in iter_jsonl(path):
            payload = rec.get("payload") or {}
            if rec.get("type") == "turn_context":
                cwd = payload.get("cwd", cwd)
            elif rec.get("type") == "response_item" and payload.get("type") == "message" \
                    and payload.get("role") == "assistant":
                parts = [c.get("text", "") for c in payload.get("content", []) if c.get("type") == "output_text"]
                if any(parts):
                    last_text = "\n".join(parts)
            elif rec.get("type") == "response_item" and payload.get("type") == "message" \
                    and payload.get("role") == "user":
                raw = "\n".join(c.get("text", "") for c in payload.get("content", [])
                                if c.get("type") == "input_text")
                text = owner_text(raw)
                if text:
                    yield "codex", cwd, path.stem, rec.get("timestamp", ""), text, last_text[-400:]


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return default


def collect(since: str | None, include_seen: bool) -> tuple[list[dict], int]:
    seen = set(load_json(SEEN, []))
    transcripts = list(claude_transcripts())
    have = {t[2] for t in transcripts}
    found, scanned, emitted = [], 0, {}
    messages = sorted([*transcripts, *claude_history(have), *codex_sessions()], key=lambda m: m[3])
    for source, project, session, ts, text, before in messages:
        # Resumed and forked sessions repeat earlier turns with their original
        # timestamp: once per tool per day. Work carried from Claude into Codex
        # repeats the text within a few days: dropped in the other tool. The
        # same words said again later, in either tool, are a recurrence: kept.
        tool = FAMILY.get(source, source)
        day = ts[:10]
        copies = emitted.setdefault(text, set())
        if (tool, day) in copies or any(t != tool and days_apart(d, day) <= CARRY_OVER_DAYS
                                        for t, d in copies):
            continue
        copies.add((tool, day))
        scanned += 1
        if since and ts[:10] < since:
            continue
        points, labels = score(text)
        if points < THRESHOLD:
            continue
        k = key(text, ts)
        if k in seen and not include_seen:
            continue
        found.append({"key": k, "source": source, "project": project, "session": session,
                      "time": ts[:16].replace("T", " "), "score": points, "signals": labels,
                      "text": text, "before": before})
    found.sort(key=lambda c: (-c["score"], c["time"]))
    return found, scanned


def write_report(found: list[dict], scanned: int) -> Path:
    STATE.mkdir(parents=True, exist_ok=True)
    out = STATE / f"corrections-{dt.date.today()}.md"
    lines = [f"# Corrections -- {dt.date.today()}", "",
             f"{len(found)} candidates from {scanned} owner messages "
             f"(threshold {THRESHOLD}; Claude transcripts, Claude prompt history, Codex).",
             "Each is a candidate, not a finding: triage per rule-loop SKILL.md.", ""]
    for i, c in enumerate(found, 1):
        lines += [f"## {i}. [{c['score']}] {c['time']} {c['source']} {c['project']}",
                  f"signals: {', '.join(c['signals'])}  key: `{c['key']}`", "",
                  "> " + c["text"][:900].replace("\n", "\n> "), ""]
        if c["before"]:
            lines += ["Agent just before:", "```", c["before"].strip(), "```", ""]
    out.write_text("\n".join(lines))
    LAST.write_text(json.dumps([c["key"] for c in found]))
    return out


# Messages with the verdict they must get, written in the shape real owner
# corrections take (typos, "!!", "why didnt you", tags). A pattern change that
# loses one, or starts matching a plain question, fails. local/selftest.json,
# when present, adds the owner's own messages (kept out of shared copies).
SELFTEST = [
    ("i want these rules followed every time !! EVERY time !", True),
    ("why didnt you put the notes in the docs folder ?", True),
    ("i asked you to check all of it exactly for that reason", True),
    ("lets do this properly for phones i shouldnt have to ask this of you", True),
    ("please make sure you're not overwriting imporant files explain yourself", True),
    ("the page is not responsive to say the least ?? how did you ship that", True),
    ("make sure next time we are always on track on all of these", True),
    ("<command-args>stop adding emojis, never again !!</command-args>", True),
    ("why is that ?", False),
    ("i unplugged my second monitor but the system still sees it why is that ?", False),
    ("ok lets go with 1", False),
    ("<system-reminder>never do X !! I said stop</system-reminder> ok thanks", False),
]
LOCAL_SELFTEST = Path(__file__).resolve().parent.parent / "local/selftest.json"


def selftest() -> None:
    cases = SELFTEST + [tuple(c) for c in load_json(LOCAL_SELFTEST, [])]
    bad = 0
    for raw, want in cases:
        points, labels = score(owner_text(raw))
        got = points >= THRESHOLD
        bad += got != want
        if got != want:
            print(f"FAIL  want {want}, got {got} ({points}: {labels}): {raw}")
    print(f"corrections selftest: {len(cases) - bad}/{len(cases)}")
    sys.exit(1 if bad else 0)


def ack() -> None:
    last = load_json(LAST, None)
    if last is None:
        sys.exit("corrections: no report to acknowledge; run corrections first")
    seen = set(load_json(SEEN, [])) | set(last)
    SEEN.write_text(json.dumps(sorted(seen)))
    print(f"marked {len(last)} as reviewed ({len(seen)} reviewed in all)")


def main() -> None:
    ap = argparse.ArgumentParser(prog="corrections", description=__doc__.split("\n\n")[0])
    ap.add_argument("--all", action="store_true", help="include reviewed corrections")
    ap.add_argument("--since", metavar="YYYY-MM-DD")
    ap.add_argument("--ack", action="store_true", help="mark the last report as reviewed")
    ap.add_argument("--selftest", action="store_true", help="check the patterns against known messages")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if args.ack:
        return ack()
    found, scanned = collect(args.since, args.all)
    out = write_report(found, scanned)
    by_source: dict[str, int] = {}
    for c in found:
        by_source[c["source"]] = by_source.get(c["source"], 0) + 1
    print(f"{len(found)} candidates from {scanned} owner messages {by_source}")
    print(f"report: {out}")


if __name__ == "__main__":
    main()
