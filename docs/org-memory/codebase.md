# codebase.md — verified facts about the code

One bullet per fact: date · evidence (`file:line`) · which cycle/PR established it. Read this
before researching, reviewing, or hunting — do not re-derive or re-file what's here. Delete
entries when falsified; promote to `CLAUDE.md` when they harden into rules.

## XSS surface

- 2026-07-10 (S1, PR #12): the four untrusted-string sinks — `logEvent()` and `toast()` in
  `js/app.js`, `chipsEditor` and `appendLog` in `js/auth.js` — are verified `textContent`-safe.
  A headless XSS probe in `scripts/boot-check.mjs` (hash→chips and mint→event-log paths) guards
  them; both sinks were mutation-tested.
- 2026-07-10 (S1 research → filed as S9): `el(tag, cls, html)` (app.js:261, auth.js:72) passes its
  third arg through `innerHTML`. Two call sites feed it a variable that is today always a
  literal/enum but would become a sink if ever fed TS/user data: `accordion(title,…)` (app.js:931)
  and `el('span','act-name', a)` (app.js:1266). Never pass TS/link-derived strings as the third
  arg — omit it and set `textContent` after. All four file:line cites independently re-verified
  2026-07-10 (M7 review) — exact.

## Standalone Answers (S3)

- 2026-07-13 (S3, this PR): the `answerId` render/generate/state plumbing **predates** the picker
  work — state key (`state.js:38` default, `:252` sanitize cap-128, `mergeKnown` spread), the
  `SearchEmbed({answerId,hideSearchBar:true})` render path (`embed.js:272-286`, gives `answerId`
  precedence over `vizId`), the code generator (`app.js:4224,4295-4297`), and lifecycle/APIs
  answer-awareness were all already present. The "Standalone Answer unreachable" gap was ONLY (1) no
  picker UI in `sectionObject` and (2) a broken `discoverAnswers`. Picker adds no new state key.
- 2026-07-13 (S3): `discoverAnswers(host)` (`discovery.js:193-212`) now does an instance-wide
  `POST /metadata/search {metadata:[{type:'ANSWER'}], record_size:10000, sort_options:NAME/ASC}`,
  parsing the top-level array identically to `discoverObjects` (`.filter(metadata_type==='ANSWER')`
  → `{id:metadata_id, name:metadata_name||'Untitled'}`). The old 2-arg worksheet-`dependent_objects`
  traversal was **dead code** (declared `answerCache`, never called; `dependent_objects` is an opaque
  map not keyed by type → always `[]`). Sole caller is `loadAnswers()` (`app.js:1155`).
- 2026-07-13 (S3): the answer auto-load fires a **credentialed** `POST /metadata/search`; its
  host-confirm safety rests entirely on the `connected &&` prefix (`app.js:1116`). `connected===true`
  is a safe proxy for "host confirmed" because it is set only in `connect()` (`app.js:481`) AFTER
  `pendingHostConfirm=false` (`:452`), and there is no `hashchange`/`popstate` listener (`loadState`
  runs once, `:274`). Any future code that sets `connected` elsewhere, or adds a live hash re-read,
  re-opens the pre-confirm leak. Boot-check `runAnswerPreconfirmProbe` guards this — but only for the
  literal `/metadata/search` path; a discovery-endpoint refactor would need the probe widened.
- 2026-07-13 (S3): `refreshCode` writes generated SDK code via `pre.textContent` (`app.js:4536`),
  which is why `esc()` (`app.js:4221`, escapes only `\` and `'`, NOT HTML) is XSS-safe today. If the
  code view ever switches to `innerHTML` (e.g. syntax highlighting), every `esc()`'d hash-derived
  value (`answerId`/`worksheetId`/`liveboardId`) becomes a sink.

## Session caches / host switch (S3 review)

- 2026-07-13 (S3 review): `connect()` (`app.js:447`) must reset every **non-host-keyed** session
  cache or an in-session host switch serves the prior host's objects. `answerList`/`answersLoading`
  (`app.js:204-205`) are now reset there (`:491`). `loadAnswers()` is additionally **host-fenced**
  (captures `getState().host`, drops the write + preserves the loading flag if the host changed
  mid-flight) — because the reset alone re-opened a last-write-wins race (a stale in-flight fetch
  could overwrite the new host's result). `vizCache` (`app.js:202`) is the same class and is NOT yet
  reset — latent, low-reachability (GUID-keyed, mostly self-masking); filed as **S11**.

## Filters & rendering

- 2026-07-08 (commit f7d439f, PR #4): `pushRuntimeFilters()` + `appliedRuntimeCols` landed,
  claiming to supersede the S5 filter-clobbering finding (`cfbApply()`/`applyLiveFilters()`/
  `cfbBuild` wiping each other). **Not yet re-verified** — S5 is still open; verify before
  building on this claim.

## Gates

- 2026-07-10 (M7 review): `scripts/smoke-test.mjs:23` (PORT 34917) and `scripts/boot-check.mjs:31`
  (PORT 34921) hardcode their server ports with no env override — the server-bound gates are NOT
  safe to run concurrently on one machine (parallel worktrees, or a reviewer running the suite
  alongside QA, collide with `EADDRINUSE` and produce phantom reds). Only one agent runs them at
  a time; M8 tracks making them parallel-safe.

## Webhooks (S12)

- 2026-07-14 (S12, this PR): **scheduled-Liveboard webhook batching is a permission-model
  consequence, not a bug.** ThoughtSpot renders the report per recipient: an **internal (`USER`)**
  recipient's report runs *as that user* (their RLS) → a personalized render → **one webhook each**,
  and an RLS-blocked user → empty render → **no webhook**; **external (`EXTERNAL_EMAIL`)** recipients
  share one render under the **schedule owner's** permissions → **one batched webhook**. Groups expand
  to per-user webhooks. Triggering is **Send now** / cadence (no REST "run now"); schedules are
  creatable via `POST /api/rest/2.0/schedules/create` (`recipient_details.emails` / `.principals`).
- 2026-07-14 (S12): the receiver stores `data = payload.data || payload` and the inbox renderer reads
  the **full `payload`** — so a `LIVEBOARD_SCHEDULE` renderer must read defensively (top-level
  `eventType` OR `data.notificationType`, and `payload.data.recipients`). HMAC verify is over the
  **raw request bytes**, so a replay that signs the exact bytes it POSTs gets ✓ verified — this is how
  `scripts/simulate-webhook.mjs` produces verified deliveries. Verification is **advisory**: a
  bad/missing signature is still stored and shown, flagged ⚠.
- 2026-07-14 (S12): **real scheduled-Liveboard webhooks to a plain endpoint arrive as
  `multipart/form-data`** — a JSON metadata part **plus the rendered report as a binary file
  attachment** (PDF/CSV/XLSX); only *storage-destination* (GCS/S3) configs send pure JSON with file
  links. The JSON-only `express.json` receiver could not capture the file, so the receiver was made
  multipart-aware: `lib/multipart.js` (dependency-free, binary-safe parser) + `server.js` uses
  `express.raw({type:'multipart/form-data'})` to get raw bytes, `parseMultipart`/`splitMultipart` to
  extract `{meta, files}`, keeps file bytes out-of-band in a `webhookFiles` Map (evicted with the
  50-event ring), and serves them at `GET /api/webhook/file/:recId/:fileId`. HMAC is verified over the
  raw multipart bytes. `server.js` is guard-protected, so this change needs the human-approved label.
- 2026-07-14 (S12): the "RLS-blocked user got no webhook" signal is inferred, not in the payload —
  the inbox summary diffs `scheduleDetails.userIds` (directly-named users) against delivered `USER`
  ids. It can't see **group-expanded** members (their ids aren't in `userIds`), so for the live test
  name the blocked user **directly** on the schedule. The email-vs-webhook check disambiguates
  expected-RLS from a webhook defect (email fails too → by design; email succeeds → likely a bug).

## Upstream / SDK

- 2026-07-10 (W2): the ts-watch detector reports SDK versions 1.49.1–1.50.0 newer than the pinned
  1.49.0. Bump procedure is in `docs/ts-watch-playbook.md`; W2 is the open item.
