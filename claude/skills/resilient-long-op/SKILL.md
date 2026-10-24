---
name: resilient-long-op
description: >
  Run any long or large operation so it SURVIVES a disconnect and is fully resumable —
  multi-GB downloads (ollama/model pulls, docker pulls, dataset/HuggingFace fetches, wget/curl
  of big files), long installs/builds/compiles, migrations, or anything that runs more than a
  few minutes. Use BEFORE starting such work, especially over a flaky link or when the user
  says "we might get disconnected" / "make sure we can resume". Not for quick commands.
---

# Resilient long operations

A long job launched normally dies when the Claude session drops, the terminal closes, or the
user logs out — and a naive re-run starts from zero. Wrap it so it survives and resumes.

## Rule of thumb
If a step will take more than ~a few minutes, download more than ~1 GB, or the user flags a
shaky connection: **do not run it inline or as a plain `&` background job.** Wrap it as below.

## Why not the obvious options
- **`&` / `nohup` / `setsid` from inside the Claude Bash tool** get reaped when the tool shell
  exits. Verified: they do not survive. Don't rely on them.
- A tracked `run_in_background` Bash job dies with the Claude session.
- Only a **systemd transient unit** (or a real user-lingering service) is truly independent of
  this session, the terminal, and logout.

## The pattern

1. **Write an idempotent retry script** to a stable path (`~/.local/state/<op>/run.sh`, NOT
   /tmp — it clears on reboot). It must: skip work already done (e.g. `ollama show`,
   `test -f`), retry each item in an `until` loop with a sleep backoff, log to a stable file,
   and `touch` a `DONE` marker at the end.

2. **Launch as a transient unit.** A job that needs no root (downloads into your home, agent
   batches, test runs) is a USER unit; no privileges, and `$HOME` is already right:
   ```bash
   systemctl --user reset-failed <op> 2>/dev/null
   systemd-run --user --unit=<op> --collect --setenv=PATH="$PATH" bash ~/.local/state/<op>/run.sh
   ```
   A job that needs root is a SYSTEM unit, and on this machine root needs the owner: `pkexec`
   fails (no polkit agent), so hand over one `! sudo systemd-run --unit=<op>
   --collect /usr/bin/bash /home/<user>/.local/state/<op>/run.sh` for the owner to run.
   - Use the **default Type=simple** — `--service-type=oneshot` imposes a 90s start timeout
     that KILLS long jobs.
   - `--collect` auto-GCs the unit on success.
   - **System units only: set `HOME`** in the script (`export HOME=/root`) — a system unit's bare env has none, and many
     CLIs (ollama, git, cargo) panic/misbehave without it. Add `TERM=dumb` if a tool needs it.

3. **Verify it's actually progressing at a reasonable speed**, not just "active":
   `systemctl is-active <op>` AND a real progress line with an acceptable rate/ETA (see
   "Slow ≠ stuck" below). Never report success from "no error," and never treat "active" as
   "healthy."

4. **Notify on completion** with a single background waiter that exits on the terminal state:
   ```bash
   until [ -f ~/.local/state/<op>/DONE ] || \
     [ "$(systemctl is-active <op>)" != active ]; do sleep 30; done
   ```
   (Bash `run_in_background` — one notification when done or the unit stops.)

5. **Resume after any interruption**: just re-run the launch command. Idempotent skip-checks +
   tool-level resume (ollama/docker resume partial blobs; use `wget -c`, `rsync --partial`)
   mean no lost progress. After a reboot the unit is gone — re-run the same command.

6. **Log it** to your system change log when it's a host change,
   including the exact resume command.

## Slow ≠ stuck: watch throughput, then switch mirrors

A download can be `active` and still crawling — a throttled source looks identical to a healthy
one if you only check liveness. Watch the **real rate and ETA**.

- **Parse the actual speed.** Strip carriage returns (`tr '\r' '\n'`) from the progress log and
  read the MB/s + ETA off the last line. A multi-hour ETA for a few GB is a red flag.
- **Set a floor by comparison.** If one artifact came down fast this session and another is
  crawling, the slow one's **source is throttling** — it is *not* your connection. Diagnose by
  contrast, then switch the slow one's source.
- **The same artifact is usually mirrored — switch to the fast source:**
  - **Ollama models:** HuggingFace (`hf.co/<user>/<repo>-GGUF:QUANT`) throttles per-IP hard;
    the **Ollama registry** (`ollama.com`, incl. community namespaces like
    `huihui_ai/<model>:<tag>`) is usually far faster. Prefer whatever proved fast this session.
    *Real case: same model — HF 274 KB/s vs Ollama registry 12 MB/s, ~44× faster.*
  - **Distro packages:** re-rank mirrors (`reflector` on Arch) or pick a closer CDN.
  - **Generic files:** try an alternate release host/mirror; `wget -c` / `curl -C -` resume
    across the switch so you keep the bytes already fetched.
- **Switching is cheap** because the script is idempotent: change the source in the model/URL
  list, `reset-failed`, relaunch — done items are skipped and the small partial from the slow
  source is simply abandoned, not re-downloaded from zero.
- **Never silently accept a multi-hour ETA.** Surface it and switch mirror (or ask) — don't let
  it grind for hours when a faster source exists.

## Checklist
- [ ] Script in `~/.local/state/<op>/`, idempotent, retry loop, DONE marker
- [ ] User unit for user jobs; system unit (handed to the owner) only when root is needed, with `export HOME=/root` in its script
- [ ] systemd transient unit, Type=simple (no oneshot), `--collect`
- [ ] `reset-failed` before any relaunch of the same unit name
- [ ] Verified progressing at a real rate (MB/s + ETA), not just "active"
- [ ] On throttle: compared sources, switched to the fast mirror (Ollama registry vs HF, etc.)
- [ ] Completion waiter armed
- [ ] Resume command recorded
