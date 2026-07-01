# Running Host Code from a Liveboard Button — ThoughtSpot Callback Custom Actions

This guide explains how to add a button to an embedded ThoughtSpot liveboard (or
visualization) that runs **your own code in the host application** when clicked — for
example, to take the visualization's data and generate a custom, multi‑page PDF.

The concrete example throughout is a **"Download PDF"** button that pulls the rows behind a
visualization and builds a paginated PDF in the browser. The same pattern applies to any host
logic: write‑back to a system of record, open a tailored view, kick off a workflow, etc.

---

## 1. The idea in one picture

ThoughtSpot runs inside an iframe and cannot execute your application's JavaScript. So a
"button that runs custom logic" is really two halves communicating across the iframe boundary:

```
  ┌─────────────────────────────┐        EmbedEvent.CustomAction        ┌──────────────────────────┐
  │   ThoughtSpot (in iframe)    │  ───────────  postMessage  ────────▶  │   Your host application  │
  │                             │                                      │                          │
  │  User clicks the custom      │   { id, data, answerService, … }     │  1. match the action id  │
  │  action button               │                                      │  2. fetch the data       │
  │  (type = Callback)           │                                      │  3. do the work (PDF)    │
  └─────────────────────────────┘                                      └──────────────────────────┘
```

- **Inside ThoughtSpot:** a **Callback** custom action. When clicked it does nothing on its
  own — it emits an `EmbedEvent.CustomAction` event to the host, carrying an action **id** and
  some context.
- **In your host app:** you listen for that event, check the id, and run whatever you want.

That is the entire model: **ThoughtSpot fires an event → the host does the work.**

### Callback vs URL actions

Custom actions come in two flavors:

| Type         | What it does                                   | Runs host code? |
| ------------ | ---------------------------------------------- | --------------- |
| **URL**      | Opens a URL (optionally with row values in it) | No              |
| **Callback** | Emits `EmbedEvent.CustomAction` to the host    | **Yes**         |

For anything that needs to process data or run logic in your app, use **Callback**.

---

## 2. Two ways to create the action

Both produce the same `EmbedEvent.CustomAction`; pick based on who should control it.

1. **In the ThoughtSpot UI** — *Develop → Customizations → Custom actions → Create action.*
   Type = **Callback**, give it a label and copy the generated **action id**. Persistent and
   managed in ThoughtSpot; requires developer/admin privilege. You can scope where it appears
   (all visualizations, specific ones, liveboard level, etc.).

2. **Injected by the SDK** — pass a `customActions` array in the embed configuration at render
   time. The **label, placement, and id are controlled entirely in your code**, and it can't
   collide with ThoughtSpot's built‑in actions. No TS‑side setup needed.

This guide uses the **SDK‑injected** approach because it keeps everything in one place and is
the most predictable. If you prefer the UI‑created action, everything from Section 4 onward is
identical — you just skip the injection step and match on the id ThoughtSpot generated.

---

## 3. Prerequisites

- The **ThoughtSpot Visual Embed SDK** loaded, and an embed rendered
  (`LiveboardEmbed`, `AppEmbed`, `SearchEmbed`, …). Keep a reference to the embed instance.
- An **authenticated ThoughtSpot session** (session cookie or trusted auth). Both the button
  and the data fetch run against that session.
- **The data must exist in ThoughtSpot.** The button can only export what the visualization's
  underlying *answer* actually contains (see gotcha #4). If a visualization renders data that
  is hard‑coded in a custom‑chart script rather than coming from a search, there is nothing for
  the host to fetch.

---

## 4. How it works, end to end

Click‑to‑PDF flow:

```
User clicks the custom action
   │
   ▼
ThoughtSpot emits EmbedEvent.CustomAction ──postMessage──▶ host
   │
embed.on(EmbedEvent.CustomAction, payload => handle(payload))
   │
   ▼
handler:
   1. Match the action id            (payload.id ?? payload.data.id)
   2. Get an answer session          (payload.answerService OR embed.getAnswerService(vizId))
   3. Fetch + paginate the rows      (answerService.fetchData(offset, size))
   4. Normalize columns → rows       (transpose columnDataLite, parse values)
   5. Do the work                    (build the PDF, download as a Blob)
```

---

## 5. Step‑by‑step implementation

### Step 1 — Embed the liveboard and keep the instance

```js
import {
  init, AuthType, EmbedEvent,
  LiveboardEmbed, CustomActionsPosition, CustomActionTarget,
} from "@thoughtspot/visual-embed-sdk";

init({ thoughtSpotHost: "https://your-instance.thoughtspot.cloud", authType: AuthType.None /* or your auth */ });

const embed = new LiveboardEmbed(document.getElementById("ts-embed"), {
  liveboardId: "<LIVEBOARD_GUID>",
  frameParams: { width: "100%", height: "100%" },
});
```

### Step 2 — Register the button (SDK‑injected)

Add a `customActions` entry to the embed configuration:

```js
const PDF_ACTION_ID = "download-invoice-pdf"; // your own id; this is the contract with the handler

const embed = new LiveboardEmbed(el, {
  liveboardId: "<LIVEBOARD_GUID>",
  customActions: [
    {
      id: PDF_ACTION_ID,
      name: "Download PDF",                     // the label users see
      position: CustomActionsPosition.MENU,     // PRIMARY = button · MENU = "…" overflow · CONTEXTMENU = right‑click
      target: CustomActionTarget.LIVEBOARD,     // LIVEBOARD · VIZ · ANSWER · SPOTTER
    },
  ],
});
```

- **`position`** — `PRIMARY` (a visible button), `MENU` (the "…" overflow menu), or
  `CONTEXTMENU` (right‑click on a data point).
- **`target`** — where it appears: `LIVEBOARD` (whole liveboard), `VIZ` (each
  visualization's "…" menu), `ANSWER`, or `SPOTTER`.
- **`id`** is the contract. The label can be anything; the handler matches on the id.

### Step 3 — Listen for the event

```js
embed.on(EmbedEvent.CustomAction, async (payload) => {
  const id = payload?.id ?? payload?.data?.id;   // Classic vs New experience — read both
  if (id !== PDF_ACTION_ID) return;
  await handlePdf(payload);
});

embed.render();
```

### Step 4 — Get an answer session

An **answer session** is what lets you query the data behind a visualization. Where it comes
from depends on where the action fired:

- **Visualization‑level action** → the payload usually already carries a live
  `answerService` with a session.
- **Liveboard‑level action** → the payload's `answerService` has **no** session; calling
  `fetchData()` on it throws. You must mint one with `embed.getAnswerService(vizId)`.

Handle both:

```js
async function resolveAnswerService(payload) {
  // 1) Use the payload's service if it already has a real session.
  const fromEvent = payload?.answerService ?? payload?.data?.answerService;
  if (fromEvent?.getSession?.()?.sessionId) return fromEvent;

  // 2) Otherwise mint a session for a specific viz (liveboard actions are sessionless).
  const containers = (payload?.data ?? payload)?.pinboardDetails?.containers ?? [];
  const candidateVizIds = [];
  containers.forEach((c) => [c.id, c.refVizId, c.answerId].forEach((x) => x && candidateVizIds.push(x)));
  candidateVizIds.push(undefined); // last resort: let the host pick (works for single‑viz boards)

  for (const vizId of candidateVizIds) {
    try {
      const svc = await embed.getAnswerService(vizId);
      if (svc?.getSession?.()?.sessionId) return svc;
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}
```

### Step 5 — Fetch the data (with pagination)

`answerService.fetchData(offset, size)` returns one page as `{ columns, data }`. Loop until a
short page signals the end:

```js
async function fetchAllRows(svc, pageSize = 1000) {
  let offset = 0, rows = [], schema = null;
  for (;;) {
    const res = await svc.fetchData(offset, pageSize);
    if (!schema) schema = (res.columns ?? []).map((c) => {
      const col = c.column ?? c;
      return { name: col.name, type: col.type }; // type: "MEASURE" | "ATTRIBUTE"
    });
    const page = normalizeRows(res);
    rows = rows.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return { rows, schema: schema ?? [] };
}
```

### Step 6 — Normalize columns → rows

`fetchData` returns **column‑oriented** data (`data.columnDataLite`), and the values are
sometimes a **JSON string** rather than an array. Transpose to plain row objects keyed by
column name, and parse values defensively:

```js
function normalizeRows(res) {
  // columnId → display name
  const nameById = {};
  (res.columns ?? []).forEach((c) => {
    const col = c.column ?? c;
    if (col.id) nameById[col.id] = col.name;
  });

  const lite = res.data?.columnDataLite ?? res.data?.data?.columnDataLite;
  if (!Array.isArray(lite)) return [];

  // Each entry: { columnId, dataValue: [v0, v1, …] } — dataValue may be a JSON string.
  const valuesOf = (c) => {
    const raw = c.dataValue ?? c.values ?? c.data;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string" && raw.trim().startsWith("[")) {
      try { return JSON.parse(raw); } catch { /* fall through */ }
    }
    return raw == null ? [] : [raw];
  };

  const n = lite.reduce((m, c) => Math.max(m, valuesOf(c).length), 0);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    lite.forEach((c, idx) => { row[nameById[c.columnId] ?? c.columnId ?? idx] = valuesOf(c)[i]; });
    rows.push(row);
  }
  return rows;
}
```

Because live column display names vary in case / punctuation / aggregation prefixes, resolve
the columns you need **fuzzily** rather than hard‑coding exact strings:

```js
function pickCol(names, candidates) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const c of candidates) if (names.includes(c)) return c;                    // exact
  for (const c of candidates) { const hit = names.find((n) => norm(n) === norm(c)); if (hit) return hit; }
  for (const c of candidates) { const hit = names.find((n) => norm(n).includes(norm(c))); if (hit) return hit; }
  return null;
}
```

### Step 7 — Do the work (build & download)

Now you have clean rows. Group / transform them and produce your output. File downloads work
inside the iframe (`window.print()` does **not**), so build the file in memory and save it as a
Blob:

```js
function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function handlePdf(payload) {
  const svc = await resolveAnswerService(payload);
  if (!svc) return console.warn("No answer session available");
  const { rows, schema } = await fetchAllRows(svc);
  const pdfBytes = buildPdf(rows, schema);   // your own PDF builder (pure JS, no CDN needed)
  download(pdfBytes, "report.pdf", "application/pdf");
}
```

> In our implementation the PDF builder is a small, dependency‑free routine that lays out text
> with the browser's canvas metrics and emits PDF bytes directly — no external library or CDN,
> which keeps it working inside the sandboxed iframe.

---

## 6. Key things to know (the non‑obvious parts)

These are the details that most often cost time:

1. **Read the action id from both places.** New experience puts it at `payload.data.id`,
   Classic at `payload.id`. Use `payload?.id ?? payload?.data?.id`.

2. **Liveboard actions have no answer session.** `payload.answerService.fetchData()` throws
   (`Cannot convert undefined or null to object`) because there is no session. Mint one with
   `embed.getAnswerService(vizId)`. Visualization‑level actions usually *do* carry a session.

3. **`answerService` is a live object, not JSON.** It will not appear in
   `JSON.stringify(payload)` (methods don't serialize). It is still there — don't assume it's
   missing because a log dump doesn't show it.

4. **The data must live in ThoughtSpot.** `fetchData()` returns the columns of the
   visualization's *answer*. If the numbers on screen are produced by a custom‑chart script's
   own hard‑coded data (rather than a real search), the host has nothing to fetch — the export
   will be empty. Bind the visualization to a real search first.

5. **Data comes back column‑oriented, sometimes stringified.** The shape is
   `data.columnDataLite = [{ columnId, dataValue }]`, and `dataValue` may be a JSON **string**.
   Transpose to rows and `JSON.parse` string values.

6. **Column names vary.** Resolve them fuzzily (exact → normalized → contains) instead of
   hard‑coding display names.

7. **Always paginate.** `fetchData(offset, size)` returns one page; loop until you get a short
   one.

8. **Downloads work in the iframe; `window.print()` doesn't.** Build files in memory and save
   as a Blob.

---

## 7. Implementation checklist

1. Embed the liveboard; keep the embed instance.
2. Register the Callback action (SDK `customActions`, or create it in Develop → Custom actions).
3. `embed.on(EmbedEvent.CustomAction, handler)`.
4. In the handler, match `payload?.id ?? payload?.data?.id`.
5. Resolve an answer session: payload's `answerService` if it has a session, else
   `embed.getAnswerService(vizId)`.
6. Fetch and paginate with `answerService.fetchData(offset, size)`.
7. Normalize `columnDataLite` → row objects; parse stringified values; resolve columns fuzzily.
8. Do the work — build the output and download it as a Blob.

---

## 8. Reference

**Event:** `EmbedEvent.CustomAction` — fired to the host when a Callback action is clicked.
Payload includes the action `id`, `data`, and (for viz context) a live `answerService`.

**`CustomActionsPosition`:** `PRIMARY` · `MENU` · `CONTEXTMENU`
**`CustomActionTarget`:** `LIVEBOARD` · `VIZ` · `ANSWER` · `SPOTTER`

**`answerService` methods used here:**
- `getSession()` — returns the session (check `.sessionId` to know if it's usable).
- `fetchData(offset, size)` — returns `{ columns, data }` for the answer (paginated).

**`embed.getAnswerService(vizId)`** — mints an `answerService` (with a fresh session) for a
specific visualization on a liveboard. Use this when the action fired at the liveboard level.
