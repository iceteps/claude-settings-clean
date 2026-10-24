---
name: hebrew-msg
description: Write a ready-to-send Hebrew message to the team, a manager, a permissions/access owner, or a client — status update, access request, blocker escalation, handoff note. Use whenever the user asks for a message in Hebrew for someone else, and for putting it on the clipboard correctly in RTL. Not for Hebrew UI strings or app copy.
---

# Hebrew message to the team

Output is **ready to send**, not a draft to edit. Deliver it both ways in the same turn: show it in chat **and** put it on the clipboard.

## Voice — write the way the user actually talks

Dry, technical, short. No warmth, no small talk, no openers. Never `מה קורה`, never `רציתי לסדר לך את הראש`. No crafted or literary phrasing — say it plainly or cut it. Short declarative sentences. Cut every word that is not information.

For one named person: their name, then straight into content — `דני, תוכנית X לסטייג' -`.

Numbered steps are good; that is how the user writes plans.

## Hard formatting rules

- **No emojis. Ever.**
- **Compact — no blank lines between sections.** Single line breaks only.
- **No bold section labels and no report-style headers** — not `מה עשינו`, not `החסם`, not `הבקשה`. It must read like a message from a colleague, not a status report. Keep the underlying order — framing, what happened, what is missing or blocked, the ask, the payoff — woven into normal prose sentences.
- **No parentheses around mixed Hebrew + Latin/code content.** In RTL they render mirrored. Use a dash, a colon, or a new line: `פרויקט: my-repo, מספר: 866...` not `(פרויקט my-repo...)`.
- **Separate what works from what is blocked** — `אז'ור כבר עובד, פיירבייס חסום`. Never lump them ambiguously.
- **Avoid gendered Hebrew verbs** unless the person's gender is known. Prefer infinitive or impersonal: `להרים`, `מוסיפים` — not `שים לב` / `שימי לב`.
- Plain `תודה` close.

## Transliterate concepts, keep machine strings verbatim

Transliterate common platform words into Israeli-dev Hebrew slang so it reads as if the user wrote it:

אז'ור = Azure · פיירבייס = Firebase · בקאנד = backend · פרונט = frontend · גיטהאב = GitHub · ריפו = repo · דיפלוי = deploy · מרג' = merge · טוקן = token · סרוויס אקאונט = service account · סופאבייס = Supabase · בילד = build

Keep universal acronyms as-is: CI/CD, API, DNS, SSH.

**Never transliterate literal machine strings — keep them verbatim, in code formatting**, so the reader can act on them:

- service-account emails
- org-policy constraints — `constraints/iam.disableServiceAccountKeyCreation`
- project id and project number
- full repo paths — `my-org/my-repo`
- IAM roles — `roles/firebasehosting.admin`
- branch names, env-var names, bundle ids
- feature proper-names — Workload Identity Federation

## Ask for one thing

State the single solution actually wanted. **No options, no fallbacks upfront.** Hold alternatives in reserve and offer one only if the ask meets resistance. This is a general principle, not just a Hebrew-message rule.

## Delivery on Linux / Wayland

The terminal reverses RTL on copy, so the user must paste from the clipboard, not copy from chat. Prepend an RTL mark (U+200F) to **every** line — messaging apps pick each line's direction from its first strong character, so a line starting with `-`, an email, or Latin text slams left.

```bash
printf '%s\n' "$msg" | sed 's/^/\xe2\x80\x8f/' | wl-copy
```

For a multi-line message, write it with a quoted heredoc into a variable or a scratchpad file first, then pipe through the same `sed`/`wl-copy` line. The user dislikes leaving throwaway files around — use the session scratchpad, not the home directory or the repo.

Verify it landed: `wl-paste | head -3`.

## Shape to aim for

Name, one framing line, what is working, what is blocked and why, the exact ask with the exact identifiers, one line on what it unblocks, `תודה`. Six to ten lines, no headers, no blank lines.
