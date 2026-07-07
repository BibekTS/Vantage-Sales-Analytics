# Per‑User Personal Copies of a Liveboard — Editable Clones with a Tab Strip

This guide explains how to let each end user make their own **personal copy (or copies)** of a
standard embedded liveboard, shown as a **tab strip** right next to it, so a user can switch
seamlessly between the shared **Standard** board and their **personalized** clones. Multiple
users each get their own copies, and the same mechanism works for **any** liveboard.

The concrete example throughout is a **"＋ Personalize"** button that clones the current board,
adds a **My copy** tab, and opens it editable. Each copy is a full, independent, user‑owned
liveboard — the user can add/remove visualizations, change formulas, and re‑arrange tiles.

---

## 1. The idea in one picture

A "personal copy" is a **real ThoughtSpot liveboard object**, created by (and owned by) the end
user, that sits alongside the standard board in a host‑app tab strip:

```
   Host application (your page)
   ┌───────────────────────────────────────────────────────────────┐
   │  [ Standard ]  [ My copy 1 ]  [ My copy 2 ]  [ ＋ Personalize ] │  ← host-app tab strip
   ├───────────────────────────────────────────────────────────────┤
   │                                                               │
   │            LiveboardEmbed( liveboardId = <active> )            │  ← one iframe, id swapped per tab
   │                                                               │
   └───────────────────────────────────────────────────────────────┘

   ＋ Personalize ──▶ POST /metadata/copyobject ──▶ new liveboard GUID (owned by the user)
                     POST /tags/assign          ──▶ tag it "Personal" (re-discoverable) and
                                                    "src:<source GUID>" (records WHICH board it copies)
```

Two halves:

- **A tab strip in your host app** — plain UI. It remembers the **standard board id** as tab #1
  and, when a copy tab is active, re‑embeds the iframe with that copy's id. ThoughtSpot has no
  "copies next to a board" concept; the strip is entirely yours.
- **REST calls to ThoughtSpot** — `copyobject` clones the board, `tags/assign` labels the clone
  (`Personal` + a `src:<GUID>` tag recording its source board), and `metadata/search` lists a user's
  clones so the strip can be rebuilt on any device.

That is the entire model: **the host app owns the tab UI; ThoughtSpot owns the objects.**

### Editable copies vs native Personalised Views

There are two different ways to give users "their own version" of a board — pick by need:

| Approach                          | What the user gets                                   | New objects? | Tracks the standard board? |
| --------------------------------- | ---------------------------------------------------- | ------------ | -------------------------- |
| **Personalised Views** (native)   | Saved **filter/sort/parameter** snapshots            | No           | **Yes** (always latest)    |
| **Personal copies** (this guide)  | A full **editable clone** (add/remove vizzes, edit)  | **Yes**      | No (a point‑in‑time copy)  |

If users only need to save a *filtered view*, enable the SDK's native
`Action.PersonalizedViewsDropdown` and stop — no REST, no copies. Use the pattern below only
when users need to **restructure** the board.

---

## 2. What it's built on (three REST calls + one host event)

| Call                                              | Purpose                                            | Since        |
| ------------------------------------------------- | -------------------------------------------------- | ------------ |
| `POST /api/rest/2.0/metadata/copyobject`          | Clone a liveboard into a **user‑owned** copy       | 10.3.0.cl+   |
| `POST /api/rest/2.0/tags/assign`                  | Tag the copy so it can be re‑discovered            | 9.0.0.cl+    |
| `POST /api/rest/2.0/metadata/search`              | List a user's copies (scoped by owner + tag)       | 9.0.0.cl+    |
| `HostEvent.Edit`                                  | Open the fresh copy in edit mode                   | 8.7.0.cl+    |

(Plus `GET /api/rest/2.0/auth/session/user` to learn *who* the caller is, and
`POST /api/rest/2.0/metadata/delete` to remove a copy.)

---

## 3. Prerequisites

- The **Visual Embed SDK** loaded with a rendered `LiveboardEmbed`. Keep a mutable reference to
  the embed instance (you will `destroy()` and recreate it when switching tabs).
- An **authenticated session**. Use **trusted auth** in production so each end user is
  authenticated as *themselves* — that identity is what makes copies per‑user (see §6).
- The caller needs rights to **create content** (for `copyobject`) and **edit** the copy (for
  `tags/assign` — the caller owns the fresh copy, so they have it). `copyobject` requires
  **10.3.0.cl or later**.
- **REST reachability.** Browser→ThoughtSpot REST is cross‑origin: either add your app origin to
  ThoughtSpot's CORS allowlist, or relay the calls through your own server (see gotcha #5).

---

## 4. How it works, end to end

```
User clicks "＋ Personalize" (Standard tab active)
   │
   ▼
1. POST /metadata/copyobject { identifier: <standard id>, type: 'LIVEBOARD', title }
       └─▶ returns { metadata_id } = the new copy's GUID, owned by the caller
   │
2. POST /tags/assign { metadata: [{ identifier: <copy id>, type: 'LIVEBOARD' }],
                       tag_identifiers: ['Personal', 'src:<standard id>'] }   ← records the source board
   │
3. Add a tab for the copy; make it the active tab
   │
4. Re-embed: embed.destroy() → new LiveboardEmbed({ liveboardId: <copy id> })
   │
5. On render, embed.trigger(HostEvent.Edit)   ← opens it editable ("personalize now")

Later / on another device:
   GET  /auth/session/user                     ← who am I?
   POST /metadata/search { created_by_user_identifiers: [me], tag_identifiers: ['src:<standard id>'] }
       └─▶ this user's copies OF THIS board (owner × src tag) — rebuild the tab strip, no title guessing
```

---

## 5. Step‑by‑step implementation

### Step 1 — Anchor on the standard board; track the active copy separately

The single most important rule: **the standard board id is the anchor and never changes.** Track
the active copy as a *separate* value; only the rendered embed points at it.

```js
let sourceLiveboardId = "<STANDARD_LIVEBOARD_GUID>"; // tab #1, the shared board — never overwritten
let activeCopyId = "";                               // "" = Standard; else a copy's GUID
let copies = [];                                     // [{ id, title }] for THIS source board

const effectiveId = () => activeCopyId || sourceLiveboardId; // what the iframe should render
```

Keeping the source id fixed is what guarantees "Standard" is always available as tab #1 and keeps
copy discovery keyed to the real board (Step 5). If you overwrite it with a copy id, you lose both.

### Step 2 — The tab strip and switching boards

Switching a tab is just: destroy the embed and make a new one with a different `liveboardId`.

```js
import { init, AuthType, LiveboardEmbed, HostEvent, EmbedEvent } from "@thoughtspot/visual-embed-sdk";

init({ thoughtSpotHost: "https://your-instance.thoughtspot.cloud", authType: AuthType.None /* or trusted */ });

let embed;
function renderBoard() {
  if (embed) embed.destroy();
  embed = new LiveboardEmbed(document.getElementById("ts-embed"), {
    liveboardId: effectiveId(),                 // ← the active tab's board
    frameParams: { width: "100%", height: "100%" },
  });
  embed.render();
}

function switchTab(copyId) {          // "" for Standard, else a copy id
  if (copyId === activeCopyId) return;
  activeCopyId = copyId;
  renderBoard();
  renderStrip();
}
```

`renderStrip()` is ordinary DOM: a **Standard** button first (always), one button per `copies`
entry, and a **＋ Personalize** button shown **only when Standard is active** (so a user can't
personalize a copy — no copies‑of‑copies).

### Step 3 — Create a copy (and tag it)

```js
const REST = { "Content-Type": "application/json", Accept: "application/json" /*, Authorization: `Bearer ${token}` */ };
const HOST = "https://your-instance.thoughtspot.cloud";
const TAG  = "Personal";
const srcTag = (boardId) => `src:${boardId}`;   // per-source tag: records which board a copy was cloned from

async function createPersonalCopy(title) {
  // 1) Clone — the new board is owned by the calling user.
  const res = await fetch(`${HOST}/api/rest/2.0/metadata/copyobject`, {
    method: "POST", headers: REST, credentials: "include",
    body: JSON.stringify({ identifier: sourceLiveboardId, type: "LIVEBOARD", title }),
  });
  if (!res.ok) throw new Error(`copyobject ${res.status}`); // 403 = no create/view rights; needs 10.3.0.cl+
  const { metadata_id: copyId } = await res.json();

  // 2) Tag it (best-effort; keep the copy even if tagging fails):
  //    • TAG ("Personal")          → re-discovers a user's copies + excludes them from the source picker.
  //    • srcTag(sourceLiveboardId) → records WHICH board this copies, so discovery attributes it by tag,
  //      not by title (rename-proof, server-side filterable).
  await ensureTag(TAG); await ensureTag(srcTag(sourceLiveboardId));
  await fetch(`${HOST}/api/rest/2.0/tags/assign`, {
    method: "POST", headers: REST, credentials: "include",
    body: JSON.stringify({
      metadata: [{ identifier: copyId, type: "LIVEBOARD" }],
      tag_identifiers: [TAG, srcTag(sourceLiveboardId)],
    }),
  }).catch(() => {});

  return copyId;
}

// tags/assign needs the tag to exist; create-if-missing is idempotent enough (409/400 = already there).
async function ensureTag(name) {
  const r = await fetch(`${HOST}/api/rest/2.0/tags/create`, {
    method: "POST", headers: REST, credentials: "include", body: JSON.stringify({ name }),
  });
  return r.ok || r.status === 409 || r.status === 400;
}
```

Give the copy a **descriptive title** (e.g. `"{Board name} — {user} #{n}"`) — it's what shows in
ThoughtSpot's own object list and a friendly default tab label. Attribution to the source board,
though, rides on the `src:<GUID>` **tag**, not the title: titles get renamed, the GUID tag doesn't.
The title is only a *fallback* for legacy copies made before the tag (§5 Step 5, gotcha #4).

### Step 4 — Wire "＋ Personalize" and open the copy editable

```js
async function onPersonalize() {
  const title = `${standardName} — ${currentUser.displayName} #${copies.length + 1}`;
  const copyId = await createPersonalCopy(title);

  copies.push({ id: copyId, title });
  activeCopyId = copyId;
  justCreated = copyId;          // flag so the next render opens it editable
  renderBoard();
  renderStrip();
}

// When the freshly-created copy finishes rendering, drop the user straight into edit mode.
function attachEditOnCreate() {
  embed.on(EmbedEvent.LiveboardRendered, () => {
    if (justCreated && activeCopyId === justCreated) {
      justCreated = "";
      embed.trigger(HostEvent.Edit);   // the "personalize now" moment
    }
  });
}
```

### Step 5 — Rediscover a user's copies (owner × src‑tag), exact per board

So tabs reappear on reload / another device, list the user's copies from ThoughtSpot rather than
from any app‑side store:

```js
async function whoAmI() {
  const r = await fetch(`${HOST}/api/rest/2.0/auth/session/user`, { headers: REST, credentials: "include" });
  const d = await r.json();
  return { id: d.id, name: d.name, displayName: d.display_name }; // use id (GUID) for scoping
}

// This user's copies OF THIS board — owner scopes the user, the src:<GUID> tag scopes the board.
// Exact and server-side: no title matching, no client cache, rebuilds on any device.
async function listCopiesForBoard(me) {
  const r = await fetch(`${HOST}/api/rest/2.0/metadata/search`, {
    method: "POST", headers: REST, credentials: "include",
    body: JSON.stringify({
      metadata: [{ type: "LIVEBOARD" }],
      created_by_user_identifiers: [me.id],         // ← per-user isolation
      tag_identifiers: [srcTag(sourceLiveboardId)], // ← this board's copies only (src:<GUID>)
      record_size: -1, record_offset: 0,
    }),
  });
  return (await r.json()).map((m) => ({ id: m.metadata_id, title: m.metadata_name }));
}
```

`created_by_user + src:<GUID>` gives you *this user's copies of this exact board* in one query — the
two filters are the two axes (user × board), and neither depends on titles or a client cache, so both
survive renames and any device. Just render what comes back:

```js
async function refreshCopiesForSource(me) {
  copies = await listCopiesForBoard(me);                             // owner × src:<GUID> — exact
  if (!copies.some((c) => c.id === activeCopyId)) activeCopyId = ""; // active copy deleted elsewhere → Standard
  renderStrip();
}
```

> **Legacy fallback.** Copies made *before* you added the `src:` tag (or whose tagging failed) won't
> carry it, so the exact query won't return them. To recover those, also query owner + `Personal` and
> keep copies whose title starts with the board's name (or that you cached locally) — the brittle title
> match, used only as a backstop. Best is a one‑time **backfill**: assign `src:<sourceGuid>` to old
> copies once, then every copy is discovered the exact way.

### Worked example — attributing copies to the right board (3 boards × 3 users)

Steps 3 and 5 already tag each copy with a **per‑source tag keyed to the standard board's GUID**
(`src:<sourceGuid>`) and discover by it. Here's *why* that two‑axis model — `created_by_user`
(whose) × `src:<GUID>` (which board) — scales cleanly across several boards and users: the src tag
is immutable, so it survives renaming the board *or* the copy, and needs no client cache. Recapping
the create call from Step 3:

```js
async function createPersonalCopy(title) {
  const copyId = /* … POST /metadata/copyobject as in Step 3 … */;
  await ensureTag("Personal");
  await ensureTag(`src:${sourceLiveboardId}`);              // e.g. "src:lb-A" — the source board's GUID
  await fetch(`${HOST}/api/rest/2.0/tags/assign`, {
    method: "POST", headers: REST, credentials: "include",
    body: JSON.stringify({
      metadata: [{ identifier: copyId, type: "LIVEBOARD" }],
      tag_identifiers: ["Personal", `src:${sourceLiveboardId}`],
    }),
  });
  return copyId;
}
```

Discovery for a board is then a single **exact** query — one specific tag, so there's no AND/OR
ambiguity, no naming heuristic, and no cache:

```js
async function listCopiesForBoard(me, boardId) {
  const r = await fetch(`${HOST}/api/rest/2.0/metadata/search`, {
    method: "POST", headers: REST, credentials: "include",
    body: JSON.stringify({
      metadata: [{ type: "LIVEBOARD" }],
      created_by_user_identifiers: [me.id],     // whose
      tag_identifiers: [`src:${boardId}`],       // of which board (GUID)
      record_size: -1,
    }),
  });
  return (await r.json()).map((m) => ({ id: m.metadata_id, title: m.metadata_name }));
}
```

**Scenario.** Three standard boards — **A** `lb-A`, **B** `lb-B`, **C** `lb-C` — and three users,
**Sam / Alex / Josh**. Each user clones one or two of them. Every copy is *owned by its maker* and
carries `Personal` + `src:<board GUID>`:

| Copy (a real liveboard object)          | Owner | Tags                     |
| --------------------------------------- | ----- | ------------------------ |
| Sales Liveboard — Sam #1                | Sam   | `Personal`, `src:lb-A`   |
| Sales Liveboard — Sam #2                | Sam   | `Personal`, `src:lb-A`   |
| Marketing Liveboard — Sam #1            | Sam   | `Personal`, `src:lb-B`   |
| Sales Liveboard — Alex #1               | Alex  | `Personal`, `src:lb-A`   |
| Ops Liveboard — Alex #1                 | Alex  | `Personal`, `src:lb-C`   |
| Marketing Liveboard — Josh #1           | Josh  | `Personal`, `src:lb-B`   |
| Ops Liveboard — Josh #1                 | Josh  | `Personal`, `src:lb-C`   |
| Ops Liveboard — Josh #2                 | Josh  | `Personal`, `src:lb-C`   |

The tab strip is driven by **owner × src‑tag**, so each user only ever sees *their own* copies of
*the board they're on*:

| Viewer | Board on screen | Query (`created_by` + `tag`) | Tabs shown                                   |
| ------ | --------------- | ---------------------------- | -------------------------------------------- |
| Sam    | A               | `[Sam]` + `src:lb-A`         | Standard · Sales — Sam #1 · Sales — Sam #2 · ＋ |
| Sam    | B               | `[Sam]` + `src:lb-B`         | Standard · Marketing — Sam #1 · ＋            |
| Sam    | C               | `[Sam]` + `src:lb-C`         | Standard · ＋   (Sam has none yet)            |
| Alex   | A               | `[Alex]` + `src:lb-A`        | Standard · Sales — Alex #1 · ＋               |
| Alex   | C               | `[Alex]` + `src:lb-C`        | Standard · Ops — Alex #1 · ＋                 |
| Josh   | C               | `[Josh]` + `src:lb-C`        | Standard · Ops — Josh #1 · Ops — Josh #2 · ＋ |

Two axes, cleanly separated — and neither depends on titles or a client cache, so both survive
renames and work on any device:

- **`created_by_user`** isolates *users* from each other (Sam never sees Alex's or Josh's copies).
- **`src:<GUID>`** isolates *boards* from each other (on board A, Sam sees only his A‑copies, not
  his B‑copy). Because the tag is the board's **GUID**, renaming board A doesn't strip its copies
  of `src:lb-A`.

The same two tags make **admin governance** a clean two‑axis filter, no owner scoping required:

- *"All of Josh's personal copies"* → search `created_by:[Josh]` + `Personal`.
- *"Everything derived from board C"* (any owner) → search `src:lb-C` → audit, or bulk‑delete when
  board C is retired.

> **Naming‑convention fallback.** If you can't add per‑source tags, you can instead attribute by
> **title prefix** — name copies `"{board name} — {user} #{n}"` and match copies whose title starts
> with the board's name. It's simpler but brittle: it breaks if two boards share a name, if a user
> renames the copy's title, or if the board is renamed. Prefer the `src:<GUID>` tag when you can.

#### Where to store the source → copy link

ThoughtSpot does **not** record "this liveboard is a copy of that one" — a copy is fully
independent, with **no backlink**. So the copy's own GUID identifies *the copy*, not its origin;
you must record the **source board's GUID** yourself. Key both axes on GUIDs (the user's GUID for
owner, the board's GUID for source); the only real choice is *where the source GUID lives*:

| Where                      | Set it with                            | Filter by it                        | Trade‑off                                          |
| -------------------------- | -------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| **Tag** `src:<guid>`       | `tags/assign` (one extra call)         | `tag_identifiers` — **server‑side** | Exact, rename‑proof, DB does the filtering ✅       |
| **Copy `description`**     | `copyobject` `description` (same call) | fetch owner's copies, parse — client| One call, hidden from the UI; not server‑filterable |
| **External map** (your DB) | write `{ copyId → sourceId, owner }`   | your own query                      | Authoritative + cross‑device, but app‑owned state   |

`copyobject` accepts `{ identifier, type, title, description }`, so you can stash the source GUID
in **`description`** on the very same create call and skip the separate tag — at the cost of a
client‑side filter, since `metadata/search` filters by `tag_identifiers` but not by description:

```js
// One-call variant: encode the source GUID in the copy's description instead of a src: tag.
await fetch(`${HOST}/api/rest/2.0/metadata/copyobject`, {
  method: "POST", headers: REST, credentials: "include",
  body: JSON.stringify({
    identifier: sourceLiveboardId, type: "LIVEBOARD", title,
    description: `src:${sourceLiveboardId}`,   // ← the origin, in the copy's own metadata
  }),
});
// …then discover with owner scoping + include_details, and keep copies whose description == `src:${boardId}`.
```

(`obj_identifier`/CustomObjectId is also searchable, but it's meant for deployment FQNs, must be
unique, and isn't settable via `copyobject` — it'd need a separate update, so it's rarely worth it.)

**Use the source board's GUID as the key either way** — as a `src:<guid>` **tag** for server‑side
filtering (best at scale), or in the **description** for a single create call with a client filter.

### Step 6 — Delete a copy

```js
async function deleteCopy(copyId) {
  const r = await fetch(`${HOST}/api/rest/2.0/metadata/delete`, {
    method: "POST", headers: REST, credentials: "include",
    body: JSON.stringify({ metadata: [{ identifier: copyId, type: "LIVEBOARD" }] }),
  });
  if (!r.ok) throw new Error(`delete ${r.status}`);
  copies = copies.filter((c) => c.id !== copyId);
  if (activeCopyId === copyId) activeCopyId = "";  // fall back to Standard
  renderBoard(); renderStrip();
}
```

---

## 6. Scale & manageability (multiple users at once)

The isolation is **ThoughtSpot's object model, not app state** — that is the design decision that
makes this scale:

- **Ownership = per‑user isolation.** `copyobject` runs as the caller's identity, so each copy is
  owned by the user who made it, and discovery is `created_by_user_identifiers`‑scoped. **User A
  cannot see User B's copies** — enforced by ThoughtSpot permissions, not by app logic.
- **No per‑user store to maintain.** The "user → copies" mapping is derived **live** from
  ThoughtSpot (owner + tag search). Keep only a small client cache for instant paint, reconciled
  against the server. Works for 10 users or 10,000 with nothing to provision.
- **Repeatable per board, zero new code.** Copies are keyed by source `liveboardId`. Turn it on
  for any board and the same machinery works.
- **RLS/ABAC still applies.** A copy is built on the same worksheet/model, so row‑level security
  is enforced at query time — personalizing can't expose data the user couldn't already see.
- **Trusted auth scales it.** Each end user authenticates as themselves, so copies are per‑identity
  automatically. If you relay REST through your own server, forward the **caller's own token** and
  never mint an admin one, so a user can only act as themselves.

Because these are **full copies**, be deliberate about three governance costs:

| Concern          | What happens                                                        | Lever                                                                 |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Object sprawl**| users × boards × copies → many liveboard objects                    | the `Personal` / `src:<GUID>` tags → one `metadata/search` audits/bulk‑deletes them |
| **Drift**        | a copy is a snapshot; changes to the standard board don't propagate | offer a "reset to standard" (re‑clone) action                         |
| **Lifecycle**    | orphaned copies when users leave; no TTL                            | `metadata/search` `sort_options: LAST_ACCESSED` → prune stale copies  |

The **`src:<GUID>` tag** (already applied on create) doubles as the precise admin filter — *"everything
derived from board C"* is one `metadata/search` on `src:<C>`, any owner. Cheap extra hardening: a
**per‑user cap** (e.g. max 3 copies per board), a **scheduled cleanup** job, and a dedicated **folder**
so personal copies don't clutter users' main content.

---

## 7. Key things to know (the non‑obvious parts)

1. **Anchor on the standard board id.** Track the active copy separately and only override the
   *rendered* `liveboardId`. Overwrite the source id and you lose "Standard" as tab #1 *and* the
   scoping key for discovery.

2. **`copyobject` is owned by the caller.** That ownership *is* your per‑user isolation. Use
   trusted auth so each end user is authenticated as themselves — otherwise every copy is owned by
   one shared account and users see each other's boards.

3. **Tag before you rely on discovery.** `tags/assign` needs the tag to exist (create‑if‑missing)
   and requires edit access — which the caller has because they own the fresh copy. Treat tagging
   as best‑effort: if it fails, keep the copy and fall back to owner + name discovery.

4. **Owner + the `Personal` tag alone doesn't tell you the *source* board** — only *whose* a copy is.
   So tag each copy with a **per‑source tag keyed to the board's GUID** (`src:<sourceGuid>`) and query
   owner + that tag; it's rename‑proof, server‑side, and needs no cache. See the
   [worked example](#worked-example--attributing-copies-to-the-right-board-3-boards--3-users) in §5.
   The title‑prefix convention is only a fallback for legacy copies — it breaks on renames / duplicate names.

5. **Browser→ThoughtSpot REST is cross‑origin.** With a session cookie it works only if your
   origin is on ThoughtSpot's CORS allowlist. With **cookieless trusted auth** it's blocked — relay
   the calls through your own server, forwarding the caller's bearer token to an **allowlisted** set
   of paths (never minting a token). This keeps the browser unable to act as anyone but itself.

6. **Copies don't track the standard board (drift).** They're point‑in‑time clones. If the standard
   board changes, offer a "re‑sync / reset to standard" that re‑clones.

7. **Switching = destroy + recreate.** There's no "change the liveboard id" on a live embed; call
   `embed.destroy()` and `new LiveboardEmbed({ liveboardId })`. Keep the instance in a mutable
   variable.

8. **`copyobject` needs 10.3.0.cl+.** Let the API's 4xx be the source of truth and surface it
   (e.g. a 403 → "you need view access; copyobject needs 10.3.0.cl+").

9. **Don't confuse this with Personalised Views.** `Action.PersonalizedViewsDropdown` saves
   filter snapshots, not editable clones. It's the simpler answer when users only need saved views.

---

## 8. Implementation checklist

1. Keep the **standard board id** fixed; track `activeCopyId` separately; render `effectiveId()`.
2. Build a host **tab strip**: Standard (tab #1) · one per copy · ＋ Personalize (Standard only).
3. Switch tabs by `embed.destroy()` + `new LiveboardEmbed({ liveboardId })`.
4. **＋ Personalize** → `POST /metadata/copyobject` → `POST /tags/assign` (`Personal` + `src:<sourceId>`) → add tab → make active.
5. Open the fresh copy editable on render via `HostEvent.Edit`.
6. **Rediscover** with `GET /auth/session/user` + `POST /metadata/search`
   (`created_by_user_identifiers` + `tag_identifiers: ['src:<sourceId>']`) — attributed to the board by tag, no title guessing.
7. Support **delete** via `POST /metadata/delete`; fall back to Standard if the active copy went away.
8. Under trusted auth, **relay REST through your server** forwarding the caller's token.
9. Plan governance: a per‑user **cap**, tag‑based **audit**, and a **cleanup** routine for drift/sprawl.

---

## 9. Reference

**REST**
- `POST /api/rest/2.0/metadata/copyobject` — `{ identifier, type:'LIVEBOARD', title, description }` → `{ metadata_id }`. Owned by the caller. **10.3.0.cl+.**
- `POST /api/rest/2.0/tags/assign` — `{ metadata:[{identifier,type:'LIVEBOARD'}], tag_identifiers:['Personal','src:<sourceId>'] }`. (Create each tag first with `/tags/create`.) The `src:<GUID>` tag records the source board so copies are attributed by tag, not title.
- `POST /api/rest/2.0/metadata/search` — filter by `created_by_user_identifiers`, `tag_identifiers`, `name_pattern`; `record_size:-1` for all; `sort_options:{ field_name:'LAST_ACCESSED' }` for cleanup.
- `GET  /api/rest/2.0/auth/session/user` — `{ id, name, display_name, current_org }`.
- `POST /api/rest/2.0/metadata/delete` — `{ metadata:[{identifier,type:'LIVEBOARD'}] }`.

**SDK**
- `HostEvent.Edit` — open a liveboard/visualization in edit mode (the "personalize now" moment).
- `Action.PersonalizedViewsDropdown` — the native saved‑**views** dropdown (filter snapshots; the lighter alternative to full copies).
- Switch boards by `embed.destroy()` + `new LiveboardEmbed({ liveboardId })`.
