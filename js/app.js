/**
 * app.js — playground controller.
 *
 * Wires the connection bar, embed rail, render flow, the single contextual
 * inspector (which replaces the old gear + advanced panels), the full SDK-code
 * view, the event log, and reset. State lives in
 * state.js; SDK calls go through embed.js; REST discovery through discovery.js;
 * the trusted-auth token playground lives in auth.js.
 */

import { initSDK, doRender, HostEvent, Action, RuntimeFilterOp, CustomActionsPosition, CustomActionTarget } from './embed.js';
import { getState, setState, subscribe, loadState, resetState, getHostSource, holdHostPersist } from './state.js';
import * as Discovery from './discovery.js';
import { openAuthModal, buildTrustedAuthConfig, seedAuthHooks } from './auth.js';
import { fetchAllRows, groupStatements, downloadStatementsPdf } from './invoice-pdf.js';

// ── Embed catalogue ──────────────────────────────────────────────────────────
const EMBEDS = [
  { id: 'search',           name: 'Search Data',       cls: 'SearchEmbed',    needs: 'worksheet' },
  { id: 'nlsearch',         name: 'NL Search Bar',     cls: 'SearchBarEmbed', needs: 'worksheet' },
  { id: 'spotter',          name: 'Spotter AI',        cls: 'SpotterEmbed',   needs: 'worksheet' },
  { id: 'liveboard',        name: 'Liveboard',         cls: 'LiveboardEmbed', needs: 'liveboard' },
  { id: 'liveboard-custom', name: 'Custom Liveboard',  cls: 'LiveboardEmbed', needs: 'liveboard' },
  { id: 'ai-highlights',    name: 'AI Highlights',     cls: 'LiveboardEmbed', needs: 'liveboard' },
  { id: 'viz',              name: 'Single Viz',        cls: 'LiveboardEmbed', needs: 'viz' },
  { id: 'fullapp',          name: 'Full App',          cls: 'AppEmbed',       needs: 'none' },
  { id: 'ai-insights',      name: 'AI Insights (REST)',cls: 'Spotter REST',   needs: 'worksheet' },
];
const META = Object.fromEntries(EMBEDS.map(e => [e.id, e]));

// Rail grouping — mirrors how the SDK families the surfaces: the three search-driven
// embeds, the four LiveboardEmbed flavours, and the two whole-app / no-iframe options.
const RAIL_GROUPS = [
  { label: 'Search & AI',  ids: ['search', 'nlsearch', 'spotter'] },
  { label: 'Liveboards',   ids: ['liveboard', 'liveboard-custom', 'ai-highlights', 'viz'] },
  { label: 'App & REST',   ids: ['fullapp', 'ai-insights'] },
];

// Plain-English "what does this do" blurbs shown on hover over each rail item.
const EMBED_BLURBS = {
  search:           'Full search experience — build a query against a Worksheet/Model and get an auto-charted answer.',
  nlsearch:         'Just the natural-language search bar — users type a question and results open in ThoughtSpot.',
  spotter:          'Conversational AI analyst — ask a question, then keep asking follow-ups in a chat-style session.',
  liveboard:        'Embed a full interactive Liveboard (dashboard) with all its tiles, filters, and tabs.',
  'liveboard-custom':'A Liveboard driven by your own website-native filter bar, from outside the iframe.',
  'ai-highlights':  'Render a Liveboard, then surface AI-generated “Key Highlights” narratives over it.',
  viz:              'Embed a single visualization from a Liveboard — or one standalone Answer — on its own.',
  fullapp:          'Embed the entire ThoughtSpot app — nav bar, search, Liveboards, the works.',
  'ai-insights':    'Headless Spotter over REST — you render the AI answer cards yourself, with no ThoughtSpot iframe.',
};

// Menu actions offered in the "Modify actions" panel, listed per section.
// A Liveboard has TWO independent download surfaces, each with its own Action ID:
//   • Liveboard-level — the whole-board Download button (DownloadLiveboard + the format
//     sub-actions surfaced in the Download modal once the multi-format flags are on).
//   • Answer/viz-level — the Download item inside an individual visualization's "…" menu
//     (Download / DownloadAsPdf / DownloadAsCsv / DownloadAsXlsx).
// Hiding the viz-level set disables export on the Answers INSIDE the board while the
// Liveboard-level Download keeps working — exactly the "disable export on the answers in
// the liveboard, keep liveboard export" ask. See ACTION_HINTS for the per-row scope.
const LB_DOWNLOAD_ACTIONS = ['DownloadLiveboard', 'DownloadLiveboardAsContinuousPDF',
  'DownloadLiveboardAsA4Pdf', 'DownloadLiveboardAsCsv', 'DownloadLiveboardAsXlsx'];
const VIZ_DOWNLOAD_ACTIONS = ['Download', 'DownloadAsPdf', 'DownloadAsCsv', 'DownloadAsXlsx'];
const ACTIONS = {
  search:   [...VIZ_DOWNLOAD_ACTIONS, 'Edit', 'Share', 'Pin', 'DrillDown', 'SpotIQAnalyze'],
  nlsearch: ['Edit', 'Share'],
  spotter:  ['Share', 'Pin', 'SpotIQAnalyze'],
  liveboard: [...LB_DOWNLOAD_ACTIONS, ...VIZ_DOWNLOAD_ACTIONS,
    'Edit', 'MakeACopy', 'Share', 'Pin', 'Explore', 'DrillDown', 'LiveboardInfo', 'LiveboardUsers', 'SpotIQAnalyze'],
  viz:      [...VIZ_DOWNLOAD_ACTIONS, 'Share', 'Pin', 'Explore', 'DrillDown', 'SpotIQAnalyze'],
  fullapp:  [...LB_DOWNLOAD_ACTIONS, ...VIZ_DOWNLOAD_ACTIONS,
    'Edit', 'MakeACopy', 'Share', 'Pin', 'Explore', 'DrillDown', 'LiveboardInfo', 'LiveboardUsers', 'SpotIQAnalyze'],
};
ACTIONS['liveboard-custom'] = ACTIONS.liveboard;
ACTIONS['ai-highlights'] = ACTIONS.liveboard;

// Per-action scope tooltips for the "Modify actions" rows (which surface to hover title).
const ACTION_HINTS = {
  DownloadLiveboard: 'Liveboard-level: the whole-board Download button. Leave visible to keep Liveboard exports working.',
  DownloadLiveboardAsContinuousPDF: 'Liveboard-level: the Continuous-PDF option in the Download modal (needs “Enable continuous PDF” on).',
  DownloadLiveboardAsA4Pdf: 'Liveboard-level: the paginated A4-PDF option in the Download modal.',
  DownloadLiveboardAsCsv: 'Liveboard-level: the CSV option in the Download modal (needs “Enable XLSX + CSV download” on).',
  DownloadLiveboardAsXlsx: 'Liveboard-level: the XLSX option in the Download modal (needs “Enable XLSX + CSV download” on).',
  Download: 'Answer/viz-level: the Download item in a single visualization’s “…” menu. Hide to disable export on the Answers inside the Liveboard.',
  DownloadAsPdf: 'Answer/viz-level: Download › PDF on an individual Answer/visualization.',
  DownloadAsCsv: 'Answer/viz-level: Download › CSV on an individual Answer/visualization.',
  DownloadAsXlsx: 'Answer/viz-level: Download › XLSX on an individual Answer/visualization.',
  LiveboardUsers: 'Liveboard header: the strip of viewer avatars at the top (people the board is shared with / who have access — “recently visited / social proof”). Hide to remove those faces. Also toggleable in Display options.',
  LiveboardInfo: 'Liveboard header: the “Show Liveboard details” menu item (author + created/updated timestamps). Opens a panel; not shown inline on the board.',
  MakeACopy: 'Liveboard header ⋯ menu: the “Make a copy” item that lets a viewer duplicate the whole board into their own editable copy. Hide to stop end users cloning the board.',
};

// Per-embed display flags (the old gear schema, kept as-is but now in the inspector).
const DISPLAY = {
  search: [
    ['collapseDataSources', 'Collapse data panel', true],
    ['hideDataSources', 'Hide data panel', false],
    ['enableSearchAssist', 'Search assist', false],
    ['focusSearchBarOnRender', 'Auto-focus search bar', true],
    ['hideResults', 'Hide results', false],
    ['forceTable', 'Force table view', false],
  ],
  nlsearch: [
    ['hideWorksheetSelector', 'Hide data source', false],
    ['disableWorksheetChange', 'Lock data source', false],
    ['hideSampleQuestions', 'Hide sample questions', false],
  ],
  spotter: [
    ['disableSourceSelection', 'Disable source switch', false],
    ['hideSourceSelection', 'Hide source selection', false],
    ['hideSampleQuestions', 'Hide sample questions', false],
    ['updatedSpotterChatPrompt', 'Spotter 3 chat interface', false],
    ['enablePastConversationsSidebar', 'Chat history sidebar', false],
    ['enableStopAnswerGenerationEmbed', 'Stop-generation button', false],
    ['showSpotterLimitations', 'Show limitations text', false],
  ],
  liveboard: [
    ['fullHeight', 'Full height', false],
    ['hideLiveboardHeader', 'Hide header bar', false],
    ['showLiveboardTitle', 'Show title', false],
    ['hideTabPanel', 'Hide tab panel', false],
    ['enableVizTransformations', 'Allow chart changes', false],
    ['isLiveboardCompactHeaderEnabled', 'Compact header', false],
    ['hideIrrelevantChipsInLiveboardTabs', 'Hide irrelevant filter chips', false],
    ['coverAndFilterOptionInPDF', 'PDF cover/filter options', false],
    ['isLiveboardXLSXCSVDownloadEnabled', 'Enable XLSX + CSV download', false],
    ['isContinuousLiveboardPDFEnabled', 'Enable continuous PDF', false],
    ['isLiveboardMasterpiecesEnabled', 'Styling & grouping (Masterpieces)', true],
    ['isEnhancedFilterInteractivityEnabled', 'Enhanced filter interactivity', false],
    ['isCentralizedLiveboardFilterUXEnabled', 'Centralized filter UX (v2)', false],
  ],
  viz: [
    ['fullHeight', 'Full height', false],
    ['hideLiveboardHeader', 'Hide header bar', false],
    ['enableVizTransformations', 'Allow chart changes', false],
  ],
  fullapp: [
    ['showPrimaryNavbar', 'Show top nav bar', false],
    ['hideHamburger', 'Hide hamburger', false],
    ['disableProfileAndHelp', 'Hide profile & help', false],
    ['hideObjectSearch', 'Hide object search', false],
    ['pageId', 'Start page', 'Home', ['Home', 'Liveboards', 'Answers', 'Data', 'SpotterPage']],
  ],
};

DISPLAY['liveboard-custom'] = DISPLAY.liveboard; // same display flags as liveboard
DISPLAY['ai-highlights'] = DISPLAY.liveboard;    // AI Highlights renders a Liveboard, then triggers HostEvent.AIHighlights

// Hover descriptions for the display flags above (keyed by flag name; same key = same meaning across sections).
const HINTS = {
  // search
  collapseDataSources: 'Start with the data sources panel collapsed (still expandable by the user).',
  hideDataSources: 'Completely hide the data sources panel on the left.',
  enableSearchAssist: 'Show the guided Search Assist walkthrough for new users.',
  focusSearchBarOnRender: 'Put the cursor in the search bar as soon as the embed loads.',
  hideResults: 'Hide the results chart/table, leaving only the search bar.',
  forceTable: 'Always render results as a table instead of the auto-picked chart.',
  // nlsearch
  hideWorksheetSelector: 'Hide the data source picker so users can’t see which source is used.',
  disableWorksheetChange: 'Lock the data source — visible but users can’t switch it.',
  hideSampleQuestions: 'Hide the suggested/sample questions shown before searching.',
  // spotter
  disableSourceSelection: 'Lock the Spotter data source — visible but not switchable.',
  hideSourceSelection: 'Hide the Spotter data source selector entirely.',
  updatedSpotterChatPrompt: 'Turn on the new Spotter 3 chat interface (updatedSpotterChatPrompt). Off by default — the cluster must have the Spotter 3 experience enabled for this to take effect. Needs SDK 1.45.0+ / cluster 26.2.0.cl+.',
  enablePastConversationsSidebar: 'Show the past-conversations (chat history) sidebar so users can reopen earlier Spotter chats. A Spotter 3 feature; needs SDK 1.46.0+ / cluster 26.3.0.cl+ with chat history enabled on the instance.',
  enableStopAnswerGenerationEmbed: 'Add a “Stop generating” button so users can interrupt an in-progress Spotter answer. Needs SDK 1.48.0+ / cluster 26.5.0.cl+.',
  showSpotterLimitations: 'Show the small Spotter limitations disclaimer beneath the chat input. Off by default. Needs SDK 1.36.0+ / cluster 10.5.0.cl+.',
  // liveboard / viz
  fullHeight: 'Let the embed grow to its full content height instead of scrolling inside a fixed box.',
  hideLiveboardHeader: 'Hide the entire Liveboard header bar (title, filters, actions).',
  showLiveboardTitle: 'Show the Liveboard title even when the header bar is hidden.',
  hideTabPanel: 'Hide the row of Liveboard tabs.',
  enableVizTransformations: 'Allow users to change chart types and tweak visualizations inline.',
  isLiveboardCompactHeaderEnabled: 'Use the slim compact header instead of the tall default one. Required for the chip-hiding option below.',
  hideIrrelevantChipsInLiveboardTabs: 'On multi-tab Liveboards, hide filter chips that don’t apply to the active tab. Needs the compact header on.',
  coverAndFilterOptionInPDF: 'Add checkboxes in Download-as-PDF to include/exclude the cover page and filters page.',
  isLiveboardXLSXCSVDownloadEnabled: 'Add XLSX + CSV to the Liveboard-level Download modal. Without this, the embed shows only PDF. Needs cluster 26.5.0.cl+.',
  isContinuousLiveboardPDFEnabled: 'Add the Continuous-PDF option (one long page matching the on-screen layout) to the Liveboard Download modal. Needs cluster 26.5.0.cl+.',
  isLiveboardMasterpiecesEnabled: 'Enable the new Liveboard styling & grouping (“Masterpieces”) layout. On by default; toggle off to render the classic layout.',
  isEnhancedFilterInteractivityEnabled: 'Enable the enhanced, more responsive filter interactions on the Liveboard.',
  isCentralizedLiveboardFilterUXEnabled: 'New centralized filter UX (v2): one modal to manage all filters. Must also be enabled by ThoughtSpot Support.',
  // fullapp
  showPrimaryNavbar: 'Show the full ThoughtSpot top navigation bar.',
  hideHamburger: 'Hide the hamburger menu in the top-left.',
  disableProfileAndHelp: 'Hide the profile avatar and help menu in the top-right.',
  hideObjectSearch: 'Hide the global object search box in the nav bar.',
  pageId: 'Which page the full-app embed opens on first.',
};

const OPERATORS = ['EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'IN', 'NOT_IN', 'CONTAINS', 'BEGINS_WITH', 'ENDS_WITH'];

// ── Runtime (non-shared) state ────────────────────────────────────────────────
let currentEmbed = null;
let connected = false;
let discovered = { worksheets: [], liveboards: [] };
let vizCache = {};      // liveboardId -> [{id,name}] | null (failed) | undefined (not loaded)
const _vizLoading = new Set(); // liveboardIds with a fetch in flight
let answerCache = {};   // worksheetId -> [{id,name}]
let logCount = 0;
let bottomTab = 'log';
const customActionRegistry = {}; // id -> { type, label, webhook, urlTemplate, drillLiveboardId }
// Id of the app-injected "Download invoice pdf" viz-menu action (see buildEmbedCustomActions +
// handleInvoicePdf). Override with window.TS_PDF_ACTION_ID to match a TS-side action id instead.
const PDF_ACTION_ID = window.TS_PDF_ACTION_ID || 'download-invoice-pdf';
// Id of the app-injected "Date" PRIMARY toolbar button (host-side date filter). Gated by
// state.dateBtn.enabled; the CustomAction dispatcher routes it to openDatePicker().
const DATE_ACTION_ID = '__date_filter';
let editingActionId = null;      // id of the custom action currently loaded into the form for editing
let lastSaved = null;            // { name, guid, at } — most recent EmbedEvent.Save this session
let drillParent = null;          // { liveboardId } — set while drilled into a detail board (Q4)
let authFailed = false;          // set when the embed reports AuthFailure/NoCookie; keeps the
                                 // not-logged-in overlay pinned so a late Load event can't hide it
// Personal liveboards — the connected user's identity (for scoping copy discovery) + a one-shot flag
// so a freshly-created copy opens straight into Edit mode. Captured in connect(); non-fatal if absent.
let currentUserName = '';        // display name (for copy titles)
let currentUserLogin = '';       // login id or GUID → created_by_user_identifiers when discovering copies
let justCreatedCopyId = '';      // set by personalizeFlow(); render()'s onDone triggers HostEvent.Edit once
let plbArmedDelete = '';         // copy id whose ✕ is armed for a confirm-click (inline delete)
let plbArmedTimer = null;        // disarm timer for the above
let plbDiscovering = false;      // true while refreshPersonalCopies() is in flight (shows a skeleton tab)
let plbClickTimer = null;        // debounces a copy-tab click so a dblclick can cancel it (rename vs switch)
let pendingHostConfirm = false;  // a shared-link (#s=) host is awaiting an explicit Connect click
let tokenServerAvailable = true; // Trusted Auth mints via the local token server; probed on boot (see probeTokenServer)

// ── AI Insights (headless REST panel) runtime state ───────────────────────────
let aiQuery = '';   // last free-text question typed into the AI Insights panel
let aiLimit = 3;    // how many insights to auto-generate (each = 1 answer + 1 data call)
let aiBusy = false; // a relevant-questions / answer call is in flight
let pendingSpotterQuery = null; // NL question to run in Spotter on its next load (AI Insights bridge)
let aiInsightsCache = {};       // worksheetId -> { wsName, items:[{query, answer, error}] } — auto-insights, so revisits are instant

// ── Custom Liveboard filter state ─────────────────────────────────────────────
let cfbCols = [];            // ordered list of column names shown as filter controls
let cfbSelected = {};        // { colName: [selectedValues] }
let cfbSort = {};            // { colName: 'asc' | 'desc' | 'custom' | 'metric' } — value display order
let cfbOrder = {};           // { colName: [orderedValues] } — drag-defined order for 'custom'
let cfbMetric = {};          // { colName: { col, agg, dir } } — sort-by-another-column config for 'metric'
let cfbValueCache = {};      // { colName: [allDistinctValues] }
let cfbContents = [];        // raw liveboard data blocks (column_names + data_rows) kept for metric aggregation
let cfbNumericCols = [];     // column names whose values are numeric — offered as metric columns
let cfbDateCols = new Set();  // date-named columns whose values are epoch numbers — displayed as dates
let cfbMetricCache = {};     // memoized aggregate maps, keyed `${filterCol}|${metricCol}|${agg}`
let cfbAllColumns = [];      // all column names discovered from the liveboard
let _cfbBuilding = false;    // guard against concurrent builds
let lbTagFilter = '';        // Q3: active "filter by tag" selection for the Liveboard picker
let cfbLoadedFor = '';       // liveboardId the column/value cache currently belongs to
let _cfbLoadPromise = null;  // in-flight single liveboard/data fetch (dedupes concurrent callers)
const CFB_RECORD_SIZE = 10000; // rows pulled once to derive filter columns + distinct values

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const seed = window.TS_CONFIG ? {
    host: window.TS_CONFIG.thoughtSpotHost || '',
    worksheetId: window.TS_CONFIG.worksheetId || '',
    liveboardId: window.TS_CONFIG.liveboardId || '',
    vizId: window.TS_CONFIG.vizId || '',
    searchTokenString: window.TS_CONFIG.searchTokenString || '',
    executeSearch: !!window.TS_CONFIG.executeSearch,
  } : {};
  loadState(seed);

  // Rebuild the in-memory custom-action registry from restored state (shared link / reload).
  // Without this, re-attached actions exist on the embed but the dispatcher can't find them,
  // so URL / write-back actions silently no-op for anyone opening a shared setup.
  getState().customActions.forEach(a => {
    customActionRegistry[a.id] = { type: a.type, label: a.label, urlTemplate: a.urlTemplate, webhook: a.webhook, drillLiveboardId: a.drillLiveboardId };
  });

  renderEmbedList();
  bindTopbar();
  bindBottomPanel();
  bindStateOverlay();
  // When a trusted-auth token is minted & applied, feed it to REST discovery so object lists
  // populate for token-only users (no browser session), then re-discover against the host.
  seedAuthHooks({ logEvent, onTokenApplied: (token) => {
    if (token) Discovery.setBearerToken(token);
    applyConfig();
    if (token && getState().host) connect({ silent: true });
    else render();
  } });

  const s = getState();
  $('#host-input').value = s.host;
  $('#auth-select').value = s.authType;
  $('#auth-config-btn').hidden = s.authType === 'None';

  // A host arriving via the (attacker-controllable) #s= hash must be confirmed before we touch it.
  // Set this BEFORE the first render() so nothing — not even the embed iframe — contacts the host.
  pendingHostConfirm = !!(s.host && getHostSource() === 'hash');
  // While unconfirmed, keep the hash host out of localStorage so a dismissed shared link can't
  // auto-connect on the user's NEXT visit (the URL hash already carries it — no need to store it).
  if (pendingHostConfirm) holdHostPersist(true);

  applyConfig();
  renderInspector();
  // Skip the first render when connect() is about to run — it will render after discovering objects,
  // avoiding a double iframe creation (flicker + double network cost) on every page load.
  setActive(s.section, { skipRender: !!(s.host && !pendingHostConfirm) });

  // Clear All button for the custom filter bar
  $('#cfb-clear')?.addEventListener('click', () => {
    cfbSelected = {};
    persistCfb();
    document.querySelectorAll('.cfb-panel .cfb-value-cb').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.cfb-panel .cfb-item--all input').forEach(cb => { cb.checked = true; });
    document.querySelectorAll('.cfb-toggle').forEach(btn => { btn.textContent = 'All'; btn.classList.remove('cfb-toggle--active'); });
    if (currentEmbed) { currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, []); logEvent('CustomFilter', 'cleared'); }
  });

  // Export button for the custom filter bar (REST: /api/rest/2.0/report/liveboard).
  // Format comes from the adjacent #cfb-format select (PDF/XLSX/CSV/PNG).
  $('#cfb-export')?.addEventListener('click', downloadCfbReport);

  // Probe for the local token server BEFORE auto-connect. If it's absent (frontend opened via
  // Live Server / a static host with no Node backend), Trusted Auth can't mint tokens — grey out
  // the option and fall back to browser-session auth so Connect doesn't dead-end.
  await probeTokenServer();

  // Auto-connect — but NOT to a host that arrived via the (attacker-controllable) #s= hash.
  // A shared link can name any host; connecting fires credentialed REST probes at it, so a
  // hash-sourced host requires an explicit click. Hosts from localStorage (you used it here
  // before) or the operator's config.js seed are trusted and connect silently.
  if (pendingHostConfirm) {
    showHostConfirm(s.host);
  } else if (s.host) {
    connect({ silent: true });
  } else {
    setOverlay('not-connected');
  }
});

// A shared link proposed a host. Show it and require a click before we touch it.
function showHostConfirm(host) {
  setOverlay('confirm-host');
  const label = $('#confirm-host-name');
  if (label) label.textContent = host;
  const btn = $('#confirm-host-go');
  if (btn) btn.onclick = () => connect();
}

// ── Trusted-auth availability ─────────────────────────────────────────────────
// Trusted Auth mints short-lived tokens via the local Node server (/api/auth/token).
// Opened WITHOUT that server (Live Server on :5500, or any static host), the endpoint
// 404s / connection-refuses — so probe /api/auth/config and, if it's not there, grey out
// the Trusted-token option (+ hide "Token claims…") instead of letting Connect fail.
const TRUSTED_UNAVAILABLE_NOTE = 'Trusted Auth needs the local token server — run `npm start` (port 3000).';

async function probeTokenServer() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/config`, { headers: { Accept: 'application/json' } });
    tokenServerAvailable = res.ok && (res.headers.get('content-type') || '').includes('application/json');
  } catch (_) {
    tokenServerAvailable = false; // network error / connection refused / wrong origin
  }
  applyTrustedAuthAvailability();
}

function applyTrustedAuthAvailability() {
  const sel = $('#auth-select');
  const opt = sel?.querySelector('option[value="TrustedAuthTokenCookieless"]');
  const btn = $('#auth-config-btn');
  if (opt) {
    opt.disabled = !tokenServerAvailable;
    opt.textContent = tokenServerAvailable ? 'Auth: Trusted token' : 'Auth: Trusted token (local server only)';
  }
  if (sel) sel.title = tokenServerAvailable ? 'Authentication type' : TRUSTED_UNAVAILABLE_NOTE;

  if (!tokenServerAvailable) {
    // A shared link / stored state may have left us on a trusted mode we can't fulfil.
    // Fall back to browser-session auth so Connect doesn't dead-end on a missing endpoint.
    if (getState().authType !== 'None') {
      setState({ authType: 'None' });
      if (sel) sel.value = 'None';
      applyConfig();
      logEvent('Trusted Auth', 'Unavailable — no local token server. Using browser session.');
      toast(TRUSTED_UNAVAILABLE_NOTE, 'info');
    }
    if (btn) { btn.hidden = true; btn.disabled = true; }
  } else if (btn) {
    btn.disabled = false;
  }
}

// ── Config bridge (state → embed.js/initSDK shape) ─────────────────────────────
function hasStyles(s) {
  return Object.keys(s.styles.variables || {}).length || Object.keys(s.styles.rules || {}).length;
}
function buildConfig() {
  const s = getState();
  const cfg = {
    thoughtSpotHost: s.host,
    authType: s.authType,
    worksheetId: s.worksheetId,
    liveboardId: s.liveboardId,
    vizId: s.vizId,
    answerId: s.answerId,
    searchTokenString: s.searchTokenString,
    executeSearch: s.executeSearch,
  };
  if (hasStyles(s)) {
    const customCSS = {};
    if (Object.keys(s.styles.variables).length) customCSS.variables = s.styles.variables;
    if (Object.keys(s.styles.rules).length) customCSS.rules_UNSTABLE = s.styles.rules;
    cfg._customStyles = { customCSS };
  }
  if (s.authType !== 'None') cfg.trustedAuth = buildTrustedAuthConfig(s.auth);
  window.TS_CONFIG = cfg; // keep a single consistent config object around
  return cfg;
}
function applyConfig() { initSDK(buildConfig()); }

// ── Connection ────────────────────────────────────────────────────────────────
async function connect({ silent = false } = {}) {
  let host = $('#host-input').value.trim().replace(/\/+$/, '');
  if (!host) { toast('Enter a host URL first.'); return; }
  // Auto-prefix https:// when the user omits the scheme (e.g. "my-co.thoughtspot.cloud").
  if (!/^https?:\/\//i.test(host)) { host = 'https://' + host; $('#host-input').value = host; }
  pendingHostConfirm = false; // an explicit Connect trusts this host for the session
  holdHostPersist(false);     // lift the localStorage suppression now that host is confirmed
  setState({ host });
  setStatus('connecting', 'Connecting…');
  applyConfig();

  const org = await Discovery.discoverOrg(host);
  if (!org.ok) {
    connected = false;
    const isCors = org.reason === 'cors';
    const label = org.status === 401 ? 'Not logged in' : isCors ? 'CORS blocked' : 'Unreachable';
    const detail = isCors
      ? `Host is reachable, but the browser blocked the cross-origin REST call. Add ${location.origin} to ThoughtSpot’s CORS allowlist (Develop → Customizations → Security Settings). The embed iframe is unaffected.`
      : org.error;
    setStatus('error', label, detail);
    if (!silent) toast(isCors
      ? `CORS blocked — add ${location.origin} to ThoughtSpot’s CORS allowlist. The embed still renders via the iframe.`
      : `Could not verify session: ${org.error}`, 'error');
    if (isCors) {
      // CORS: REST is blocked but the embed iframe still works — show the error overlay with
      // "Proceed anyway" so the user can still render without fixing CORS first.
      $('#error-sub').textContent = `CORS blocked — add ${location.origin} to ThoughtSpot’s CORS allowlist (Develop → Customizations → Security Settings). Click "Proceed anyway" to render the embed via the iframe.`;
      setOverlay('error');
    } else {
      setOverlay(org.status === 401 ? 'not-logged-in' : 'not-connected');
    }
    renderInspector();
    return;
  }
  connected = true;
  setStatus('ok', `${org.userName}${org.orgName ? ' · ' + org.orgName : ''}`);
  currentUserName = org.userName || '';

  currentUserLogin = ''; // re-resolved (scoped to this session's identity) by refreshPersonalCopies()
  const objs = await Discovery.discoverObjects(host);
  if (objs.ok) discovered = { worksheets: objs.worksheets, liveboards: objs.liveboards };
  // Personal liveboards: repopulate the current board's copies (non-fatal — refreshPersonalCopies
  // resolves the scoping identity itself and stays empty if that or the search fails).
  if (getState().personalLb?.enabled) refreshPersonalCopies();
  renderInspector();
  render();
}

function setStatus(state, text, detail) {
  const e = $('#conn-status');
  e.dataset.state = state;
  // Text goes in the .tb-status-txt span so it can ellipsize; the dot is a ::before.
  const txt = e.querySelector('.tb-status-txt') || e;
  txt.textContent = text;
  // Always expose the full value on hover — the pill may truncate a long "user · org".
  e.title = detail || text;
}

// ── Embed rail ──────────────────────────────────────────────────────────────
function renderEmbedList() {
  const ul = $('#embed-list');
  ul.innerHTML = '';
  RAIL_GROUPS.forEach(g => {
    const lbl = el('li', 'rail-group');
    lbl.textContent = g.label;
    ul.appendChild(lbl);
    g.ids.forEach(id => {
      const e = META[id];
      const li = el('li', 'embed-item');
      li.dataset.id = e.id;
      li.innerHTML = `<span class="ei-name">${e.name}</span><span class="ei-cls">${e.cls}</span>`;
      const blurb = EMBED_BLURBS[e.id];
      if (blurb) {
        li.setAttribute('aria-label', `${e.name} — ${blurb}`);
        attachRailTip(li, e.name, e.cls, blurb);
      }
      li.addEventListener('click', () => setActive(e.id));
      ul.appendChild(li);
    });
  });
}

// Instant, styled hover tooltip for the rail. A body-anchored element is used
// (not a CSS ::after) because #rail has overflow-y:auto, which would clip any
// tooltip extending past its right edge.
let railTipEl = null;
function attachRailTip(item, name, cls, blurb) {
  const show = () => {
    if (!railTipEl) {
      railTipEl = el('div', 'rail-tip');
      document.body.appendChild(railTipEl);
    }
    railTipEl.innerHTML =
      `<div class="rail-tip-title">${name} <span class="rail-tip-cls">${cls}</span></div>` +
      `<div class="rail-tip-body">${blurb}</div>`;
    const r = item.getBoundingClientRect();
    railTipEl.style.left = `${r.right + 10}px`;
    railTipEl.style.top = `${r.top + r.height / 2}px`;
    railTipEl.dataset.show = 'true';
  };
  const hide = () => { if (railTipEl) railTipEl.dataset.show = 'false'; };
  item.addEventListener('mouseenter', show);
  item.addEventListener('mouseleave', hide);
  item.addEventListener('mousedown', hide); // dismiss on click so it doesn't linger after switching
}

function setActive(id, { skipRender = false } = {}) {
  setState({ section: id });
  document.querySelectorAll('.embed-item').forEach(li => li.classList.toggle('active', li.dataset.id === id));
  const m = META[id];
  $('#insp-title').textContent = m.name;
  $('#insp-badge').textContent = m.cls;
  // Show/hide the website-native filter bar
  const cfb = $('#custom-filter-bar');
  if (cfb) cfb.hidden = id !== 'liveboard-custom';
  renderPersonalStrip(); // show/hide the Personal-liveboards strip for this section
  renderInspector();
  if (!skipRender) render();
}

// ── Render ─────────────────────────────────────────────────────────────────
function needsMissing(s) {
  const m = META[s.section];
  if (m.needs === 'worksheet' && !s.worksheetId) return 'Pick a Worksheet / Model in the Object section.';
  if (m.needs === 'liveboard' && !s.liveboardId) return 'Pick a Liveboard in the Object section.';
  if (m.needs === 'viz' && !(s.answerId || (s.liveboardId && s.vizId)))
    return 'Pick a Liveboard + Visualization (or a standalone Answer) in the Object section.';
  return null;
}

function render() {
  // Never render (the iframe would contact the host) while a shared-link host is unconfirmed.
  if (pendingHostConfirm) { showHostConfirm(getState().host); return; }
  // A normal render always exits any active drill-down (Q4) — drop the back bar and state.
  if (drillParent) { drillParent = null; hideDrillBar(); }
  const s = getState();
  renderPersonalStrip(); // paint/refresh the Personal-liveboards tab strip on every render path
  // fullHeight makes the SDK grow the iframe to the Liveboard's content height; the stage must then
  // scroll and stop pinning the iframe to 100% (see the .full-height rules in styles.css). Drive
  // that purely from the active section's flag so the CSS and the embed config never disagree.
  $('#embed-area').classList.toggle('full-height', !!(s.flags[s.section] || {}).fullHeight);
  if (!s.host) { setOverlay('not-connected'); return; }

  const missing = needsMissing(s);
  if (missing) {
    $('#needs-title').textContent = `${META[s.section].name} needs a data object`;
    $('#needs-sub').textContent = missing;
    setOverlay('needs');
    refreshCode();
    return;
  }

  // Headless AI Insights (REST) — a custom DOM panel, not an SDK iframe embed.
  if (s.section === 'ai-insights') {
    if (currentEmbed) { try { currentEmbed.destroy(); } catch (_) {} currentEmbed = null; }
    setOverlay('hidden');
    flowReset(s.section);
    refreshCode();
    renderAiInsights(s);
    return;
  }

  applyConfig();
  if (currentEmbed) { try { currentEmbed.destroy(); } catch (_) {} currentEmbed = null; }
  // Drop any leftover AI Insights panel when switching back to a real embed.
  document.getElementById('ai-insights-panel')?.remove();

  $('#loading-sub').textContent = `${META[s.section].cls} → ${s.host}`;
  setOverlay('loading');
  refreshCode();
  flowReset(s.section);

  const fallback = setTimeout(() => { setOverlay('hidden'); logEvent('Info', 'Embed handed off — verify you are logged in at the host.'); }, 4000);

  // Personal liveboards: when a copy tab is active, render THAT board (keep state.liveboardId = the
  // Standard/source board so it stays tab #1 and copy discovery stays keyed to the source). Same
  // clone-the-config pattern enterDrill() uses.
  const cfg = buildConfig();
  cfg.liveboardId = effectiveLiveboardId(s);

  authFailed = false; // fresh render — clear any prior auth-failure latch
  currentEmbed = doRender(s.section, cfg, {
    onDone() { if (authFailed) return; clearTimeout(fallback); setOverlay('hidden'); applyLiveFilters(); if (getState().section === 'liveboard-custom') cfbBuild(); maybeOpenCreatedCopyForEdit(); },
    onError(msg) {
      clearTimeout(fallback);
      const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
      // Auth failures (bad/expired token, blocked cookies) → the styled not-logged-in overlay,
      // latched so a trailing Load event for TS's own "Not logged in" page can't clear it.
      if (str === '__NO_COOKIE__' || str === '__AUTH_FAILURE__') { authFailed = true; setOverlay('not-logged-in'); return; }
      $('#error-sub').textContent = str;
      setOverlay('error');
    },
    onEvent: logEvent,
  }, {
    hiddenActions: hiddenActionKeys(s).map(k => Action[k]).filter(Boolean),
    disabledActions: s.disabledActions.map(k => Action[k]).filter(Boolean),
    customActions: buildEmbedCustomActions(s),
    runtimeParameters: s.runtimeParameters,
    flags: s.flags[s.section] || {},
    spotterQuery: s.section === 'spotter' ? pendingSpotterQuery : null,
  });
  pendingSpotterQuery = null; // consumed — only auto-runs on the render triggered by the bridge
  flowStart(); // SDK is now creating the iframe & opening the postMessage bridge
}

function applyLiveFilters() {
  const s = getState();
  if (!currentEmbed || !s.activeFilters.length) return;
  const filters = s.activeFilters.map(f => ({
    columnName: f.columnName, operator: RuntimeFilterOp[f.opKey], values: f.values,
  }));
  try { currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, filters); logEvent('HostEvent', `UpdateRuntimeFilters: ${filters.length} filter(s)`); } catch (_) {}
}

// ── State overlay ─────────────────────────────────────────────────────────────
function setOverlay(state) {
  const wrap = $('#state-overlay');
  if (state === 'hidden') { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  wrap.querySelectorAll('.st').forEach(e => e.classList.remove('active'));
  const e = wrap.querySelector(`.st-${state}`);
  if (e) e.classList.add('active');
  if (state === 'not-connected') {
    // The default copy assumes browser-session auth; trusted auth DOES need a key setup.
    const sub = wrap.querySelector('.st-not-connected .st-sub');
    if (sub) sub.textContent = getState().authType !== 'None'
      ? 'Trusted-token auth mints sign-in tokens via the local Node server — a one-time secret-key setup. Open “Token claims…” in the top bar for the step-by-step guide.'
      : 'Browser-session auth uses your existing ThoughtSpot login — no keys needed.';
  }
  if (state === 'not-logged-in') {
    $('#login-link').href = getState().host || '#';
    const authType = getState().authType;
    const isTrusted = authType === 'TrustedAuthTokenCookieless' || authType === 'TrustedAuthToken';
    const title = $('#not-logged-in-title');
    const sub = $('#not-logged-in-sub');
    if (title) title.textContent = isTrusted ? 'Embed session not authenticated' : 'Log in to ThoughtSpot first';
    if (sub) sub.textContent = isTrusted
      ? 'ThoughtSpot rejected the trusted-auth token, so the embed has no session. Re-mint a fresh token from Token claims… (Mint & apply), then it reloads automatically.'
      : 'Browser-session auth needs an active login at the host. Open ThoughtSpot, sign in, then retry.';
    // Swap the actions to match the auth mode: trusted auth is fixed by re-minting (Token
    // claims…), not by signing in at the host — so promote that button and demote Retry to a
    // secondary. Browser session keeps "Open ThoughtSpot ↗" + a primary Retry.
    const loginLink = $('#login-link');
    const claimsBtn = $('#open-claims-btn');
    const retryBtn = $('#state-overlay .st-not-logged-in [data-act="retry"]');
    if (loginLink) loginLink.hidden = isTrusted;
    if (claimsBtn) claimsBtn.hidden = !isTrusted;
    if (retryBtn) retryBtn.classList.toggle('st-btn-ghost', isTrusted);
  }
}

function bindStateOverlay() {
  $('#state-overlay').addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    if (act === 'retry') connect();
    if (act === 'proceed') render();
    if (act === 'open-claims') openAuthModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Close auth modal
    const modal = document.getElementById('auth-modal');
    if (modal && !modal.hidden) { modal.hidden = true; return; }
    // Close any open customSelect panel
    const openPanel = document.querySelector('.sel-panel:not([hidden])');
    if (openPanel) { openPanel.hidden = true; return; }
    // Close any open cfb panel or picker
    document.querySelectorAll('.cfb-panel:not([hidden]), .cfb-picker:not([hidden])').forEach(p => { p.hidden = true; });
  });
}

// ── Top bar ─────────────────────────────────────────────────────────────────
function bindTopbar() {
  $('#connect-btn').addEventListener('click', () => connect());
  $('#host-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  $('#share-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href)
      .then(() => toast('Link copied — paste it to share this exact setup.', 'success'))
      .catch(() => toast('Could not copy — try selecting the URL bar manually.'));
  });
  $('#auth-select').addEventListener('change', e => {
    setState({ authType: e.target.value });
    $('#auth-config-btn').hidden = e.target.value === 'None';
    // Modal first — it carries the setup guide, and must appear even if the SDK
    // re-init below throws (e.g. a malformed host typed into the top bar).
    if (e.target.value !== 'None') openAuthModal();
    applyConfig();
    render();
  });
  $('#auth-config-btn').addEventListener('click', openAuthModal);
  // Reset wipes every applied option — arm on first click, act on the second,
  // so a stray click next to "Best practices" can't silently destroy a setup.
  const resetBtn = $('#reset-btn');
  let resetDisarm = 0;
  const disarmReset = () => { resetBtn.classList.remove('confirm'); resetBtn.textContent = 'Reset'; };
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.classList.contains('confirm')) {
      resetBtn.classList.add('confirm');
      resetBtn.textContent = 'Reset all options?';
      clearTimeout(resetDisarm);
      resetDisarm = setTimeout(disarmReset, 2600);
      return;
    }
    clearTimeout(resetDisarm);
    disarmReset();
    resetState({ keepConnection: true });
    // Keep all cfb module state in sync with the cleared store.
    cfbCols = []; cfbSelected = {}; cfbSort = {}; cfbOrder = {}; cfbMetric = {};
    cfbValueCache = {}; cfbContents = []; cfbNumericCols = []; cfbDateCols = new Set();
    cfbMetricCache = {}; cfbAllColumns = []; cfbLoadedFor = '';
    aiInsightsCache = {}; aiQuery = '';   // force AI Insights to regenerate after a reset
    document.querySelectorAll('.act-hide, .act-disable').forEach(cb => { cb.checked = false; });
    renderInspector();
    applyConfig();
    render();
    toast('Options reset', 'success');
  });
}

// ── Bottom panel ────────────────────────────────────────────────────────────
function bindBottomPanel() {
  document.querySelectorAll('.bp-tab').forEach(t => t.addEventListener('click', () => {
    bottomTab = t.dataset.tab;
    document.querySelectorAll('.bp-tab').forEach(x => x.classList.toggle('active', x === t));
    $('#pane-log').classList.toggle('active', bottomTab === 'log');
    $('#pane-code').classList.toggle('active', bottomTab === 'code');
    $('#pane-flow').classList.toggle('active', bottomTab === 'flow');
    $('#pane-apis').classList.toggle('active', bottomTab === 'apis');
    $('#copy-code').hidden = bottomTab !== 'code';
    if ($('#bottom').dataset.open === 'false') toggleBottom(true);
    if (bottomTab === 'code') refreshCode();
    if (bottomTab === 'flow') renderFlow();
    if (bottomTab === 'apis') renderApis();
  }));
  $('#bp-toggle').addEventListener('click', () => toggleBottom());
  $('#clear-log').addEventListener('click', () => {
    $('#log-list').innerHTML = '<div class="log-empty">No events yet — interact with the embed.</div>';
    logCount = 0; $('#log-count').textContent = '0';
  });
  $('#copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(generateCode()).then(() => toast('SDK code copied', 'success'));
  });
}
function toggleBottom(force) {
  const bp = $('#bottom');
  const open = force != null ? force : bp.dataset.open === 'false';
  bp.dataset.open = String(open);
  $('#bp-toggle').classList.toggle('open', open);
}

function logEvent(type, data) {
  flowMark(type);
  logCount++;
  $('#log-count').textContent = String(logCount);
  const list = $('#log-list');
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();
  const row = el('div', 'log-row');
  // Use textContent — data comes from embed events/TS payloads (untrusted); type is a const string.
  const timeEl = el('span', 'lr-time'); timeEl.textContent = new Date().toTimeString().slice(0, 8);
  const typeEl = el('span', 'lr-type'); typeEl.textContent = type;
  const dataEl = el('span', 'lr-data'); dataEl.textContent = String(data);
  row.append(timeEl, typeEl, dataEl);
  list.insertBefore(row, list.firstChild);
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'warn') {
  const c = $('#toast-container');
  const t = el('div', `toast toast-${type}`);
  t.textContent = msg; // msg may contain upstream TS error text — must not be parsed as HTML
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 3200);
}

// Persistent "busy" toast with a spinner — for long operations (REST exports, PDF builds) that
// otherwise give no feedback, especially when fired from a custom action inside the embed. It stays
// up until you call the returned done(finalMsg?, type?): with a message it swaps into a short-lived
// result toast, with no args it just dismisses. Always call done() on every exit path.
function showBusy(msg) {
  const c = $('#toast-container');
  const t = el('div', 'toast toast-busy');
  const sp = el('span', 'toast-spinner');
  const lbl = el('span', 'toast-busy-label');
  lbl.textContent = msg; // may contain upstream text — keep as textContent
  t.append(sp, lbl);
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  let closed = false;
  return (finalMsg, type = 'success') => {
    if (closed) return;
    closed = true;
    if (finalMsg) {
      sp.remove();
      t.className = `toast toast-${type} show`;
      lbl.textContent = finalMsg;
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2600);
    } else {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }
  };
}

/** Trigger a browser download of a Blob with the given filename. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ═══ INSPECTOR — one contextual options panel ═════════════════════════════════
function renderInspector() {
  const s = getState();
  const body = $('#insp-body');
  body.innerHTML = '';
  // Make the connection state legible from the panel itself: while disconnected the data
  // pickers are disabled, so say why up front instead of leaving a dead-looking dropdown.
  $('#inspector').dataset.connected = String(connected);
  if (!connected) {
    const off = el('div', 'insp-offline');
    off.textContent = 'Not connected — options are browsable, but data objects load after you connect above.';
    body.appendChild(off);
  }
  const groupLbl = (t) => el('div', 'insp-group-lbl', t);
  if (s.section === 'ai-insights') {
    body.appendChild(sectionObject(s));         // Worksheet / Model picker (the metadata_identifier)
    body.appendChild(sectionAiControls(s));
    $('#insp-reset').onclick = () => { aiQuery = ''; renderInspector(); render(); };
    return;
  }
  if (s.section === 'ai-highlights') {
    const aiNote = el('div', 'sec-note');
    aiNote.textContent = 'Renders the selected Liveboard, then fires HostEvent.AIHighlights to open the insights panel automatically. Requires AI Highlights + KPI anomaly detection enabled on the instance (admin); SDK ≥ 1.44 / TS ≥ 10.15.';
    body.appendChild(aiNote);
  }
  // Sections are grouped by intent — Data (what renders), Behavior (how it acts),
  // Appearance (how it looks) — so first-time users know where to start.
  body.appendChild(groupLbl('Data'));
  body.appendChild(sectionObject(s));
  if (s.section === 'liveboard-custom') body.appendChild(sectionCfbSetup());
  if (['liveboard', 'liveboard-custom', 'viz', 'fullapp', 'ai-highlights'].includes(s.section)) body.appendChild(sectionFilters(s));
  if (['search', 'liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section)) body.appendChild(sectionParams(s));
  body.appendChild(groupLbl('Behavior'));
  if ((DISPLAY[s.section] || []).length) body.appendChild(sectionDisplay(s));
  body.appendChild(sectionActions(s));
  if (['liveboard', 'liveboard-custom', 'viz', 'fullapp', 'ai-highlights'].includes(s.section)) body.appendChild(sectionCustomActions(s));
  if (['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section)) body.appendChild(sectionExport(s));
  body.appendChild(sectionHostEvents(s));
  body.appendChild(groupLbl('Appearance'));
  body.appendChild(sectionStyles(s));
  $('#insp-reset').onclick = () => {
    setState({ flags: { ...s.flags, [s.section]: {} }, hiddenActions: [], disabledActions: [] });
    renderInspector(); render();
  };
}

// Which accordion sections are expanded — persisted across inspector re-renders.
const openAccordions = new Set(['Data object']);

/** Collapsible accordion section. */
function accordion(title, count, contentEl, openByDefault = false) {
  const wrap = el('div', 'acc');
  const head = el('button', 'acc-head', `<span>${title}</span><span class="acc-r"><span class="acc-count">${count || ''}</span><span class="acc-chev">›</span></span>`);
  head.type = 'button';
  const body = el('div', 'acc-body');
  body.appendChild(contentEl);
  if (openByDefault) openAccordions.add(title);
  const isOpen = openAccordions.has(title);
  if (isOpen) wrap.classList.add('open');
  head.setAttribute('aria-expanded', String(isOpen));
  head.addEventListener('click', () => {
    const nowOpen = wrap.classList.toggle('open');
    head.setAttribute('aria-expanded', String(nowOpen));
    nowOpen ? openAccordions.add(title) : openAccordions.delete(title);
  });
  wrap.append(head, body);
  return wrap;
}

function labeledSelect(label, value, options, onChange, hint, disabled = false) {
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', label));
  f.appendChild(customSelect(value, options, onChange, disabled));
  if (hint) f.appendChild(el('div', 'fld-hint', hint));
  return f;
}

// Custom dropdown replacing native <select>. Native selects open a macOS popup that aligns
// the selected row to the cursor, so long lists (e.g. all liveboards) overflow off the top of
// the screen. This panel is position:fixed (so the inspector's overflow:auto can't clip it),
// stays inside the viewport, flips up when there's no room below, and is searchable + scrollable.
function customSelect(value, options, onChange, disabled = false) {
  const wrap = el('div', 'sel');
  const current = options.find(o => o.id === value);
  const btn = el('button', 'sel-btn'); btn.type = 'button';
  btn.textContent = current ? current.name : '— select —';
  if (!current) btn.classList.add('sel-btn--placeholder');
  if (disabled) { btn.disabled = true; wrap.appendChild(btn); return wrap; }

  const panel = el('div', 'sel-panel'); panel.hidden = true;
  const search = el('input', 'sel-search'); search.type = 'text'; search.placeholder = 'Search…';
  const list = el('div', 'sel-list');
  panel.append(search, list);

  const renderList = (q = '') => {
    list.innerHTML = '';
    const ql = q.trim().toLowerCase();
    const all = [{ id: '', name: '— select —' }, ...options];
    const matches = all.filter(o => !ql || o.name.toLowerCase().includes(ql));
    if (!matches.length) { list.appendChild(el('div', 'sel-empty', 'No matches')); return; }
    matches.forEach(o => {
      const item = el('div', 'sel-item' + (o.id === value ? ' sel-item--active' : ''));
      item.textContent = o.name;
      item.addEventListener('click', () => { close(); onChange(o.id); });
      list.appendChild(item);
    });
  };

  function position() {
    const r = btn.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.width = `${r.width}px`;
    const gap = 4, pad = 10, cap = 300;
    const below = window.innerHeight - r.bottom - pad;
    const above = r.top - pad;
    if (below >= 180 || below >= above) {
      panel.style.top = `${r.bottom + gap}px`;
      panel.style.bottom = 'auto';
      panel.style.maxHeight = `${Math.min(cap, below)}px`;
    } else {
      panel.style.top = 'auto';
      panel.style.bottom = `${window.innerHeight - r.top + gap}px`;
      panel.style.maxHeight = `${Math.min(cap, above)}px`;
    }
  }
  const onDocClick = (ev) => { if (!wrap.contains(ev.target) && !panel.contains(ev.target)) close(); };
  // Close on page/inspector scroll (the fixed panel would otherwise detach from its button),
  // but NOT when the user scrolls inside the panel's own list — that's a capture-phase scroll
  // event whose target lives inside the panel, and closing it makes the list un-scrollable.
  const onReposition = (ev) => {
    if (ev && ev.type === 'scroll' && panel.contains(ev.target)) return;
    if (!panel.hidden) close();
  };
  function open() {
    document.querySelectorAll('.sel-panel').forEach(p => { if (p !== panel) p.hidden = true; });
    renderList(); search.value = '';
    document.body.appendChild(panel);   // portal out so nothing clips it
    panel.hidden = false; position();
    setTimeout(() => {
      document.addEventListener('click', onDocClick);
      window.addEventListener('resize', onReposition);
      window.addEventListener('scroll', onReposition, true);
      search.focus();
    }, 0);
  }
  function close() {
    panel.hidden = true;
    if (panel.parentNode === document.body) wrap.appendChild(panel);
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('resize', onReposition);
    window.removeEventListener('scroll', onReposition, true);
  }
  search.addEventListener('input', () => renderList(search.value));
  btn.addEventListener('click', () => { panel.hidden ? open() : close(); });

  wrap.append(btn, panel);
  return wrap;
}

// — Object section (contextual data pickers) —
function sectionObject(s) {
  const c = el('div', 'sec-body');
  const needs = META[s.section].needs;
  if (!connected) c.appendChild(el('div', 'sec-note', 'Connect to load objects, or paste a GUID after connecting.'));

  if (needs === 'worksheet') {
    c.appendChild(labeledSelect('Worksheet / Model', s.worksheetId, discovered.worksheets,
      v => { setState({ worksheetId: v }); renderInspector(); render(); }, 'Used by Search, NL Search, Spotter', !connected));
    if (s.section === 'search') {
      c.appendChild(textField('Pre-fill search query', s.searchTokenString, v => { setState({ searchTokenString: v }); render(); }, '[Sales Amount] [Region]'));
      c.appendChild(toggleField('Auto-execute search', s.executeSearch, v => { setState({ executeSearch: v }); render(); }));
    }
  }
  if (needs === 'liveboard' || needs === 'viz') {
    // Q3 — tag-based categorization. Tags come from metadata/search (metadata_header.tags);
    // pick one to narrow the liveboard list the way a host app's section navigation would.
    const allTags = [...new Set((discovered.liveboards || []).flatMap(lb => lb.tags || []))].sort();
    if (allTags.length) {
      c.appendChild(labeledSelect('Filter by tag', lbTagFilter,
        [{ id: '', name: 'All tags' }, ...allTags.map(t => ({ id: t, name: t }))],
        v => { lbTagFilter = v; renderInspector(); },
        'Tags read live from metadata/search. Server-side uses tag_identifiers.'));
    }
    // When Personal liveboards is on, hide the user's own copies (tagged with the scoping tag) from the
    // SOURCE picker so they can't be personalized again — but keep the currently-selected board visible.
    const plbTag = s.personalLb?.enabled ? (s.personalLb.tag || 'Personal') : '';
    const lbOptions = (discovered.liveboards || [])
      .filter(lb => !lbTagFilter || (lb.tags || []).includes(lbTagFilter))
      .filter(lb => !plbTag || lb.id === s.liveboardId || !(lb.tags || []).includes(plbTag))
      .map(lb => ({ id: lb.id, name: lb.tags?.length ? `${lb.name}  ·  ${lb.tags.join(', ')}` : lb.name }));
    c.appendChild(labeledSelect('Liveboard', s.liveboardId, lbOptions,
      async v => { setState({ liveboardId: v, vizId: '', cfbCols: [], cfbSelected: {}, cfbSort: {}, cfbOrder: {}, cfbMetric: {}, personalLb: { ...getState().personalLb, activeCopyId: '' } }); cfbAllColumns = []; cfbValueCache = {}; cfbContents = []; cfbNumericCols = []; cfbDateCols = new Set(); cfbMetricCache = {}; cfbLoadedFor = ''; cfbCols = []; cfbSelected = {}; cfbSort = {}; cfbOrder = {}; cfbMetric = {}; await loadViz(v); await refreshPersonalCopies(); renderInspector(); render(); }, '', !connected));
  }
  if (needs === 'viz') {
    // Lazy-load vizzes when the inspector renders with a pre-selected liveboard but a cold
    // cache — happens on page reload or when arriving via a shared link.
    if (s.liveboardId && vizCache[s.liveboardId] === undefined && !_vizLoading.has(s.liveboardId)) {
      loadViz(s.liveboardId).then(() => renderInspector());
    }
    const isLoading = _vizLoading.has(s.liveboardId);
    const vizzes = vizCache[s.liveboardId] || [];
    c.appendChild(labeledSelect('Visualization', s.vizId, vizzes,
      v => { setState({ vizId: v, answerId: '' }); renderInspector(); render(); },
      !s.liveboardId ? 'Pick a liveboard first' : isLoading ? 'Loading…' : '', !connected));
    // When discovery fails (CORS, auth, or no vizzes returned), show a GUID paste field
    // so users can still drive the embed without needing the REST call to succeed.
    if (s.liveboardId && !isLoading && vizzes.length === 0) {
      const note = el('div', 'sec-note');
      note.textContent = vizCache[s.liveboardId] === null
        ? 'Viz list unavailable (CORS or auth). Paste a viz GUID directly:'
        : 'No visualizations found. Paste a viz GUID directly:';
      c.appendChild(note);
      c.appendChild(textField('Visualization GUID', s.vizId,
        v => { setState({ vizId: v.trim(), answerId: '' }); render(); },
        'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'));
    }
  }
  if (needs === 'none') c.appendChild(el('div', 'sec-note', 'Full App needs no GUID — it embeds the whole ThoughtSpot experience.'));

  return accordion('Data object', '', c, true);
}

async function loadViz(liveboardId) {
  if (!liveboardId || vizCache[liveboardId] !== undefined || _vizLoading.has(liveboardId)) return;
  _vizLoading.add(liveboardId);
  try {
    const r = await Discovery.discoverViz(getState().host, liveboardId);
    vizCache[liveboardId] = r.ok ? (r.visualizations || []) : null;
  } finally {
    _vizLoading.delete(liveboardId);
  }
}

function textField(label, value, onChange, placeholder) {
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', label));
  const i = el('input', 'inp'); i.type = 'text'; i.value = value || ''; i.placeholder = placeholder || '';
  i.addEventListener('change', () => onChange(i.value.trim()));
  f.appendChild(i);
  return f;
}
// Small native <select> for short enum choices (lighter than the searchable customSelect).
function enumSelect(label, value, opts, onChange, hint) {
  const f = el('div', 'fld');
  if (hint) f.title = hint;
  f.appendChild(el('label', 'fld-lbl', label));
  const sel = el('select', 'inp');
  sel.innerHTML = opts.map(o => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${o.label}</option>`).join('');
  sel.addEventListener('change', () => onChange(sel.value));
  f.appendChild(sel);
  return f;
}
function toggleField(label, value, onChange, hint) {
  const f = el('label', 'tgl');
  if (hint) f.title = hint;
  f.innerHTML = `<span>${label}</span>`;
  const i = el('input'); i.type = 'checkbox'; i.checked = !!value;
  const slider = el('span', 'tgl-slider');
  i.addEventListener('change', () => onChange(i.checked));
  f.append(i, slider);
  return f;
}

// — Display flags —
function sectionDisplay(s) {
  const c = el('div', 'sec-body');
  const flags = s.flags[s.section] || {};
  let active = 0;
  DISPLAY[s.section].forEach(([key, label, def, opts]) => {
    const cur = key in flags ? flags[key] : def;
    if (key in flags && flags[key] !== def) active++;
    const hint = HINTS[key];
    if (opts) {
      const sel = el('div', 'fld');
      if (hint) sel.title = hint;
      sel.appendChild(el('label', 'fld-lbl', label));
      const dd = el('select', 'inp');
      dd.innerHTML = opts.map(o => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join('');
      dd.addEventListener('change', () => setFlag(key, dd.value, def));
      sel.appendChild(dd);
      c.appendChild(sel);
    } else {
      c.appendChild(toggleField(label, cur, v => setFlag(key, v, def), hint));
    }
  });
  // Spotter: the chat-interface / history / stop-generation / limitations flags only surface a
  // feature the CLUSTER already allows — the Spotter experience (2 / 3) must be enabled instance-side.
  if (s.section === 'spotter') {
    c.appendChild(el('div', 'sec-note', 'The Spotter 3 chat interface, chat-history sidebar, stop-generation and limitations options only take effect when the matching Spotter experience is enabled on your ThoughtSpot cluster — the SDK flag surfaces the feature, the instance must already allow it.'));
  }
  // "Show shared-with users" — the strip of viewer avatars in the Liveboard header: the people the
  // board is shared with / who have viewed it (ThoughtSpot's "recently visited / social proof"
  // users). This is the LiveboardUsers action (lives in hiddenActions), so the toggle controls
  // hide/show and stays in sync with the LiveboardUsers row in Modify actions + the generated code.
  // IMPORTANT: that strip ONLY renders in the compact header (isLiveboardCompactHeaderEnabled) — the
  // default Masterpieces header never paints it. So when the action is visible but the compact
  // header is off, we surface a one-click prompt to enable it, otherwise the toggle looks inert.
  if (['liveboard', 'liveboard-custom', 'ai-highlights'].includes(s.section)) {
    const usersHidden = s.hiddenActions.includes('LiveboardUsers');
    const compactOn = flags.isLiveboardCompactHeaderEnabled === true;
    if (usersHidden) active++;
    c.appendChild(toggleField('Show shared-with users', !usersHidden,
      v => toggleAction('hiddenActions', 'LiveboardUsers', !v),
      'The viewer/shared-with avatars in the Liveboard header (ThoughtSpot’s “recently visited / social proof” users). Off hides the LiveboardUsers action. Note: this strip only renders in the compact header, and only when the board actually has viewer data and the feature is enabled on your cluster.'));
    if (!usersHidden && !compactOn) {
      c.appendChild(el('div', 'sec-note', 'These avatars only render in the compact header — the default header never shows them. Enable it to see them:'));
      const cbtn = el('button', 'sec-add', '→ Enable compact header');
      cbtn.addEventListener('click', () => { setFlag('isLiveboardCompactHeaderEnabled', true, false); renderInspector(); });
      c.appendChild(cbtn);
    }
  }
  // App-injected "Date" PRIMARY button (not a native embed flag): enable/disable + target column.
  // Toggling re-renders so the SDK picks up the added/removed customAction at init.
  if (['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section)) {
    const db = s.dateBtn || { enabled: false, column: 'Order Date' };
    if (db.enabled) active++;
    c.appendChild(el('div', 'sub-lbl', 'Date filter button'));
    c.appendChild(toggleField('Show “Date” primary button', db.enabled, v => {
      setState({ dateBtn: { ...getState().dateBtn, enabled: v } });
      render();
    }, 'Adds a Primary button on the liveboard toolbar. Clicking it opens a Today / On-a-specific-date chooser and applies a runtime filter — sidestepping the native date dialog and its Between/Yesterday default. Off by default.'));
    if (db.enabled) {
      c.appendChild(textField('Filter column', db.column, v => {
        setState({ dateBtn: { ...getState().dateBtn, column: v || 'Order Date' } });
      }, 'Order Date'));
    }
  }
  // Personal liveboards — per-user editable copies shown as a tab strip above the board.
  if (PLB_SECTIONS.includes(s.section)) {
    const plb = s.personalLb || { enabled: false, tag: 'Personal' };
    if (plb.enabled) active++;
    c.appendChild(el('div', 'sub-lbl', 'Personal liveboards'));
    c.appendChild(toggleField('Enable personal copies (tab strip)', plb.enabled, v => {
      setState({ personalLb: { ...getState().personalLb, enabled: v, activeCopyId: '' } });
      renderInspector();
      render();
      if (v) refreshPersonalCopies();
    }, 'Adds a tab strip above the board: Standard | your copies | ＋ Personalize. Each “Personalize” makes a full, editable, user-owned clone (POST metadata/copyobject, 10.3.0.cl+), tagged so it’s re-discovered per user + per board. For saved filter/sort VIEWS instead of editable copies, the native Action.PersonalizedViewsDropdown is simpler.'));
    if (plb.enabled) {
      c.appendChild(textField('Scoping tag', plb.tag, v => {
        setState({ personalLb: { ...getState().personalLb, tag: v || 'Personal' } });
      }, 'Personal'));
    }
  }
  return accordion('Display options', active, c);
}
function setFlag(key, value, def) {
  const s = getState();
  const flags = { ...(s.flags[s.section] || {}) };
  if (value === def) delete flags[key]; else flags[key] = value;
  setState({ flags: { ...s.flags, [s.section]: flags } });
  render();
}

// — Modify actions —
function sectionActions(s) {
  const c = el('div', 'sec-body');
  const list = ACTIONS[s.section] || VIZ_DOWNLOAD_ACTIONS;
  const isLb = ['liveboard', 'liveboard-custom', 'ai-highlights'].includes(s.section);
  if (isLb) {
    const note = el('div', 'sec-note',
      'To disable export on the Answers <em>inside</em> the board but keep the whole-board export, hide the <strong>viz-level</strong> download actions (Download / DownloadAsPdf / DownloadAsCsv / DownloadAsXlsx) and leave <strong>DownloadLiveboard</strong> visible. Hover a row for its scope.');
    note.style.marginBottom = '10px';
    c.appendChild(note);
  }
  const tbl = el('div', 'act-tbl');
  tbl.appendChild(el('div', 'act-hdr', '<span>Action</span><span>Hide</span><span>Disable</span>'));
  list.forEach(a => {
    const row = el('div', 'act-row');
    if (ACTION_HINTS[a]) row.title = ACTION_HINTS[a];
    row.appendChild(el('span', 'act-name', a));
    const hide = el('input', 'act-hide'); hide.type = 'checkbox'; hide.checked = s.hiddenActions.includes(a);
    const dis = el('input', 'act-disable'); dis.type = 'checkbox'; dis.checked = s.disabledActions.includes(a);
    hide.addEventListener('change', () => toggleAction('hiddenActions', a, hide.checked));
    dis.addEventListener('change', () => toggleAction('disabledActions', a, dis.checked));
    row.append(hide, dis);
    tbl.appendChild(row);
  });
  c.appendChild(tbl);
  return accordion('Modify actions', s.hiddenActions.length + s.disabledActions.length, c);
}
function toggleAction(key, name, on) {
  const s = getState();
  const arr = new Set(s[key]);
  on ? arr.add(name) : arr.delete(name);
  setState({ [key]: [...arr] });
  render();
}

// The effective hidden-action keys: the user's picks, plus the native Download actions when
// "Hide native Download" is on (so users can only export via the custom button below).
function hiddenActionKeys(s) {
  const keys = [...s.hiddenActions];
  const lbish = ['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section);
  if (lbish && s.exportOpts?.hideNativeDownload) {
    for (const k of ['DownloadLiveboard', 'DownloadAsPdf', 'Download']) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

// The custom actions passed to the embed: the user's, plus a synthetic "Export" menu action
// (id '__export') when enabled, which the EmbedEvent.CustomAction dispatcher routes to runExport().
function buildEmbedCustomActions(s) {
  const actions = s.customActions.map(a => ({
    id: a.id,
    name: a.label,                                            // SDK 1.43+ reads "name", not "label"
    position: CustomActionsPosition[a.pos] ?? CustomActionsPosition.PRIMARY,
    target: CustomActionTarget[a.target] ?? CustomActionTarget.LIVEBOARD,
  }));
  const lbish = ['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section);
  if (lbish && s.exportOpts?.menuAction) {
    actions.push({
      id: '__export',
      name: s.exportOpts.actionLabel || 'Preconfigured pdf download',
      position: CustomActionsPosition.MENU,                   // the "…" overflow menu
      target: CustomActionTarget.LIVEBOARD,
    });
  }
  // "Customize Export" — same REST export, but the action opens a runtime dialog so the END USER
  // picks the format/PDF options at click-time (vs "Preconfigured pdf download", which exports with the
  // host's pre-set options). The dispatcher routes id '__export_customize' to openExportPicker().
  if (lbish && s.exportOpts?.pickerAction) {
    actions.push({
      id: '__export_customize',
      name: s.exportOpts.pickerLabel || 'Customize Export',
      position: CustomActionsPosition.MENU,                   // the "…" overflow menu
      target: CustomActionTarget.LIVEBOARD,
    });
  }
  // "Download invoice pdf" — injected here (not created in the TS UI) so the label and placement
  // are controlled in-app and can't collide with ThoughtSpot's native "Download PDF". Placed in the
  // LIVEBOARD "…" (More) menu (swap MENU→PRIMARY for a visible header button). The
  // EmbedEvent.CustomAction dispatcher routes id PDF_ACTION_ID to handleInvoicePdf(); because a
  // liveboard action carries no viz answer session, resolveAnswerService() mints one for the viz.
  if (lbish) {
    actions.push({
      id: PDF_ACTION_ID,
      name: 'Download invoice pdf',
      position: CustomActionsPosition.MENU,                   // liveboard "…" (More) overflow menu
      target: CustomActionTarget.LIVEBOARD,
    });
  }
  // "Date" — a PRIMARY toolbar button (host-side date filter). Only injected when enabled in Display
  // options. The CustomAction dispatcher routes DATE_ACTION_ID → openDatePicker(), which applies
  // Today / a specific date as a runtime filter — the host-side control that sidesteps the native
  // date dialog and its un-presettable Between/Yesterday default.
  if (lbish && s.dateBtn?.enabled) {
    actions.push({
      id: DATE_ACTION_ID,
      name: 'Date',
      position: CustomActionsPosition.PRIMARY,                // visible primary button on the toolbar
      target: CustomActionTarget.LIVEBOARD,
    });
  }
  return actions;
}

// — Custom export (REST /report/liveboard) — full control over the exported file —
function sectionExport(s) {
  const eo = s.exportOpts || {};
  const c = el('div', 'sec-body');
  c.appendChild(el('div', 'sec-note',
    'Export via the REST Report API instead of the native modal — you control every option (and which ones the user sees). The current active filters are baked in.'));

  c.appendChild(enumSelect('Format', eo.format, [
    { value: 'PDF', label: 'PDF' }, { value: 'XLSX', label: 'XLSX' },
    { value: 'CSV', label: 'CSV (zip if multi-viz)' }, { value: 'PNG', label: 'PNG' },
  ], v => setExportOpt('format', v), 'XLSX keeps full pivot/cross-tab formatting; CSV & XLSX never truncate.'));

  if (eo.format === 'PDF') {
    c.appendChild(enumSelect('Page layout', eo.pageSize, [
      { value: 'A4', label: 'A4 pages (page breaks)' },
      { value: 'CONTINUOUS', label: 'Continuous — beta, needs enablement' },
    ], v => setExportOpt('pageSize', v), 'A4 (GA) forces page breaks between visualizations. Continuous matches the on-screen layout but is beta — ThoughtSpot Support must enable it, or the API returns 400.'));
    c.appendChild(enumSelect('Orientation', eo.orientation, [
      { value: 'LANDSCAPE', label: 'Landscape' }, { value: 'PORTRAIT', label: 'Portrait' },
    ], v => setExportOpt('orientation', v)));
    c.appendChild(toggleField('Truncate wide tables', eo.truncateTable, v => setExportOpt('truncateTable', v),
      'OFF = show ALL columns/rows (fixes cross-tab / form-report cutoff). ON = first page only.'));
    c.appendChild(toggleField('Include cover page', eo.includeCoverPage, v => setExportOpt('includeCoverPage', v)));
    c.appendChild(toggleField('Include filter page', eo.includeFilterPage, v => setExportOpt('includeFilterPage', v)));
    c.appendChild(toggleField('Include page numbers', eo.includePageNumber, v => setExportOpt('includePageNumber', v)));
    c.appendChild(toggleField('Include logo', eo.includeCustomLogo, v => setExportOpt('includeCustomLogo', v)));
    c.appendChild(textField('Footer text', eo.footerText, v => setExportOpt('footerText', v), 'e.g. Confidential'));
  }

  c.appendChild(toggleField('Hide native Download in embed', eo.hideNativeDownload, v => setExportOpt('hideNativeDownload', v),
    'Removes the built-in Download action so users can export only via your button — full control over the output.'));

  c.appendChild(toggleField('Add “Preconfigured pdf download” to Liveboard menu', eo.menuAction, v => setExportOpt('menuAction', v),
    'Adds a custom action in the Liveboard “…” menu that exports immediately with the options set above. ThoughtSpot fires EmbedEvent.CustomAction; the host catches it and runs this REST export.'));
  if (eo.menuAction) c.appendChild(textField('Menu action label', eo.actionLabel, v => setExportOpt('actionLabel', v || 'Preconfigured pdf download'), 'Preconfigured pdf download'));

  c.appendChild(toggleField('Add “Customize Export” to Liveboard menu', eo.pickerAction, v => setExportOpt('pickerAction', v),
    'Adds a second menu action that opens a selection dialog so the end user picks the format & PDF options at export time, then downloads. The options above seed the dialog’s defaults.'));
  if (eo.pickerAction) c.appendChild(textField('Picker action label', eo.pickerLabel, v => setExportOpt('pickerLabel', v || 'Customize Export'), 'Customize Export'));

  const btn = el('button', 'sec-apply', '⬇ Export now (test)');
  btn.type = 'button';
  btn.style.marginTop = '10px';
  btn.addEventListener('click', () => runExport(btn));
  c.appendChild(btn);

  let active = 0;
  if (eo.format !== 'PDF') active++;
  if (eo.truncateTable) active++;
  if (eo.hideNativeDownload) active++;
  return accordion('Export options', active, c);
}
function setExportOpt(key, value) {
  const s = getState();
  setState({ exportOpts: { ...s.exportOpts, [key]: value } });
  renderInspector();
  refreshCode();
  // These change what the embed renders (hidden Download / injected menu actions), so re-embed.
  if (['hideNativeDownload', 'menuAction', 'actionLabel', 'pickerAction', 'pickerLabel'].includes(key)) render();
}

// Run the REST export with the host's configured options; bakes in active (and cfb) filters.
async function runExport(btn) {
  return performReportExport(getState().exportOpts || {}, btn);
}

// Shared REST-export runner: exports the current liveboard with the given options object, baking in
// the active runtime + custom-filter-bar filters. Used by runExport (pre-set opts) AND the
// "Customize Export" dialog (opts the end user just picked). Returns true on a successful download.
async function performReportExport(eo, btn) {
  const s = getState();
  if (!s.host || !s.liveboardId) { toast('Connect and pick a liveboard first.'); return false; }
  const format = (eo.format || 'PDF').toUpperCase();
  const overrideFilters = [
    ...s.activeFilters.filter(f => f.values && f.values.length).map(f => ({ column_name: f.columnName, values: f.values })),
    ...Object.entries(cfbSelected).filter(([, v]) => v && v.length).map(([col, v]) => ({ column_name: col, values: v })),
  ];
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⬇ …'; }
  const done = showBusy(`Preparing ${format} download…`);
  logEvent('Export', `report/liveboard ${format} → ${s.liveboardId}${overrideFilters.length ? ` (${overrideFilters.length} filter(s))` : ''}`);
  try {
    const res = await Discovery.downloadLiveboardReport(s.host, s.liveboardId, format, overrideFilters, eo);
    if (!res.ok) {
      logEvent('Export', `✗ ${res.error}`);
      done();
      if (res.status === 401 || res.status === 403) {
        toast('Not authorized — log in at the host or use a token.');
      } else if (res.status === 400 && format === 'PDF' && eo.pageSize === 'CONTINUOUS') {
        toast('400 — Continuous PDF is beta and likely not enabled on this instance. Switch Page layout to A4.');
      } else {
        toast(`${format} export failed: ${res.error}`);
      }
      return false;
    }
    saveBlob(res.blob, `liveboard-${s.liveboardId}.${res.ext}`);
    logEvent('Export', `✓ ${res.ext.toUpperCase()} downloaded`);
    done(`✓ ${res.ext.toUpperCase()} downloaded`, 'success');
    return true;
  } catch (e) {
    logEvent('Export', `✗ ${e.message}`);
    done();
    toast(`${format} export failed: ${e.message}`);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

// "Customize Export" — an in-embed selection screen. Opens a centered modal seeded from the host's
// configured export options; the end user tweaks the format & PDF knobs, then Export downloads via
// the same REST Report API path (active filters baked in). The tweaks are EPHEMERAL — they never
// overwrite the host's saved exportOpts (a working copy is used).
function openExportPicker() {
  const s = getState();
  if (!s.host || !s.liveboardId) { toast('Connect and pick a liveboard first.'); return; }
  // Don't stack dialogs if the action is clicked twice.
  document.getElementById('export-modal')?.remove();

  const opts = { ...(s.exportOpts || {}) };

  const modal = el('div', 'modal'); modal.id = 'export-modal';
  const scrim = el('div', 'modal-scrim');
  const panel = el('div', 'modal-panel modal-panel--center');
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const head = el('div', 'modal-head',
    '<div><div class="modal-title">Customize Export</div>' +
    '<div class="modal-sub">Pick your options, then export. The current active filters are applied.</div></div>');
  const x = el('button', 'modal-close', '✕'); x.type = 'button'; x.addEventListener('click', close);
  head.appendChild(x);

  const body = el('div', 'modal-body');
  const renderBody = () => {
    body.innerHTML = '';
    body.appendChild(enumSelect('Format', opts.format, [
      { value: 'PDF', label: 'PDF' }, { value: 'XLSX', label: 'XLSX' },
      { value: 'CSV', label: 'CSV (zip if multi-viz)' }, { value: 'PNG', label: 'PNG' },
    ], v => { opts.format = v; renderBody(); }, 'XLSX keeps full pivot/cross-tab formatting; CSV & XLSX never truncate.'));

    if (opts.format === 'PDF') {
      body.appendChild(enumSelect('Page layout', opts.pageSize, [
        { value: 'A4', label: 'A4 pages (page breaks)' },
        { value: 'CONTINUOUS', label: 'Continuous — beta, needs enablement' },
      ], v => { opts.pageSize = v; }, 'A4 (GA) forces page breaks. Continuous matches the on-screen layout but is beta.'));
      body.appendChild(enumSelect('Orientation', opts.orientation, [
        { value: 'LANDSCAPE', label: 'Landscape' }, { value: 'PORTRAIT', label: 'Portrait' },
      ], v => { opts.orientation = v; }));
      body.appendChild(toggleField('Truncate wide tables', opts.truncateTable, v => { opts.truncateTable = v; },
        'OFF = show ALL columns/rows. ON = first page only.'));
      body.appendChild(toggleField('Include cover page', opts.includeCoverPage, v => { opts.includeCoverPage = v; }));
      body.appendChild(toggleField('Include filter page', opts.includeFilterPage, v => { opts.includeFilterPage = v; }));
      body.appendChild(toggleField('Include page numbers', opts.includePageNumber, v => { opts.includePageNumber = v; }));
      body.appendChild(toggleField('Include logo', opts.includeCustomLogo, v => { opts.includeCustomLogo = v; }));
      body.appendChild(textField('Footer text', opts.footerText, v => { opts.footerText = v; }, 'e.g. Confidential'));
    }
  };
  renderBody();

  const foot = el('div', 'modal-foot');
  const cancel = el('button', 'sec-apply ghost', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
  const go = el('button', 'sec-apply', '⬇ Export'); go.type = 'button';
  go.addEventListener('click', async () => { const ok = await performReportExport(opts, go); if (ok) close(); });
  foot.append(cancel, go);

  panel.append(head, body, foot);
  modal.append(scrim, panel);
  document.body.appendChild(modal);
}

// ── "Date" primary custom action → host-side date filter ──────────────────────
// The PRIMARY "Date" toolbar button (injected when Display options › "Show Date primary button" is
// on) routes here. It applies Today / a specific date as a runtime filter, so the value is fully
// host-controlled — no native date dialog, no un-presettable Between/Yesterday default.

// Local YYYY-MM-DD for "today" (matches what an <input type="date"> shows).
function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Apply (iso = 'YYYY-MM-DD') or clear (iso = null) an "On this date" runtime filter on `column`.
// UpdateRuntimeFilters REPLACES the whole set, so we resend existing runtime/filter-bar filters
// (minus this column) alongside it. Date values go as epoch SECONDS — ThoughtSpot's date runtime-
// filter format — at local midnight, so "Today" is recomputed fresh on each click.
function applyDateFilter(column, iso) {
  if (!currentEmbed) { toast('Render a liveboard first.'); return; }
  const base = buildParentRuntimeFilters().filter(f => f.columnName !== column);
  let logVal = 'cleared';
  if (iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const epoch = Math.floor(new Date(y, m - 1, d).getTime() / 1000);
    base.push({ columnName: column, operator: RuntimeFilterOp.EQ, values: [String(epoch)] });
    logVal = `EQ ${iso} (epoch ${epoch})`;
  }
  try {
    currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, base);
    logEvent('CustomAction', `Date filter → ${column} ${logVal}`);
    toast(iso ? `Date filter: ${column} on ${iso}` : 'Date filter cleared', 'success');
  } catch (e) {
    logEvent('CustomAction', `✗ Date filter: ${e.message}`);
    toast('Could not apply date filter.', 'error');
  }
}

function openDatePicker() {
  const s = getState();
  if (!currentEmbed) { toast('Render a liveboard first.'); return; }
  const column = (s.dateBtn?.column || 'Order Date').trim() || 'Order Date';
  document.getElementById('date-modal')?.remove();

  let mode = 'today';           // 'today' | 'on'
  let onDate = todayISO();

  const modal = el('div', 'modal'); modal.id = 'date-modal';
  const scrim = el('div', 'modal-scrim');
  const panel = el('div', 'modal-panel modal-panel--center');
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // Head — column via textContent (it's serialized into the untrusted #s= hash, so never innerHTML it).
  const head = el('div', 'modal-head');
  const htxt = el('div');
  htxt.appendChild(el('div', 'modal-title', 'Date filter'));
  const sub = el('div', 'modal-sub');
  const strong = document.createElement('strong'); strong.textContent = column;
  sub.append('Applies to ', strong, ' via HostEvent.UpdateRuntimeFilters.');
  htxt.appendChild(sub);
  const xbtn = el('button', 'modal-close', '✕'); xbtn.type = 'button'; xbtn.addEventListener('click', close);
  head.append(htxt, xbtn);

  const body = el('div', 'modal-body');
  const renderBody = () => {
    body.innerHTML = '';
    body.appendChild(enumSelect('When', mode, [
      { value: 'today', label: 'Today (recomputed on each click)' },
      { value: 'on', label: 'On a specific date' },
    ], v => { mode = v; renderBody(); }));
    if (mode === 'on') {
      const fld = el('div', 'fld');
      fld.appendChild(el('label', 'fld-lbl', 'Date'));
      const inp = el('input', 'inp'); inp.type = 'date'; inp.value = onDate;
      inp.addEventListener('change', () => { onDate = inp.value; });
      fld.appendChild(inp);
      body.appendChild(fld);
    }
  };
  renderBody();

  const foot = el('div', 'modal-foot');
  const clear = el('button', 'sec-apply ghost', 'Clear'); clear.type = 'button';
  clear.addEventListener('click', () => { applyDateFilter(column, null); close(); });
  const cancel = el('button', 'sec-apply ghost', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
  const go = el('button', 'sec-apply', 'Apply'); go.type = 'button';
  go.addEventListener('click', () => {
    const iso = mode === 'today' ? todayISO() : onDate;
    if (!iso) { toast('Pick a date.'); return; }
    applyDateFilter(column, iso);
    close();
  });
  foot.append(clear, cancel, go);

  panel.append(head, body, foot);
  modal.append(scrim, panel);
  document.body.appendChild(modal);
}

// — Runtime filters (live, HostEvent) —
function sectionFilters(s) {
  const c = el('div', 'sec-body');
  c.appendChild(el('div', 'sec-note', 'Applied live via HostEvent.UpdateRuntimeFilters — no re-render needed.'));
  c.appendChild(el('div', 'sec-note sec-note--warn',
    '⚠ Not a security boundary. Runtime filters become visible URL params the user can edit — use them for drill-down/convenience only. For tenant isolation or per-user data, enforce it server-side with RLS / ABAC (mint a custom token with variable_values).'));
  const rows = el('div', 'rows');
  s.activeFilters.forEach((f, i) => rows.appendChild(filterRow(f, i)));
  c.appendChild(rows);
  const add = el('button', 'sec-add', '+ Add filter');
  add.addEventListener('click', () => {
    setState({ activeFilters: [...getState().activeFilters, { columnName: '', opKey: 'EQ', values: [] }] });
    renderInspector();
  });
  const apply = el('button', 'sec-apply', 'Apply filters');
  apply.addEventListener('click', () => {
    if (!currentEmbed) { toast('No active embed — render one first.'); return; }
    // Read directly from the DOM so uncommitted input values (not yet blurred) are captured.
    const frows = rows.querySelectorAll('.frow');
    const filters = [];
    const stateSync = [];
    frows.forEach(row => {
      const inputs = row.querySelectorAll('.inp');
      const col = inputs[0]?.value.trim();
      const opKey = inputs[1]?.value || 'EQ';
      const valStr = inputs[2]?.value.trim() || '';
      if (!col) return;
      const values = valStr ? valStr.split(',').map(v => v.trim()).filter(Boolean) : [];
      const operator = RuntimeFilterOp[opKey];
      if (operator === undefined) { toast(`Unknown operator: ${opKey}`); return; }
      filters.push({ columnName: col, operator, values });
      stateSync.push({ columnName: col, opKey, values });
    });
    if (!filters.length) { toast('Add at least one filter with a column name.'); return; }
    try {
      currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, filters);
      setState({ activeFilters: stateSync }); // keep state in sync for code view
      logEvent('HostEvent', `UpdateRuntimeFilters (${filters.length}): ${stateSync.map(f => f.columnName).join(', ')}`);
      refreshCode();
    } catch (e) {
      logEvent('HostEvent', `✗ UpdateRuntimeFilters: ${e.message}`);
      toast(`Filter error: ${e.message}`);
    }
  });
  c.append(add, apply);
  return accordion('Runtime filters', s.activeFilters.length, c);
}
function filterRow(f, i) {
  const r = el('div', 'frow');
  const col = el('input', 'inp inp-sm'); col.placeholder = 'Column'; col.value = f.columnName;
  const op = el('select', 'inp inp-sm'); op.innerHTML = OPERATORS.map(o => `<option${o === f.opKey ? ' selected' : ''}>${o}</option>`).join('');
  const val = el('input', 'inp inp-sm'); val.placeholder = 'value(s), comma-sep'; val.value = (f.values || []).join(', ');
  const del = el('button', 'frow-x', '✕');
  const commit = () => {
    const list = [...getState().activeFilters];
    list[i] = { columnName: col.value.trim(), opKey: op.value, values: val.value.split(',').map(v => v.trim()).filter(Boolean) };
    setState({ activeFilters: list });
  };
  col.addEventListener('change', commit); op.addEventListener('change', commit); val.addEventListener('change', commit);
  del.addEventListener('click', () => { const list = [...getState().activeFilters]; list.splice(i, 1); setState({ activeFilters: list }); renderInspector(); });
  r.append(col, op, val, del);
  return r;
}

// — Runtime parameters (re-render) —
function sectionParams(s) {
  const c = el('div', 'sec-body');
  const rows = el('div', 'rows');
  s.runtimeParameters.forEach((p, i) => {
    const r = el('div', 'frow');
    const name = el('input', 'inp inp-sm'); name.placeholder = 'name'; name.value = p.name;
    const val = el('input', 'inp inp-sm'); val.placeholder = 'value'; val.value = p.value;
    const del = el('button', 'frow-x', '✕');
    const commit = () => { const list = [...getState().runtimeParameters]; list[i] = { name: name.value.trim(), value: val.value.trim() }; setState({ runtimeParameters: list }); };
    name.addEventListener('change', commit); val.addEventListener('change', commit);
    del.addEventListener('click', () => { const list = [...getState().runtimeParameters]; list.splice(i, 1); setState({ runtimeParameters: list }); renderInspector(); render(); });
    r.append(name, val, del); rows.appendChild(r);
  });
  c.appendChild(rows);
  const add = el('button', 'sec-add', '+ Add parameter');
  add.addEventListener('click', () => { setState({ runtimeParameters: [...getState().runtimeParameters, { name: '', value: '' }] }); renderInspector(); });
  const apply = el('button', 'sec-apply', 'Apply — re-render');
  apply.addEventListener('click', () => render());
  c.append(add, apply);
  return accordion('Runtime parameters', s.runtimeParameters.length, c);
}

// — Custom actions —
function sectionCustomActions(s) {
  const c = el('div', 'sec-body');
  const label = textField('Button label', '', null, 'Send to CRM'); const labelInp = label.querySelector('input');
  const typeF = el('div', 'fld'); typeF.appendChild(el('label', 'fld-lbl', 'Type'));
  const typeSel = el('select', 'inp'); typeSel.innerHTML = `<option value="callback">Callback (capture payload)</option><option value="url">URL (open with row data)</option><option value="writeback">Write-back (POST /api/writeback)</option><option value="drill">Drill-down (re-render at detail board)</option>`;
  typeF.appendChild(typeSel);
  const posF = el('div', 'fld'); posF.appendChild(el('label', 'fld-lbl', 'Position'));
  const posSel = el('select', 'inp'); posSel.innerHTML = `<option value="PRIMARY">Primary button (toolbar)</option><option value="MENU">More menu (⋮)</option><option value="CONTEXTMENU">Right-click context menu</option>`;
  posF.appendChild(posSel);
  const tgtF = el('div', 'fld'); tgtF.appendChild(el('label', 'fld-lbl', 'Target'));
  const tgtSel = el('select', 'inp'); tgtSel.innerHTML = `<option value="LIVEBOARD">Liveboard</option><option value="VIZ">Visualization</option><option value="ANSWER">Answer</option><option value="SPOTTER">Spotter</option>`;
  tgtF.appendChild(tgtSel);
  tgtF.appendChild(el('div', 'fld-hint', 'Where the action attaches. CONTEXTMENU + VIZ fires per data point; PRIMARY + LIVEBOARD shows a toolbar button.'));
  // URL template — only meaningful for the "url" type, so it's revealed when that's selected.
  const urlF = el('div', 'fld'); urlF.appendChild(el('label', 'fld-lbl', 'URL template'));
  const urlInp = el('input', 'inp'); urlInp.type = 'text';
  urlInp.placeholder = 'https://crm.example.com/lookup?id={{Customer ID}}';
  urlF.appendChild(urlInp);
  urlF.appendChild(el('div', 'fld-hint', 'Opened when the action fires. Use {{Column Name}} placeholders to inject values from the clicked row.'));
  // Drill target — only meaningful for the "drill" type. The detail liveboard re-renders in
  // place carrying the parent filter bar + the clicked point's attributes (Q4).
  const drillF = el('div', 'fld'); drillF.appendChild(el('label', 'fld-lbl', 'Drill-down liveboard GUID'));
  const drillInp = el('input', 'inp'); drillInp.type = 'text';
  drillInp.placeholder = 'curated-detail-liveboard-guid';
  drillF.appendChild(drillInp);
  drillF.appendChild(el('div', 'fld-hint', 'Best with Position = Right-click context menu + Target = Visualization. On click, this board re-renders with the parent’s filters + the clicked value, and a ← Back bar appears.'));
  // When a chip is being edited, prefill the form with its current values.
  const editing = editingActionId ? s.customActions.find(a => a.id === editingActionId) : null;
  if (editing) {
    labelInp.value = editing.label;
    typeSel.value = editing.type || 'callback';
    posSel.value = editing.pos || 'PRIMARY';
    tgtSel.value = editing.target || 'LIVEBOARD';
    urlInp.value = editing.urlTemplate || '';
    drillInp.value = editing.drillLiveboardId || '';
  }
  const syncTypeFields = () => { urlF.hidden = typeSel.value !== 'url'; drillF.hidden = typeSel.value !== 'drill'; };
  syncTypeFields();
  typeSel.addEventListener('change', syncTypeFields);
  c.append(label, typeF, posF, tgtF, urlF, drillF);

  const add = el('button', 'sec-apply', editing ? '✓ Save changes & re-render' : '+ Add action & re-render');
  add.addEventListener('click', () => {
    const lbl = labelInp.value.trim(); if (!lbl) { toast('Enter a label first.'); return; }
    // Keep the original id while editing so the click-handler registry stays valid.
    const rawId = lbl.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const id = editing ? editing.id : (rawId || `action-${Date.now()}`);
    if (!editing && getState().customActions.find(a => a.id === id)) { toast('An action with this label already exists.'); return; }
    const type = typeSel.value;
    const urlTemplate = type === 'url' ? urlInp.value.trim() : '';
    if (type === 'url' && !urlTemplate) { toast('Enter a URL template for a URL action.'); return; }
    const drillLiveboardId = type === 'drill' ? drillInp.value.trim() : '';
    if (type === 'drill' && !drillLiveboardId) { toast('Enter the drill-down liveboard GUID.'); return; }
    customActionRegistry[id] = { type, label: lbl, urlTemplate, drillLiveboardId };
    const entry = { id, label: lbl, pos: posSel.value, target: tgtSel.value, type, urlTemplate, drillLiveboardId };
    const list = [...getState().customActions];
    const idx = list.findIndex(a => a.id === id);
    if (idx >= 0) list[idx] = entry; else list.push(entry);   // replace in place when editing, else append
    editingActionId = null;
    setState({ customActions: list });
    renderInspector(); render();
  });
  c.appendChild(add);
  if (editing) {
    const cancel = el('button', 'sec-apply ghost', 'Cancel edit');
    cancel.addEventListener('click', () => { editingActionId = null; renderInspector(); });
    c.appendChild(cancel);
  }

  if (s.customActions.length) {
    c.appendChild(el('div', 'fld-hint', 'Click a chip to edit it · ✕ to remove. Format: label · type · position/target.'));
    const chips = el('div', 'chips');
    s.customActions.forEach((a, i) => {
      const active = a.id === editingActionId;
      const chip = el('span', `chip${active ? ' chip-active' : ''}`);
      // textContent — a.label can arrive from a shared link and must not be parsed as HTML.
      chip.textContent = `${a.label} · ${a.type} · ${a.pos || 'PRIMARY'}/${a.target || 'LIVEBOARD'}`;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', (ev) => { if (ev.target.classList.contains('chip-x')) return; editingActionId = a.id; renderInspector(); });
      const x = el('button', 'chip-x', '✕'); x.setAttribute('aria-label', `Remove ${a.label}`);
      x.addEventListener('click', (ev) => { ev.stopPropagation(); const list = [...getState().customActions]; list.splice(i, 1); if (editingActionId === a.id) editingActionId = null; setState({ customActions: list }); renderInspector(); render(); });
      chip.appendChild(x); chips.appendChild(chip);
    });
    c.appendChild(chips);
  }
  return accordion('Custom actions', s.customActions.length, c);
}

// — Host events —
function sectionHostEvents(s) {
  const c = el('div', 'sec-body');
  c.appendChild(el('div', 'sec-note', 'Drive the live embed from the host page.'));
  const mk = (label, ph, fn) => {
    const r = el('div', 'frow');
    const i = el('input', 'inp inp-sm'); i.placeholder = ph;
    const b = el('button', 'frow-go', '→'); b.title = label;
    b.addEventListener('click', () => fn(i.value.trim()));
    r.append(i, b); return { r, i };
  };
  c.appendChild(mk('HostEvent.Search', 'search query', q => { if (q) trigger(HostEvent.Search, { searchQuery: q }, `Search "${q}"`); }).r);
  c.appendChild(mk('HostEvent.Navigate', 'navigate path / GUID', p => { if (p) trigger(HostEvent.Navigate, p, `Navigate ${p}`); }).r);
  c.appendChild(mk('HostEvent.SetVisibleVizs', 'viz GUIDs, comma-sep', v => { if (v) trigger(HostEvent.SetVisibleVizs, v.split(',').map(x => x.trim()), 'SetVisibleVizs'); }).r);
  const reload = el('button', 'sec-apply', '⟳ Reload embed');
  reload.addEventListener('click', () => trigger(HostEvent.Reload, undefined, 'Reload'));
  c.appendChild(reload);
  return accordion('Host events', '', c);
}
function trigger(evt, payload, label) {
  if (!currentEmbed) { toast('No embed active. Render one first.'); return; }
  try { currentEmbed.trigger(evt, payload); logEvent('HostEvent', label); }
  catch (e) { logEvent('HostEvent', `✗ ${label}: ${e.message}`); }
}

// ═══ AI INSIGHTS (headless REST) — custom panel, no iframe ═════════════════════
// A "build your own panel" demo of ThoughtSpot's Spotter REST API: suggest analytical
// questions for a data source (/ai/relevant-questions/) and generate single answers
// (/ai/answer/create), rendering the results as our own DOM cards instead of an embed.

// Inspector controls for the AI Insights section.
function sectionAiControls(s) {
  const c = el('div', 'sec-body');
  c.appendChild(el('div', 'sec-note', 'Insights auto-generate via Spotter REST when you open this section — no question needed. Results render in a custom panel (no iframe). Needs Spotter enabled + the CAN_USE_SPOTTER privilege (Beta endpoints).'));
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', 'Insights to generate (max)'));
  const inp = el('input', 'inp'); inp.type = 'number'; inp.min = '1'; inp.max = '10'; inp.value = String(aiLimit);
  inp.addEventListener('change', () => { aiLimit = Math.min(10, Math.max(1, Number(inp.value) || 5)); inp.value = String(aiLimit); });
  f.appendChild(inp);
  f.appendChild(el('div', 'fld-hint', 'limit_relevant_questions — how many insights to auto-generate. Change, then ↻ Regenerate in the panel.'));
  c.appendChild(f);
  return accordion('AI options', '', c, true);
}

// Build + mount the panel into #ts-embed-container (replacing any prior embed/panel).
// Insights AUTO-GENERATE on landing — no question typing required.
function renderAiInsights(s) {
  const host = s.host;
  const container = $('#ts-embed-container');
  container.innerHTML = '';
  const ws = (discovered.worksheets || []).find(w => w.id === s.worksheetId);
  const wsName = ws ? ws.name : s.worksheetId;

  const panel = el('div', 'aip'); panel.id = 'ai-insights-panel';

  const head = el('div', 'aip-head');
  head.appendChild(el('div', 'aip-title', '✨ AI Insights'));
  const sub = el('div', 'aip-sub');
  sub.textContent = `Auto-generated by Spotter (REST) for: ${wsName}`;
  head.appendChild(sub);
  panel.appendChild(head);

  const ask = el('div', 'aip-ask');
  const input = el('input', 'inp aip-input');
  input.type = 'text';
  input.placeholder = 'Ask a follow-up — e.g. "Top 5 products by sales last quarter"';
  input.value = aiQuery;
  const askBtn = el('button', 'sec-apply aip-go'); askBtn.textContent = 'Ask';
  const regenBtn = el('button', 'sec-add aip-suggest'); regenBtn.textContent = '↻ Regenerate';
  ask.append(input, askBtn, regenBtn);
  panel.appendChild(ask);

  // Narrative status line — the "what's going on" text shown above the insight cards.
  const status = el('div', 'aip-status'); panel.appendChild(status);
  const results = el('div', 'aip-results'); panel.appendChild(results);
  container.appendChild(panel);

  const setStatus = (t) => { status.textContent = t; };
  const setBusy = (b) => { aiBusy = b; askBtn.disabled = b; regenBtn.disabled = b; };

  // Manual follow-up question → prepend a fully-rendered insight card (answer + inline data).
  const runAnswer = async (query) => {
    if (!query) { toast('Type a question first.'); return; }
    if (aiBusy) return;
    aiQuery = query; input.value = query;
    setBusy(true);
    const card = aiInsightCard(query);
    results.insertBefore(card.el, results.firstChild);
    const item = { query, answer: null, data: null, error: null, dataError: null };
    await loadInsight(host, s.worksheetId, item);
    card.fill(item);
    setBusy(false);
  };

  // Auto-generate insights for the data source. Runs on landing; result cached per worksheet.
  const runAutoInsights = async () => {
    if (aiBusy) return;
    setBusy(true);
    results.innerHTML = '';
    setStatus(`✨ Analyzing “${wsName}” — asking Spotter what stands out…`);
    logEvent('REST', 'POST /ai/relevant-questions/ (auto)');
    const r = await Discovery.aiRelevantQuestions(host, {
      query: 'Summarize the most important insights, trends, and outliers in this data.',
      worksheetIds: [s.worksheetId], limit: aiLimit,
    });
    logEvent('REST', `/ai/relevant-questions/ → ${r.ok ? 'ok' : 'HTTP ' + (r.status || 'error')}`);
    if (!r.ok) { setStatus('Couldn’t generate insights:'); results.appendChild(aiErrorCard('✨ AI Insights', r.error)); setBusy(false); return; }
    if (!r.questions.length) { setStatus(''); results.appendChild(aiErrorCard('✨ AI Insights', 'Spotter returned no insights for this data source. Try a different Worksheet/Model.')); setBusy(false); return; }
    const n = r.questions.length;
    setStatus(`✨ Here’s what Spotter surfaced for “${wsName}” — ${n} insight${n > 1 ? 's' : ''}. Data shown inline; open any one in Spotter for the full interactive chart.`);
    // Render a card per insight immediately, then fill each (answer + data) in parallel.
    const items = r.questions.map(qq => ({ query: qq.query, answer: null, data: null, error: null, dataError: null }));
    const cards = items.map(it => { const card = aiInsightCard(it.query); results.appendChild(card.el); return card; });
    await Promise.all(items.map(async (it, i) => { await loadInsight(host, s.worksheetId, it); cards[i].fill(it); }));
    aiInsightsCache[s.worksheetId] = { wsName, items };
    setBusy(false);
  };

  askBtn.addEventListener('click', () => runAnswer(input.value.trim()));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runAnswer(input.value.trim()); });
  input.addEventListener('input', () => { aiQuery = input.value; });
  regenBtn.addEventListener('click', () => { delete aiInsightsCache[s.worksheetId]; runAutoInsights(); });

  // Land → show cached insights instantly, or auto-generate them now (no click needed).
  const cached = aiInsightsCache[s.worksheetId];
  if (cached) {
    const n = cached.items.length;
    setStatus(`✨ Here’s what Spotter surfaced for “${cached.wsName}” — ${n} insight${n > 1 ? 's' : ''}. Ask a follow-up below, or ↻ Regenerate.`);
    cached.items.forEach(it => { const card = aiInsightCard(it.query); results.appendChild(card.el); card.fill(it); });
  } else {
    runAutoInsights();
  }
}

// — AI Insights card builders (all dynamic text via textContent: TS payloads are untrusted) —

// Resolve one insight: Spotter answer (NL → tokens) → actual data rows (searchdata). Mutates item.
async function loadInsight(host, worksheetId, item) {
  const a = await Discovery.aiSingleAnswer(host, { query: item.query, metadataIdentifier: worksheetId });
  logEvent('REST', `/ai/answer/create → ${a.ok ? 'ok' : 'HTTP ' + (a.status || 'error')}`);
  if (!a.ok) { item.error = a.error; return item; }
  item.answer = a.answer;
  // Materialize the resolved tokens into real data rows so the insight shows inline.
  const tokens = a.answer.tokens || a.answer.display_tokens || '';
  if (tokens) {
    const d = await Discovery.aiSearchData(host, { queryString: tokens, worksheetId, recordSize: 10 });
    logEvent('REST', `/searchdata → ${d.ok ? `${d.returned} rows` : 'HTTP ' + (d.status || 'error')}`);
    if (d.ok) item.data = d; else item.dataError = d.error;
  }
  return item;
}

function aiErrorCard(title, msg) {
  const c = el('div', 'aip-card aip-card--err');
  const q = el('div', 'aip-card-q'); q.textContent = title;
  const m = el('div', 'aip-card-errmsg'); m.textContent = msg;
  c.append(q, m);
  return c;
}

// Compact data table from a searchdata result. COMPACT rows are arrays aligned to column_names;
// fall back to object lookup just in case the instance returns FULL-shaped rows.
function aiDataTable(data) {
  const wrap = el('div', 'aip-table-wrap');
  const table = el('table', 'aip-table');
  const thead = el('thead'); const htr = el('tr');
  data.columns.forEach(name => { const th = el('th'); th.textContent = name; htr.appendChild(th); });
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = el('tbody');
  data.rows.slice(0, 10).forEach(row => {
    const tr = el('tr');
    data.columns.forEach((name, i) => {
      const td = el('td');
      const v = Array.isArray(row) ? row[i] : (row && typeof row === 'object' ? row[name] : row);
      td.textContent = (v === null || v === undefined || v === '') ? '—' : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table);
  return wrap;
}

// Progressive insight card: shows the question immediately, then fills the resolved query +
// an inline data table (with Open-in-Spotter as a secondary action for the full chart).
function aiInsightCard(query) {
  const c = el('div', 'aip-card aip-insight');
  const q = el('div', 'aip-card-q'); q.textContent = query;
  const body = el('div', 'aip-insight-body');
  const load = el('div', 'aip-loading');
  load.append(el('span', 'st-spinner aip-spin'), document.createTextNode(' Generating…'));
  body.appendChild(load);
  c.append(q, body);
  return {
    el: c,
    fill(item) {
      body.innerHTML = '';
      if (item.error) { const m = el('div', 'aip-card-errmsg'); m.textContent = item.error; body.appendChild(m); return; }
      const ans = item.answer || {};
      const resolved = ans.display_tokens || ans.tokens || '';
      if (resolved) {
        const tok = el('div', 'aip-tokens'); tok.textContent = resolved; body.appendChild(tok);
      }
      if (item.data && item.data.columns.length && item.data.rows.length) {
        body.appendChild(aiDataTable(item.data));
        const shown = Math.min(10, item.data.rows.length);
        const foot = el('div', 'aip-table-foot');
        foot.textContent = item.data.totalRows > shown ? `Showing ${shown} of ${item.data.totalRows} rows` : `${shown} row${shown === 1 ? '' : 's'}`;
        body.appendChild(foot);
      } else if (item.dataError) {
        const note = el('div', 'aip-table-foot'); note.textContent = `Inline data unavailable (${item.dataError}). Open in Spotter for the chart.`;
        body.appendChild(note);
      }
      const open = el('button', 'sec-add aip-open'); open.textContent = 'Open in Spotter ↗';
      open.addEventListener('click', () => { pendingSpotterQuery = item.query; setActive('spotter'); });
      body.appendChild(open);
    },
  };
}

// — Custom styles —
function sectionStyles(s) {
  const c = el('div', 'sec-body');
  c.appendChild(el('div', 'sec-note', 'CSS variables match standalone TS styling; rules_UNSTABLE target elements by selector.'));
  // Variables
  c.appendChild(el('div', 'sub-lbl', 'CSS variables'));
  const vars = el('div', 'rows');
  Object.entries(s.styles.variables).forEach(([k, v]) => vars.appendChild(kvRow(k, v, 'variables')));
  c.appendChild(vars);
  const addVar = el('button', 'sec-add', '+ Add variable');
  addVar.addEventListener('click', () => { const st = { ...getState().styles }; st.variables = { ...st.variables, '': '' }; setState({ styles: st }); renderInspector(); });
  c.appendChild(addVar);
  // Parse Element — paste DevTools HTML to extract a CSS selector
  c.appendChild(el('div', 'sub-lbl', 'Parse element'));
  const parseWrap = el('div', 'fld');
  const parseHint = el('div', 'fld-hint', 'In ThoughtSpot: right-click any element → Inspect → right-click the node → Copy → Copy element. Paste below.');
  const parseArea = el('textarea', 'inp');
  parseArea.placeholder = 'Paste element HTML from DevTools…';
  parseArea.style.cssText = 'height:58px;resize:vertical;font-family:var(--mono);font-size:11px;padding:7px 10px;';
  const parseBtn = el('button', 'sec-add', '→ Extract selector');
  parseBtn.style.marginTop = '4px';
  parseBtn.addEventListener('click', () => {
    const raw = parseArea.value.trim();
    if (!raw) { toast('Paste some HTML first.'); return; }
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const node = doc.body.firstElementChild;
    if (!node) { toast('Could not parse — paste the full opening tag from DevTools.'); return; }
    let selector = null;
    if (node.dataset.testid)                selector = `[data-testid="${node.dataset.testid}"]`;
    else if (node.getAttribute('aria-label')) selector = `[aria-label="${node.getAttribute('aria-label')}"]`;
    else if (node.id)                         selector = `#${node.id}`;
    else if (node.className && typeof node.className === 'string') {
      const first = node.className.trim().split(/\s+/)[0];
      if (first) selector = `.${first}`;
    }
    if (!selector) { toast('No usable selector found (no data-testid, aria-label, id, or class).'); return; }
    const st = { ...getState().styles };
    st.rules = { ...st.rules, [selector]: { display: 'none !important' } };
    setState({ styles: st });
    parseArea.value = '';
    renderInspector();
    toast(`Added: ${selector}`, 'success');
  });
  parseWrap.append(parseHint, parseArea, parseBtn);
  c.appendChild(parseWrap);

  // Rules
  c.appendChild(el('div', 'sub-lbl', 'CSS rules (rules_UNSTABLE)'));
  // Paste a full CSS block — parsed (via the browser's own CSS engine) into the rule rows below.
  const pasteWrap = el('div', 'fld');
  const pasteHint = el('div', 'fld-hint', 'Paste a full CSS block (selector { declarations }). Each rule is added to the list below; hex colors may normalise to rgb().');
  const pasteArea = el('textarea', 'inp');
  pasteArea.placeholder = 'button:has([*|href="#rd-icon-more"]) {\n  opacity: 1 !important;\n  visibility: visible !important;\n}';
  pasteArea.style.cssText = 'height:92px;resize:vertical;font-family:var(--mono);font-size:11px;padding:7px 10px;';
  const pasteBtn = el('button', 'sec-add', '→ Add CSS');
  pasteBtn.style.marginTop = '4px';
  pasteBtn.addEventListener('click', () => {
    const raw = pasteArea.value.trim();
    if (!raw) { toast('Paste some CSS first.'); return; }
    const { rules: parsed, error } = parseCssText(raw);
    if (error) { toast(`Could not parse CSS: ${error}`, 'error'); return; }
    const sels = Object.keys(parsed);
    if (!sels.length) { toast('No rules found — include at least one selector { … } block.', 'error'); return; }
    const st = { ...getState().styles };
    st.rules = { ...st.rules, ...parsed };
    setState({ styles: st });
    pasteArea.value = '';
    renderInspector();
    toast(`Added ${sels.length} rule${sels.length > 1 ? 's' : ''}.`, 'success');
  });
  pasteWrap.append(pasteHint, pasteArea, pasteBtn);
  c.appendChild(pasteWrap);
  const rules = el('div', 'rows');
  Object.entries(s.styles.rules).forEach(([sel, decls]) => rules.appendChild(ruleRow(sel, decls)));
  c.appendChild(rules);
  const addRule = el('button', 'sec-add', '+ Add rule');
  addRule.addEventListener('click', () => { const st = { ...getState().styles }; st.rules = { ...st.rules, '': {} }; setState({ styles: st }); renderInspector(); });
  const apply = el('button', 'sec-apply', 'Apply — reload embed');
  apply.addEventListener('click', () => { applyConfig(); render(); });
  c.append(addRule, apply);
  const count = Object.keys(s.styles.variables).length + Object.keys(s.styles.rules).length;
  return accordion('Custom styles', count, c);
}
function kvRow(key, val, bucket) {
  const r = el('div', 'frow');
  const k = el('input', 'inp inp-sm'); k.placeholder = '--ts-var-root-background'; k.value = key;
  const v = el('input', 'inp inp-sm'); v.placeholder = '#0F1623'; v.value = val;
  const x = el('button', 'frow-x', '✕');
  const commit = () => { const st = { ...getState().styles }; const b = { ...st[bucket] }; delete b[key]; if (k.value.trim()) b[k.value.trim()] = v.value.trim(); st[bucket] = b; setState({ styles: st }); };
  k.addEventListener('change', commit); v.addEventListener('change', commit);
  x.addEventListener('click', () => { const st = { ...getState().styles }; const b = { ...st[bucket] }; delete b[key]; st[bucket] = b; setState({ styles: st }); renderInspector(); });
  r.append(k, v, x); return r;
}
function ruleRow(sel, decls) {
  const r = el('div', 'frow');
  const s = el('input', 'inp inp-sm'); s.placeholder = '[data-testid="share-button"]'; s.value = sel;
  const d = el('input', 'inp inp-sm'); d.placeholder = 'display: none !important'; d.value = Object.entries(decls).map(([p, v]) => `${p}: ${v}`).join('; ');
  const x = el('button', 'frow-x', '✕');
  const commit = () => {
    const st = { ...getState().styles }; const rules = { ...st.rules }; delete rules[sel];
    if (s.value.trim()) {
      const obj = {}; d.value.split(';').forEach(p => { const i = p.indexOf(':'); if (i > 0) obj[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
      rules[s.value.trim()] = obj;
    }
    st.rules = rules; setState({ styles: st });
  };
  s.addEventListener('change', commit); d.addEventListener('change', commit);
  x.addEventListener('click', () => { const st = { ...getState().styles }; const rules = { ...st.rules }; delete rules[sel]; st.rules = rules; setState({ styles: st }); renderInspector(); });
  r.append(s, d, x); return r;
}
// Pull style rules out of a parsed CSSRuleList into the { selector: { prop: 'value [!important]' } }
// shape that rules_UNSTABLE expects. Only CSSStyleRule entries are kept (skips @media/@font-face/etc.).
function extractCssRules(cssRules) {
  const rules = {};
  for (const rule of cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue;
    const decls = {};
    for (let i = 0; i < rule.style.length; i++) {
      const prop = rule.style[i];
      const val = rule.style.getPropertyValue(prop);
      decls[prop] = rule.style.getPropertyPriority(prop) === 'important' ? `${val} !important` : val;
    }
    if (Object.keys(decls).length) rules[rule.selectorText] = { ...(rules[rule.selectorText] || {}), ...decls };
  }
  return rules;
}
// Parse a raw CSS string using the browser's own CSS engine, so selectors/declarations are
// validated exactly as ThoughtSpot will see them. Prefers a constructable stylesheet (no DOM
// side effects); falls back to a detached <style> for older engines. Returns { rules, error? }.
function parseCssText(cssText) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    return { rules: extractCssRules(sheet.cssRules) };
  } catch (_) {
    try {
      const styleEl = el('style');
      styleEl.textContent = cssText;
      document.head.appendChild(styleEl);
      const rules = styleEl.sheet ? extractCssRules(styleEl.sheet.cssRules) : {};
      styleEl.remove();
      return { rules };
    } catch (e) {
      return { rules: {}, error: e.message };
    }
  }
}

// ═══ CUSTOM LIVEBOARD — website-native filter bar ════════════════════════════

/** Discover all columns from the liveboard, then rebuild the active filter dropdowns. */
async function cfbBuild() {
  if (_cfbBuilding) return;
  _cfbBuilding = true;
  const container = $('#cfb-dropdowns');
  try {
    // Restore persisted setup (shared link / reload) instead of wiping it.
    const saved = getState();
    if (!cfbCols.length && saved.cfbCols?.length) cfbCols = [...saved.cfbCols];
    cfbSelected = { ...(saved.cfbSelected || {}) };
    cfbSort = { ...(saved.cfbSort || {}) };
    cfbOrder = { ...(saved.cfbOrder || {}) };
    cfbMetric = { ...(saved.cfbMetric || {}) };
    // Show a placeholder while the single liveboard/data fetch resolves.
    if (container && cfbCols.length) container.innerHTML = '<span class="cfb-loading">Loading filters…</span>';
    await cfbLoadData();                 // ONE fetch → columns + every column's values
    if (!container) return;
    container.innerHTML = '';
    // Values are now cache-resident, so this loop is synchronous-fast (no per-column network).
    for (const col of cfbCols) {
      container.appendChild(cfbBuildDropdown(col, cfbValueCache[col] || []));
    }
    container.appendChild(cfbAddBtn(container));
    cfbApply(); // re-apply restored selections to the live embed
  } finally {
    _cfbBuilding = false;
  }
}

/**
 * Fetch the liveboard's data EXACTLY ONCE and derive both the full column list and every
 * column's distinct values from that single payload. Cached per-liveboard, so adding filter
 * columns, re-renders, and the value lookups below never trigger another network round-trip.
 * (Previously each column re-fetched the entire 10k-row dataset — the cause of slow loads.)
 */
async function cfbLoadData() {
  const s = getState();
  if (!s.liveboardId) return;
  if (cfbLoadedFor === s.liveboardId && cfbAllColumns.length) return;   // already loaded
  if (_cfbLoadPromise) return _cfbLoadPromise;                          // dedupe concurrent callers
  _cfbLoadPromise = (async () => {
    let contents = [];
    try {
      if (s.authType && s.authType !== 'None') {
        // The proxy forwards the CALLER'S token (it never mints an admin one), so send ours.
        const token = Discovery.getBearerToken();
        const res = await fetch(`${API_BASE}/api/filter-values`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ liveboardId: s.liveboardId }),   // no column → raw contents
        });
        recordApi({ scope: 'playground', method: 'POST', path: '/api/filter-values', status: res.status });
        if (res.ok) contents = (await res.json()).contents || [];
        else if (res.status === 401) logEvent('CustomFilter', '✗ filter values need a minted token — open Token claims… and Mint & apply first.');
      } else {
        const host = s.host.replace(/\/+$/, '');
        const res = await fetch(`${host}/api/rest/2.0/metadata/liveboard/data`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata_identifier: s.liveboardId, record_size: CFB_RECORD_SIZE, record_offset: 0 }),
        });
        recordApi({ scope: 'TS REST', method: 'POST', path: '/api/rest/2.0/metadata/liveboard/data', status: res.status });
        if (res.ok) contents = (await res.json()).contents ?? [];
      }
    } catch (_) { contents = []; }

    // Accumulate distinct values per column across every viz that contains it.
    const all = new Set();
    const valuesByCol = {};
    contents.forEach(c => {
      const cols = c.column_names ?? [];
      const rows = c.data_rows ?? [];
      cols.forEach((name, idx) => {
        all.add(name);
        const set = valuesByCol[name] || (valuesByCol[name] = new Set());
        rows.forEach(r => { const v = r[idx]; set.add(v === null || v === undefined ? '{Null}' : String(v)); });
      });
    });
    const sortVals = arr => [...arr].sort((a, b) => a === '{Null}' ? -1 : b === '{Null}' ? 1 : a.localeCompare(b, undefined, { numeric: true }));
    cfbAllColumns = [...all].sort();
    Object.keys(valuesByCol).forEach(name => { cfbValueCache[name] = sortVals(valuesByCol[name]); });
    // Keep the raw blocks so 'metric' sort can aggregate one column per value of another,
    // and flag numeric columns (≥80% parseable) as eligible metric columns.
    cfbContents = contents;
    cfbMetricCache = {};
    const isNumeric = vals => {
      let n = 0, t = 0;
      vals.forEach(v => { if (v === '{Null}') return; t++; if (Number.isFinite(Number(v))) n++; });
      return t > 0 && n / t >= 0.8;
    };
    cfbNumericCols = Object.keys(valuesByCol).filter(name => isNumeric([...valuesByCol[name]])).sort();
    // Date columns come back as epoch numbers (no type metadata in this API), so detect them
    // heuristically — a date-ish name plus at least one epoch-parseable value — and format for
    // display only. They're dropped from the metric list (summing epochs is meaningless).
    cfbDateCols = new Set(Object.keys(valuesByCol).filter(name =>
      CFB_DATE_NAME_RE.test(name) && [...valuesByCol[name]].some(v => cfbFmtDate(v) !== null)));
    cfbNumericCols = cfbNumericCols.filter(c => !cfbDateCols.has(c));
    cfbLoadedFor = s.liveboardId;
  })();
  try { await _cfbLoadPromise; } finally { _cfbLoadPromise = null; }
}

/** Discover all columns from the liveboard (now just ensures the single data load ran). */
async function cfbDiscoverColumns() { await cfbLoadData(); }

/** Build the "+ Add filter" button with an inline column picker. */
function cfbAddBtn(container) {
  const wrap = document.createElement('div'); wrap.className = 'cfb-add-wrap';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cfb-add-btn'; btn.textContent = '+ Add filter';
  const picker = document.createElement('div'); picker.className = 'cfb-picker'; picker.hidden = true;

  const addCol = async (col) => {
    picker.hidden = true;
    if (!col || cfbCols.includes(col)) return;
    cfbCols.push(col);
    const values = await cfbFetchValues(col);
    container.insertBefore(cfbBuildDropdown(col, values), wrap);
    persistCfb();
    renderInspector();
  };

  const populate = () => {
    picker.innerHTML = '';
    const unused = cfbAllColumns.filter(c => !cfbCols.includes(c));

    const search = document.createElement('input');
    search.className = 'cfb-pick-search'; search.type = 'text';
    search.placeholder = 'Search or type a column name…';

    const list = document.createElement('div'); list.className = 'cfb-pick-list';

    const renderList = q => {
      list.innerHTML = '';
      const trimmed = q.trim();
      const matches = unused.filter(c => !trimmed || c.toLowerCase().includes(trimmed.toLowerCase()));

      if (!matches.length && !unused.length && !trimmed) {
        const d = document.createElement('div'); d.className = 'cfb-pick-empty';
        d.textContent = cfbAllColumns.length ? 'All discovered columns in use' : 'No columns discovered yet';
        list.appendChild(d);
      }

      matches.forEach(col => {
        const item = document.createElement('div'); item.className = 'cfb-pick-item'; item.textContent = col;
        item.addEventListener('click', () => addCol(col));
        list.appendChild(item);
      });

      // If the typed text doesn't exactly match any discovered column, offer to add it anyway.
      // This handles liveboard filter chips (Country, Product Category, etc.) that appear as
      // filter tiles on the board but aren't in the visualization data columns.
      const exactMatch = cfbAllColumns.includes(trimmed) || cfbCols.includes(trimmed);
      if (trimmed && !exactMatch) {
        const custom = document.createElement('div');
        custom.className = 'cfb-pick-item cfb-pick-custom';
        // textContent throughout — `trimmed` is user input and must never be parsed as HTML.
        const icon = document.createElement('span'); icon.className = 'cfb-pick-custom-icon'; icon.textContent = '+';
        const strong = document.createElement('strong'); strong.textContent = trimmed;
        custom.append(icon, document.createTextNode(' Add "'), strong, document.createTextNode('" as filter column'));
        custom.addEventListener('click', () => addCol(trimmed));
        list.appendChild(custom);
      }
    };

    search.addEventListener('input', () => renderList(search.value));
    search.addEventListener('keydown', e => { if (e.key === 'Enter') { const t = search.value.trim(); if (t) addCol(t); } });
    renderList('');
    picker.append(search, list);
    setTimeout(() => search.focus(), 50);
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = !picker.hidden;
    document.querySelectorAll('.cfb-picker, .cfb-panel').forEach(p => { p.hidden = true; });
    if (!wasOpen) {
      populate(); picker.hidden = false;
      setTimeout(() => document.addEventListener('click', function h(ev) {
        if (!wrap.contains(ev.target)) { picker.hidden = true; document.removeEventListener('click', h); }
      }), 0);
    }
  });
  wrap.append(btn, picker);
  return wrap;
}

/**
 * Distinct values for a liveboard column. Served from the shared cache populated by
 * cfbLoadData() — only triggers the (single, deduped) data load if it hasn't run yet.
 */
async function cfbFetchValues(col) {
  if (cfbValueCache[col]) return cfbValueCache[col];
  await cfbLoadData();
  return cfbValueCache[col] || [];
}

/** Build one labeled multi-select dropdown for a column. */
function cfbBuildDropdown(colName, values) {
  const wrap = document.createElement('div');
  wrap.className = 'cfb-col'; wrap.dataset.column = colName;

  const label = document.createElement('div');
  label.className = 'cfb-col-label'; label.textContent = colName;

  const ms = document.createElement('div'); ms.className = 'cfb-ms';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'cfb-toggle'; btn.textContent = 'All';

  const panel = document.createElement('div'); panel.className = 'cfb-panel'; panel.hidden = true;

  const updateToggleLabel = () => {
    const sel = cfbSelected[colName] || [];
    btn.textContent = !sel.length ? 'All' : sel.length === 1 ? cfbDisplayValue(colName, sel[0]) : `${sel.length} selected`;
    btn.classList.toggle('cfb-toggle--active', sel.length > 0);
  };

  if (!values.length) {
    const msg = document.createElement('div');
    msg.className = 'cfb-empty';
    msg.textContent = 'No values — column may not have a filter on this board';
    panel.appendChild(msg);
  } else {
    // Sort header: A→Z / Z→A / Custom (drag) / By measure. Lives at the top of the open panel.
    const sortHeader = document.createElement('div'); sortHeader.className = 'cfb-sort';
    const sortModes = [
      { key: 'asc', label: 'A→Z', title: 'Ascending' },
      { key: 'desc', label: 'Z→A', title: 'Descending' },
      { key: 'custom', label: 'Custom', title: 'Drag values to reorder' },
      { key: 'metric', label: 'By measure', title: 'Sort by an aggregate of another column' },
    ];
    const sortBtns = {};
    sortModes.forEach(m => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cfb-sort-btn'; b.textContent = m.label; b.title = m.title;
      b.addEventListener('click', e => {
        e.stopPropagation();
        // First switch to custom seeds the order from whatever is currently displayed.
        if (m.key === 'custom' && !(cfbOrder[colName] || []).length) {
          cfbOrder[colName] = cfbSortValues(colName, values);
        }
        // First switch to metric seeds a sensible default (first measure column, descending).
        if (m.key === 'metric' && !cfbMetric[colName]) {
          cfbMetric[colName] = cfbDefaultMetric(colName);
        }
        cfbSort[colName] = m.key;
        Object.entries(sortBtns).forEach(([k, btnEl]) => btnEl.classList.toggle('cfb-sort-btn--active', k === m.key));
        renderMetricCfg();
        renderValues();
        persistCfb();
      });
      sortBtns[m.key] = b; sortHeader.appendChild(b);
    });
    const activeMode = cfbSort[colName] || 'asc';
    sortBtns[activeMode]?.classList.add('cfb-sort-btn--active');
    panel.appendChild(sortHeader);

    // Metric config row — only visible in 'By measure' mode: aggregation · column · direction.
    const metricCfg = document.createElement('div'); metricCfg.className = 'cfb-metric-cfg';
    panel.appendChild(metricCfg);
    // Explains the silent-failure case where the filter and measure never share a viz.
    const metricWarn = document.createElement('div'); metricWarn.className = 'cfb-metric-warn'; metricWarn.hidden = true;
    panel.appendChild(metricWarn);

    function renderMetricCfg() {
      metricCfg.innerHTML = '';
      metricWarn.hidden = true;
      if ((cfbSort[colName] || 'asc') !== 'metric') { metricCfg.hidden = true; return; }
      metricCfg.hidden = false;
      const m = cfbMetric[colName] || (cfbMetric[colName] = cfbDefaultMetric(colName));
      const measures = cfbMeasureCols(colName);
      if (!m.col && measures.length) m.col = measures[0];
      const metricIsDate = cfbDateCols.has(m.col);
      // 'sum' is meaningless on a date — coerce to 'max' (latest) when a date measure is chosen.
      if (metricIsDate && m.agg === 'sum') m.agg = 'max';

      // Aggregation options adapt to the measure type (date columns get latest/earliest/midpoint).
      const aggOptions = metricIsDate
        ? [['max', 'Latest'], ['min', 'Earliest'], ['avg', 'Midpoint'], ['count', 'Count']]
        : [['sum', 'Sum'], ['avg', 'Avg'], ['max', 'Max'], ['min', 'Min'], ['count', 'Count']];
      const aggSel = document.createElement('select'); aggSel.className = 'cfb-metric-sel';
      aggOptions.forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l; if (m.agg === v) o.selected = true; aggSel.appendChild(o);
      });
      aggSel.addEventListener('change', e => { e.stopPropagation(); m.agg = aggSel.value; persistCfb(); renderMetricCfg(); renderValues(); });

      const colSel = document.createElement('select'); colSel.className = 'cfb-metric-sel';
      colSel.style.display = m.agg === 'count' ? 'none' : '';
      if (!measures.length) {
        const o = document.createElement('option'); o.value = ''; o.textContent = '(no measure columns)'; colSel.appendChild(o); colSel.disabled = true;
      } else {
        measures.forEach(c => {
          const o = document.createElement('option'); o.value = c;
          o.textContent = cfbDateCols.has(c) ? `${c}  (date)` : c;
          if (m.col === c) o.selected = true; colSel.appendChild(o);
        });
      }
      // Re-render the config too: switching to/from a date column changes the aggregation list.
      colSel.addEventListener('change', e => { e.stopPropagation(); m.col = colSel.value; renderMetricCfg(); persistCfb(); renderValues(); });

      const dirBtn = document.createElement('button');
      dirBtn.type = 'button'; dirBtn.className = 'cfb-metric-dir';
      dirBtn.textContent = m.dir === 'asc' ? '↑ Low→High' : '↓ High→Low';
      dirBtn.title = 'Toggle sort direction';
      dirBtn.addEventListener('click', e => { e.stopPropagation(); m.dir = m.dir === 'asc' ? 'desc' : 'asc'; persistCfb(); renderMetricCfg(); renderValues(); });

      metricCfg.append(aggSel, colSel, dirBtn);

      // Coverage check: sort-by-measure can only correlate two columns that appear together in
      // some viz's result set. If they never co-occur the aggregate is empty and nothing reorders
      // — say so instead of failing silently. (Count always covers, so it's exempt.)
      if (m.agg !== 'count' && m.col) {
        const map = cfbMetricMap(colName, m.col, m.agg);
        const covered = values.filter(v => Number.isFinite(map[v])).length;
        if (!covered) {
          metricWarn.hidden = false;
          metricWarn.textContent = `No visualization on this liveboard shows “${colName}” together with “${m.col}”, so there's nothing to sort by. Add a viz or table containing both columns, or pick a measure that already shares a viz with this filter.`;
        } else if (covered < values.length) {
          metricWarn.hidden = false;
          metricWarn.textContent = `Only ${covered} of ${values.length} values share a viz with “${m.col}”; values without a match sort to the bottom.`;
        }
      }
    }
    renderMetricCfg();

    // The value list is rebuilt in place whenever the sort mode or order changes,
    // so the panel can stay open across re-sorts.
    const valuesWrap = document.createElement('div'); valuesWrap.className = 'cfb-values';
    panel.appendChild(valuesWrap);

    function renderValues() {
      valuesWrap.innerHTML = '';
      const draggable = (cfbSort[colName] || 'asc') === 'custom';
      const selected = cfbSelected[colName] || [];

      // Select All / Clear row
      const allRow = document.createElement('label'); allRow.className = 'cfb-item cfb-item--all';
      const allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.checked = selected.length === 0;
      const allSpan = document.createElement('span'); allSpan.textContent = 'All';
      allCb.addEventListener('change', () => {
        // "All" is the unfiltered reset state: clear every specific selection.
        // An empty selection means "no constraint" (see cfbApply). Checking an
        // individual value re-toggles "All" off via the value handler below.
        valuesWrap.querySelectorAll('.cfb-value-cb').forEach(cb => { cb.checked = false; });
        allCb.checked = true;
        cfbSelected[colName] = [];
        updateToggleLabel(); cfbApply();
      });
      allRow.append(allCb, allSpan); valuesWrap.appendChild(allRow);

      const ordered = cfbSortValues(colName, values);
      // In 'metric' mode, surface the aggregate beside each value as a badge.
      const mc = cfbMetric[colName];
      const metricMap = (cfbSort[colName] === 'metric' && mc && (mc.agg === 'count' || mc.col))
        ? cfbMetricMap(colName, mc.col, mc.agg) : null;
      // A date measure shows its aggregate (latest/earliest/midpoint) as a date — but 'count'
      // is a row count regardless of the measure type, so it stays a plain number.
      const badgeIsDate = metricMap && mc.agg !== 'count' && cfbDateCols.has(mc.col);
      const fmtBadge = n => (badgeIsDate ? (cfbFmtDate(Math.round(n)) || '—') : cfbFmtMetric(n));
      ordered.forEach(v => {
        const item = document.createElement('label'); item.className = 'cfb-item';
        if (draggable) {
          item.classList.add('cfb-item--draggable');
          item.draggable = true; item.dataset.value = v;
          const handle = document.createElement('span'); handle.className = 'cfb-drag'; handle.textContent = '⠿';
          handle.addEventListener('click', e => e.preventDefault()); // grip is drag-only, don't toggle the checkbox
          item.appendChild(handle);
        }
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = v; cb.className = 'cfb-value-cb';
        cb.checked = selected.includes(v);
        cb.addEventListener('change', () => {
          const checked = [...valuesWrap.querySelectorAll('.cfb-value-cb:checked')].map(c => c.value);
          cfbSelected[colName] = checked;
          allCb.checked = checked.length === 0;
          updateToggleLabel(); cfbApply();
        });
        const span = document.createElement('span'); span.className = 'cfb-item-label'; span.textContent = cfbDisplayValue(colName, v);
        item.append(cb, span);
        if (metricMap) {
          const badge = document.createElement('span'); badge.className = 'cfb-metric-val';
          badge.textContent = fmtBadge(metricMap[v]);
          item.appendChild(badge);
        }
        valuesWrap.appendChild(item);
      });

      if (draggable) wireDrag(valuesWrap, colName, renderValues);
      updateToggleLabel();
    }

    renderValues();
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = !panel.hidden;
    document.querySelectorAll('.cfb-panel').forEach(p => { p.hidden = true; });
    panel.hidden = wasOpen;
    if (!wasOpen) setTimeout(() => {
      document.addEventListener('click', function hide(ev) {
        if (!ms.contains(ev.target)) { panel.hidden = true; document.removeEventListener('click', hide); }
      });
    }, 0);
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'cfb-remove'; removeBtn.title = `Remove ${colName}`;
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    cfbCols = cfbCols.filter(c => c !== colName);
    delete cfbSelected[colName]; delete cfbValueCache[colName];
    delete cfbSort[colName]; delete cfbOrder[colName]; delete cfbMetric[colName];
    wrap.remove(); cfbApply(); renderInspector();
  });

  ms.append(btn, panel);
  wrap.append(label, ms, removeBtn);
  return wrap;
}

/**
 * Wire HTML5 drag-and-drop reordering onto a custom-sort value list. On drop it reads the
 * resulting DOM order, saves it as the column's custom order, persists, and re-renders to
 * normalize. Only the value rows (.cfb-item--draggable) move — the "All" row stays pinned.
 */
function wireDrag(valuesWrap, colName, rerender) {
  let dragging = null;
  valuesWrap.querySelectorAll('.cfb-item--draggable').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragging = item; item.classList.add('cfb-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('cfb-dragging');
      if (!dragging) return;
      dragging = null;
      // Persist the new order from the DOM, then re-render to lock it in.
      cfbOrder[colName] = [...valuesWrap.querySelectorAll('.cfb-item--draggable')].map(el => el.dataset.value);
      persistCfb();
      rerender();
    });
  });
  valuesWrap.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragging) return;
    // Insert the dragged row before the first sibling whose midpoint is below the cursor.
    const rows = [...valuesWrap.querySelectorAll('.cfb-item--draggable:not(.cfb-dragging)')];
    const after = rows.find(row => {
      const box = row.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (after) valuesWrap.insertBefore(dragging, after);
    else valuesWrap.appendChild(dragging);
  });
}

// Persist the custom filter bar into shared state so a link / reload reproduces it.
// Silent: no re-render needed, but it still writes localStorage + the URL hash.
function persistCfb() {
  setState({
    cfbCols: [...cfbCols],
    cfbSelected: { ...cfbSelected },
    cfbSort: { ...cfbSort },
    cfbOrder: { ...cfbOrder },
    cfbMetric: { ...cfbMetric },
  }, { silent: true });
}

/**
 * Aggregate a (numeric) metric column per distinct value of a filter column, from the raw
 * liveboard rows kept in cfbContents. Returns { value: number }. The two columns must
 * co-occur in the same data block (viz) to be correlatable; blocks without both are skipped.
 * 'count' ignores metricCol and just counts rows per value. Memoized in cfbMetricCache.
 */
function cfbMetricMap(filterCol, metricCol, agg) {
  const key = `${filterCol}|${metricCol}|${agg}`;
  if (cfbMetricCache[key]) return cfbMetricCache[key];
  const acc = {}; // value -> { sum, count, max, min }
  cfbContents.forEach(c => {
    const cols = c.column_names || [];
    const fi = cols.indexOf(filterCol);
    if (fi < 0) return;
    const mi = agg === 'count' ? -1 : cols.indexOf(metricCol);
    if (agg !== 'count' && mi < 0) return;
    (c.data_rows || []).forEach(r => {
      const k = r[fi] === null || r[fi] === undefined ? '{Null}' : String(r[fi]);
      const a = acc[k] || (acc[k] = { sum: 0, count: 0, max: -Infinity, min: Infinity });
      a.count++;
      if (agg !== 'count') {
        const n = Number(r[mi]);
        if (Number.isFinite(n)) { a.sum += n; if (n > a.max) a.max = n; if (n < a.min) a.min = n; }
      }
    });
  });
  const out = {};
  Object.entries(acc).forEach(([k, a]) => {
    out[k] = agg === 'count' ? a.count
      : agg === 'sum' ? a.sum
      : agg === 'avg' ? (a.count ? a.sum / a.count : 0)
      : agg === 'max' ? (a.max === -Infinity ? null : a.max)
      : agg === 'min' ? (a.min === Infinity ? null : a.min)
      : 0;
  });
  cfbMetricCache[key] = out;
  return out;
}

// A column whose NAME looks date/time-ish. Used (with an epoch value check) to decide which
// columns to render as dates, since the data API carries no per-column type metadata.
const CFB_DATE_NAME_RE = /(^|[^a-z])(date|time|day|month|year|quarter|qtr|week|timestamp|dt)([^a-z]|$)/i;

// Format an epoch value (seconds or milliseconds) as YYYY-MM-DD in UTC. Returns null if the
// raw value isn't an epoch-like integer (already-formatted strings fall through unchanged).
function cfbFmtDate(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  let ms;
  if (n >= 1e8 && n < 1e11) ms = n * 1000;        // epoch seconds (~1973–5138)
  else if (n >= 1e11 && n < 1e14) ms = n;          // epoch milliseconds
  else return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const pad = x => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Display label for a filter value. Date-named columns whose values are epoch numbers render as
// YYYY-MM-DD; everything else is shown verbatim. The underlying value used for filtering, sorting,
// and selection stays raw — only the visible label changes.
function cfbDisplayValue(colName, raw) {
  if (raw === '{Null}') return '{Null}';
  if (cfbDateCols.has(colName)) {
    const f = cfbFmtDate(raw);
    if (f) return f;
  }
  return raw;
}

// Compact number for the metric badge shown beside each value (e.g. 1.2M, 3.4K, 56).
function cfbFmtMetric(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Columns offerable as a "measure" to sort another filter by: numeric columns plus date columns
// (dates sort by latest/earliest/midpoint). Excludes the filter's own column.
function cfbMeasureCols(forCol) {
  const set = new Set([...cfbNumericCols, ...cfbDateCols]);
  set.delete(forCol);
  return [...set].sort();
}

// Seed config when a filter first switches to 'By measure': first available measure, descending.
// Date measures default to 'max' (latest) since 'sum' is meaningless for a date.
function cfbDefaultMetric(forCol) {
  const col = cfbMeasureCols(forCol)[0] || '';
  return { col, agg: col && cfbDateCols.has(col) ? 'max' : 'sum', dir: 'desc' };
}

/**
 * Order a column's values for display in its dropdown.
 *   'asc'/'desc' — natural (numeric-aware, case-insensitive) compare.
 *   'custom'     — the drag-defined sequence in cfbOrder[col]; any values not yet
 *                  placed (e.g. new data) fall to the end in natural ascending order.
 *   'metric'     — by an aggregate of another column (cfbMetric[col] = {col,agg,dir});
 *                  values with no metric (column absent / non-numeric) fall to the end.
 * Default (no mode set) is ascending.
 */
function cfbSortValues(colName, values) {
  const mode = cfbSort[colName] || 'asc';
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  if (mode === 'custom') {
    const order = cfbOrder[colName] || [];
    const placed = order.filter(v => values.includes(v));
    const extras = values.filter(v => !order.includes(v)).sort(natural);
    return [...placed, ...extras];
  }
  if (mode === 'metric') {
    const m = cfbMetric[colName];
    if (m && (m.agg === 'count' || m.col)) {
      const map = cfbMetricMap(colName, m.col, m.agg);
      const dir = m.dir === 'asc' ? 1 : -1;
      return [...values].sort((a, b) => {
        const av = map[a], bv = map[b];
        const aok = Number.isFinite(av), bok = Number.isFinite(bv);
        if (!aok && !bok) return natural(a, b);
        if (!aok) return 1;   // values without a metric sink to the bottom regardless of dir
        if (!bok) return -1;
        return av === bv ? natural(a, b) : (av - bv) * dir;
      });
    }
    // Not configured yet — show ascending until the user picks a metric column.
  }
  const sorted = [...values].sort(natural);
  return mode === 'desc' ? sorted.reverse() : sorted;
}

function cfbApply() {
  persistCfb();
  if (!currentEmbed) return;
  // Merge cfb selections with any Inspector runtime filters so neither overwrites the other.
  // UpdateRuntimeFilters has replace semantics, so we must always send the full combined set.
  const filters = buildParentRuntimeFilters();
  try {
    currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, filters);
    const cfbActive = Object.entries(cfbSelected).filter(([, v]) => v?.length);
    const desc = cfbActive.length ? cfbActive.map(([c, v]) => `${c}=[${v.join(',')}]`).join('; ') : 'cleared';
    logEvent('CustomFilter', desc);
    refreshCode(); // keep SDK Preview in sync with active filter selections
  } catch (e) { logEvent('CustomFilter', `✗ UpdateRuntimeFilters: ${e.message}`); }
}

// Export the current liveboard via the REST report API in the chosen format. Bakes in any
// active custom-filter-bar selections (override_filters) so the file matches what's on screen.
async function downloadCfbReport() {
  const s = getState();
  if (!s.host || !s.liveboardId) { toast('Connect and pick a liveboard first.'); return; }
  const btn = $('#cfb-export');
  const format = ($('#cfb-format')?.value || 'PDF').toUpperCase();
  const overrideFilters = Object.entries(cfbSelected)
    .filter(([, vals]) => vals && vals.length)
    .map(([col, vals]) => ({ column_name: col, values: vals }));

  if (btn) { btn.disabled = true; btn.textContent = '⬇ …'; }
  const done = showBusy(`Preparing ${format} download…`);
  logEvent('Export', `report/liveboard ${format} → ${s.liveboardId}${overrideFilters.length ? ` (${overrideFilters.length} override filter(s))` : ''}`);
  try {
    const res = await Discovery.downloadLiveboardReport(s.host, s.liveboardId, format, overrideFilters);
    if (!res.ok) {
      logEvent('Export', `✗ ${res.error}`);
      done();
      toast(res.status === 401 || res.status === 403 ? 'Not authorized — log in at the host or use a token.' : `${format} export failed: ${res.error}`);
      return;
    }
    saveBlob(res.blob, `liveboard-${s.liveboardId}.${res.ext}`);
    logEvent('Export', `✓ ${res.ext.toUpperCase()} downloaded`);
    done(`✓ ${res.ext.toUpperCase()} downloaded`, 'success');
  } catch (e) {
    logEvent('Export', `✗ ${e.message}`);
    done();
    toast(`${format} export failed: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Export'; }
  }
}

// Inspector section: shows active filter columns + refresh.
function sectionCfbSetup() {
  const c = el('div', 'sec-body');
  c.appendChild(el('div', 'sec-note', 'Click "+ Add filter" in the bar above to add a column. Available columns are discovered from the liveboard data.'));

  if (cfbAllColumns.length) {
    const avail = el('div', 'sec-note');
    avail.innerHTML = `<strong>${cfbAllColumns.length}</strong> column${cfbAllColumns.length !== 1 ? 's' : ''} available · <strong>${cfbCols.length}</strong> active`;
    c.appendChild(avail);
  }

  if (cfbCols.length) {
    const chips = el('div', 'chips');
    [...cfbCols].forEach((col, i) => {
      const chip = el('span', 'chip'); chip.textContent = col; // col is a TS column name — not HTML
      const x = el('button', 'chip-x', '✕'); x.setAttribute('aria-label', `Remove ${col}`);
      x.addEventListener('click', () => {
        cfbCols.splice(i, 1);
        delete cfbSelected[col]; delete cfbValueCache[col];
        const node = document.querySelector(`#cfb-dropdowns [data-column="${CSS.escape(col)}"]`);
        if (node) node.remove();
        cfbApply(); renderInspector();
      });
      chip.appendChild(x); chips.appendChild(chip);
    });
    c.appendChild(chips);
  }

  const rebuild = el('button', 'sec-apply', '↻ Refresh values');
  rebuild.addEventListener('click', () => { cfbAllColumns = []; cfbValueCache = {}; cfbLoadedFor = ''; cfbBuild(); toast('Refreshing filter values…'); });
  c.appendChild(rebuild);

  // Q2 — last EmbedEvent.Save captured this session. ThoughtSpot has no server-side save
  // webhook, so this client event is how a host app learns a user saved inside the embed.
  const saveNote = el('div', 'sec-note');
  if (lastSaved) {
    // Build with textContent — name/guid come from the embed payload (untrusted).
    const t = lastSaved.at.toLocaleTimeString();
    const strong = el('strong'); strong.textContent = 'Last saved (EmbedEvent.Save):';
    saveNote.append(strong, document.createTextNode(` ${lastSaved.name || 'object'}`));
    if (lastSaved.guid) {
      const code = document.createElement('code'); code.textContent = lastSaved.guid;
      saveNote.append(document.createTextNode(' · '), code);
    }
    saveNote.append(document.createTextNode(` at ${t}`));
  } else {
    saveNote.textContent = 'No save captured yet. Edit & Save inside the embed — EmbedEvent.Save fires (there is no server-side save webhook).';
  }
  c.appendChild(saveNote);

  return accordion('Active filters', cfbCols.length, c, true);
}

// ── Custom action dispatcher (callback / url / writeback) ──────────────────────
const API_BASE = window.TS_API_BASE || '';

// EmbedEvent.FilterChanged fires when the user changes a filter inside the embed.
// Log it so the Event Log stays accurate; a full cfb UI reconciliation is not yet implemented.
window.__onFilterChanged = (payload) => {
  logEvent('FilterChanged', JSON.stringify(payload?.data ?? payload).slice(0, 300));
};

// init()'s auth event emitter reports session-level auth here (AuthStatus.FAILURE / SUCCESS),
// separate from per-embed EmbedEvent.AuthFailure. This is what fires when trusted auth mints a
// token but ThoughtSpot still won't establish the iframe session — the "REST works (green pill)
// but the embed shows TS's own 'Not logged in' page" case. FAILURE → show the styled overlay.
window.__onAuthStatus = (status, reason) => {
  if (status === 'FAILURE') {
    authFailed = true; // latch so a trailing Load event can't clear the overlay (see render onDone)
    logEvent('Auth', `⚠ Session not established${reason ? ` (${reason})` : ''} — ThoughtSpot rejected the embed login`);
    setOverlay('not-logged-in');
  } else if (status === 'SUCCESS') {
    if (authFailed) { authFailed = false; logEvent('Auth', 'Embed session established'); setOverlay('hidden'); }
  }
};

window.__onCustomAction = async (payload) => {
  const id = payload?.id ?? payload?.data?.id;
  logEvent('CustomAction', JSON.stringify(payload?.data ?? payload).slice(0, 200));
  // Synthetic Export menu action — run the REST export the host controls.
  if (id === '__export') { runExport(); return; }
  // "Customize Export" menu action — open the selection dialog so the user picks options first.
  if (id === '__export_customize') { openExportPicker(); return; }
  // TS-side Callback action: build the one-invoice-per-page PDF here from the viz's data.
  // (Created in the TS UI and scoped to the invoice viz — not injected by the SDK, so it
  // is not in customActionRegistry. payload.answerService gives us the underlying rows.)
  if (id === PDF_ACTION_ID) { await handleInvoicePdf(payload); return; }
  // "Date" primary button → open the host-side chooser (Today / On a specific date).
  if (id === DATE_ACTION_ID) { openDatePicker(); return; }
  const reg = customActionRegistry[id];
  if (!reg) return;
  const row = extractRow(payload);
  if (reg.type === 'url' && reg.urlTemplate) {
    const url = reg.urlTemplate.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, c) => encodeURIComponent(row[c.trim()] ?? ''));
    window.open(url, '_blank', 'noopener');
  } else if (reg.type === 'writeback') {
    try { const res = await fetch(`${API_BASE}/api/writeback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: id, row }) }); recordApi({ scope: 'playground', method: 'POST', path: '/api/writeback', status: res.status }); const d = await res.json(); logEvent('Writeback', res.ok ? `✓ ${d.ticketId}` : `✗ ${d.error}`); }
    catch (e) { logEvent('Writeback', `✗ ${e.message} — is the Node server running?`); }
  } else if (reg.type === 'drill') {
    // Drill-down with filters carried over: parent (filter-bar + runtime) filters PLUS the
    // clicked point's dimensional attributes, re-rendered at a curated detail liveboard.
    if (!reg.drillLiveboardId) { toast('This drill action has no target liveboard GUID set.'); return; }
    const merged = [...buildParentRuntimeFilters(), ...clickedAttributes(payload)];
    enterDrill(reg.drillLiveboardId, merged);
  }
};

// Invoice "Download PDF" — paginate the viz behind the action, group rows into invoices, and
// build the multi-page PDF (one invoice per page) with the verbatim builder from invoice-pdf.js.
async function handleInvoicePdf(payload) {
  const done = showBusy('Preparing PDF download…');
  try {
    const svc = await resolveAnswerService(payload);
    if (!svc) {
      logEvent('CustomAction', '✗ Download invoice PDF — could not obtain an answer session for the viz (see console)');
      done();
      toast('Download invoice PDF: no data session available — see console.');
      return;
    }
    const { rows, schema } = await fetchAllRows(svc);
    const docs = groupStatements(rows, schema);
    if (!docs.length) {
      logEvent('CustomAction', '✗ Download invoice PDF — 0 rows returned from the viz');
      done();
      toast('Download invoice PDF: no rows to export.');
      return;
    }
    downloadStatementsPdf(docs);
    logEvent('CustomAction', `✓ Download invoice PDF — ${docs.length} statement(s) from ${rows.length} row(s) → sales-statements.pdf`);
    done('✓ PDF downloaded', 'success');
  } catch (e) {
    console.error('Invoice PDF export failed', e);
    logEvent('CustomAction', `✗ Download invoice PDF failed — ${e.message}`);
    done();
    toast('Download invoice PDF failed — see console.');
  }
}

// Get an AnswerService with a real answer SESSION for the invoice viz.
// A liveboard-level CustomAction (like ours) arrives WITHOUT a session, so payload.answerService
// is inert (fetchData throws on the empty session). The SDK's documented fix for liveboards is
// embed.getAnswerService(vizId), which round-trips HostEvent.GetAnswerSession to mint a session
// for a specific viz. We pull candidate viz ids from the payload's liveboard metadata and use the
// first one whose session can actually fetch data.
async function resolveAnswerService(payload) {
  // 1) If the event already carries a usable session, use it as-is (viz-context invocation).
  const fromEvent = payload?.answerService || payload?.data?.answerService;
  if (fromEvent && fromEvent.getSession?.()?.sessionId) {
    console.log('[invoice-pdf] using answerService from the event payload');
    return fromEvent;
  }

  if (!currentEmbed?.getAnswerService) {
    console.warn('[invoice-pdf] no embed.getAnswerService available');
    return fromEvent || null;
  }

  // 2) Otherwise mint a session for the invoice viz. Collect candidate ids from the payload.
  const d = payload?.data ?? payload ?? {};
  const containers = d.pinboardDetails?.containers || [];
  const ids = [];
  containers.forEach((c) => { [c.id, c.refVizId, c.answerId].forEach((x) => { if (x && !ids.includes(x)) ids.push(x); }); });
  ids.push(undefined); // last resort: let the host pick (works when the board has one viz)
  console.log('[invoice-pdf] candidate viz ids for getAnswerService:', ids);

  for (const vizId of ids) {
    try {
      const svc = await currentEmbed.getAnswerService(vizId);
      const sid = svc?.getSession?.()?.sessionId;
      if (sid) {
        console.log(`[invoice-pdf] got answer session via getAnswerService(${vizId ?? 'no-vizId'}) → session ${sid}`);
        return svc;
      }
      console.warn(`[invoice-pdf] getAnswerService(${vizId ?? 'no-vizId'}) returned no session`);
    } catch (e) {
      console.warn(`[invoice-pdf] getAnswerService(${vizId ?? 'no-vizId'}) failed:`, e?.message || e);
    }
  }
  return null;
}

// EmbedEvent.Save — ThoughtSpot has no server-side "saved" webhook, so this client event is
// how a host app reacts to a user saving inside the embed (e.g. sync the new object).
window.__onSave = (payload) => {
  const d = payload?.data ?? payload ?? {};
  const guid = d.liveboardId || d.answerId || d.vizId || d.id || d.metadata_id || '';
  const name = d.name || d.liveboardName || d.answerName || '';
  lastSaved = { name, guid, at: new Date() };
  logEvent('Save', `${name || 'object'}${guid ? ' · ' + guid : ''} saved — no server webhook exists; this is the client-side signal.`);
  toast(`Saved${name ? ': ' + name : ''} — captured via EmbedEvent.Save`);
  // Refresh the Custom Liveboard inspector so the "last saved" note updates live.
  if (getState().section === 'liveboard-custom') renderInspector();
};

function extractRow(payload) {
  const row = {}; const visit = n => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(visit); const c = n.column?.name ?? n.columnName; if (c && ('value' in n || 'dataValue' in n)) row[c] = n.value ?? n.dataValue; Object.keys(n).forEach(k => k !== 'column' && visit(n[k])); };
  visit(payload?.data ?? payload); return row;
}

// ── Drill-down carry-over (Q4) ────────────────────────────────────────────────
// Parent filters = the website-native filter bar (cfbSelected) + any applied runtime filters.
function buildParentRuntimeFilters() {
  const s = getState();
  const fromCfb = Object.entries(cfbSelected)
    .filter(([, v]) => v && v.length)
    .map(([col, vals]) => ({ columnName: col, operator: RuntimeFilterOp.IN, values: vals }));
  const fromActive = (s.activeFilters || [])
    .map(f => ({ columnName: f.columnName, operator: RuntimeFilterOp[f.opKey] ?? RuntimeFilterOp.IN, values: f.values }));
  return [...fromActive, ...fromCfb];
}

// Pull the clicked point's *dimensional* attributes (not measures) across SDK payload shapes.
function clickedAttributes(payload) {
  const d = payload?.data ?? payload ?? {};
  const attrs = d.clickedPoint?.selectedAttributes
    || d.selectedPoints?.[0]?.selectedAttributes
    || d.contextMenuPoints?.[0]?.selectedAttributes
    || [];
  const out = [];
  attrs.forEach(a => {
    const name = a?.column?.name ?? a?.columnName;
    const val = a?.value ?? a?.dataValue;
    if (name != null && val != null && val !== '') out.push({ columnName: name, operator: RuntimeFilterOp.IN, values: [String(val)] });
  });
  return out;
}

// Render the curated drill liveboard in place, carrying the merged filters; show a Back bar.
function enterDrill(drillId, filters) {
  drillParent = { liveboardId: getState().liveboardId };
  const cfb = $('#custom-filter-bar'); if (cfb) cfb.hidden = true;   // the bar's columns belong to the parent board
  applyConfig();
  if (currentEmbed) { try { currentEmbed.destroy(); } catch (_) {} currentEmbed = null; }
  const cfg = buildConfig(); cfg.liveboardId = drillId;
  $('#loading-sub').textContent = `Drill-down → ${drillId}`;
  setOverlay('loading');
  flowReset('liveboard');
  showDrillBar(drillId, filters);
  logEvent('Drill', `→ ${drillId} with ${filters.length} carried filter(s): ${filters.map(f => `${f.columnName}=[${f.values.join(',')}]`).join('; ') || 'none'}`);
  const fallback = setTimeout(() => setOverlay('hidden'), 4000);
  authFailed = false;
  currentEmbed = doRender('liveboard', cfg, {
    onDone() { if (authFailed) return; clearTimeout(fallback); setOverlay('hidden'); },
    onError(msg) { clearTimeout(fallback); const str = typeof msg === 'string' ? msg : JSON.stringify(msg); if (str === '__NO_COOKIE__' || str === '__AUTH_FAILURE__') { authFailed = true; setOverlay('not-logged-in'); return; } $('#error-sub').textContent = str; setOverlay('error'); },
    onEvent: logEvent,
  }, {
    hiddenActions: getState().hiddenActions.map(k => Action[k]).filter(Boolean),
    disabledActions: getState().disabledActions.map(k => Action[k]).filter(Boolean),
    customActions: [],
    runtimeParameters: getState().runtimeParameters,
    flags: { runtimeFilters: filters },
  });
  flowStart();
}

// Return from a drill: drop the back bar and re-render the parent board (filters restored by cfbBuild).
function exitDrill() {
  drillParent = null;
  hideDrillBar();
  const cfb = $('#custom-filter-bar');
  if (cfb && getState().section === 'liveboard-custom') cfb.hidden = false;
  render();
}

function showDrillBar(drillId, filters) {
  let bar = $('#drill-bar');
  if (!bar) {
    bar = el('div', 'drill-bar'); bar.id = 'drill-bar';
    const stage = $('#stage'); const area = $('#embed-area');
    stage.insertBefore(bar, area);
  }
  const summary = filters.length
    ? filters.map(f => `${f.columnName}: ${f.values.join(' / ')}`).join('  ·  ')
    : 'no filters carried';
  bar.innerHTML = '';
  const back = el('button', 'drill-back', '← Back');
  back.addEventListener('click', exitDrill);
  // textContent — drillId is a user-typed GUID and `summary` carries column names + values
  // pulled from the embed payload; neither may be parsed as HTML.
  const label = el('span', 'drill-label');
  const strong = el('strong'); strong.textContent = 'Drill-down';
  const filtersEl = el('span', 'drill-filters'); filtersEl.textContent = summary;
  label.append(strong, document.createTextNode(` · ${drillId} `), filtersEl);
  bar.append(back, label);
  bar.hidden = false;
}
function hideDrillBar() { const bar = $('#drill-bar'); if (bar) bar.remove(); }

// ═══ PERSONAL LIVEBOARDS — per-user editable copies as a tab strip ════════════
// End users make their own copy (or copies) of a standard liveboard via POST metadata/copyobject; the
// copies live next to it as a tab strip and each is a full, user-owned, editable clone. Copies are
// keyed by the SOURCE liveboard id (repeatable for any board) and scoped to the connected user
// (multi-user by construction). state.liveboardId always stays the Standard/source board (tab #1);
// only the RENDERED config points at the active copy — the enterDrill() clone-the-config pattern.
const PLB_SECTIONS = ['liveboard', 'liveboard-custom', 'ai-highlights'];

/** The liveboard id the embed should actually render: the active copy when one is selected, else Standard. */
function effectiveLiveboardId(s) {
  return (s.personalLb?.enabled && s.personalLb.activeCopyId) || s.liveboardId;
}

/** True when the tab strip should be visible (feature on, connected, a source board picked, not drilling). */
function personalStripVisible(s) {
  return !!(s.personalLb?.enabled && connected && !drillParent
    && PLB_SECTIONS.includes(s.section) && s.liveboardId);
}

/** The compact tab label: an explicit nickname, else the title minus the "{stdName} — " prefix. */
function copyLabel(c, stdName) {
  if (c.label) return c.label;
  const t = c.title || 'Copy';
  const pre = stdName ? `${stdName} — ` : '';
  return pre && t.startsWith(pre) ? t.slice(pre.length) : t;
}

/** Paint/refresh the tab strip: Standard (tab #1) · one tab per copy · ＋ Personalize (Standard only). */
function renderPersonalStrip() {
  const strip = $('#personal-lb-strip');
  if (!strip) return;
  const s = getState();
  if (!personalStripVisible(s)) { strip.hidden = true; strip.innerHTML = ''; return; }
  strip.hidden = false;
  strip.innerHTML = '';

  const active = s.personalLb.activeCopyId;
  const copies = s.personalLb.copies[s.liveboardId] || [];
  const stdName = discovered.liveboards.find(lb => lb.id === s.liveboardId)?.name || '';

  // Tab #1 — always the Standard board.
  const std = el('button', 'plb-tab plb-tab--standard' + (!active ? ' active' : ''));
  const stdLbl = el('span', 'plb-tab-name'); stdLbl.textContent = 'Standard'; std.appendChild(stdLbl);
  std.title = 'The shared standard liveboard';
  std.addEventListener('click', () => switchPersonalTab(''));
  strip.appendChild(std);

  // One tab per copy: short label (nickname or derived), full title as tooltip, double-click to rename,
  // inline two-click delete. Labels/titles are REST/user data → textContent, never innerHTML.
  copies.forEach(c => {
    const tab = el('button', 'plb-tab' + (c.id === active ? ' active' : ''));
    tab.title = c.title || c.id;
    const name = el('span', 'plb-tab-name'); name.textContent = copyLabel(c, stdName); tab.appendChild(name);
    // Debounce the switch so a double-click can cancel it and rename in place (a switch re-renders the
    // strip, which would otherwise detach this tab before the dblclick fires).
    tab.addEventListener('click', () => {
      clearTimeout(plbClickTimer);
      plbClickTimer = setTimeout(() => switchPersonalTab(c.id), 200);
    });
    tab.addEventListener('dblclick', ev => {
      clearTimeout(plbClickTimer);
      ev.preventDefault(); ev.stopPropagation();
      startRenameCopy(tab, name, c);
    });

    const armed = plbArmedDelete === c.id;
    const x = el('span', 'plb-tab-close' + (armed ? ' armed' : ''));
    x.textContent = armed ? 'Delete?' : '✕';
    x.title = armed ? 'Click again to confirm delete' : 'Delete this copy';
    x.addEventListener('click', ev => { ev.stopPropagation(); onDeleteClick(c); });
    tab.appendChild(x);
    strip.appendChild(tab);
  });

  // Skeleton placeholder while discovery is in flight (first paint after connect / board change).
  if (plbDiscovering) strip.appendChild(el('span', 'plb-skel'));

  // ＋ Personalize — only on Standard (no copies-of-copies). Full CTA only when there are no copies yet;
  // once copies exist it shrinks to a quiet "＋" so it stops competing with the board's own controls.
  if (!active) {
    const hasCopies = copies.length > 0;
    const add = el('button', 'plb-add' + (hasCopies ? '' : ' plb-add--cta'));
    add.textContent = hasCopies ? '＋' : '＋ Personalize';
    add.title = 'Make your own editable copy of this liveboard';
    add.addEventListener('click', () => personalizeFlow(add));
    strip.appendChild(add);
  }

  // Fade the right edge only when the tabs actually overflow the strip.
  strip.classList.toggle('plb-strip--overflow', strip.scrollWidth > strip.clientWidth + 1);
}

/** Inline-rename a copy's tab: swap the label for a text input; commit on Enter/blur, cancel on Esc. */
function startRenameCopy(tab, nameSpan, copy) {
  if (tab.querySelector('.plb-rename-input')) return;
  const stdName = discovered.liveboards.find(lb => lb.id === getState().liveboardId)?.name || '';
  const input = el('input', 'plb-rename-input');
  input.value = copyLabel(copy, stdName);
  input.maxLength = 60;
  nameSpan.replaceWith(input);
  input.focus(); input.select();
  let cancelled = false;
  input.addEventListener('click', ev => ev.stopPropagation());
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; renderPersonalStrip(); }
  });
  input.addEventListener('blur', () => { if (!cancelled) saveCopyLabel(copy.id, input.value.trim()); });
}

/** Persist a copy's display nickname (empty clears it → derived label shows). Local to this browser. */
function saveCopyLabel(id, label) {
  const s = getState();
  const sourceId = s.liveboardId;
  const list = (s.personalLb.copies[sourceId] || []).map(c => c.id === id ? { ...c, label } : c);
  setState({ personalLb: { ...s.personalLb, copies: { ...s.personalLb.copies, [sourceId]: list } } });
  logEvent('Personalize', `renamed ${id} → "${label || '(cleared)'}"`);
  renderPersonalStrip();
  refreshCode();
}

/** First ✕ click arms the tab (shows "Delete?"); a second click within 3s deletes it. */
function onDeleteClick(copy) {
  if (plbArmedDelete === copy.id) {
    clearTimeout(plbArmedTimer);
    plbArmedDelete = '';
    deleteCopy(copy);
    return;
  }
  plbArmedDelete = copy.id;
  renderPersonalStrip();
  clearTimeout(plbArmedTimer);
  plbArmedTimer = setTimeout(() => { plbArmedDelete = ''; renderPersonalStrip(); }, 3000);
}

/** Switch the active tab (‘’ = Standard) and re-render the embed at the effective board. */
function switchPersonalTab(copyId) {
  const s = getState();
  if ((s.personalLb.activeCopyId || '') === (copyId || '')) return; // no-op if already active
  setState({ personalLb: { ...s.personalLb, activeCopyId: copyId } });
  render();          // re-embeds with effectiveLiveboardId(); render() repaints the strip
  refreshCode();
}

/** If a copy was just created, open it in Edit mode once it renders (the “personalize now” moment). */
function maybeOpenCreatedCopyForEdit() {
  if (!justCreatedCopyId) return;
  const s = getState();
  if (s.personalLb.activeCopyId !== justCreatedCopyId) { justCreatedCopyId = ''; return; }
  justCreatedCopyId = '';
  try { currentEmbed?.trigger(HostEvent.Edit); logEvent('HostEvent', 'Edit (new personal copy)'); }
  catch (e) { logEvent('HostEvent', `✗ Edit: ${e.message}`); }
}

/** ＋ Personalize: copyobject → tag → cache + switch to the new copy → open it editable. */
async function personalizeFlow(btn) {
  const s = getState();
  if (!s.host || !s.liveboardId) { toast('Connect and pick a liveboard first.'); return; }
  if (s.personalLb.activeCopyId) { toast('Switch to the Standard board before personalizing.'); return; }
  const sourceId = s.liveboardId;
  const stdName = (discovered.liveboards.find(lb => lb.id === sourceId)?.name) || 'Liveboard';
  const existing = s.personalLb.copies[sourceId] || [];
  const who = currentUserName || 'me';
  const title = `${stdName} — ${who} #${existing.length + 1}`;

  if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = '⋯ Creating'; }
  const done = showBusy('Creating your personal copy…');
  logEvent('Personalize', `copyobject ← ${sourceId} → "${title}"`);
  try {
    const cp = await Discovery.copyLiveboard(s.host, sourceId, title);
    if (!cp.ok) {
      done();
      if (cp.status === 403) toast('Not allowed to copy this liveboard — you need at least view access. (copyobject needs 10.3.0.cl+.)', 'error');
      else toast(`Copy failed: ${cp.error}`, 'error');
      logEvent('Personalize', `✗ copyobject: ${cp.error}`);
      return;
    }
    // Tag it (best-effort — keep the copy either way):
    //  • Personal        → re-discoverable + excluded from the source-board picker.
    //  • src:<sourceId>  → records WHICH board this is a copy of, so discovery attributes it by tag, not title.
    const tag = s.personalLb.tag || 'Personal';
    const srcTag = Discovery.sourceTag(sourceId);
    const tagRes = await Discovery.assignTags(s.host, cp.id, [tag, srcTag]);
    if (!tagRes.ok) logEvent('Personalize', `⚠ tags [${tag}, ${srcTag}] not assigned (${tagRes.error}) — copy kept; discovery falls back to owner+name.`);

    // Update the per-source cache, switch to the new copy, and flag it to open editable on render.
    const cur = getState();
    const prior = cur.personalLb.copies[sourceId] || [];
    const copies = [...prior, { id: cp.id, title, label: `Copy ${prior.length + 1}` }];
    justCreatedCopyId = cp.id;
    setState({ personalLb: { ...cur.personalLb, copies: { ...cur.personalLb.copies, [sourceId]: copies }, activeCopyId: cp.id } });
    logEvent('Personalize', `✓ created ${cp.id}`);
    done('✓ Personal copy created', 'success');
    render();
    refreshCode();
  } catch (e) {
    done(); toast(`Copy failed: ${e.message}`, 'error'); logEvent('Personalize', `✗ ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteCopy(copy) {
  const s = getState();
  const sourceId = s.liveboardId;
  const done = showBusy('Deleting copy…');
  logEvent('Personalize', `delete ${copy.id}`);
  const res = await Discovery.deleteLiveboard(s.host, copy.id);
  if (!res.ok) { done(); toast(`Delete failed: ${res.error}`, 'error'); logEvent('Personalize', `✗ delete: ${res.error}`); return; }
  const cur = getState();
  const remaining = (cur.personalLb.copies[sourceId] || []).filter(c => c.id !== copy.id);
  const wasActive = cur.personalLb.activeCopyId === copy.id;
  setState({ personalLb: { ...cur.personalLb,
    copies: { ...cur.personalLb.copies, [sourceId]: remaining },
    activeCopyId: wasActive ? '' : cur.personalLb.activeCopyId } });
  done('✓ Copy deleted', 'success');
  render();      // if the active copy was deleted we land back on Standard
  refreshCode();
}

/**
 * Rebuild the current board's copy list from ThoughtSpot (owner + tag scoped), reconciled against the
 * persisted cache + this board's naming prefix so only THIS source board's copies show. Runs on connect
 * and whenever the source liveboard changes. Keeps the feature repeatable per board and per user.
 */
async function refreshPersonalCopies() {
  const s = getState();
  if (!s.personalLb.enabled || !s.host || !connected || !s.liveboardId) return;
  const sourceId = s.liveboardId;
  const tag = s.personalLb.tag || 'Personal';
  plbDiscovering = true; renderPersonalStrip();
  try {
    // Resolve the scoping identity lazily (covers enabling the feature AFTER connect). Without it we
    // must NOT query — an owner-less tag search would surface other users' copies (a cross-user leak).
    if (!currentUserLogin) {
      const u = await Discovery.getCurrentUser(s.host);
      if (u.ok) { currentUserLogin = u.userId || u.userName || ''; if (u.displayName) currentUserName = u.displayName; }
    }
    if (!currentUserLogin) { logEvent('Personalize', '⚠ could not resolve current user — copy discovery skipped'); return; }
    const r = await Discovery.listPersonalCopies(s.host, sourceId, { userName: currentUserLogin, tag });
    if (!r.ok) { logEvent('Personalize', `⚠ copy discovery failed: ${r.error}`); return; }

    const cur = getState();
    const cached = cur.personalLb.copies[sourceId] || [];
    const cachedById = new Map(cached.map(c => [c.id, c]));
    const stdName = discovered.liveboards.find(lb => lb.id === sourceId)?.name || '';
    const prefix = stdName ? `${stdName} — ` : '';
    const srcTag = Discovery.sourceTag(sourceId);
    // A live copy belongs to THIS board if it carries this board's src:<guid> tag (authoritative,
    // rename-proof). Fall back to the local cache or the title prefix only for legacy copies made before
    // the src tag existed. Preserve any locally-set nickname from the cache so a rename survives re-discovery.
    const reconciled = r.copies
      .filter(c => (c.tags || []).includes(srcTag) || cachedById.has(c.id) || (prefix && c.title.startsWith(prefix)))
      .map(c => ({ id: c.id, title: c.title, label: cachedById.get(c.id)?.label || '' }));
    const liveIds = new Set(r.copies.map(c => c.id));
    setState({ personalLb: { ...cur.personalLb,
      copies: { ...cur.personalLb.copies, [sourceId]: reconciled },
      // If the active copy was deleted in another session, fall back to Standard.
      activeCopyId: liveIds.has(cur.personalLb.activeCopyId) ? cur.personalLb.activeCopyId : '' } });
  } finally {
    plbDiscovering = false;
    renderPersonalStrip();
  }
}

// ═══ SDK CODE VIEW — full, runnable snippet ═══════════════════════════════════
function generateCode() {
  const s = getState();
  if (s.section === 'ai-insights') return aiInsightsCode(s);
  const m = META[s.section];
  // Escape backslashes then single quotes so values with apostrophes don't break the JS snippet.
  const esc = str => String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // A standalone saved Answer renders through SearchEmbed (not LiveboardEmbed), so the
  // generated snippet must import and instantiate the class we actually use at runtime.
  const embedCls = (s.section === 'viz' && s.answerId) ? 'SearchEmbed' : m.cls;
  const lbishSection = ['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section);
  const exportMenu = lbishSection && s.exportOpts?.menuAction;
  const pickerMenu = lbishSection && s.exportOpts?.pickerAction;
  const dateBtn = lbishSection && s.dateBtn?.enabled;
  const plbOn = ['liveboard', 'liveboard-custom', 'ai-highlights'].includes(s.section) && s.personalLb?.enabled;
  const importNames = ['init', 'AuthType', embedCls, 'EmbedEvent'];
  if (s.customActions.length || exportMenu || pickerMenu || dateBtn) importNames.push('CustomActionsPosition', 'CustomActionTarget');
  const cfbActiveFilters = s.section === 'liveboard-custom'
    ? Object.entries(cfbSelected).filter(([, v]) => v && v.length)
    : [];
  const drillAction = s.customActions.find(a => a.type === 'drill');
  if (s.activeFilters.length || cfbActiveFilters.length || drillAction || dateBtn) importNames.push('HostEvent', 'RuntimeFilterOp');
  if (hiddenActionKeys(s).length || s.disabledActions.length) importNames.push('Action');
  if (s.section === 'fullapp') importNames.push('Page');
  if (s.section === 'ai-highlights') importNames.push('HostEvent');
  if (plbOn) importNames.push('HostEvent');

  const L = [];
  L.push(`import {\n  ${[...new Set(importNames)].join(', ')}\n} from '@thoughtspot/visual-embed-sdk';`);
  L.push('');
  // init()
  const initLines = [`  thoughtSpotHost: '${esc(s.host) || 'https://your-instance.thoughtspot.cloud'}',`, `  authType: AuthType.${s.authType},`];
  if (s.authType !== 'None') {
    initLines.push('  autoLogin: true,');
    initLines.push('  // PROD: do NOT let the browser choose the user. Your token endpoint must derive the');
    initLines.push('  // identity from a verified server session (SSO/cookie), never from the request body.');
    initLines.push('  getAuthToken: () => fetch(\'/api/auth/token\', { method: \'POST\' }).then(r => r.json()).then(d => d.token),');
  }
  if (hasStyles(s)) {
    initLines.push('  customizations: { style: { customCSS: {');
    if (Object.keys(s.styles.variables).length) { initLines.push('    variables: {'); Object.entries(s.styles.variables).forEach(([k, v]) => initLines.push(`      '${esc(k)}': '${esc(v)}',`)); initLines.push('    },'); }
    if (Object.keys(s.styles.rules).length) {
      initLines.push('    rules_UNSTABLE: {');
      Object.entries(s.styles.rules).forEach(([sel, decls]) => { initLines.push(`      '${esc(sel)}': {`); Object.entries(decls).forEach(([p, v]) => initLines.push(`        '${esc(p)}': '${esc(v)}',`)); initLines.push('      },'); });
      initLines.push('    },');
    }
    initLines.push('  } } },');
  }
  L.push(`init({\n${initLines.join('\n')}\n});`);
  L.push('');
  // embed
  const opt = [];
  opt.push('  frameParams: {},');
  if (s.section === 'search') { opt.push(`  dataSources: ['${esc(s.worksheetId)}'],`); if (s.searchTokenString) opt.push(`  searchOptions: { searchTokenString: '${esc(s.searchTokenString)}', executeSearch: ${s.executeSearch} },`); }
  if (s.section === 'nlsearch') opt.push(`  dataSources: ['${esc(s.worksheetId)}'],`);
  if (s.section === 'spotter') opt.push(`  worksheetId: '${esc(s.worksheetId)}',`);
  // Masterpieces is on by default; the flags loop below emits the explicit `false` when it's toggled off.
  const masterpiecesOn = (s.flags[s.section] || {}).isLiveboardMasterpiecesEnabled !== false;
  if (s.section === 'liveboard' || s.section === 'liveboard-custom' || s.section === 'ai-highlights') {
    opt.push('  liveboardV2: true,');
    if (masterpiecesOn) opt.push('  isLiveboardMasterpiecesEnabled: true,');
    opt.push(`  liveboardId: '${esc(s.liveboardId)}',`);
  }
  if (s.section === 'viz') {
    if (s.answerId) opt.push(`  answerId: '${esc(s.answerId)}',`, '  hideSearchBar: true,');
    else opt.push('  liveboardV2: true,', '  isLiveboardMasterpiecesEnabled: true,', `  liveboardId: '${esc(s.liveboardId)}',`, `  vizId: '${esc(s.vizId)}',`);
  }
  if (s.section === 'fullapp') { const pid = (s.flags.fullapp || {}).pageId || 'Home'; opt.push('  showPrimaryNavbar: false,', `  pageId: Page.${pid},`); }
  Object.entries(s.flags[s.section] || {}).forEach(([k, v]) => { if (k === 'pageId') return; if (k === 'isLiveboardMasterpiecesEnabled' && v === true) return; opt.push(`  ${k}: ${JSON.stringify(v)},`); });
  const hiddenKeys = hiddenActionKeys(s);
  if (hiddenKeys.length) opt.push(`  hiddenActions: [${hiddenKeys.map(a => `Action.${a}`).join(', ')}],`);
  if (s.disabledActions.length) opt.push(`  disabledActions: [${s.disabledActions.map(a => `Action.${a}`).join(', ')}],`);
  if (s.customActions.length || exportMenu || pickerMenu || dateBtn) {
    opt.push('  customActions: [');
    s.customActions.forEach(a => opt.push(`    { id: '${esc(a.id)}', name: '${esc(a.label)}', position: CustomActionsPosition.${a.pos || 'PRIMARY'}, target: CustomActionTarget.${a.target || 'LIVEBOARD'} },`));
    if (exportMenu) opt.push(`    { id: 'export', name: '${esc(s.exportOpts.actionLabel || 'Preconfigured pdf download')}', position: CustomActionsPosition.MENU, target: CustomActionTarget.LIVEBOARD },`);
    if (pickerMenu) opt.push(`    { id: 'export-customize', name: '${esc(s.exportOpts.pickerLabel || 'Customize Export')}', position: CustomActionsPosition.MENU, target: CustomActionTarget.LIVEBOARD },`);
    if (dateBtn) opt.push(`    { id: '${DATE_ACTION_ID}', name: 'Date', position: CustomActionsPosition.PRIMARY, target: CustomActionTarget.LIVEBOARD },`);
    opt.push('  ],');
  }
  if (s.runtimeParameters.length) { opt.push('  runtimeParameters: ['); s.runtimeParameters.forEach(p => opt.push(`    { name: '${esc(p.name)}', value: '${esc(p.value)}' },`)); opt.push('  ],'); }

  // `let` when Personal liveboards is on so switchBoard() can reassign `embed` on a tab click.
  L.push(`${plbOn ? 'let' : 'const'} embed = new ${embedCls}('#ts-embed-container', {\n${opt.join('\n')}\n});`);
  if (drillAction) {
    // Drill-down with filters carried over (Q4): clicked attributes + parent filters → detail board.
    L.push('');
    L.push('// Drill-down: carry the clicked point + the parent board\'s filters into a detail Liveboard.');
    L.push('// Illustrative — this re-creates the embed in place, which is what the playground does.');
    L.push('embed.on(EmbedEvent.CustomAction, (payload) => {');
    L.push(`  if (payload.id !== '${drillAction.id}') return;`);
    L.push('  const attrs = payload.data?.clickedPoint?.selectedAttributes ?? [];');
    L.push('  const clicked = attrs.map(a => ({ columnName: a.column.name, operator: RuntimeFilterOp.IN, values: [a.value] }));');
    L.push('  embed.destroy();');
    L.push(`  const detail = new ${embedCls}('#ts-embed-container', {`);
    L.push('    frameParams: {}, liveboardV2: true,');
    L.push(`    liveboardId: '${drillAction.drillLiveboardId || 'detail-liveboard-guid'}',`);
    L.push('    runtimeFilters: clicked, // plus any parent filters you are already tracking');
    L.push('  });');
    L.push('  detail.render();');
    L.push('});');
  } else if (s.customActions.length || exportMenu || pickerMenu) {
    L.push('embed.on(EmbedEvent.CustomAction, (payload) => {');
    if (exportMenu) L.push("  if (payload.id === 'export') return exportLiveboard(); // the Liveboard-menu Export action");
    if (pickerMenu) L.push("  if (payload.id === 'export-customize') return openExportDialog(); // your UI: let the user pick options, then export");
    L.push('  console.log(payload.id, payload.data);');
    L.push('});');
  }
  if (dateBtn) {
    const col = esc(s.dateBtn?.column || 'Order Date');
    L.push('');
    L.push('// "Date" PRIMARY button → apply Today / a specific date as a runtime filter. Host-controlled,');
    L.push('// so there is no native date-dialog default (Between/Yesterday) to fight. Replaces the whole set.');
    L.push('embed.on(EmbedEvent.CustomAction, (payload) => {');
    L.push(`  if (payload.id !== '${DATE_ACTION_ID}') return;`);
    L.push('  const iso = prompt(\'Date (YYYY-MM-DD)\', new Date().toISOString().slice(0, 10)); // swap for your own UI');
    L.push('  if (!iso) return;');
    L.push('  const [y, m, d] = iso.split(\'-\').map(Number);');
    L.push('  const epoch = Math.floor(new Date(y, m - 1, d).getTime() / 1000); // TS date runtime-filter = epoch seconds');
    L.push(`  embed.trigger(HostEvent.UpdateRuntimeFilters, [{ columnName: '${col}', operator: RuntimeFilterOp.EQ, values: [String(epoch)] }]);`);
    L.push('});');
  }
  if (['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section)) {
    // Q2 — no server-side save webhook exists; this client event is the host's save signal.
    L.push('embed.on(EmbedEvent.Save, (payload) => {\n  console.log("Saved inside embed:", payload.data); // sync to your store here\n});');
  }
  if (plbOn) {
    const host = esc(s.host) || 'https://your-instance.thoughtspot.cloud';
    const tag = esc(s.personalLb?.tag || 'Personal');
    L.push('');
    L.push('// ── Personal liveboards — per-user editable copies (host-app UI, not an SDK feature) ─────────');
    L.push('// "Personalize" makes a full, user-owned CLONE of the standard board via metadata/copyobject');
    L.push('// (10.3.0.cl+), tags it `Personal` + `src:<sourceId>` so a user\'s copies can be re-discovered');
    L.push('// per board (the src: tag records WHICH board it came from — rename-proof), then swaps the embed');
    L.push('// to the chosen board id. Keep your app state on the STANDARD id so it\'s always tab #1.');
    L.push('// (For saved filter/sort VIEWS instead of editable copies, add Action.PersonalizedViewsDropdown');
    L.push('//  to visibleActions — no REST needed.) Declare `embed` with `let` so switchBoard() can reassign it.');
    L.push(`const HOST = '${host}';`);
    L.push('const REST = { \'Content-Type\': \'application/json\', Accept: \'application/json\' /*, Authorization: `Bearer ${token}` */ };');
    L.push('');
    L.push('async function createPersonalCopy(sourceId, title) {');
    L.push('  const res = await fetch(`${HOST}/api/rest/2.0/metadata/copyobject`, {');
    L.push('    method: \'POST\', headers: REST, credentials: \'include\',');
    L.push('    body: JSON.stringify({ identifier: sourceId, type: \'LIVEBOARD\', title }),');
    L.push('  });');
    L.push('  const { metadata_id } = await res.json();');
    L.push('  await fetch(`${HOST}/api/rest/2.0/tags/assign`, {');
    L.push('    method: \'POST\', headers: REST, credentials: \'include\',');
    L.push(`    body: JSON.stringify({ metadata: [{ identifier: metadata_id, type: 'LIVEBOARD' }], tag_identifiers: ['${tag}', \`src:\${sourceId}\`] }),`);
    L.push('  });');
    L.push('  switchBoard(metadata_id);');
    L.push('  embed.trigger(HostEvent.Edit); // open the fresh copy editable so the user can personalize it');
    L.push('  return metadata_id;');
    L.push('}');
    L.push('');
    L.push('// This user\'s copies OF THIS board — an exact, server-side query on the src:<sourceId> tag');
    L.push('// (owner scopes to the user; the src tag scopes to the board). No title matching, no client cache.');
    L.push('async function listCopiesForBoard(sourceId) {');
    L.push('  const me = await (await fetch(`${HOST}/api/rest/2.0/auth/session/user`, { headers: REST, credentials: \'include\' })).json();');
    L.push('  const res = await fetch(`${HOST}/api/rest/2.0/metadata/search`, {');
    L.push('    method: \'POST\', headers: REST, credentials: \'include\',');
    L.push('    body: JSON.stringify({ metadata: [{ type: \'LIVEBOARD\' }], created_by_user_identifiers: [me.id], tag_identifiers: [`src:${sourceId}`], record_size: -1 }),');
    L.push('  });');
    L.push('  return (await res.json()).map(m => ({ id: m.metadata_id, title: m.metadata_name }));');
    L.push('}');
    L.push('');
    L.push('function switchBoard(id) { // tab click: destroy + re-embed at the chosen board id');
    L.push('  embed.destroy();');
    L.push(`  embed = new ${embedCls}('#ts-embed-container', { frameParams: {}, liveboardV2: true, isLiveboardMasterpiecesEnabled: true, liveboardId: id });`);
    L.push('  embed.render();');
    L.push('}');
  }
  if (s.section === 'ai-highlights') {
    // AI Highlights nav option — pop the "how your top metrics changed" panel as soon as the board paints.
    L.push('// AI Highlights: open the insights panel once the Liveboard finishes rendering.');
    L.push('// Needs AI Highlights + KPI anomaly detection enabled on the instance; SDK 1.44+ / TS 10.15+.');
    L.push('embed.on(EmbedEvent.LiveboardRendered, () => {\n  embed.trigger(HostEvent.AIHighlights);\n});');
  }
  L.push('embed.render();');
  if (['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section)) {
    const eo = s.exportOpts || {};
    L.push('');
    L.push('// ── Custom export via the REST Report API ──────────────────────────────────────');
    if (eo.hideNativeDownload) L.push('// Native Download is hidden above; this is the only export path — full control of the output.');
    L.push('// Server-side this gives you every PDF knob the native modal does not expose individually');
    L.push('// (truncate_table:false = no column cutoff; page_size = page-break behaviour; orientation; etc.).');
    const body = { metadata_identifier: s.liveboardId || '<liveboard-guid>', file_format: eo.format || 'PDF' };
    if ((eo.format || 'PDF') === 'PDF') {
      body.pdf_options = {
        page_size: eo.pageSize || 'CONTINUOUS',
        page_orientation: eo.orientation || 'LANDSCAPE',
        truncate_table: !!eo.truncateTable,
        include_cover_page: eo.includeCoverPage !== false,
        include_filter_page: eo.includeFilterPage !== false,
        include_page_number: eo.includePageNumber !== false,
        include_custom_logo: eo.includeCustomLogo !== false,
        ...(eo.footerText ? { page_footer_text: eo.footerText } : {}),
      };
    }
    L.push('async function exportLiveboard() {');
    L.push(`  const res = await fetch('${esc(s.host) || 'https://your-instance.thoughtspot.cloud'}/api/rest/2.0/report/liveboard', {`);
    L.push("    method: 'POST',");
    L.push("    headers: { 'Content-Type': 'application/json', Accept: 'application/octet-stream' /*, Authorization: `Bearer ${token}` */ },");
    L.push(`    body: JSON.stringify(${JSON.stringify(body, null, 2).split('\n').map((ln, i) => i === 0 ? ln : '    ' + ln).join('\n')}),`);
    L.push('  });');
    L.push('  const blob = await res.blob();');
    L.push('  const url = URL.createObjectURL(blob);');
    L.push(`  const a = Object.assign(document.createElement('a'), { href: url, download: 'liveboard.${(eo.format || 'pdf').toLowerCase()}' });`);
    L.push('  a.click(); URL.revokeObjectURL(url);');
    L.push('}');
    L.push('// Wire exportLiveboard() to your own button, or to a custom action via embed.on(EmbedEvent.CustomAction, …).');
    if (pickerMenu) {
      L.push('');
      L.push('// "Customize Export" — render your own dialog so the user picks options at export time, then');
      L.push('// merge their choices into the request body above and call exportLiveboard(). The options');
      L.push('// baked in above are just the defaults you seed the dialog with.');
      L.push('function openExportDialog() {');
      L.push('  // e.g. show a <dialog> with format + pdf_options controls, then on submit run exportLiveboard().');
      L.push('  exportLiveboard();');
      L.push('}');
    }
  }
  if (s.activeFilters.length) {
    L.push(''); L.push('// Runtime filters — applied live, no re-render:');
    L.push('// NOT a security boundary: these surface as editable URL params. For tenant isolation or');
    L.push('// per-user data, enforce server-side with RLS/ABAC (custom token + variable_values).');
    L.push('embed.trigger(HostEvent.UpdateRuntimeFilters, [');
    s.activeFilters.forEach(f => L.push(`  { columnName: '${esc(f.columnName)}', operator: RuntimeFilterOp.${f.opKey}, values: [${f.values.map(v => `'${esc(v)}'`).join(', ')}] },`));
    L.push(']);');
  }
  // Custom filter bar — record the value display order chosen in the playground.
  // Sorting is a host-app UI concern: the embed has no API to order a filter's values,
  // so this object just documents the order your own filter controls should render in.
  if (s.section === 'liveboard-custom' && cfbCols.length) {
    L.push(''); L.push('// Custom filter bar — value display order (host-app UI; the embed does not sort filter values):');
    L.push('const filterValueOrder = {');
    cfbCols.forEach(col => {
      const mode = cfbSort[col] || 'asc';
      const ordered = () => cfbSortValues(col, cfbValueCache[col] || []).map(v => `'${esc(v)}'`).join(', ');
      let entry;
      if (mode === 'custom') {
        entry = `{ sort: 'custom', values: [${ordered()}] }`;
      } else if (mode === 'metric') {
        const m = cfbMetric[col] || {};
        entry = `{ sort: 'metric', by: { column: '${esc(m.col || '')}', agg: '${m.agg || 'sum'}', dir: '${m.dir || 'desc'}' }, values: [${ordered()}] }`;
      } else {
        entry = `{ sort: '${mode}' }`;
      }
      L.push(`  '${esc(col)}': ${entry},`);
    });
    L.push('};');
  }
  if (cfbActiveFilters.length) {
    L.push(''); L.push('// Custom filter bar — selected values, applied live (ordered per filterValueOrder):');
    L.push('embed.trigger(HostEvent.UpdateRuntimeFilters, [');
    cfbActiveFilters.forEach(([col, vals]) => {
      const ordered = cfbSortValues(col, vals);
      L.push(`  { columnName: '${esc(col)}', operator: RuntimeFilterOp.IN, values: [${ordered.map(v => `'${esc(v)}'`).join(', ')}] },`);
    });
    L.push(']);');
  }
  return L.join('\n');
}
function refreshCode() {
  const pre = $('#code-view');
  if (pre) pre.textContent = generateCode();
}

// Generated REST snippet for the headless AI Insights section (no Visual Embed SDK).
function aiInsightsCode(s) {
  const esc = str => String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const host = esc(s.host) || 'https://your-instance.thoughtspot.cloud';
  const ws = esc(s.worksheetId) || 'your-worksheet-or-model-guid';
  return [
    '// Headless AI insights — ThoughtSpot Spotter REST API (no Visual Embed SDK).',
    '// Requires Spotter enabled on the cluster + the CAN_USE_SPOTTER privilege (Beta endpoints).',
    '// Auth: a browser session cookie (credentials: include) OR a bearer token.',
    '',
    `const HOST = '${host}';`,
    `const DATA_SOURCE = '${ws}'; // Worksheet / Model GUID — the metadata_identifier`,
    '',
    'const headers = {',
    "  'Content-Type': 'application/json',",
    "  Accept: 'application/json',",
    '  // Authorization: `Bearer ${token}`, // add for cookieless trusted auth',
    '};',
    '',
    '// 1) Suggest analytical questions for this data source.',
    'async function suggestInsights(prompt = "What are the most important insights in this data?") {',
    '  const resp = await fetch(`${HOST}/api/rest/2.0/ai/relevant-questions/`, {',
    "    method: 'POST', credentials: 'include', headers,",
    '    body: JSON.stringify({',
    '      query: prompt,',
    '      metadata_context: { data_source_identifiers: [DATA_SOURCE] },',
    `      limit_relevant_questions: ${aiLimit},`,
    '    }),',
    '  });',
    '  const { relevant_questions = [] } = await resp.json();',
    '  return relevant_questions; // [{ query, data_source_identifier, data_source_name }]',
    '}',
    '',
    '// 2) Generate a single AI answer for a natural-language question.',
    'async function answer(query) {',
    '  const resp = await fetch(`${HOST}/api/rest/2.0/ai/answer/create`, {',
    "    method: 'POST', credentials: 'include', headers,",
    '    body: JSON.stringify({ query, metadata_identifier: DATA_SOURCE }),',
    '  });',
    '  return resp.json(); // { visualization_type, tokens, display_tokens, ... }',
    '}',
    '',
    "// 3) Materialize the answer's tokens into actual data rows to render inline.",
    'async function data(queryString) {',
    '  const resp = await fetch(`${HOST}/api/rest/2.0/searchdata`, {',
    "    method: 'POST', credentials: 'include', headers,",
    '    body: JSON.stringify({ query_string: queryString, logical_table_identifier: DATA_SOURCE, record_size: 10 }),',
    '  });',
    '  const { contents = [] } = await resp.json();',
    '  return contents[0]; // { column_names, data_rows, available_data_row_count }',
    '}',
    '',
    '// Auto-generate: for each suggested question, answer it and pull its rows for your own table.',
    'const questions = await suggestInsights();',
    'for (const q of questions) {',
    '  const a = await answer(q.query);',
    '  const rows = await data(a.tokens || a.display_tokens);',
    '  console.log(q.query, rows);',
    '}',
  ].join('\n');
}

// ═══ SDK LIFECYCLE — live flow diagram (host ↔ iframe ↔ TS server) ════════════
// Narrates what the Visual Embed SDK does internally as the real EmbedEvents fire.
// Steps light up: pending → active (pulsing) → done (green). Driven from logEvent().

// Which EmbedEvent completes which step. (Data/Load both land on the 'load' step.)
const FLOW_EVENT_STEP = {
  AuthInit: 'auth',
  EmbedListenerReady: 'bridge',
  Load: 'load',
  Data: 'load',
  LiveboardRendered: 'rendered',
};

function flowSteps(section) {
  // Headless AI Insights is REST, not an iframe — show the request sequence instead of the
  // postMessage handshake. These steps are descriptive (no EmbedEvents drive them).
  if (section === 'ai-insights') {
    return [
      { key: 'pick',    lane: 'host',   title: 'Pick a data source', evt: 'Worksheet / Model GUID',
        desc: 'The metadata_identifier every AI call runs against.' },
      { key: 'suggest', lane: 'server', title: 'Suggest questions', evt: 'POST /api/rest/2.0/ai/relevant-questions/',
        desc: 'Spotter proposes analytical sub-questions for the data source.' },
      { key: 'answer',  lane: 'server', title: 'Generate answer', evt: 'POST /api/rest/2.0/ai/answer/create',
        desc: 'A single AI answer (search tokens + viz type) — no conversation session.' },
      { key: 'render',  lane: 'host',   title: 'Render your panel', evt: 'custom DOM',
        desc: 'You render the cards yourself — no embed iframe involved.' },
    ];
  }
  // A standalone saved Answer renders via SearchEmbed (fires Load, not LiveboardRendered),
  // so reflect the real class and skip the liveboard-only "rendered" step for it.
  const isAnswer = section === 'viz' && getState().answerId;
  const cls = isAnswer ? 'SearchEmbed' : (META[section]?.cls || 'Embed');
  const isLb = ['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(section) && !isAnswer;
  const steps = [
    { key: 'init',   lane: 'host',   title: 'SDK initialised',
      evt: 'init({ thoughtSpotHost, authType })',
      desc: 'Host + auth mode stored once. Nothing renders yet.' },
    { key: 'embed',  lane: 'host',   title: `${cls} created → render()`,
      evt: `new ${cls}('#ts-embed-container', {…}).render()`,
      desc: 'An iframe is injected, with your options encoded in.' },
    { key: 'auth',   lane: 'server', title: 'Authentication verified',
      evt: 'EmbedEvent.AuthInit',
      desc: 'TS validates the session — SSO cookie or trusted token.' },
    { key: 'bridge', lane: 'iframe', title: 'postMessage bridge open',
      evt: 'EmbedEvent.EmbedListenerReady',
      desc: 'Channel live: HostEvents in, EmbedEvents out.' },
    { key: 'load',   lane: 'server', title: 'Definition fetched & queried',
      evt: 'EmbedEvent.Load / Data',
      desc: 'TS loads the object and runs each query server-side.' },
  ];
  if (isLb) steps.push({ key: 'rendered', lane: 'host', title: 'Liveboard rendered',
    evt: 'EmbedEvent.LiveboardRendered',
    desc: 'Tiles painted; overlay clears and pending filters apply.' });
  return steps;
}

const LANE_LABEL = { host: 'Your page', iframe: 'SDK iframe', server: 'TS server' };

// Runtime flow state.
let flowCurrent = [];   // the step objects for the active section
let flowReached = -1;   // furthest done index
let flowActive = -1;    // currently-active (pulsing) index
let flowFailed = -1;    // failed index, or -1

function flowReset(section) {
  flowCurrent = flowSteps(section);
  flowReached = -1; flowActive = -1; flowFailed = -1;
  renderFlow();
}
function flowStart() {
  // init() + embed/render() are host-side and have already happened by now.
  flowReached = 1; flowActive = 2; flowFailed = -1;
  renderFlow();
}
function flowMark(type) {
  if (!flowCurrent.length) return;
  if (type === 'NoCookieAccess') { flowFailAt('auth'); return; }
  if (type === 'Error')         { flowFailAt(flowCurrent[flowActive]?.key); return; }
  const key = FLOW_EVENT_STEP[type];
  if (!key) return;
  const idx = flowCurrent.findIndex(s => s.key === key);
  if (idx < 0 || idx <= flowReached) return;
  flowReached = idx;
  flowActive = idx + 1 < flowCurrent.length ? idx + 1 : -1; // -1 → all done
  renderFlow();
}
function flowFailAt(key) {
  const idx = flowCurrent.findIndex(s => s.key === key);
  if (idx < 0) return;
  flowFailed = idx; flowActive = -1;
  renderFlow();
}

function renderFlow() {
  const root = $('#flow-diagram');
  if (!root) return;
  if (!flowCurrent.length) {
    root.innerHTML = '<div class="log-empty">Render an embed to watch the SDK lifecycle.</div>';
    return;
  }
  // Lane legend
  const lanes = el('div', 'flow-lanes');
  ['host', 'iframe', 'server'].forEach(l => {
    const lane = el('div', 'flow-lane', LANE_LABEL[l]);
    lane.dataset.lane = l;
    lanes.appendChild(lane);
  });
  // Steps
  const list = el('div', 'flow-steps');
  flowCurrent.forEach((step, i) => {
    let cls = 'flow-step';
    if (i === flowFailed) cls += ' failed';
    else if (i <= flowReached) cls += ' done';
    else if (i === flowActive) cls += ' active';
    else cls += ' fs-pending';
    const row = el('div', cls);
    const dotChar = i === flowFailed ? '✕' : i <= flowReached ? '✓' : String(i + 1);
    const dot = el('div', 'fs-dot', dotChar);
    const lane = el('div', 'fs-lane', LANE_LABEL[step.lane]);
    lane.dataset.lane = step.lane;
    // Build with textContent so any literal "<…>" in evt/desc renders as text, never HTML
    // (a raw "<iframe>" in a description string was rendering as an empty iframe box).
    const body = el('div', 'fs-body');
    const title = el('div', 'fs-title');
    title.textContent = step.title + ' ';
    const evt = el('span', 'fs-evt'); evt.textContent = step.evt; title.appendChild(evt);
    const desc = el('div', 'fs-desc'); desc.textContent = step.desc;
    body.append(title, desc);
    row.append(dot, lane, body);
    list.appendChild(row);
  });
  const foot = el('div', 'flow-foot',
    'Steps 1–2 run in <strong>your page</strong> (embed.js). Steps 3+ happen <strong>inside the ThoughtSpot iframe</strong> and surface back to you as EmbedEvents over postMessage — they appear live in the Event Log tab.');
  root.innerHTML = '';
  root.append(lanes, list, foot);
}

// ═══ APIs USED — contextual REST + SDK surface for the current setup ═══════════
// A companion to the SDK Lifecycle tab: instead of narrating the iframe handshake, this lists
// every REST endpoint and SDK call the active configuration touches, grouped by where it runs.
// HTTP calls light up with a live count + last status as they actually fire (via window.__onApiCall).
const apiUsage = new Map(); // `${method} ${path}` -> { method, path, scope, count, lastStatus }
function recordApi({ scope = 'TS REST', method = 'GET', path = '', status } = {}) {
  if (!path) return;
  const key = `${method} ${path}`;
  let rec = apiUsage.get(key);
  if (!rec) { rec = { scope, method, path, count: 0, lastStatus: null }; apiUsage.set(key, rec); }
  rec.count += 1;
  if (status != null) rec.lastStatus = status;
  if (bottomTab === 'apis') renderApis();
}
window.__onApiCall = recordApi; // discovery.js / embed.js / auth.js report here

/** Build the contextual catalog of APIs this configuration uses (derived from state, like SDK Code). */
function apiCatalog(s) {
  const groups = [];
  const auth = s.authType !== 'None';

  const authItems = [
    { method: 'GET', path: '/api/rest/2.0/auth/session/user', scope: 'TS REST', desc: 'Verify the session and read user + current org (on Connect).' },
  ];
  const customTok = s.auth?.tokenType === 'custom';
  if (auth) authItems.push(
    { method: 'GET', path: '/api/auth/config', scope: 'playground', desc: 'Non-sensitive server bootstrap (host, allowlist, JIT/group guards).' },
    { method: 'POST', path: '/api/auth/token', scope: 'playground', desc: 'Mint a short-lived trusted-auth token. The server injects secret_key.' },
    customTok
      ? { method: 'POST', path: '/api/rest/2.0/auth/token/custom', scope: 'server→TS', desc: 'ABAC token mint — stamps variable_values for RLS (ts_var) with a required persist_option. Server-side only.' }
      : { method: 'POST', path: '/api/rest/2.0/auth/token/full', scope: 'server→TS', desc: 'ThoughtSpot token mint — server-side only; the secret never reaches the browser.' },
  );
  groups.push({ group: 'Auth & session', items: authItems });

  // Headless AI Insights uses only the Spotter AI REST endpoints — no SDK / embed surface.
  if (s.section === 'ai-insights') {
    groups.push({ group: 'Spotter AI (REST)', items: [
      { method: 'POST', path: '/api/rest/2.0/ai/relevant-questions/', scope: 'TS REST', desc: 'Suggest analytical questions for the data source (Spotter; needs CAN_USE_SPOTTER).' },
      { method: 'POST', path: '/api/rest/2.0/ai/answer/create', scope: 'TS REST', desc: 'Generate a single AI answer (search tokens + viz type) for a natural-language query.' },
      { method: 'POST', path: '/api/rest/2.0/searchdata', scope: 'TS REST', desc: "Run the answer's tokens against the data source to fetch the actual rows shown inline." },
    ] });
    return groups;
  }

  const disc = [
    { method: 'POST', path: '/api/rest/2.0/metadata/search', scope: 'TS REST', desc: 'List worksheets/models and liveboards (+ tags) for the pickers.' },
  ];
  if (['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section))
    disc.push({ method: 'POST', path: '/api/rest/2.0/metadata/liveboard/data', scope: 'TS REST', desc: "List a liveboard's visualizations and derive custom-filter values." });
  if (s.section === 'liveboard-custom' && auth)
    disc.push({ method: 'POST', path: '/api/filter-values', scope: 'playground', desc: 'CORS-safe relay for filter values, using YOUR minted token (never an admin mint).' });
  groups.push({ group: 'Discovery (REST)', items: disc });

  const cls = (s.section === 'viz' && s.answerId) ? 'SearchEmbed' : META[s.section].cls;
  const sdk = [
    { method: 'SDK', path: `init({ thoughtSpotHost, authType: AuthType.${s.authType} })`, scope: 'visual-embed-sdk', desc: 'One-time SDK init with host + auth mode.' },
    { method: 'SDK', path: `new ${cls}('#ts-embed-container', { … })`, scope: 'visual-embed-sdk', desc: 'Instantiate the embed with your configured options.' },
    { method: 'SDK', path: 'embed.render()', scope: 'visual-embed-sdk', desc: 'Inject the iframe and open the postMessage bridge.' },
    { method: 'SDK', path: 'embed.on(EmbedEvent.*)', scope: 'visual-embed-sdk', desc: 'Subscribe to lifecycle / data / error / custom-action / save events.' },
    { method: 'SDK', path: 'embed.destroy()', scope: 'visual-embed-sdk', desc: 'Tear down before every re-render.' },
  ];
  if (s.activeFilters.length || s.section === 'liveboard-custom')
    sdk.push({ method: 'SDK', path: 'embed.trigger(HostEvent.UpdateRuntimeFilters, …)', scope: 'visual-embed-sdk', desc: 'Apply runtime filters live — no re-render.' });
  sdk.push({ method: 'SDK', path: 'embed.trigger(HostEvent.Reload | Search | Navigate | SetVisibleVizs)', scope: 'visual-embed-sdk', desc: 'Drive the live embed from the host (Host events section).' });
  if (s.section === 'ai-highlights')
    sdk.push({ method: 'SDK', path: 'embed.trigger(HostEvent.AIHighlights)', scope: 'visual-embed-sdk', desc: 'Open the AI Highlights insights panel once the Liveboard renders.' });
  groups.push({ group: 'SDK (Visual Embed)', items: sdk });

  const ex = [];
  if (['liveboard', 'liveboard-custom', 'viz', 'ai-highlights'].includes(s.section))
    ex.push({ method: 'POST', path: '/api/rest/2.0/report/liveboard', scope: 'TS REST', desc: 'Export the liveboard (PDF/XLSX/CSV/PNG); active filters bake in as override_filters.' });
  if (s.customActions.some(a => a.type === 'writeback'))
    ex.push({ method: 'POST', path: '/api/writeback', scope: 'playground', desc: 'Write-back custom-action sink (stub; requires TS_ALLOW_DEV_PROXY on the server).' });
  if (ex.length) groups.push({ group: 'Export & write-back', items: ex });

  return groups;
}

function renderApis() {
  const root = $('#pane-apis');
  if (!root) return;
  root.innerHTML = '';
  const intro = el('div', 'flow-foot',
    'Every REST + SDK call the current setup uses. <strong>TS REST</strong> = direct to ThoughtSpot · <strong>playground</strong> = this tool’s Node server · <strong>server→TS</strong> = server-side only · <strong>visual-embed-sdk</strong> = inside the iframe. A green badge marks calls that have fired this session.');
  root.appendChild(intro);
  apiCatalog(getState()).forEach(g => {
    const sec = el('div', 'api-group');
    sec.appendChild(el('div', 'api-group-t', g.group));
    g.items.forEach(it => {
      const row = el('div', 'api-row');
      const m = el('span', `api-method api-method--${it.method.toLowerCase()}`); m.textContent = it.method;
      const main = el('div', 'api-main');
      const path = el('div', 'api-path'); path.textContent = it.path;       // textContent: never parse as HTML
      const desc = el('div', 'api-desc'); desc.textContent = it.desc;
      main.append(path, desc);
      const scope = el('span', 'api-scope'); scope.textContent = it.scope;
      row.append(m, main, scope);
      const rec = apiUsage.get(`${it.method} ${it.path}`);
      if (rec && rec.count) {
        const ok = !(rec.lastStatus >= 400);
        const badge = el('span', 'api-badge' + (ok ? '' : ' api-badge--err'));
        badge.textContent = `✓ ${rec.count}${rec.lastStatus ? ' · ' + rec.lastStatus : ''}`;
        row.appendChild(badge);
      }
      sec.appendChild(row);
    });
    root.appendChild(sec);
  });
}

// Re-render the live views whenever shared state changes.
subscribe(() => {
  if (bottomTab === 'code') refreshCode();
  if (bottomTab === 'apis') renderApis();
});
