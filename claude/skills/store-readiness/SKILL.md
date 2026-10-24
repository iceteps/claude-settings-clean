---
name: store-readiness
description: Audit a mobile app against the Apple App Store and Google Play submission walls before anyone promises a release — permissions and purpose strings, privacy manifest, account deletion, privacy policy, user-generated-content moderation, Sign in with Apple, background location and broad media declarations, data-safety and nutrition labels, review notes and demo accounts, listing assets. Use before a first store submission, before adding a permission, background mode, login provider, chat/photo sharing or third-party processor, when a review rejects, and when asked "can we ship to the stores".
---

# store-readiness — the walls are mapped before the build, not by the reviewer

Built on a field-work app (Expo / React Native, iOS + Android) audited 2026-09:
a parallel device-and-store audit, every finding adversarially verified against
the CURRENT policy text, found the app **not submittable to either store** — six
feature-sized walls, a stack of paperwork, and config that declared more than
the app did. None of it was visible from inside the code. The rejection would
have arrived one review cycle (days) per wall.

## 0. Doctrine

1. **Three classes, three timelines.** Every finding is one of: CONFIG hygiene
   (fix in the audit commit), a FEATURE wall (must be built, designed first,
   before ANY submission), or PAPERWORK (one sitting each, after the features).
   Mixing them hides the features behind the paperwork.
2. **Cite the policy, verify it today.** Each wall carries its guideline number
   or help-center article AND the date it was checked. Store policies change; a
   recalled rule is a candidate, not a finding. Re-read the current text at
   audit time and record the check date.
3. **Inspect the BUILT artifact, not the source config.** Libraries merge
   permissions and plist keys in at build time. Read the merged
   `AndroidManifest.xml` (`aapt dump permissions app.apk`, or
   `apkanalyzer manifest print`) and the `Info.plist` / `PrivacyInfo.xcprivacy`
   inside the `.ipa`. The source says what you meant; the artifact is what the
   reviewer sees.
4. **False privacy copy is its own rejection class AND a trust breach.** Every
   in-app privacy statement, purpose string and store form must match what the
   code does. The audit found in-app copy promising "never tracks during the
   shift" in an app shipping opt-in geofencing and photo auto-attach. Audit the
   copy against the code, both directions.
5. **Native vs over-the-air.** Permissions, plist keys, manifests, entitlements,
   extensions and native modules ride a NEW BINARY. Say so before promising a
   date; an OTA update cannot fix a store wall made of config.
6. **Every declared permission maps to a shipped feature.** If no feature uses
   it, remove it. If a library injects it, block it.

## 1. Config hygiene (fix in the audit commit)

- [ ] **Permissions minimal.** List every permission in the merged manifest and
      Info.plist; map each to the feature and file that uses it. Remove the rest.
- [ ] **Library-injected permissions blocked.** On Android, permissions merged
      from dependencies are removed with `tools:node="remove"` (Expo:
      `android.blockedPermissions`). Typical strays: `WRITE_CONTACTS`,
      `READ_MEDIA_AUDIO`, `FOREGROUND_SERVICE*`, `SYSTEM_ALERT_WINDOW`.
- [ ] **Foreground-service permissions** only if a foreground service actually
      runs; Play requires a declared FGS type with justification.
- [ ] **Granular media.** Request photo/video only (Android 13+ granular media
      permissions); drop `READ_MEDIA_AUDIO` unless audio is used; drop legacy
      `READ/WRITE_EXTERNAL_STORAGE` for the API levels that no longer need them.
- [ ] **Background modes trimmed** (iOS `UIBackgroundModes`) to those with a
      shipped feature behind them; an unused mode invites a rejection question.
- [ ] **Purpose strings** (`NS*UsageDescription`) present for EVERY protected API
      the binary links, including ones only an SDK touches (a missing string is
      a crash on access and a rejection), specific about what and why, truthful,
      and localized for every shipped locale.
- [ ] **Privacy manifest** (`PrivacyInfo.xcprivacy`): required-reason APIs
      declared with approved reasons (UserDefaults, file timestamps, system boot
      time, disk space, active keyboards), collected data types, tracking flag
      and tracking domains; third-party SDKs on Apple's list ship their own
      signed manifests at supported versions.
- [ ] **Unused plugins and SDKs removed**, both the config plugin and the
      dependency: each one can add permissions, background modes or manifest
      entries.
- [ ] **Target API level** meets Play's current requirement (it moves yearly).
- [ ] **Export compliance** answered (`ITSAppUsesNonExemptEncryption`), so every
      build is not held at upload.

## 2. Feature walls (build before any submission)

Verified in the source audit (citation as of 2026-09; re-verify):

1. **Account deletion** (Apple 5.1.1(v); Google Play account deletion
   requirement). If the app lets a user create an account, it must let them
   delete it IN the app, and Play also requires a WEB deletion link entered in
   the Console. Deletion removes the data (or states exactly what is retained
   and why), not merely deactivates. Needs a privileged server path (a client
   key cannot delete an auth user), and a decision for data other users depend
   on (shared records, a worker added by someone else).
2. **Privacy policy and terms URLs** (Apple 5.1.1(i); Play User Data policy).
   Hosted, reachable without signing in, linked inside the app and in both
   consoles. Names every data category and every processor: AI vendors, message
   relays, analytics, crash reporting, hosting.
3. **User-generated content moderation** (Apple 1.2; Play UGC policy). Chat,
   notes, comments, photos shared between users need: a report action on each
   item, per-user block, content rules accepted at sign-up, a way to act on
   reports, and visible contact information. Delete-only moderation fails.
   Design pass first.
4. **Sign in with Apple** (Apple 4.8). Any third-party or social login on iOS
   requires an equivalent privacy-preserving option; Sign in with Apple
   satisfies it.
5. **Background location, Play** (Play location permissions policy). An in-app
   PROMINENT DISCLOSURE (what is collected, why, that it runs in the background,
   with an explicit accept) shown BEFORE the runtime request; the Console
   background-location declaration; a short video demonstrating the feature.
   iOS: When-In-Use and Always purpose strings, and the background use
   explained in the review notes.
6. **Broad photo/video access, Play** (Play photo and video permissions
   policy). Apps whose core use does not need broad library access must use the
   system photo picker; those that do must file the declaration with that core
   use.

Standard walls the source audit did not hit but every audit must check
(verify each against current text before relying on it):

- [ ] **Permission in context** (Apple 5.1.1(iv)): request at the moment of use,
      never at launch; the app still works when the user declines.
- [ ] **App Tracking Transparency** (Apple 5.1.2) before any cross-app tracking
      or IDFA access; tracking domains in the privacy manifest.
- [ ] **Digital goods** sold in the app use in-app purchase / Play Billing
      (Apple 3.1.1; Play Payments policy) unless an exemption applies.
- [ ] **Completeness** (Apple 2.1): no placeholder screens, dead buttons, or
      features gated behind a server the reviewer cannot reach.
- [ ] **Minimum functionality** (Apple 4.2): a thin web wrapper is rejected.
- [ ] **Login required means a demo account** (Apple 2.1 review information;
      Play app access declaration).
- [ ] **Children, health, finance, VPN, contacts upload**: each carries its own
      category rules; check whether the app falls into one.
- [ ] **Push notifications** not required for core function and not used for
      marketing without opt-in (Apple 4.5.4).
- [ ] **Contacts**: prefer the system contact picker over a full read permission
      when only one contact is chosen at a time.

## 3. Paperwork (one sitting each, after the walls)

- [ ] **App Store privacy nutrition labels** and **Play Data safety form**,
      filled from the code inventory, not memory. Name each category (precise
      location, photos, contacts, messages, financial, calendar, identifiers)
      and the processors that receive it. Must match the privacy policy and the
      purpose strings word for word in substance.
- [ ] **Review notes, demo account and video**: a seeded account the reviewer
      can sign into, with data that exercises the gated features; notes that
      explain background location, deep links and anything that needs hardware
      or a place; a video for the geofence-type features.
- [ ] **Listing assets**: screenshots per required device size class per
      locale; Play feature graphic 1024x500; icon; short and full description;
      support URL (required by Apple) and marketing URL.
- [ ] **Content rating questionnaire** (Play) and **age rating** (Apple).
- [ ] **Automated submit config** (e.g. a Play service account for the upload
      lane), so the first upload is not done by hand from a laptop.
- [ ] **Contact details**: developer email, phone (Play), address where the
      account type requires it.

## 4. Method

1. **Inventory first** (one pass, mechanical): merged permissions, plist keys,
   background modes, entitlements, extensions, SDK list with versions, every
   network destination (processors), every login provider, every place a user
   can see another user's content.
2. **Audit in parallel lanes** (per store x per area: permissions, privacy,
   UGC, auth, location, media, listing) when the app is large; each finding
   carries `{wall, store, citation, check date, evidence file:line, class
   (config|feature|paperwork), effort}`.
3. **Adversarially verify every finding** against the current policy text and
   the code before it is recorded. Refuted findings are recorded as refuted.
4. **Fix config hygiene in the same commit** and prove it on the built artifact.
5. **Record the walls** in the project's task list, features ranked, each with
   its citation; and the decisions (e.g. "contacts via picker, not full read")
   in the decision ledger.
6. **Truthfulness pass** last: every privacy sentence in the app, the policy and
   both forms, read against the inventory.

## 5. Report template

```
STORE READINESS — <app> <version/build> — audited <date>
Verdict: submittable to App Store: NO (n walls) | Play: NO (n walls)

FEATURE WALLS (build first)
1. <wall> — <store(s)> — <citation, checked date> — evidence <file:line> — effort
CONFIG (fixed in <commit>, proven on built artifact <how>)
PAPERWORK (after walls)
REFUTED (claimed, disproved, why)
NEEDS A NEW BINARY: <list>
```
