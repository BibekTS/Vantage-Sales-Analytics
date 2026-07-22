# Spotter Chat (MCP) — your own chat UI over the Spotter 3 MCP server

The **Spotter Chat (MCP)** rail section (under *Search & AI*, right below *Spotter AI*) is the
no-iframe counterpart to the `SpotterEmbed` section: the chat surface is yours, ThoughtSpot only
supplies the analysis. There is **no Visual Embed SDK and no LLM in the loop** — the server calls
the MCP tools directly.

It also carries a **text-customization layer**: vendor terms in the streamed prose ("Spotter",
"Liveboard") are rewritten to per-client labels ("DataAnalyzer", "Dashboard"), while URLs and
`iframe_url` values pass through untouched. That is the piece worth stealing for a real embed —
`lib/spotter-mcp/customize.mjs` and `lib/spotter-mcp/mcp-client.mjs` are standalone (no Express,
no shared globals) so they lift into another app as-is.

## Auth: it runs as you

**There is nothing to configure.** Connect in the app as usual and the section works — the relay
uses the credential you already have and **never mints**, the same rule `/api/filter-values`
follows. No caller token → `401`, so it is fail-closed by construction and can't become an
unauthenticated proxy. Spotter therefore sees the real end user: their object access and RLS apply,
not an admin's.

Where the bearer comes from, resolved fresh before **every turn** (so a lapsed token fixes itself
on the next question instead of dead-ending the conversation):

| Your connection | The bearer |
|---|---|
| **Auth: Trusted token** | the token already minted for the SDK (`Discovery.getBearerToken()`) |
| **Browser session (cookie)** | `GET /api/rest/2.0/auth/session/token` — *getCurrentUserToken*, 9.4.0.cl+. It **introspects** the session you already have and returns its token; it does not create one. |

The browser also sends the host it connected to (`tsHost`) — that's the cluster the token is scoped
to, which need not be the `THOUGHTSPOT_HOST` in `.env` (used only as a fallback). It becomes the
`x-ts-host` header; the request itself always goes to the fixed MCP URL.

Optional overrides, none required: `TS_MCP_URL`, `TS_MCP_DATA_SOURCE_ID` (pin every session to one
Worksheet/Model).

`GET /api/spotter-mcp/health` (with your `Authorization: Bearer …`) returns the live MCP tool list
and the active label map — the fastest check that the host and token work.

> **api-version matters.** The analytical-session tools exist only on `api-version=beta`.
> `api-version=2025-01-01` connects fine but lists the older toolset (`ping`, `createLiveboard`,
> `getRelevantQuestions`, `getAnswer`) — verified against the live endpoint 2026-07-21. The server
> logs a warning at connect time if the expected tools are missing.

## Request flow

The chat body also accepts `systemContext` — a persona / standing-instructions string ("Answer in
French", "you are advising the CFO") forwarded as `send_session_message additional_context` on
**every** turn (the session does not remember it server-side). Sanitized by `cleanContext()`:
control chars stripped (newlines kept), capped at 4000 chars. It steers tone and framing only — it
cannot widen data access beyond the caller's own token.

```
browser ──POST /api/spotter-mcp/chat {question, sessionId?} + YOUR bearer──▶ server
                                        ├─ create_analysis_session   (first turn only)
                                        ├─ send_session_message
                                        └─ get_session_updates (poll until is_done)
browser ◀────────────────── SSE: session | text | answer | done | error ──────────────
```

| Event | Payload |
|---|---|
| `session` | `{ sessionId, isNew }` — **always first**; the client sends it back on follow-ups so conversation context persists |
| `text` | `{ text, thinking }` — customized prose, streamed; `thinking` marks agent reasoning (`is_thinking`) |
| `answer` | `{ answer_id, answer_title, answer_query, iframe_url }` — title customized, `iframe_url` **untouched** |
| `done` / `error` | end of stream; `error` carries `authExpired: true` when your token was rejected |

The panel (`js/spotter-mcp.js`) inserts every streamed string with `textContent` and renders
`iframe_url` directly in an `<iframe>`.

Two hard-won rendering rules live in the panel:

- **Typewriter pacing.** `get_session_updates` returns everything generated since the last poll in
  one lump (batches land 2–4s apart regardless of the poll interval), so painting each SSE event
  verbatim renders whole paragraphs at once. The panel queues text per lane and drains a few
  characters per animation frame (rate scales with backlog, so it catches up within ~2.5s).
- **`flex: 0 0 auto` on `.smcp-card` is load-bearing.** The card is a flex item in the `.smcp-log`
  column and its `overflow: hidden` (corner rounding) zeroes its automatic minimum size — with the
  default `flex-shrink: 1`, the browser squeezes chart cards toward 0px as soon as the transcript
  overflows the panel. Text bubbles can't shrink below content, so *all* the squeeze lands on the
  charts: after a couple of questions every chart collapses to a sliver. The same `answer_id` arrives twice — a thinking preview then
the final version — so the client keys on it and replaces in place rather than adding a second chart.

## Design note: the holdback buffer

Substitution is word-boundary (`\bSpotter\b`) and case-preserving (`Spotter`→`DataAnalyzer`,
`spotter`→`dataAnalyzer`, `SPOTTER`→`DATAANALYZER`). URLs and markdown link targets are masked out
before substitution runs and restored afterwards, so `https://host/spotter/x` survives verbatim.

Streaming breaks naive substitution: `text_chunk` updates split wherever the API feels like it, so
`"Spot"` + `"ter is great"` would never match `\bSpotter\b`. `createStreamCustomizer()` therefore
buffers: each `push(chunk)` appends to a buffer and emits only up to a **safe cut point**, holding
back the tail. The cut is at least *(longest LABEL_MAP key − 1)* characters from the end — enough
that any term ending near the boundary is still whole — and is then pulled back further so it never
lands inside:

- a **word** (otherwise `Spot|ter` escapes substitution), or
- a **URL or markdown link target** that is still arriving (otherwise a half-arrived URL loses its
  protection and the term *inside* it gets rewritten — this actually failed in testing before the
  back-off was added; see `lib/spotter-mcp/customize.test.mjs`).

`flush()` emits whatever is still held when the stream ends. The result is chunk-size independent:
the test suite asserts that streaming at every chunk size from 1 to 17 produces byte-identical
output to customizing the whole string at once. Run it with `npm run test:spotter-mcp`.

Reasoning (`is_thinking`) and answer prose are interleaved on the wire but are separate streams, so
each gets its **own** buffer per turn — a held tail must never be flushed into the other lane.

### Remaining limitation

The buffer is per-turn and per-*stream*, not per-update-type. A term split across a
**`text_chunk` → `text` type transition** would not be joined: on a `text` update the server flushes
the holdback first and then customizes the `text` payload separately, so `"Spot"` (held from a
chunk) followed by a `text` update starting `"ter…"` emits `Spot` + `ter…` unreplaced. The API is
not observed to do this — `text` appears as a standalone whole-message update — and joining them
would require knowing that a `text` update *continues* the chunk stream rather than replacing it.
If the API ever does split that way, the fix is to route `text` payloads through the same
`push()`/`flush()` buffer instead of customizing them independently.

## Layout

```
lib/spotter-mcp/router.mjs         Express router + SSE relay; the only place the two libs meet
lib/spotter-mcp/mcp-client.mjs     MCP Streamable HTTP client + analytical-session flow (standalone)
lib/spotter-mcp/customize.mjs      LABEL_MAP substitution + streaming holdback buffer (standalone)
lib/spotter-mcp/labels.json        the swappable per-client label map
lib/spotter-mcp/customize.test.mjs node:test unit tests for the customization layer
js/spotter-mcp.js                  the chat panel (custom DOM, textContent only)
```

ESM (`.mjs`) because the MCP SDK is ESM-only — `server.js` is CommonJS and loads the router with a
dynamic `import()` on first request.

The MCP bearer is fixed at transport construction, so a connection belongs to one `(host, token)`
pair. The router caches exactly one and rebuilds it whenever that pair changes (a token refresh, a
different user) — a map keyed by token would pin every expired token's connection open for the life
of the process.
