---
name: vet-install
description: Trust assessment before installing, fixing, integrating, or debugging third-party software — any `curl | sh` installer, root install, closed binary, a plugin or launcher that downloads a prebuilt binary (build it from source instead), browser extension, npm/pip/distro package from an unfamiliar vendor, VPN/DNS/proxy service, or anything touching DNS, network, auth, or the kernel. Use BEFORE the work starts, and again mid-task if red flags accumulate.
---

# Vet before you install

This machine is post-compromise (2026-08-10). Helping competently with a bad idea reads as an endorsement. The point of this skill is to put the trust question **in front of** the fix-it momentum, because that momentum is exactly when it gets skipped.

## When it fires

- `curl … | sh`, `wget … | bash`, any installer that pipes network content into a shell
- anything that wants root, or a systemd unit, at install time
- closed-source binaries, unsigned packages, third-party package repos, random GitHub release tarballs
- DNS, VPN, proxy, ad-blocker, "privacy" services — anything in the middle of all traffic
- auth/credential tooling, password managers, key agents, browser extensions
- kernel modules, drivers from sources outside your distribution
- npm/pip packages that are not the obvious well-known one (`npm ignore-scripts` is `true` globally — keep it that way)

## The assessment — do this before touching anything

Take two minutes and answer these out loud to the user, briefly:

1. **Who publishes it?** Named company or person, or anonymous? How long has it existed?
2. **Is it open source and auditable?** Public repo, real commit history, real issue tracker, or a marketing page with a download button?
3. **Independent signal.** Packaged by your distribution or Flathub-verified? Distro or security-community discussion? Or only the vendor's own site saying it is good?
4. **What does it touch?** Root, DNS, network path, credentials, kernel, autostart. What is the blast radius if the vendor is malicious or just careless?
5. **How does it install and uninstall?** Does the uninstaller actually remove everything? Can the install be reversed?
6. **What is the reputable alternative?** There is nearly always a distro-packaged or well-known option that does 90% of the job.

Then give a one-line verdict: **install / install-but-contained / don't**. Contained means a `distrobox`/`toolbox` container, never the host — that is the default for risky or unknown project work.

## Then let the user decide

Flag, recommend, proceed per their call. Do not silently refuse and do not silently comply.

## Owner default: build open source from source, never run the prebuilt binary

Owner decision 2026-10-22 (impeccable engine): when an open-source tool offers or
auto-downloads a prebuilt binary, build it from the tagged source instead and
block the download. Do this without re-asking; report it in the final summary.

1. **Pin the source.** Read the version the consumer expects (e.g. a `VERSION`
   file next to the launcher). Clone that exact tag shallow into its own dir:
   `git clone --depth 1 --branch <tag> <repo> ~/.local/src/<name>-<ver>`.
   Confirm `git rev-parse HEAD` equals the tag's commit via `gh api`.
2. **Vet the build surface** (minutes, not an audit):
   - build-time code: Rust `build.rs` at crate roots, npm install scripts,
     Python `setup.py`, Makefile fetches;
   - dependency sources: lockfile present, registry-only (no git/url deps),
     well-known packages; `cargo tree` / `npm ls` to list them;
   - runtime egress: grep for HTTP clients, URLs, `Command::new`/`exec`,
     telemetry and update checks; note their opt-out switches.
3. **Build locked** (`cargo build --release --locked`, `npm ci`), as a systemd
   user unit with a DONE marker if it can run long (`resilient-long-op`).
4. **Install outside the repo** (`~/.local/bin/<name>`), record its sha256.
5. **Pin and fail closed.** Point the consumer at the build with the tool's own
   override (e.g. `IMPECCABLE_BIN`) and point any download URL override at a
   `.invalid` host (RFC 2606 reserved), so a missing binary fails instead of
   fetching. Turn off telemetry and update checks. Claude Code plugin hooks
   take env from `~/.claude/settings.json` `env` (back the file up first).
6. **Prove it.** Run the real launcher path, not just the binary; then point the
   override at a nonexistent path and confirm it refuses to download.
7. **Log** in your system change log (tag, commit, sha256, settings, the
   rebuild steps for the next version) and your bug tracker if something broke.

State the limit honestly: source builds remove the tampered-download vector,
not a malicious author; the vetting is a targeted scan, not a full audit.

## Mid-task red flags — stop and re-raise

If any of these show up while fixing something, they are trust signals, not just bugs. Say so before continuing:

- installer broken on a default install of the distro
- fights the system (`chattr +i` on config files, disabling resolved's stub listener, replacing distro components)
- status output that misdiagnoses its own state
- `--help` or a flag that performs a destructive action
- uninstall that leaves the binary or the unit behind
- crash-loops treated as normal by the vendor's docs

The uBlockDNS session (2026-08-11) hit every one of these and the trust question still never got asked. That is the failure this skill exists to prevent.
