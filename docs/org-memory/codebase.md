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
- 2026-07-13 (discover, filed S14): CFB (custom-filter-bar) date columns emit STRING epoch runtime
  filters → silently dropped by TS. `buildParentRuntimeFilters().fromCfb` (app.js:3872) passes
  `cfbSelected` values untouched; only `fromActive` (app.js:3876) runs `dateAwareValues`. Values are
  stringified at load (`String(v)` app.js:3087) + DOM `cb.value` (app.js:3379); the code generator
  quotes them too (app.js:4487). Two-lens confirmed (correctness + data-integrity). Distinct from S5.
- 2026-07-13 (discover, filed S16): Inspector runtime date-RANGE upper bound uses start-of-day —
  `readValues` (app.js:1924) computes `isoToEpochSec(to)` (00:00:00 UTC) instead of
  `isoToEndOfDayEpochSec` as `applyDateFilterViaRuntime` (app.js:1657) does → `BW_INC` drops the final
  day's rows on DATE_TIME columns; day-granular DATE columns are unaffected.
- 2026-07-13 (discover, filed S15): `render()` (app.js:582) has FOUR exit paths but only
  `ai-insights` (app.js:606) and the main path (app.js:615) call `currentEmbed.destroy()`. The
  `!s.host` (app.js:593) and `needsMissing` (app.js:596-601) early returns LEAK the prior embed and
  leave `currentEmbed` non-null-but-stale → HostEvents route to the hidden wrong board via the
  `!currentEmbed` guards (app.js:662/3612/1641).
- 2026-07-13 (discover, filed S17): the 4s `fallback` overlay-hide timer is a per-render `const`
  (app.js:624; `enterDrill` app.js:3906) with no module handle; overlapping renders within 4s orphan
  the prior timer → spurious `setOverlay('hidden')` + "Embed handed off…" log against the live embed.
- 2026-07-13 (discover, AUDITED CLEAN): `embed.destroy()`-before-re-render holds on both live render
  SITES — `render()` destroys at app.js:615 before `doRender` (:634); `enterDrill()` destroys at
  app.js:3899 before `doRender` (:3908). (The BUG is the early-return exits that leave *no* new render
  — S15, above.) The Inspector **activeFilters** date path is correct: epoch strings in state coerced
  to NUMBERS via `dateAwareValues` (app.js:1618, `Number.isFinite` NaN guard) at trigger time, UTC via
  `Date.UTC` (`isoToEpochSec` app.js:1589). `pushRuntimeFilters` (app.js:661) honors
  UpdateRuntimeFilters-APPENDS — computes empty-`values` clears for applied-minus-desired columns and
  resets `appliedRuntimeCols` per render (:633). `onDone` fires on 5 SDK events but is idempotent
  (`pushRuntimeFilters` resends the full desired set; `cfbBuild` has `_cfbBuilding` dedupe) — no
  double-apply. Remaining filter defects are ONLY S14 (cfb string epochs) + S16 (range upper bound).

## Custom actions / navigation

- 2026-07-13 (discover, filed S13): `urlTemplate` is the ONE navigable hash-derived URL that skips
  the app's scheme guard. `state.js:262` sanitizes it with `str()` (length only), unlike `host`
  (state.js:246) and `cssUrl` (state.js:336) which use `validHost()` ("blocks javascript:/data:").
  A `#s=`-supplied `url` custom action with `urlTemplate:"javascript:…"` (no `{{}}` placeholder, so
  `.replace()` is a no-op) reaches `window.open(url,'_blank','noopener')` (app.js:3761-3763) and the
  `javascript:` scheme executes. `noopener` severs `window.opener` but does not stop script execution.
- 2026-07-22 (S13, FIXED — supersedes the line cites in the bullet above): the sink had drifted to
  `js/app.js` `window.__onCustomAction` and the `str()`-only sanitize to `state.js:264` — both cited
  numbers in the 2026-07-13 bullet were stale by ~1200 lines. **Line numbers in this file age fast;
  re-verify every cite before acting on it.** The hole is now closed at the SINK via `safeNavUrl()`
  (`new URL(String(u), location.href)` + `http:`/`https:` allowlist, returns `''` if refused), applied
  to the **post-substitution** URL. That ordering is load-bearing: guarding `reg.urlTemplate` instead
  would re-open the smuggle `java{{X}}script:alert(1)` (absent column → `''` → `javascript:`).
  `state.js` was deliberately NOT changed — `urlTemplate` is still length-only sanitized by design,
  which is what kept the PR off a guard-protected path.
- 2026-07-22 (S13, security lens, verified refused): mixed case, leading spaces/NUL, embedded
  tab/CR/LF (`java\tscript:`), `data:`/`vbscript:`/`blob:`/`view-source:`, and host-position
  substitution (`https://evil.com%2F.ok.com/` → throws → fail-closed). `window.open` exists exactly
  ONCE in the repo (the guarded URL-action sink); the `writeback` branch POSTs to a config-derived
  `${API_BASE}/api/writeback` and the `drill` branch only feeds a GUID to `enterDrill`, so neither
  navigates. `reg.webhook` is sanitized + registered but **never read** — dead field.
- 2026-07-22 (S13): `safeNavUrl` resolves relative templates against `location.href`, so scheme-less
  (`crm.example.com/x`), protocol-relative (`//host/x`), relative (`/lookup?id=`) and `#anchor`
  templates keep working **exactly as before** (the browser resolved them identically pre-fix). The
  guard is scheme-only, never a host allowlist. Consequence: `mailto:`/`tel:`/`slack://` actions are
  now refused (fail-closed, toast + log) — filed as **S18**. Returning the normalized `u.href` is
  destination-preserving for http(s) (default-port strip, IDN punycode, case, dot-segment collapse;
  query/fragment byte-preserved) and cannot double-encode, because `encodeURIComponent` substitution
  runs first.
- 2026-07-22 (S13, review): the editor-save check must validate the template's **literal leading
  scheme**, NOT the placeholder-stripped string. Stripping `https://{{Domain}}` yields `https://`,
  which `new URL` THROWS on → legitimate templates falsely rejected (same for `…/`, `…?q=1`, `…#f`);
  and `https://{{Host}}/x` strips to `https:///x` which parses as host `x`, i.e. it would validate a
  different URL than the one opened. The editor check is a nicety — shared links bypass the form
  entirely, so the SINK is the only trust boundary.
- 2026-07-22 (S13, tested — a plausible "fix" that is WRONG): the save-time scheme regex
  `[a-z][a-z0-9+.-]*` must KEEP the dot in its char class. It mirrors the WHATWG URL scheme grammar
  exactly, which is why it agrees with `safeNavUrl` on every input. Removing the dot to "stop
  misreading `crm.example.com:8080/x` as a scheme" is a false economy: `new URL` parses that scheme
  the same way (dots and all) and REFUSES it, so the form would accept a template the sink then
  blocks on every click — accept-then-block, strictly worse than rejecting at entry. `localhost:3000/x`
  is refused for the same reason and is unfixable lexically (`localhost:3000` and `tel:123` are the
  same `word:digits` shape). The remedy is user-facing: write `http://crm.example.com:8080/…`.
  Keep the two checks in lockstep — divergence is what creates accept-then-block.
- 2026-07-22 (S13, security lens, AUDITED CLEAN, low impact): `customActionRegistry[a.id]` uses
  link-derived ids that `state.js` does not proto-guard. `__proto__` re-points the registry's own
  prototype (not `Object.prototype`) and `toString`/`constructor` make `reg` truthy — but no
  dispatcher branch fires on either. No exploit today; would matter if the registry gained a
  `for…in` or a default-bearing lookup.
- 2026-07-13 (discover, AUDITED CLEAN, security lens): secrets/tokens are never serialized or
  persisted — the discovery bearer is in-memory only (discovery.js:9-12), the secret_key never
  reaches the browser, the token inspector redacts + uses `textContent`. Runtime filters are NOT
  relied on as a security boundary anywhere in the embed/filter path; entitlements go through
  server-side token claims in `js/auth.js` (`group_identifiers`/`variable_values`), per CLAUDE.md.

## Gates

- 2026-07-10 (M7 review): `scripts/smoke-test.mjs:23` (PORT 34917) and `scripts/boot-check.mjs:31`
  (PORT 34921) hardcode their server ports with no env override — the server-bound gates are NOT
  safe to run concurrently on one machine (parallel worktrees, or a reviewer running the suite
  alongside QA, collide with `EADDRINUSE` and produce phantom reds). Only one agent runs them at
  a time; M8 tracks making them parallel-safe.
- 2026-07-22 (S13): **a boot-check probe that stubs `window.open` cannot observe `javascript:`
  execution** — the stub prevents the navigation that would execute it, so a `window.__pwned`-style
  assertion reads `true` even with the guard fully removed (empirically confirmed during the mutation
  test). Load-bearing assertions must be of the form "no hostile value REACHED the sink". Every probe
  needs a positive control (a legit input that must still reach the sink) or the negative assertion
  can pass vacuously when the dispatcher breaks.
- 2026-07-22 (S13): a probe that computes a readiness flag must GATE on it — the S13 probe originally
  called `fire()` unconditionally, so a missing `window.__onCustomAction` threw, escaped the probe,
  closed the browser, and killed the run **without ever printing `BOOT CHECK: FAIL`** (non-zero exit,
  but nothing for a log-grepping consumer to see).
- 2026-07-22 (S13): probes share ONE default browser context (localStorage is common to all) and run
  in declaration order against a hard 120s whole-run watchdog that is not scaled per probe. A probe
  that writes state must be ordered after any probe that asserts on persistence. Filed as **S20**.
- 2026-07-22 (S13): `window.__onCustomAction` is a plain `window` global, dispatchable directly from a
  probe with a synthetic `{id, data:{clickedPoint:{selectedAttributes:[{column:{name},value}]}}}`
  payload — a host-free `#s=` link plus a direct call exercises registry-rebuild → `extractRow` →
  substitution with zero ThoughtSpot contact. Reusable pattern for custom-action probes.

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
