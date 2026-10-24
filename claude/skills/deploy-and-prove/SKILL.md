---
name: deploy-and-prove
description: Deploy any artifact (server process, serverless or edge function, container, static site, schema change) and then PROVE the new code is live and behaving, including the staleness check that catches "deployed" docs describing an older version. Use whenever about to deploy, whenever a doc, ticket or report claims something "is deployed", and before ordering a schema change against the code that writes it. A project-local deploy-and-prove skill takes precedence and carries the concrete commands, hosts and probes.
---

# deploy-and-prove — a deploy is not done until the new behaviour is observed

Binding doctrine (global CLAUDE.md): **deploys and destructive ops are proven, not assumed —
baseline query, surgical apply, verify query, idempotent second pass; schema lands in the
live environment BEFORE code that writes it ships.**

"Deployed" is a claim about TIMING and BEHAVIOUR, not about a command having once
succeeded. A deploy command exiting 0 proves the command ran. It does not prove the
version you think is live, and it does not prove the version behaves.

## Rule 0 — the staleness check, BEFORE claiming anything is deployed

For every artifact the claim covers, compare its last source change against its last
deploy:

```bash
git log -3 --format='%h %ci %s' -- <artifact source path>
```

If any commit postdates the last deploy of that artifact, it is NOT deployed, whatever
the docs, ticket or previous report says. Redeploy. A deploy record with no timestamp is
no record: find out from the target (file mtime, bundle hash, version endpoint, image
digest).

## The checklist

1. **Staleness check** (Rule 0). Name the artifact and the commit you intend to ship.
2. **Order against the schema.** If the code reads or writes a new column, table, index,
   queue or config key, that change lands live FIRST and is verified (`prod-check`) before
   the code ships. Code ahead of schema is a runtime error for every user in between.
3. **Baseline.** Record the observable state before touching anything: the live version
   identifier, file sizes or hashes, the row counts or behaviour the change will alter.
   Without a baseline, "it changed" is unprovable.
4. **Static check what nothing else checks.** If the artifact is excluded from the type
   checker, linter or test suite (deploy-only scripts, functions bundled separately,
   plain-JS services), run the cheapest syntax check it supports and re-read the diff.
   There is no compiler behind you.
5. **Apply surgically.** Ship only the artifact in scope. Schema: apply the new statements
   only, never re-run a full bootstrap script against a live database; keep the bootstrap
   script in sync with what you applied.
6. **Prove it landed.** Compare the target against the source: version string, bundle size
   the deploy printed, file size and mtime on the host, image digest. A size or hash
   change is cheap evidence; an unchanged one after a code change is a red flag.
7. **Prove it behaves.** Exercise the changed path and observe the new behaviour in live
   data (`prod-check`): the field the fix populates is now populated, the error the fix
   removes is gone. Reachability (HTTP 200/204 on a health or OPTIONS probe) proves only
   that something answers.
8. **Idempotent second pass.** Re-run the apply (or the migration) and prove it changes
   nothing: zero rows affected, no new objects, same hash.
9. **Record it.** Deploy time, commit, evidence, in the project's log, so the next Rule 0
   has something to compare against.

When the probe cannot reach the behaviour (auth gates the endpoint, the path needs a real
user), say exactly what was proven and what was not. Never round "reachable" up to
"working".

## Privileged deploys — stage, then hand over

When the final step needs a credential the agent does not hold (a sudo password, a
production deploy key, a 2FA prompt):

- Do every unprivileged step yourself: build, syntax check, stage the files on the host
  under the deploying user.
- Hand the owner ONE short command for the elevated half. It needs a TTY so the prompt
  can appear (`ssh -t`); a non-interactive agent hitting "no askpass" or "a terminal is
  required" is the system working as designed, not a bug to route around.
- Then prove it yourself (steps 6-8).

## Failure modes already paid for

- **Stale "deployed" claim.** The artifact was changed after its last deploy; the docs
  said "deployed" and were right about the OLD version. Class: deploy state recorded
  as a fact instead of a timestamp. Fix: Rule 0, every time.
- **Deploy script that cannot run on the real host.** It assumed root SSH, which the host
  correctly disabled, so it had never actually been usable. Class: a deploy path never
  exercised end to end against the real target. Fix: the first deploy through any new
  script is itself proven, and the script follows the host's security model rather
  than weakening it.
- **Environment expansion under privilege escalation.** `$HOME` (or `~`, `$USER`) inside
  `sudo bash -c '...'` resolves to root's, not the deploying user's; files went to the
  wrong place. Class: a variable evaluated in a different identity than the author
  assumed. Fix: resolve paths in the login shell before elevating, and pass them in as
  literals.
- **Credential probing locks you out.** Trying several SSH users "to see what works"
  tripped the host's intrusion ban and blocked the IP, including the working account,
  for minutes. Class: retrying authentication against a host with brute-force
  protection. Fix: one definitive auth failure is an answer; read the config, do not try
  another username.
- **Sync deleting live-only state.** Session stores, secrets files and runtime caches
  that exist ONLY on the host are destroyed by a `rsync --delete` that does not exclude
  them. Class: mirror sync over a directory that holds host-owned state. Fix: an explicit
  exclude list on every hop of the chain, checked before the first run.
- **Unchecked artifacts.** A function excluded from the type checker and linter shipped
  with only a human read behind it. Class: code outside every gate. Fix: step 4, and
  name the gap in the report.
