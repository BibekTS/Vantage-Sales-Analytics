# Vantage Sales — ThoughtSpot Embed Playground

A demo shell for showcasing ThoughtSpot Visual Embed SDK features to clients. Looks like a real B2B sales product. Zero build tools — just open and run.

---

## Quick Start

1. Install the **Live Server** extension in VS Code
2. Open this `Project/` folder in VS Code
3. Click **Go Live** in the status bar → opens `http://localhost:5500`
4. In a separate tab, log into your ThoughtSpot instance
5. Return to `localhost:5500` — embeds render using your active browser session

> **Must use Live Server (not file://).** ThoughtSpot's CORS whitelist only allows
> requests from `localhost` origins. Opening `index.html` directly from the filesystem
> will silently block all SDK calls.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser (localhost:5500)                      │
│                                                                      │
│  ┌──────────────┐   Explore Analytics   ┌────────────────────────┐  │
│  │ Landing Page │ ────────────────────► │   Analytics Workspace  │  │
│  │  (index.html)│ ◄──────────────────── │                        │  │
│  └──────────────┘     Back to Home      │  ┌──────────────────┐  │  │
│                                         │  │   Left Sidebar   │  │  │
│                                         │  │  ┌────────────┐  │  │  │
│  config.js                              │  │  │  nav item  │──┼──┼─►│ switchSection()
│  window.TS_CONFIG ──────────────────────┼──┼─►│  + ⚙ gear  │  │  │  │
│  (host, GUIDs,                          │  │  └────────────┘  │  │  │
│   authType…)                            │  │  × 5 sections    │  │  │
│       │                                 │  │                  │  │  │
│       │ on DOMContentLoaded             │  │  [Advanced]──────┼──┼─►│ feature panel
│       ▼                                 │  │  [Back to Home]  │  │  │
│  ┌─────────────┐                        │  └──────────────────┘  │  │
│  │   app.js    │                        │                        │  │
│  │             │  initSDK(TS_CONFIG)    │  ┌──────────────────┐  │  │
│  │  currentSection                      │  │   Embed Area     │  │  │
│  │  embedOptions ──────────────────────►│  │  #ts-embed-      │  │  │
│  │  sectionOpts  │                      │  │  container       │  │  │
│  │             │  doRender(section,…)   │  │  (iframe)        │  │  │
│  │             │ ──────────────────────►│  └──────────────────┘  │  │
│  └──────┬──────┘                        │                        │  │
│         │                               │  ┌──────────────────┐  │  │
│         ▼                               │  │  Bottom Panel    │  │  │
│  ┌─────────────┐                        │  │  Event Log       │  │  │
│  │  embed.js   │   SDK events           │  │  Embed Code      │  │  │
│  │             │ ◄──────────────────────┼──┼─ (delta only)    │  │  │
│  │  initSDK()  │                        │  │  Reset All       │  │  │
│  │  doRender() │                        │  └──────────────────┘  │  │
│  └──────┬──────┘                        └────────────────────────┘  │
│         │                                                            │
│         │ Visual Embed SDK (CDN)                                     │
│         ▼                                                            │
│  ┌─────────────────────────────────────┐                            │
│  │        ThoughtSpot Instance         │                            │
│  │  SearchEmbed / SpotterEmbed /        │                            │
│  │  LiveboardEmbed / AppEmbed          │                            │
│  └─────────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User clicks nav item
        │
        ▼
  switchSection(section)
        │
        ├─► updates sidebar active state
        ├─► sets currentSection
        └─► renderEmbedNow(section)
                  │
                  ├─► destroys previous embed instance
                  ├─► shows loading overlay
                  ├─► merges embedOptions + sectionOpts[section]
                  └─► doRender(section, TS_CONFIG, callbacks, options)
                              │
                              ├─► new SearchEmbed / SpotterEmbed /
                              │   LiveboardEmbed / AppEmbed
                              ├─► .on(EmbedEvent.*) → logEvent()
                              └─► .render() → ThoughtSpot iframe


User applies Advanced option (e.g. Runtime Filter)
        │
        ▼
  embedOptions updated
        │
        └─► renderEmbedNow(currentSection)  ← re-render with new options
              OR
        └─► embed.trigger(HostEvent.UpdateRuntimeFilters)  ← live, no re-render


User clicks Reset All
        │
        ├─► embedOptions cleared
        ├─► sectionOpts cleared
        ├─► TS_CONFIG restored from _TS_CONFIG_DEFAULT snapshot
        ├─► Configure panel fields synced
        └─► initSDK() + renderEmbedNow()
```

---

## File Overview

```
Project/
├── index.html          All markup. No inline CSS or JS.
├── config.js           Your ThoughtSpot connection + GUIDs. Edit this first.
├── css/
│   └── styles.css      Design system: variables, landing page, analytics app,
│                       sidebar panels, bottom panel, advanced features.
└── js/
    ├── embed.js        Thin SDK wrapper. Exports initSDK() and doRender().
    ├── app.js          Everything else: state, navigation, advanced panel logic,
    │                   event log, embed code view, reset.
    └── auth.js         Auth session check utility (kept for reference, not
                        used in the main render flow).
```

---

## Configuring for a New Client

Open `config.js` and update these values:

```js
window.TS_CONFIG = {
  thoughtSpotHost:   'https://your-instance.thoughtspot.cloud',
  authType:          'None',

  worksheetId:       'GUID',   // Used by Search + Spotter
  liveboardId:       'GUID',   // Used by Liveboard + Visualization
  vizId:             'GUID',   // Used by Visualization (paired with liveboardId)

  searchTokenString: '[Sales Amount] [Region]',  // pre-fills the search bar
  executeSearch:     true,
};
```

**Finding GUIDs in ThoughtSpot:**
| Object | Where to find the GUID |
|---|---|
| Liveboard | URL bar: `.../#/pinboard/<liveboardId>` |
| Visualization | URL bar: `.../#/pinboard/<liveboardId>/viz/<vizId>` |
| Worksheet | Data tab → open worksheet → URL bar |

You can also update these values at runtime via the **⚙ Configure** button inside the app — no file edit needed.

---

## The App — Two Modes

### Landing Page
Shows a fictional "Vantage Sales" product site with animated KPI counters,
product category bars, and regional performance cards. Click **Explore Analytics**
to enter the embed workspace.

### Analytics Workspace
Left sidebar with five embed sections:

| Section | SDK Class | What it needs |
|---|---|---|
| Search Data | `SearchEmbed` | `worksheetId` |
| Spotter AI | `SpotterEmbed` | `worksheetId` |
| Liveboard | `LiveboardEmbed` | `liveboardId` |
| Visualization | `LiveboardEmbed` | `liveboardId` + `vizId` |
| Full App | `AppEmbed` | (no GUID needed) |

Click any section to render that embed. Click again to switch (previous embed is destroyed first).

Each sidebar item also has a **⚙ gear icon** for per-embed options. Clicking the gear icon on a section you're not currently viewing **automatically switches to that section** before opening the options panel.

---

## Advanced Panel

Click **Advanced** in the sidebar to open a slide-out panel with seven feature tabs.
All features apply to whichever embed section is currently active.

### Runtime Filters
- Add filter rows: column name · operator · value
- Operators: EQ, NE, LT, LE, GT, GE, IN
- Click **Apply Filters** → takes effect **immediately** via `HostEvent.UpdateRuntimeFilters`
- No re-render required
- Works best on: Liveboard, Visualization, Full App

### Runtime Parameters
- Add parameter rows: name · value
- Parameters map to ThoughtSpot formula-level variables defined in the worksheet
- Click **Apply — Re-render** → embed re-renders with `runtimeParameters: [...]`
- Works on: Search, Liveboard, Visualization

### Modify Actions
- Checkboxes to **Hide** or **Disable** individual SDK actions
- Actions include: Download, Share, Edit, Pin, Explore, Drill Down, etc.
- Click **Apply — Reload Embed** → re-renders with `hiddenActions` / `disabledActions`

### Custom Actions
- Add a button label + position (START or END of menu)
- Adds `customActions: [{ id, label, position }]` to the embed config
- When clicked inside ThoughtSpot, fires `EmbedEvent.CustomAction`
- Payload (row data, context) is captured and displayed in the panel
- Requires re-render; works on: Liveboard, Visualization, Full App

### Code-Based Actions
- Define a custom action entirely in code (no ThoughtSpot admin setup required)
- Same mechanic as Custom Actions but injected via the SDK
- Live code preview updates as you type
- Requires re-render

### Host Events
- Send real-time commands to the active embed without re-rendering

| Event | Target embed | What it does |
|---|---|---|
| Search Query | Search Data | Sets the search bar content |
| Navigate to Path | Full App | Navigates to a ThoughtSpot page/GUID |
| Show Only These Vizs | Liveboard · Viz | Filters visible visualizations |
| Reload | All | Reloads the embed iframe |

### Custom Styles

**Parse Element** (fastest way to find a selector):
1. In ThoughtSpot, right-click any element → **Inspect**
2. In DevTools, right-click the highlighted HTML node → **Copy → Copy element**
3. Paste the HTML into the **Parse Element** textarea and click **→ Extract Selector**
4. A CSS rule row is added automatically with `display: none !important` pre-filled
5. Selector priority: `data-testid` → `aria-label` → `id` → first class

- **CSS Rules (rows)**: Add selector + CSS declaration pairs
  - Selector: `[data-testid="share-button"]`
  - CSS: `display: none !important`
  - Selectors with double quotes (e.g. attribute selectors) are handled correctly
- **Code Block**: Write JS-style `rules_UNSTABLE` directly:
  ```
  '[data-testid="share-button"]': {
    display: 'none !important',
  },
  ```
- **↺ Sync**: imports the code block into the row builder
- **Apply — Reload Embed**: re-inits the SDK with `customizations.style.customCSS.rules_UNSTABLE`
  then re-renders
- A **sample code block** below the textarea shows common selectors (selectable, copyable)

> **Tip for finding selectors:** Open the embed in a separate tab, right-click any element
> in the ThoughtSpot UI → Inspect. Look for `data-testid` attributes — these are more stable
> across ThoughtSpot versions than class names.

---

## Layout Behavior

### Feature Panel (Advanced)
The right-side Advanced panel **pushes the embed area** when it opens. The embed container
shrinks to make room; the panel does not overlap it. The same happens in reverse when the
panel is closed — the embed area smoothly expands back.

### Bottom Panel
The bottom panel (Event Log / Embed Code) is **fixed to the bottom of the viewport** and
overlays the embed rather than pushing it up. The embed area reserves padding equal to the
collapsed bar height so content is never obscured when the panel is collapsed.

---

## Bottom Panel (Event Log + Embed Code)

Tabbed panel pinned to the bottom of the viewport. Click the chevron **▲** to expand.

### Event Log tab
- Logs every SDK event in real time: timestamp · event type · data
- Events: `AuthInit`, `EmbedListenerReady`, `Load`, `LiveboardRendered`,
  `NoCookieAccess`, `Error`, `Data`, `CustomAction`
- Newest events appear at the top

### Embed Code tab
- Shows **only what changed** from the default SDK configuration
- Updates live as you apply advanced options
- Syntax-highlighted (enums in indigo, strings in green, keywords in pink)
- **Copy** button copies the code to clipboard

### Reset All button
- Always visible (amber color) in the top-right of the panel
- Clears all advanced options (filters, params, actions, custom styles)
- **Also restores TS_CONFIG** (host, GUIDs, auth) back to the original `config.js` values and syncs the Configure panel fields
- Re-inits the SDK and re-renders the current embed
- Also appears on the **Connection Error** screen next to Retry, so you can recover from a bad config without opening the Configure panel

---

## How the Code Is Organized

### `embed.js`
Knows only about the ThoughtSpot SDK. Exports:
- `initSDK(config)` — calls `init()` with host, authType, and optional customizations
- `doRender(section, config, callbacks, options)` — creates the right embed class,
  registers all SDK events, calls `.render()`, returns the embed instance
- Re-exports: `HostEvent`, `Action`, `RuntimeFilterOp`, `CustomActionsPosition`

### `app.js`
The main controller. Key concepts:
- **`currentSection`** — which embed is active (`'search'` | `'spotter'` | etc.)
- **`embedOptions`** — accumulates all advanced settings across panel interactions
- **`renderEmbedNow(section)`** — always sets `currentSection`, destroys old embed,
  shows loading state, calls `doRender`, hides loading when SDK events fire
- All advanced "Apply" functions call `renderEmbedNow(currentSection)` directly
- **`refreshCodeView()`** — regenerates and syntax-highlights the embed code delta
- **`logEvent(type, data)`** — adds an entry to the event log

### `styles.css`
Single file, organized in sections:
1. CSS variables (`:root`)
2. Landing page (hero, KPI strip, feature grid)
3. Analytics app shell (sidebar, header, embed area)
4. Loading overlay states
5. Bottom panel (tabs, log entries, code view)
6. Config panel + feature panel (slide-out)
7. Advanced panel sub-sections (filters, actions, custom styles)

---

## Known Behaviors

**AuthType.None requires an active session.** The user must be logged into the ThoughtSpot
instance in the same browser. The embed uses that browser session cookie — no token
exchange happens in this app.

**Re-render vs live updates.** Most advanced options require a full embed re-render
(the iframe reloads). Runtime filters are the exception — they apply live via a host event.

**CSS rules are `rules_UNSTABLE`.** The `rules_UNSTABLE` key in ThoughtSpot's SDK is
intentionally marked unstable — selectors may change between ThoughtSpot versions.
Use data-testid selectors where possible as they are more stable than class names.

**Custom Actions need ThoughtSpot admin setup** for the "Custom Actions" panel.
The "Code-Based Actions" panel works without any ThoughtSpot admin configuration.

**Switching sections destroys the embed.** Any runtime state (applied filters, search
results) is lost when you switch to a different section. Advanced options in `embedOptions`
persist and are re-applied on every new render.

**`config.js` must load before `app.js`.** The `<script src="config.js">` tag appears
before the `<script type="module" src="js/app.js">` tag. Do not reorder them.
