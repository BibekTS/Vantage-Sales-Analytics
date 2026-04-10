/**
 * app.js — Main application controller
 *
 * Imports auth.js and embed.js, wires up all UI logic,
 * and exposes global window.* functions for inline HTML handlers.
 */

import { initSDK, doRender as _doRender, HostEvent, Action, RuntimeFilterOp, CustomActionsPosition } from './embed.js';
import { checkAuth } from './auth.js';

// ── State ────────────────────────────────────────────────────────────────
let currentEmbed   = null;
let currentSection = null;
let pendingSection = null;  // section waiting to render after auth
let sdkInitialized = false;
let eventCount     = 0;

let advancedExpanded = false;
let currentFeaturePanel = null;
let embedOptions = { hiddenActions: [], disabledActions: [], customActions: [], runtimeParameters: [] };

let bottomExpanded = false;
let bottomTab      = 'log';   // 'log' | 'code'

let sectionOpts = { search: {}, nlsearch: {}, spotter: {}, liveboard: {}, viz: {}, fullapp: {} };
let currentEoSection = null;

let customFilters = {};       // { columnName: selectedValue } for Custom Filters view
let availableColumns = [];    // column names from liveboard, cached after first fetch
let activeFilterColumns = []; // mutable list; seeded from TS_CONFIG.filterColumns on buildFilterBar()

// ── Bearer token discovery ────────────────────────────────────────────────────
// SECURITY: bearerToken is never persisted to localStorage. It is stored in memory only.
// If the user checks "Remember for this session", it is stored in sessionStorage (cleared on tab close).
// This design balances convenience with security: a token never persists to disk, and a security
// auditor can see at a glance that tokens are not long-lived storage.
let bearerToken = '';
let discoveredOrg = null;     // { userName, orgName } — display only, not sensitive
let discoveredObjects = { worksheets: [], liveboards: [], answers: [] };

const SECTION_META = {
  search:            { title: 'Search Data',        badge: 'SearchEmbed'           },
  spotter:           { title: 'Spotter AI',         badge: 'SpotterEmbed'          },
  nlsearch:          { title: 'NL Search',          badge: 'SearchBarEmbed'        },
  liveboard:         { title: 'Liveboard',          badge: 'LiveboardEmbed'        },
  'liveboard-custom': { title: 'Custom Liveboard',  badge: 'LiveboardEmbed+Filters' },
  viz:               { title: 'Visualization',      badge: 'LiveboardEmbed+vizId'  },
  fullapp:           { title: 'Full App',           badge: 'AppEmbed'              },
};

// ── Bearer token discovery helpers ───────────────────────────────────────────
/**
 * Returns authorization headers if bearerToken is set
 */
function getBearerHeaders() {
  if (!bearerToken) return {};
  return { 'Authorization': `Bearer ${bearerToken}` };
}

/**
 * Thin wrapper for authenticated fetch to ThoughtSpot API
 */
async function tsApiFetch(host, path, options = {}) {
  const url = `${host.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...getBearerHeaders(),
      ...(options.headers || {}),
    },
  });
}

/**
 * Verify token and get user/org info
 */
async function discoverOrg(host) {
  try {
    const resp = await tsApiFetch(host, '/api/rest/2.0/auth/session/user');
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const data = await resp.json();
    return {
      ok: true,
      userName: data.display_name || data.name || 'User',
      orgName: data.current_org?.name || data.orgs?.[0]?.name || 'Unknown Org',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Discover worksheets, liveboards, and answers in parallel
 */
async function discoverObjects(host) {
  try {
    const requests = [
      // Worksheets
      tsApiFetch(host, '/api/rest/2.0/metadata/search', {
        method: 'POST',
        body: JSON.stringify({
          metadata: [{ type: 'LOGICAL_TABLE' }],
          record_size: 100,
          sort_options: { field_name: 'NAME', order: 'ASC' },
        }),
      }),
      // Liveboards
      tsApiFetch(host, '/api/rest/2.0/metadata/search', {
        method: 'POST',
        body: JSON.stringify({
          metadata: [{ type: 'LIVEBOARD' }],
          record_size: 100,
          sort_options: { field_name: 'NAME', order: 'ASC' },
        }),
      }),
      // Answers
      tsApiFetch(host, '/api/rest/2.0/metadata/search', {
        method: 'POST',
        body: JSON.stringify({
          metadata: [{ type: 'ANSWER' }],
          record_size: 100,
          sort_options: { field_name: 'NAME', order: 'ASC' },
        }),
      }),
    ];

    const [wsResp, lbResp, ansResp] = await Promise.all(requests);

    let worksheets = [];
    let liveboards = [];
    let answers = [];

    if (wsResp.ok) {
      const wsData = await wsResp.json();
      console.log('[Discovery] Worksheets response:', wsData);
      const objects = Array.isArray(wsData) ? wsData : [];
      worksheets = objects
        .filter(m => m.metadata_type === 'LOGICAL_TABLE')
        .map(m => ({ id: m.metadata_id, name: m.metadata_name || 'Untitled' }));
    }

    if (lbResp.ok) {
      const lbData = await lbResp.json();
      console.log('[Discovery] Liveboards response:', lbData);
      const objects = Array.isArray(lbData) ? lbData : [];
      liveboards = objects
        .filter(m => m.metadata_type === 'LIVEBOARD')
        .map(m => ({ id: m.metadata_id, name: m.metadata_name || 'Untitled' }));
    }

    if (ansResp.ok) {
      const ansData = await ansResp.json();
      console.log('[Discovery] Answers response:', ansData);
      const objects = Array.isArray(ansData) ? ansData : [];
      answers = objects
        .filter(m => m.metadata_type === 'ANSWER')
        .map(m => ({ id: m.metadata_id, name: m.metadata_name || 'Untitled' }));
    }

    discoveredObjects = { worksheets, liveboards, answers };
    console.log('[Discovery] Parsed objects:', discoveredObjects);
    return { ok: true, worksheets, liveboards, answers };
  } catch (err) {
    console.error('[Discovery] Error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Discover visualization tabs within a liveboard
 */
async function discoverViz(host, liveboardId) {
  try {
    // POST /metadata/liveboard/data with record_size:1 returns contents[] with
    // visualization_id + visualization_name for every viz on the liveboard.
    const resp = await tsApiFetch(host, '/api/rest/2.0/metadata/liveboard/data', {
      method: 'POST',
      body: JSON.stringify({ metadata_identifier: liveboardId, record_size: 1 }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const vizzes = (data.contents || [])
      .filter(v => v.visualization_id)
      .map(v => ({
        id: v.visualization_id,
        name: v.visualization_name || 'Untitled',
      }));
    return { ok: true, visualizations: vizzes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Populate all discovery dropdowns
 */
function populateDiscoveryDropdowns() {
  // Worksheets
  const wsSelect = document.getElementById('cfg-worksheet-sel');
  if (wsSelect) {
    wsSelect.innerHTML = '<option value="">Select a worksheet...</option>';
    discoveredObjects.worksheets.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name;
      wsSelect.appendChild(opt);
    });
  }

  // Liveboards
  const lbSelect = document.getElementById('cfg-liveboard-sel');
  if (lbSelect) {
    lbSelect.innerHTML = '<option value="">Select a liveboard...</option>';
    discoveredObjects.liveboards.forEach(lb => {
      const opt = document.createElement('option');
      opt.value = lb.id;
      opt.textContent = lb.name;
      lbSelect.appendChild(opt);
    });
  }

  // Answers
  const ansSelect = document.getElementById('cfg-answer-sel');
  if (ansSelect) {
    ansSelect.innerHTML = '<option value="">Select an answer...</option>';
    discoveredObjects.answers.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      ansSelect.appendChild(opt);
    });
  }
}

/**
 * Enable or disable the discovery dropdowns
 */
function _enableDiscoverySelects(enabled) {
  ['cfg-worksheet-sel', 'cfg-liveboard-sel', 'cfg-viz-sel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
  const answerField = document.getElementById('cfg-answer-field');
  if (answerField) answerField.style.display = enabled ? 'block' : 'none';
}

// ── DOMContentLoaded bootstrap ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Snapshot the original config so Reset All can restore it
  window._TS_CONFIG_DEFAULT = { ...window.TS_CONFIG };

  // Init SDK immediately — matches the working pattern (AuthType.None relies on
  // the user already being logged into ThoughtSpot in the same browser).
  initSDK(window.TS_CONFIG);
  sdkInitialized = true;

  if (window.location.protocol === 'file:') {
    const banner = document.getElementById('file-protocol-banner');
    if (banner) {
      banner.style.display = 'block';
      const app = document.getElementById('app');
      if (app) app.style.paddingTop = '44px';
    }
  }

  // Restore the last viewed section from localStorage
  const savedSection = localStorage.getItem('currentSection');
  if (savedSection && SECTION_META[savedSection]) {
    console.log(`[Memory] Restoring section: ${savedSection}`);
    switchSection(savedSection);
  }

  // Dev-only features: visible on localhost, hidden in production.
  // Override by setting `devFeatures: true` in config.js.
  const isDevEnv = window.TS_CONFIG.devFeatures !== undefined
    ? window.TS_CONFIG.devFeatures
    : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  if (!isDevEnv) {
    document.querySelectorAll('[data-dev-only]').forEach(el => el.style.display = 'none');
  }
});

// ── Loading state machine ─────────────────────────────────────────────────
function setEmbedState(state) {
  const wrap = document.getElementById('embed-loading');
  wrap.style.display = state === 'hidden' ? 'none' : 'flex';
  wrap.classList.remove('fade-out');
  document.querySelectorAll('.ls').forEach(el => el.classList.remove('active'));
  if (state !== 'hidden') {
    const el = wrap.querySelector(`.ls-${state}`);
    if (el) el.classList.add('active');
  }
}

function hideEmbedOverlay() {
  const wrap = document.getElementById('embed-loading');
  wrap.classList.add('fade-out');
  setTimeout(() => { wrap.style.display = 'none'; }, 300);
}

// ── Render embed ──────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _validateConfig(section, c) {
  const needsWorksheet = section === 'search' || section === 'spotter' || section === 'nlsearch';
  const needsLiveboard = section === 'liveboard' || section === 'viz';
  if (needsWorksheet && !UUID_RE.test(c.worksheetId || '')) {
    return 'worksheetId in config.js is missing or invalid. Open ⚙ Settings and paste a valid Worksheet / Connection GUID from your ThoughtSpot instance.';
  }
  if (needsLiveboard && !UUID_RE.test(c.liveboardId || '')) {
    return 'liveboardId in config.js is missing or invalid. Open ⚙ Settings and paste a valid Liveboard GUID.';
  }
  if (section === 'viz' && !UUID_RE.test(c.vizId || '')) {
    return 'vizId in config.js is missing or invalid. Open ⚙ Settings and paste a valid Visualization GUID.';
  }
  return null;
}

function renderEmbedNow(section) {
  if (!section) {
    alert('Select a section first (Search Data, Liveboard, etc.) before applying this feature.');
    return;
  }

  // Always keep currentSection in sync — this is the root fix for the "null section" crash
  currentSection = section;

  const c = window.TS_CONFIG;

  // Pre-flight: catch bad GUIDs before SDK makes the call
  const configErr = _validateConfig(section, c);
  if (configErr) {
    logEvent('ConfigError', '✗ ' + configErr);
    document.getElementById('error-detail').textContent = configErr;
    setEmbedState('error');
    return;
  }

  if (currentEmbed) {
    try { currentEmbed.destroy(); } catch (_) {}
    currentEmbed = null;
  }

  // Refresh code view before we render
  refreshCodeView();

  // Show the "loading embed" state
  document.getElementById('loading-section-name').textContent =
    SECTION_META[section]?.title ?? section;
  setEmbedState('loading');

  // Fallback: if no SDK event fires within 10 s, reveal the embed anyway
  const fallback = setTimeout(() => {
    hideEmbedOverlay();
    logEvent('Info', 'Embed handed off to ThoughtSpot — check you are logged in at the host URL');
  }, 4000);

  const embed = _doRender(section, c, {
    onDone() {
      clearTimeout(fallback);
      hideEmbedOverlay();
    },
    onError(msg) {
      clearTimeout(fallback);
      if (msg === '__NO_COOKIE__') {
        // Re-show the CORS/cookie state
        setEmbedState('cors');
      } else {
        document.getElementById('error-detail').textContent = msg;
        setEmbedState('error');
      }
    },
    onEvent(type, data) {
      logEvent(type, data);
    },
  }, { ...embedOptions, flags: sectionOpts[section] || {} });

  currentEmbed = embed;
}

// ── Render with auth pre-check ────────────────────────────────────────────
async function renderEmbed(section) {
  const c = window.TS_CONFIG;
  pendingSection = section;

  // Show "checking" state
  document.getElementById('checking-host').textContent = c.thoughtSpotHost;
  setEmbedState('checking');
  logEvent('AuthCheck', `Verifying session at ${c.thoughtSpotHost}`);

  const result = await checkAuth(c.thoughtSpotHost);

  if (result === 'ok') {
    logEvent('AuthCheck', 'Session valid — rendering embed');
    if (!sdkInitialized) { initSDK(c); sdkInitialized = true; }
    renderEmbedNow(section);

  } else if (result === 'unauthenticated') {
    logEvent('AuthCheck', '✗ Not authenticated — login required');
    document.getElementById('ts-login-link').href = c.thoughtSpotHost;
    document.getElementById('unauth-host').textContent = c.thoughtSpotHost;
    setEmbedState('unauth');

  } else if (result === 'cors') {
    // Can't verify (CORS or local file) — warn and let user decide
    logEvent('AuthCheck', '⚠ Cannot verify session (CORS / local file) — check if you are logged in');
    document.getElementById('cors-login-link').href = c.thoughtSpotHost;
    setEmbedState('cors');

  } else {
    // Hard error (unexpected HTTP status, parse error, etc.)
    const msg = result?.msg ?? 'Unknown error during auth check';
    logEvent('AuthCheck', `✗ ${msg}`);
    document.getElementById('error-detail').textContent = msg;
    setEmbedState('error');
  }
}

// ── Event log ────────────────────────────────────────────────────────────
function logEvent(type, data) {
  eventCount++;
  const countEl = document.getElementById('log-count');
  countEl.textContent = `${eventCount} event${eventCount !== 1 ? 's' : ''}`;
  countEl.classList.add('active');

  const empty = document.getElementById('log-empty');
  if (empty) empty.remove();

  const time = new Date().toTimeString().slice(0, 8);
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="le-time">${time}</span>
    <span class="le-type">${type}</span>
    <span class="le-data">${data}</span>
  `;
  const inner = document.querySelector('#log-body .log-inner');
  inner.insertBefore(entry, inner.firstChild);
}

// ── Global functions ──────────────────────────────────────────────────────

window.enterAnalyticsMode = function () {
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  if (!currentSection) switchSection('search');
};

window.exitAnalyticsMode = function () {
  localStorage.removeItem('currentSection');  // Clear saved section when exiting
  closeFeaturePanel();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('landing').classList.remove('hidden');
};

window.switchSection = function switchSection(section) {
  if (currentSection === section) return;
  currentSection = section;
  localStorage.setItem('currentSection', section);  // Save for page persistence
  if (currentEoSection) closeEmbedOpts();

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.section === section);
  });

  const meta = SECTION_META[section];
  document.getElementById('section-title').textContent = meta.title;
  document.getElementById('section-badge').textContent = meta.badge;

  // Show/hide custom filter bar
  const filterBar = document.getElementById('custom-filter-bar');
  if (filterBar) {
    if (section === 'liveboard-custom') {
      console.log('[Filter] Showing filter bar and building it');
      filterBar.style.display = 'flex';
      buildFilterBar();   // async, non-blocking
    } else {
      filterBar.style.display = 'none';
    }
  }

  renderEmbedNow(section);
};

window.toggleConfig = function () {
  const panel   = document.getElementById('config-panel');
  const overlay = document.getElementById('overlay');
  const isOpen  = panel.classList.contains('open');

  if (!isOpen) {
    const c = window.TS_CONFIG;
    document.getElementById('cfg-host').value           = c.thoughtSpotHost;
    document.getElementById('cfg-search-token').value   = c.searchTokenString || '';
    document.getElementById('cfg-execute-search').value = String(c.executeSearch ?? false);

    // Restore token from sessionStorage if available
    const sessionToken = sessionStorage.getItem('ts_bearer_token');
    if (sessionToken && !bearerToken) {
      bearerToken = sessionToken;
      document.getElementById('cfg-token-persist').checked = true;
    }

    if (discoveredObjects.liveboards.length > 0) {
      // Already connected — re-populate and enable dropdowns
      populateDiscoveryDropdowns();
      _enableDiscoverySelects(true);
      _syncSelectsToConfig(c);
    } else if (c.thoughtSpotHost) {
      // Auto-connect on open if host is configured
      connectAndDiscover();
    }
  }

  panel.classList.toggle('open');
  overlay.classList.toggle('visible');
};

/**
 * Sync the select dropdowns to show the values currently in TS_CONFIG
 */
function _syncSelectsToConfig(c) {
  const wsEl = document.getElementById('cfg-worksheet-sel');
  if (wsEl && c.worksheetId) wsEl.value = c.worksheetId;
  const lbEl = document.getElementById('cfg-liveboard-sel');
  if (lbEl && c.liveboardId) lbEl.value = c.liveboardId;
  const vzEl = document.getElementById('cfg-viz-sel');
  if (vzEl && c.vizId) vzEl.value = c.vizId;
}

window.applyConfig = function () {
  const c = window.TS_CONFIG;
  c.thoughtSpotHost   = document.getElementById('cfg-host').value.trim();
  c.authType          = 'None';
  c.worksheetId       = document.getElementById('cfg-worksheet').value.trim();
  c.liveboardId       = document.getElementById('cfg-liveboard').value.trim();
  c.vizId             = document.getElementById('cfg-viz').value.trim();
  c.searchTokenString = document.getElementById('cfg-search-token').value.trim();
  c.executeSearch     = document.getElementById('cfg-execute-search').value === 'true';

  sdkInitialized = false;
  const section = currentSection;
  window.toggleConfig();
  // Force re-render by calling renderEmbedNow directly (bypasses switchSection's no-op guard)
  if (section) renderEmbedNow(section);
  logEvent('Config', 'Settings applied — reloading embed');
};

window.connectAndDiscover = async function() {
  const host = document.getElementById('cfg-host').value.trim();
  if (!host) { alert('Please enter a Host URL'); return; }

  const statusEl = document.getElementById('discover-status');
  statusEl.style.display = 'block';
  statusEl.textContent = '🔄 Connecting…';

  // Use bearer token from advanced section if provided
  const tokenInput = document.getElementById('cfg-token');
  bearerToken = tokenInput?.value.trim() || '';

  const orgResult = await discoverOrg(host);
  if (!orgResult.ok) {
    bearerToken = '';
    statusEl.innerHTML = `❌ ${orgResult.error} — try entering a token in <a href="#" onclick="document.getElementById('cfg-advanced').open=true;return false;">Advanced</a>`;
    logEvent('Discovery', `Failed: ${orgResult.error}`);
    return;
  }

  discoveredOrg = { userName: orgResult.userName, orgName: orgResult.orgName };

  // Persist token to sessionStorage if user checked the checkbox
  if (bearerToken) {
    const persistCheckbox = document.getElementById('cfg-token-persist');
    if (persistCheckbox?.checked) {
      try { sessionStorage.setItem('ts_bearer_token', bearerToken); } catch (e) {}
    }
  }

  const objResult = await discoverObjects(host);
  if (!objResult.ok) {
    statusEl.innerHTML = `⚠️ Connected but could not fetch objects: ${objResult.error}`;
    logEvent('Discovery', `Org verified, object discovery failed: ${objResult.error}`);
    return;
  }

  populateDiscoveryDropdowns();
  _enableDiscoverySelects(true);
  _syncSelectsToConfig(window.TS_CONFIG);
  statusEl.innerHTML = `✓ Connected as ${orgResult.userName}<br>Org: ${orgResult.orgName}`;
  logEvent('Discovery', `Connected to ${orgResult.orgName}`);
};

window.onWorksheetSelect = function(worksheetId) {
  if (!worksheetId) return;
  document.getElementById('cfg-worksheet').value = worksheetId;
  window.TS_CONFIG.worksheetId = worksheetId;
};

window.onLiveboardSelect = async function(liveboardId) {
  if (!liveboardId) return;
  document.getElementById('cfg-liveboard').value = liveboardId;
  window.TS_CONFIG.liveboardId = liveboardId;

  // Discover viz tabs for this liveboard
  const host = document.getElementById('cfg-host').value.trim();
  if (host) {
    const vizSelect = document.getElementById('cfg-viz-sel');
    vizSelect.innerHTML = '<option value="">— loading… —</option>';
    const vizResult = await discoverViz(host, liveboardId);
    if (vizResult.ok) {
      vizSelect.innerHTML = '<option value="">Select a visualization...</option>';
      vizResult.visualizations.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        vizSelect.appendChild(opt);
      });
    } else {
      vizSelect.innerHTML = '<option value="">— no visualizations found —</option>';
    }
  }
};

window.onVizSelect = function(vizId) {
  if (!vizId) return;
  document.getElementById('cfg-viz').value = vizId;
  window.TS_CONFIG.vizId = vizId;
};

window.onAnswerSelect = function(answerId) {
  if (!answerId) return;
  document.getElementById('cfg-worksheet').value = answerId;
  document.getElementById('cfg-viz').value = answerId;
  window.TS_CONFIG.worksheetId = answerId;
  window.TS_CONFIG.vizId = answerId;
};

window.toggleBottomPanel = function() {
  bottomExpanded = !bottomExpanded;
  document.getElementById('bp-body').classList.toggle('open', bottomExpanded);
  document.getElementById('bp-chevron').classList.toggle('open', bottomExpanded);
  if (bottomExpanded && bottomTab === 'code') refreshCodeView();
};

window.toggleLog = window.toggleBottomPanel; // backward compat alias

window.switchBottomTab = function(tab) {
  bottomTab = tab;
  document.getElementById('bp-pane-log').classList.toggle('active', tab === 'log');
  document.getElementById('bp-pane-code').classList.toggle('active', tab === 'code');
  document.getElementById('bp-tab-log').classList.toggle('active', tab === 'log');
  document.getElementById('bp-tab-code').classList.toggle('active', tab === 'code');
  document.getElementById('cv-copy-btn').style.visibility = tab === 'code' ? '' : 'hidden';
  if (tab === 'code') refreshCodeView();
  if (!bottomExpanded) window.toggleBottomPanel();
};

window.retryAuth = async function () {
  if (pendingSection) await renderEmbed(pendingSection);
};

window.forceRender = function () {
  if (pendingSection) {
    logEvent('AuthCheck', 'Proceeding without session verification');
    if (!sdkInitialized) { initSDK(window.TS_CONFIG); sdkInitialized = true; }
    renderEmbedNow(pendingSection);
  }
};

window.handleOverlayClick = function() {
  if (document.getElementById('config-panel').classList.contains('open')) {
    toggleConfig();
  } else {
    closeFeaturePanel();
  }
};

// ── Advanced sidebar group ────────────────────────────────────────────
window.toggleAdvanced = function() {
  advancedExpanded = !advancedExpanded;
  document.getElementById('adv-group').classList.toggle('expanded', advancedExpanded);
  document.getElementById('adv-chevron').classList.toggle('open', advancedExpanded);
};

// ── Feature panel open/close ──────────────────────────────────────────
window.openFeaturePanel = function(feature) {
  if (currentFeaturePanel === feature && document.getElementById('feature-panel').classList.contains('open')) return;
  currentFeaturePanel = feature;
  // close config if open
  if (document.getElementById('config-panel').classList.contains('open')) {
    document.getElementById('config-panel').classList.remove('open');
  }
  // highlight sidebar item
  document.querySelectorAll('.adv-item').forEach(el =>
    el.classList.toggle('active', el.dataset.feature === feature)
  );
  // set panel title
  const titles = {
    'filters':       'Runtime Filters',
    'params':        'Runtime Parameters',
    'actions':       'Modify Actions',
    'custom-action': 'Custom Actions',
    'code-action':   'Code-Based Actions',
    'host-events':   'Host Events',
    'styles':        'Custom Styles',
  };
  document.getElementById('fp-title').textContent = titles[feature] || feature;
  // show correct content
  document.querySelectorAll('.fp-content').forEach(el =>
    el.classList.toggle('active', el.id === 'fp-' + feature)
  );
  document.getElementById('feature-panel').classList.add('open');
  document.getElementById('main').classList.add('fp-open');
  // seed code-action preview on open
  if (feature === 'code-action') updateCodePreview();
};

window.closeFeaturePanel = function() {
  currentFeaturePanel = null;
  document.querySelectorAll('.adv-item').forEach(el => el.classList.remove('active'));
  document.getElementById('feature-panel').classList.remove('open');
  document.getElementById('main').classList.remove('fp-open');
};

// ── Runtime Filters ───────────────────────────────────────────────────
let filterRowCount = 0;

window.addFilterRow = function() {
  filterRowCount++;
  const id = filterRowCount;
  const row = document.createElement('div');
  row.className = 'filter-row';
  row.id = 'fr-' + id;
  row.innerHTML = `
    <input class="fr-col cp-input" placeholder="Column (e.g. Region)" style="flex:1.2">
    <select class="fr-op cp-select" style="flex:0.8">
      <option value="EQ">= Equals</option>
      <option value="NE">≠ Not Equals</option>
      <option value="LT">&lt; Less Than</option>
      <option value="LE">≤ Less or Equal</option>
      <option value="GT">&gt; Greater Than</option>
      <option value="GE">≥ Greater or Equal</option>
      <option value="CONTAINS">Contains</option>
      <option value="BEGINS_WITH">Begins With</option>
      <option value="ENDS_WITH">Ends With</option>
      <option value="IN">In (comma-sep)</option>
    </select>
    <input class="fr-val cp-input" placeholder="Value(s)" style="flex:1">
    <button class="fr-remove" onclick="removeFilterRow('fr-${id}')">✕</button>
  `;
  document.getElementById('filter-rows').appendChild(row);
};

window.removeFilterRow = function(id) {
  document.getElementById(id)?.remove();
};

window.applyRuntimeFilters = function() {
  if (!currentEmbed) {
    alert('No embed active. Switch to a Liveboard or Full App first.');
    return;
  }
  const rows = document.querySelectorAll('#filter-rows .filter-row');
  const filters = [];
  rows.forEach(row => {
    const col = row.querySelector('.fr-col').value.trim();
    const op  = row.querySelector('.fr-op').value;
    const val = row.querySelector('.fr-val').value.trim();
    if (col && val) {
      const values = op === 'IN' ? val.split(',').map(v => v.trim()) : [val];
      filters.push({ columnName: col, operator: RuntimeFilterOp[op], _opKey: op, values });
    }
  });
  if (filters.length === 0) { alert('Add at least one filter with column and value.'); return; }
  embedOptions._activeFilters = filters;
  currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, filters);
  refreshCodeView();
  logEvent('HostEvent', `UpdateRuntimeFilters: ${filters.length} filter(s) applied`);
};

window.clearRuntimeFilters = function() {
  if (!currentEmbed) return;
  embedOptions._activeFilters = [];
  currentEmbed.trigger(HostEvent.UpdateRuntimeFilters, []);
  document.getElementById('filter-rows').innerHTML = '';
  filterRowCount = 0;
  refreshCodeView();
  logEvent('HostEvent', 'UpdateRuntimeFilters: cleared');
};

// ── Custom Filter Bar (for liveboard-custom view) ──────────────────────
window.toggleLiveboardGroup = function() {
  const group = document.getElementById('lb-group');
  const chevron = document.getElementById('lb-chevron');
  group.classList.toggle('collapsed');
  chevron.classList.toggle('open');
};

async function fetchFilterOptions(column) {
  const url = `${window.TS_CONFIG.thoughtSpotHost}/api/rest/2.0/metadata/liveboard/data`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...getBearerHeaders(),
      },
      body: JSON.stringify({
        metadata_identifier: window.TS_CONFIG.liveboardId,
        record_size: 1000,
        record_offset: 0,
      }),
    });
    if (!res.ok) {
      console.warn(`[Filter] API failed: ${res.status} ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    console.log(`[Filter] API response for ${column}:`, data);
    const rows = data?.contents?.[0]?.data_rows ?? [];
    const cols = data?.contents?.[0]?.column_names ?? [];
    console.log(`[Filter] Available columns:`, cols);
    const idx = cols.indexOf(column);
    if (idx === -1) {
      console.warn(`[Filter] Column "${column}" not found in liveboard`);
      return [];
    }
    const values = [...new Set(rows.map(r => r[idx]).filter(v => v != null))].sort();
    console.log(`[Filter] Distinct values for ${column}:`, values);
    return values;
  } catch (err) {
    console.error(`[Filter] Error fetching ${column}:`, err);
    return [];
  }
}

async function buildFilterBar() {
  const container = document.getElementById('filter-dropdowns');
  if (!container) {
    console.warn('[Filter] filter-dropdowns container not found');
    return;
  }

  // Seed activeFilterColumns from config on first call
  if (activeFilterColumns.length === 0) {
    activeFilterColumns = [...(window.TS_CONFIG.filterColumns ?? [])];
  }

  console.log('[Filter] Building filter bar for columns:', activeFilterColumns);
  container.innerHTML = '';
  customFilters = {};

  for (const col of activeFilterColumns) {
    const colName = typeof col === 'string' ? col : col.name;
    console.log(`[Filter] Fetching values for: ${colName}`);

    // Fetch directly from ThoughtSpot (frontend has auth cookies)
    const values = await fetchFilterValuesFromThoughtSpot(colName);

    const wrapper = document.createElement('div');
    wrapper.className = 'filter-dropdown-wrapper';
    wrapper.dataset.column = colName;

    // Inner div: label + select (stacked vertically)
    const inner = document.createElement('div');
    inner.className = 'fdd-inner';

    const label = document.createElement('label');
    label.textContent = colName;
    const select = document.createElement('select');
    select.innerHTML = `<option value="">All</option>` +
      values.map(v => `<option value="${v}">${v}</option>`).join('');
    select.addEventListener('change', () => onFilterChange(colName, select.value));
    inner.append(label, select);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'filter-remove-btn';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${colName} filter`;
    removeBtn.addEventListener('click', () => removeDynamicFilter(colName));

    wrapper.append(inner, removeBtn);
    container.appendChild(wrapper);
    console.log(`[Filter] Added dropdown for ${colName} with ${values.length} values`);
  }
}

async function fetchFilterValuesFromThoughtSpot(column) {
  try {
    console.log(`[Filter] Fetching directly from ThoughtSpot: column=${column}`);

    // Frontend calls ThoughtSpot directly (has auth cookies or bearer token)
    const url = `${window.TS_CONFIG.thoughtSpotHost}/api/rest/2.0/metadata/liveboard/data`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...getBearerHeaders(),
      },
      body: JSON.stringify({
        metadata_identifier: window.TS_CONFIG.liveboardId,
        record_size: 10000,
        record_offset: 0,
      }),
    });

    if (!res.ok) {
      console.warn(`[Filter] ThoughtSpot API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const contents = data?.contents ?? [];

    // Cache columns: start with the main visualization (contents[0]),
    // then add columns from other visualizations that are likely filters
    if (availableColumns.length === 0) {
      const allCols = new Set();

      // Always include all columns from the primary visualization (most likely to have filters)
      const primaryViz = contents[0]?.column_names ?? [];
      primaryViz.forEach(c => allCols.add(c));

      // Also check other visualizations for additional columns
      // (these might be filter-only columns or secondary visualizations)
      for (let i = 1; i < contents.length; i++) {
        (contents[i]?.column_names ?? []).forEach(c => allCols.add(c));
      }

      availableColumns = Array.from(allCols).sort();
      console.log(`[Filter] Cached ${availableColumns.length} unique columns from ${contents.length} visualizations`);
    }

    // Find which visualization contains the requested column
    const content = contents.find(c => (c.column_names ?? []).includes(column));
    if (!content) {
      console.warn(`[Filter] Column "${column}" not found in any visualization. Available: ${availableColumns.join(', ')}`);
      return [];
    }

    const rows = content.data_rows ?? [];
    const cols = content.column_names ?? [];
    const idx = cols.indexOf(column);

    const values = [...new Set(rows.map(r => {
      const val = r[idx];
      return val === null || val === undefined ? '{Null}' : String(val);
    }))].sort((a, b) => {
      if (a === '{Null}') return -1;
      if (b === '{Null}') return 1;
      return a.localeCompare(b);
    });

    console.log(`[Filter] ✓ Got ${values.length} distinct values: ${values.slice(0, 5).join(', ')}...`);
    return values;
  } catch (err) {
    console.error(`[Filter] ✗ Failed to fetch from ThoughtSpot:`, err.message);
    return [];
  }
}

function onFilterChange(column, value) {
  if (value) customFilters[column] = value;
  else delete customFilters[column];
  const filters = Object.entries(customFilters).map(([col, val]) => ({
    column: col, oper: 'IN', values: [val],
  }));
  if (!currentEmbed) return;
  currentEmbed.trigger(HostEvent.UpdateFilters, { filters });
  logEvent('CustomFilter', `${column}: ${value || 'All'}`);
  refreshCodeView();  // Update SDK Preview to show current filters
}

window.clearCustomFilters = function() {
  customFilters = {};
  activeFilterColumns = [...(window.TS_CONFIG.filterColumns ?? [])];
  buildFilterBar();
  if (currentEmbed) currentEmbed.trigger(HostEvent.UpdateFilters, { filters: [] });
  logEvent('CustomFilter', 'All filters cleared');
};

// ── Dynamic Filter Management ─────────────────────────────────────────────

window.toggleAddFilterPicker = function() {
  const picker = document.getElementById('add-filter-picker');
  const isOpen = picker.style.display !== 'none';
  if (isOpen) { picker.style.display = 'none'; return; }
  populateAddFilterPicker();
  picker.style.display = 'block';
  // close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!picker.contains(e.target) && e.target.id !== 'add-filter-btn') {
        picker.style.display = 'none';
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
};

function populateAddFilterPicker() {
  const picker = document.getElementById('add-filter-picker');
  if (availableColumns.length === 0) {
    picker.innerHTML = '<div class="afp-item afp-loading">Loading…</div>';
    return;
  }
  const unused = availableColumns.filter(c => !activeFilterColumns.includes(c));
  if (unused.length === 0) {
    picker.innerHTML = '<div class="afp-item afp-empty">All columns in use</div>';
    return;
  }
  picker.innerHTML = unused
    .map(c => `<div class="afp-item" onclick="addDynamicFilter('${c}')">${c}</div>`)
    .join('');
}

window.addDynamicFilter = async function(column) {
  document.getElementById('add-filter-picker').style.display = 'none';
  if (activeFilterColumns.includes(column)) return;
  activeFilterColumns.push(column);

  const values = await fetchFilterValuesFromThoughtSpot(column);
  const container = document.getElementById('filter-dropdowns');

  const wrapper = document.createElement('div');
  wrapper.className = 'filter-dropdown-wrapper';
  wrapper.dataset.column = column;

  // Inner div: label + select (stacked vertically)
  const inner = document.createElement('div');
  inner.className = 'fdd-inner';

  const label = document.createElement('label');
  label.textContent = column;
  const select = document.createElement('select');
  select.innerHTML = `<option value="">All</option>` +
    values.map(v => `<option value="${v}">${v}</option>`).join('');
  select.addEventListener('change', () => onFilterChange(column, select.value));
  inner.append(label, select);

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'filter-remove-btn';
  removeBtn.textContent = '×';
  removeBtn.title = `Remove ${column} filter`;
  removeBtn.addEventListener('click', () => removeDynamicFilter(column));

  wrapper.append(inner, removeBtn);
  container.appendChild(wrapper);
  console.log(`[Filter] Added dynamic filter for ${column}`);
};

function removeDynamicFilter(column) {
  activeFilterColumns = activeFilterColumns.filter(c => c !== column);
  delete customFilters[column];
  const wrapper = document.querySelector(`#filter-dropdowns [data-column="${column}"]`);
  if (wrapper) wrapper.remove();
  const filters = Object.entries(customFilters).map(([col, val]) => ({
    column: col, oper: 'IN', values: [val],
  }));
  if (currentEmbed) currentEmbed.trigger(HostEvent.UpdateFilters, { filters });
  console.log(`[Filter] Removed dynamic filter for ${column}`);
  refreshCodeView();  // Update SDK Preview to reflect removed filter
}

// ── Runtime Parameters ────────────────────────────────────────────────
let paramRowCount = 0;

window.addParamRow = function() {
  paramRowCount++;
  const id = paramRowCount;
  const row = document.createElement('div');
  row.className = 'filter-row';
  row.id = 'pr-' + id;
  row.innerHTML = `
    <input class="pr-name cp-input" placeholder="Parameter name" style="flex:1.2">
    <input class="pr-val cp-input" placeholder="Value" style="flex:1">
    <button class="fr-remove" onclick="removeParamRow('pr-${id}')">✕</button>
  `;
  document.getElementById('param-rows').appendChild(row);
};

window.removeParamRow = function(id) {
  document.getElementById(id)?.remove();
};

window.applyRuntimeParams = function() {
  if (!currentSection) { alert('Select a section first.'); return; }
  const rows = document.querySelectorAll('#param-rows .filter-row');
  const params = [];
  rows.forEach(row => {
    const name = row.querySelector('.pr-name').value.trim();
    const val  = row.querySelector('.pr-val').value.trim();
    if (name && val) params.push({ name, value: val });
  });
  if (params.length === 0) { alert('Add at least one parameter with a name and value.'); return; }
  embedOptions.runtimeParameters = params;
  renderEmbedNow(currentSection);
  logEvent('RuntimeParams', `Applied ${params.length} parameter(s) — embed re-rendered`);
};

window.clearRuntimeParams = function() {
  if (!currentSection) return;
  embedOptions.runtimeParameters = [];
  document.getElementById('param-rows').innerHTML = '';
  paramRowCount = 0;
  renderEmbedNow(currentSection);
  logEvent('RuntimeParams', 'Parameters cleared — embed re-rendered');
};

// ── Modify Actions ────────────────────────────────────────────────────
window.applyActionMods = function() {
  if (!currentSection) { alert('Select a section first.'); return; }
  const hiddenKeys   = [...document.querySelectorAll('.act-hide:checked')].map(cb => cb.dataset.action);
  const disabledKeys = [...document.querySelectorAll('.act-disable:checked')].map(cb => cb.dataset.action);
  embedOptions.hiddenActions   = hiddenKeys.map(k => Action[k]).filter(Boolean);
  embedOptions.disabledActions = disabledKeys.map(k => Action[k]).filter(Boolean);
  embedOptions._hiddenKeys     = hiddenKeys;
  embedOptions._disabledKeys   = disabledKeys;
  renderEmbedNow(currentSection);
  logEvent('ActionMod', `Hidden: [${hiddenKeys.join(', ')}]  Disabled: [${disabledKeys.join(', ')}]`);
  closeFeaturePanel();
};

window.resetActionMods = function() {
  if (!currentSection) return;
  document.querySelectorAll('.act-hide, .act-disable').forEach(cb => cb.checked = false);
  embedOptions.hiddenActions   = [];
  embedOptions.disabledActions = [];
  embedOptions._hiddenKeys     = [];
  embedOptions._disabledKeys   = [];
  renderEmbedNow(currentSection);
  logEvent('ActionMod', 'Actions reset to defaults');
};

// ── Custom Actions (user-driven) ──────────────────────────────────────
window.__onCustomAction = null;

window.addCustomAction = function() {
  if (!currentSection) { alert('Select a section first.'); return; }
  const label = document.getElementById('ca-label').value.trim();
  if (!label) { alert('Enter an action label first.'); return; }
  const posKey  = document.getElementById('ca-position').value;
  const id      = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  if (embedOptions.customActions.find(a => a.id === id)) {
    alert(`Action "${label}" is already registered.`); return;
  }
  embedOptions.customActions.push({ id, label, position: CustomActionsPosition[posKey] ?? posKey, _pos: posKey });
  _refreshCustomActionChips();
  window.__onCustomAction = _onCustomActionPayload;
  document.getElementById('ca-label').value = '';

  renderEmbedNow(currentSection);
  logEvent('CustomAction', `Registered "${label}" at ${posKey} — right-click a chart or use ⋮ menu`);
};

window.removeCustomAction = function(idx) {
  if (!currentSection) return;
  embedOptions.customActions.splice(idx, 1);
  _refreshCustomActionChips();
  if (embedOptions.customActions.length === 0) window.__onCustomAction = null;
  renderEmbedNow(currentSection);
  logEvent('CustomAction', 'Action removed');
};

window.clearCustomActions = function() {
  if (!currentSection) return;
  embedOptions.customActions = [];
  window.__onCustomAction = null;
  _refreshCustomActionChips();
  document.getElementById('ca-payload-wrap').style.display = 'none';
  document.getElementById('ca-payload-lbl').style.display = 'none';
  renderEmbedNow(currentSection);
  logEvent('CustomAction', 'All custom actions cleared');
};

function _refreshCustomActionChips() {
  const container = document.getElementById('ca-action-chips');
  const lbl       = document.getElementById('ca-registered-lbl');
  container.innerHTML = '';
  const hasActions = embedOptions.customActions.length > 0;
  lbl.style.display = hasActions ? '' : 'none';
  embedOptions.customActions.forEach((action, idx) => {
    const chip = document.createElement('div');
    chip.className = 'ca-chip';
    chip.innerHTML = `<span class="ca-chip-label">${action.label}</span><button class="ca-chip-remove" onclick="removeCustomAction(${idx})">✕</button>`;
    container.appendChild(chip);
  });
}

function _onCustomActionPayload(payload) {
  const display = document.getElementById('ca-payload');
  const wrap    = document.getElementById('ca-payload-wrap');
  const lbl     = document.getElementById('ca-payload-lbl');
  if (display) {
    display.textContent = JSON.stringify(payload?.data ?? payload, null, 2);
    wrap.style.display = '';
    lbl.style.display  = '';
  }
}

// ── Code-Based Actions ────────────────────────────────────────────────
window.applyCodeAction = function() {
  if (!currentSection) { alert('Select a section first.'); return; }
  const label  = document.getElementById('cca-label').value.trim() || 'Export Data';
  const posKey = document.getElementById('cca-position').value;
  const id     = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  embedOptions.customActions = [{ id, label, position: CustomActionsPosition[posKey] ?? posKey, _pos: posKey }];

  window.__onCustomAction = (payload) => {
    const display = document.getElementById('cca-payload');
    const wrap    = document.getElementById('cca-payload-wrap');
    if (display) {
      display.textContent = JSON.stringify(payload?.data ?? payload, null, 2);
      wrap.style.display = '';
    }
  };

  renderEmbedNow(currentSection);
  logEvent('CustomAction', `Code action "${label}" applied — click it in the embed to see the payload`);
};

window.clearCodeAction = function() {
  if (!currentSection) return;
  embedOptions.customActions = [];
  window.__onCustomAction = null;
  const wrap = document.getElementById('cca-payload-wrap');
  if (wrap) wrap.style.display = 'none';
  renderEmbedNow(currentSection);
  logEvent('CustomAction', 'Code-based action removed');
};

window.updateCodePreview = function() {
  const label    = document.getElementById('cca-label')?.value.trim() || 'Export Data';
  const position = document.getElementById('cca-position')?.value || 'START';
  const id       = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const pre      = document.getElementById('cca-preview');
  if (pre) {
    pre.textContent =
`new LiveboardEmbed('#container', {
  customActions: [{
    id: '${id}',
    label: '${label}',
    position: CustomActionsPosition.${position}
  }]
})`;
  }
};

// ── Host Events ───────────────────────────────────────────────────────
function _requireEmbed(label) {
  if (!currentEmbed) {
    alert(`No embed is active. Switch to a section first, then trigger ${label}.`);
    return false;
  }
  return true;
}

window.triggerHeSearch = function() {
  if (!_requireEmbed('Search')) return;
  const q = document.getElementById('he-search').value.trim();
  if (!q) { alert('Enter a search query first.'); return; }
  currentEmbed.trigger(HostEvent.Search, { searchQuery: q });
  logEvent('HostEvent', `Search: "${q}"`);
};

window.triggerHeNavigate = function() {
  if (!_requireEmbed('Navigate')) return;
  const path = document.getElementById('he-navigate').value.trim();
  if (!path) { alert('Enter a navigation path first.'); return; }
  currentEmbed.trigger(HostEvent.Navigate, path);
  logEvent('HostEvent', `Navigate: "${path}"`);
};

window.triggerHeReload = function() {
  if (!_requireEmbed('Reload')) return;
  currentEmbed.trigger(HostEvent.Reload);
  logEvent('HostEvent', 'Reload triggered');
};

window.triggerHeSetVizs = function() {
  if (!_requireEmbed('SetVisibleVizs')) return;
  const raw = document.getElementById('he-vizids').value.trim();
  if (!raw) { alert('Enter one or more viz GUIDs first.'); return; }
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  currentEmbed.trigger(HostEvent.SetVisibleVizs, ids);
  logEvent('HostEvent', `SetVisibleVizs: [${ids.join(', ')}]`);
};

// ── Custom Styles ─────────────────────────────────────────────────────

/** Parse "display: none !important; color: red" → { display: "none !important", color: "red" } */
function _parseCssDeclarations(cssStr) {
  const result = {};
  cssStr.split(';').forEach(part => {
    const colon = part.indexOf(':');
    if (colon === -1) return;
    const prop = part.slice(0, colon).trim();
    const val  = part.slice(colon + 1).trim();
    if (prop && val) result[prop] = val;
  });
  return result;
}

/** Parse JS-style rules_UNSTABLE text → object (or null on error) */
function _parseCodeBlock(text) {
  if (!text.trim()) return {};
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return Object.freeze({${text.trim().replace(/,\s*$/, '')}});`)();
  } catch (_) { return null; }
}

/** Collect rules from code block (lower priority) merged with rows (higher priority) */
function _collectCssRules() {
  const rules = {};
  const cbText = (document.getElementById('cs-code-block')?.value || '').trim();
  if (cbText) {
    const parsed = _parseCodeBlock(cbText);
    if (parsed) Object.assign(rules, parsed);
  }
  document.querySelectorAll('.css-rule-row').forEach(row => {
    const sel    = row.querySelector('.csr-selector').value.trim();
    const cssStr = row.querySelector('.csr-declarations').value.trim();
    if (sel && cssStr) rules[sel] = _parseCssDeclarations(cssStr);
  });
  return rules;
}


/** Import code block → rows (Sync button) */
window.syncCodeBlockToRows = function() {
  const text = (document.getElementById('cs-code-block')?.value || '').trim();
  if (!text) return;
  const parsed = _parseCodeBlock(text);
  if (parsed === null) { alert('Could not parse code block — check syntax.'); return; }
  const container = document.getElementById('css-rule-rows');
  container.innerHTML = '';
  for (const [sel, decls] of Object.entries(parsed)) {
    const cssStr = Object.entries(decls).map(([p, v]) => `${p}: ${v}`).join('; ');
    _addCssRuleRowWithValues(sel, cssStr);
  }
};

function _addCssRuleRowWithValues(sel, cssStr) {
  const container = document.getElementById('css-rule-rows');
  const row = document.createElement('div');
  row.className = 'css-rule-row';
  row.innerHTML = `
    <input class="cp-input csr-selector" placeholder="CSS selector">
    <div class="css-rule-row-inner">
      <input class="cp-input csr-declarations" placeholder="e.g. display: none !important" style="flex:1">
      <button class="csr-remove" onclick="this.closest('.css-rule-row').remove()" title="Remove">✕</button>
    </div>`;
  row.querySelector('.csr-selector').value = sel;
  row.querySelector('.csr-declarations').value = cssStr;
  container.appendChild(row);
}

window.addCssRuleRow = function() {
  _addCssRuleRowWithValues('', '');
  const rows = document.querySelectorAll('.css-rule-row');
  rows[rows.length - 1].querySelector('.csr-selector').focus();
};

window.parseElementHtml = function() {
  const raw = (document.getElementById('cs-parse-input')?.value || '').trim();
  if (!raw) return;

  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const el  = doc.body.firstElementChild;
  if (!el) { alert('Could not parse HTML — paste the full element tag from DevTools.'); return; }

  // Priority: data-testid > aria-label > id > first stable class
  let selector = null;
  if (el.dataset.testid) {
    selector = `[data-testid="${el.dataset.testid}"]`;
  } else if (el.getAttribute('aria-label')) {
    selector = `[aria-label="${el.getAttribute('aria-label')}"]`;
  } else if (el.id) {
    selector = `#${el.id}`;
  } else if (el.className && typeof el.className === 'string') {
    const first = el.className.trim().split(/\s+/)[0];
    if (first) selector = `.${first}`;
  }

  if (!selector) { alert('No usable selector found — element has no data-testid, aria-label, id, or class.'); return; }

  _addCssRuleRowWithValues(selector, 'display: none !important');
  document.getElementById('cs-parse-input').value = '';
  document.querySelectorAll('.css-rule-row')[document.querySelectorAll('.css-rule-row').length - 1]
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};


window.applyCustomStyles = function() {
  if (!currentSection) { alert('Select a section first.'); return; }

  const rules_UNSTABLE = _collectCssRules();
  const hasRules = Object.keys(rules_UNSTABLE).length > 0;

  if (!hasRules) { alert('Add at least one CSS rule first.'); return; }

  window.TS_CONFIG._customStyles = {
    customCSS: { rules_UNSTABLE }
  };

  sdkInitialized = false;
  initSDK(window.TS_CONFIG);
  sdkInitialized = true;

  renderEmbedNow(currentSection);
  logEvent('CustomStyles', `${Object.keys(rules_UNSTABLE).length} CSS rule(s) applied`);
};

window.resetCustomStyles = function() {
  if (!currentSection) return;
  delete window.TS_CONFIG._customStyles;
  document.getElementById('css-rule-rows').innerHTML = '';
  document.getElementById('cs-code-block').value = '';
  sdkInitialized = false;
  initSDK(window.TS_CONFIG);
  sdkInitialized = true;
  renderEmbedNow(currentSection);
  logEvent('CustomStyles', 'CSS rules cleared');
};

// ── Embed Code View ───────────────────────────────────────────────────

// Minimal syntax colorizer — returns HTML string
function _colorize(text) {
  const esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const trimmed = esc.trimStart();
  if (trimmed.startsWith('//')) return `<span class="cv-comment">${esc}</span>`;
  // Enums: Action.X, RuntimeFilterOp.X, etc.
  const withEnums = esc.replace(
    /(Action\.\w+|RuntimeFilterOp\.\w+|CustomActionsPosition\.\w+|HostEvent\.\w+|EmbedEvent\.\w+|AuthType\.\w+|Page\.\w+)/g,
    '<span class="cv-enum">$1</span>'
  );
  // String literals
  const withStrings = withEnums.replace(
    /('(?:[^'\\]|\\.)*')/g,
    '<span class="cv-str">$1</span>'
  );
  // Keywords
  return withStrings.replace(
    /\b(new|const|embed|init|trigger|true|false)\b/g,
    '<span class="cv-kw">$1</span>'
  );
}

function generateEmbedCode() {
  const c       = window.TS_CONFIG;
  const section = currentSection;

  const classNames = { search: 'SearchEmbed', spotter: 'SpotterEmbed',
    nlsearch: 'SearchBarEmbed', liveboard: 'LiveboardEmbed', 'liveboard-custom': 'LiveboardEmbed', viz: 'LiveboardEmbed', fullapp: 'AppEmbed' };
  const sectionNames = { search: 'Search Data', spotter: 'Spotter AI',
    nlsearch: 'NL Search', liveboard: 'Liveboard', 'liveboard-custom': 'Custom Filters', viz: 'Visualization', fullapp: 'Full App' };

  if (!section) {
    return [
      '// No embed active yet.',
      '// Select a section from the sidebar to see',
      '// the active SDK configuration here.',
    ].join('\n');
  }

  // ── Custom Filters section — show the full REST + filter workflow ───
  if (section === 'liveboard-custom') {
    const cols = activeFilterColumns.length ? activeFilterColumns : (window.TS_CONFIG.filterColumns ?? []);
    const lines = [
      '// LiveboardEmbed · Custom Filters',
      '// ─────────────────────────────────────────────────────',
      '',
      '// Step 1 — Fetch distinct filter values from the REST API',
      `const res = await fetch('${c.thoughtSpotHost}/api/rest/2.0/metadata/liveboard/data', {`,
      "  method: 'POST',",
      "  credentials: 'include',",
      "  headers: { 'Content-Type': 'application/json' },",
      '  body: JSON.stringify({',
      `    metadata_identifier: '${c.liveboardId}',`,
      '    record_size: 10000,',
      '  }),',
      '});',
      'const { contents } = await res.json();',
      'const rows = contents[0].data_rows;',
      'const cols = contents[0].column_names;',
    ];

    // One extraction block per active column
    cols.forEach(col => {
      const varName = col.replace(/\s+/g, '_');
      lines.push(`// Extract distinct ${col} values`);
      lines.push(`const idx_${varName} = cols.indexOf('${col}');`);
      lines.push(`const values_${varName} = [...new Set(rows.map(r => r[idx_${varName}]))].sort();`);
    });

    lines.push('');
    lines.push('// Step 2 — Render the LiveboardEmbed');
    lines.push("const embed = new LiveboardEmbed('#ts-embed-container', {");
    lines.push(`  liveboardId: '${c.liveboardId}',`);
    lines.push('  liveboardV2: true,');
    lines.push('}).render();');

    // Step 3 — filters block
    lines.push('');
    lines.push('// Step 3 — Apply filter when user selects a value');
    lines.push('embed.trigger(HostEvent.UpdateFilters, {');
    lines.push('  filters: [');
    if (Object.keys(customFilters).length) {
      for (const [col, val] of Object.entries(customFilters)) {
        lines.push(`    { column: '${col}', oper: 'IN', values: ['${val}'] }, // currently selected`);
      }
    } else {
      cols.forEach(col => {
        lines.push(`    { column: '${col}', oper: 'IN', values: [/* user selection */] },`);
      });
    }
    lines.push('  ],');
    lines.push('});');

    return lines.join('\n');
  }

  const hk    = embedOptions._hiddenKeys   || [];
  const dk    = embedOptions._disabledKeys || [];
  const ca    = embedOptions.customActions || [];
  const rp    = embedOptions.runtimeParameters || [];
  const af    = embedOptions._activeFilters || [];
  const css   = c._customStyles;
  const flags = sectionOpts[section] || {};
  const hasVars  = !!(css?.customCSS?.variables && Object.keys(css.customCSS.variables).length);
  const hasRules = !!(css?.customCSS?.rules_UNSTABLE && Object.keys(css.customCSS.rules_UNSTABLE).length);
  const hasFlags = Object.keys(flags).length > 0;
  const hasAny   = hk.length || dk.length || ca.length || rp.length || af.length || hasVars || hasRules || hasFlags;

  const lines = [];
  lines.push(`// ${classNames[section]} · ${sectionNames[section]}`);
  lines.push('// ─────────────────────────────────────────────────────');

  if (!hasAny) {
    lines.push('');
    lines.push('// No options applied yet.');
    lines.push('// Use ⚙ on a section or open Advanced to configure');
    lines.push('// actions, filters, styles, and embed options.');
    return lines.join('\n');
  }

  // ── embed constructor delta ──────────────────────────────────────────
  const ctorLines = [];
  // Gear panel flags (sectionOpts)
  for (const [k, v] of Object.entries(flags)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v);
      if (entries.length) {
        ctorLines.push(`  ${k}: {`);
        entries.forEach(([pk, pv]) => ctorLines.push(`    ${pk}: ${JSON.stringify(pv)},`));
        ctorLines.push('  },');
      }
    } else if (k === 'pageId' && section === 'fullapp' && typeof v === 'string') {
      ctorLines.push(`  pageId: Page.${v},`);
    } else {
      ctorLines.push(`  ${k}: ${JSON.stringify(v)},`);
    }
  }
  if (hk.length)  ctorLines.push(`  hiddenActions: [${hk.map(k => `Action.${k}`).join(', ')}],`);
  if (dk.length)  ctorLines.push(`  disabledActions: [${dk.map(k => `Action.${k}`).join(', ')}],`);
  if (ca.length) {
    ctorLines.push('  customActions: [');
    ca.forEach(a => ctorLines.push(`    { id: '${a.id}', label: '${a.label}', position: CustomActionsPosition.${a._pos || 'END'} },`));
    ctorLines.push('  ],');
  }
  if (rp.length) {
    ctorLines.push('  runtimeParameters: [');
    rp.forEach(p => ctorLines.push(`    { name: '${p.name}', value: '${p.value}' },`));
    ctorLines.push('  ],');
  }

  if (ctorLines.length) {
    lines.push('');
    lines.push(`new ${classNames[section]}('#ts-embed-container', {`);
    lines.push('  // ...base config...');
    ctorLines.forEach(l => lines.push(l));
    if (ca.length) {
      lines.push('})');
      lines.push('  .on(EmbedEvent.CustomAction, (payload) => {');
      lines.push('    console.log(payload.id, payload.data);');
      lines.push('  })');
      lines.push('  .render();');
    } else {
      lines.push('}).render();');
    }
  }

  // ── runtime filters (HostEvent, no re-render) ────────────────────────
  if (af.length) {
    lines.push('');
    lines.push('// Applied live — no re-render needed:');
    lines.push('embed.trigger(HostEvent.UpdateRuntimeFilters, [');
    af.forEach(f => {
      lines.push(`  { columnName: '${f.columnName}', operator: RuntimeFilterOp.${f._opKey}, values: [${f.values.map(v => `'${v}'`).join(', ')}] },`);
    });
    lines.push(']);');
  }

  // ── customizations (init() delta) ────────────────────────────────────
  if (hasVars || hasRules) {
    lines.push('');
    lines.push('// Added to init({ customizations: { style: { customCSS: {');
    if (hasVars) {
      lines.push('  variables: {');
      for (const [k, v] of Object.entries(css.customCSS.variables)) {
        lines.push(`    '${k}': '${v}',`);
      }
      lines.push('  },');
    }
    if (hasRules) {
      lines.push('  rules_UNSTABLE: {');
      for (const [sel, rules] of Object.entries(css.customCSS.rules_UNSTABLE)) {
        lines.push(`    '${sel}': {`);
        for (const [prop, val] of Object.entries(rules)) {
          lines.push(`      '${prop}': '${val}',`);
        }
        lines.push('    },');
      }
      lines.push('  },');
    }
    lines.push('// } } } })');
  }

  return lines.join('\n');
}

function refreshCodeView() {
  const el = document.getElementById('cv-code');
  if (!el) return;
  // Build colorized HTML line by line
  const html = generateEmbedCode()
    .split('\n')
    .map(line => _colorize(line))
    .join('\n');
  el.innerHTML = html;
}

// ── Embed Options Panel (gear ⚙ per section) ──────────────────────────
const EMBED_OPTS_SCHEMA = {
  search: [
    { group: 'Data Panel' },
    { key: 'collapseDataSources', label: 'Collapse data panel',    type: 'bool', def: true,  hint: 'Start with data sources panel collapsed' },
    { key: 'hideDataSources',     label: 'Hide data panel',        type: 'bool', def: false, hint: 'Remove the data sources panel entirely' },
    { key: 'collapseDataPanel',   label: 'Collapse new data panel',type: 'bool', def: false, hint: 'Collapse the v2 data panel on load' },
    { group: 'Search Bar' },
    { key: 'enableSearchAssist',  label: 'Search assist',          type: 'bool', def: false, hint: 'AI-powered query suggestions as you type' },
    { key: 'focusSearchBarOnRender', label: 'Auto-focus search bar', type: 'bool', def: true, hint: 'Place cursor in search bar on load' },
    { key: 'hideSearchBar',       label: 'Hide search bar',        type: 'bool', def: false, hint: 'Show result panel only, no search bar' },
    { group: 'Results' },
    { key: 'hideResults',         label: 'Hide results',           type: 'bool', def: false, hint: 'Show search bar only, no chart/table' },
    { key: 'forceTable',          label: 'Force table view',       type: 'bool', def: false, hint: 'Always default to table (not chart)' },
  ],
  nlsearch: [
    { group: 'Data Source' },
    { key: 'hideWorksheetSelector',   label: 'Hide data source',       type: 'bool', def: false, hint: 'Remove the data source selector entirely' },
    { key: 'disableWorksheetChange',  label: 'Lock data source',       type: 'bool', def: false, hint: 'Show but disable data source switching' },
    { group: 'Search UI' },
    { key: 'hideAutocompleteSuggestions', label: 'Hide autocomplete',  type: 'bool', def: false, hint: 'Remove autocomplete suggestions' },
    { key: 'hideSampleQuestions',     label: 'Hide sample questions',  type: 'bool', def: false, hint: 'Remove auto-generated sample question prompts' },
    { key: 'hideSageAnswerHeader',    label: 'Hide "AI Answer" header',type: 'bool', def: false, hint: 'Remove the AI Answer title above results' },
  ],
  spotter: [
    { group: 'Data Source' },
    { key: 'disableSourceSelection',  label: 'Disable source switch',  type: 'bool', def: false, hint: 'Show but disable data source switching' },
    { key: 'hideSourceSelection',     label: 'Hide source selection',  type: 'bool', def: false, hint: 'Remove the data source selector entirely' },
    { group: 'Chat History' },
    { key: 'spotterSidebarConfig.enablePastConversationsSidebar', label: 'Enable history sidebar', type: 'bool', def: false, hint: 'Show past conversations in a sidebar panel' },
    { key: 'spotterSidebarConfig.spotterSidebarDefaultExpanded',  label: 'Sidebar expanded by default', type: 'bool', def: false, hint: 'Open the history sidebar automatically on load' },
  ],
  liveboard: [
    { group: 'Layout' },
    { key: 'fullHeight',                label: 'Full height',             type: 'bool', def: false, hint: 'Expand to full content height (no iframe scroll)' },
    { key: 'lazyLoadingForFullHeight',  label: 'Lazy load (full height)', type: 'bool', def: false, hint: 'Load vizzes incrementally when in full height mode' },
    { group: 'Header' },
    { key: 'hideLiveboardHeader',       label: 'Hide header bar',         type: 'bool', def: false, hint: 'Remove the liveboard title bar entirely' },
    { key: 'showLiveboardTitle',        label: 'Show title',              type: 'bool', def: false, hint: 'Show liveboard name in header' },
    { key: 'showLiveboardDescription',  label: 'Show description',        type: 'bool', def: false, hint: 'Show liveboard description in header' },
    { key: 'isLiveboardHeaderSticky',   label: 'Sticky header',           type: 'bool', def: false, hint: 'Keep header visible while scrolling' },
    { key: 'isLiveboardCompactHeaderEnabled', label: 'Compact header',    type: 'bool', def: false, hint: 'Use the compact header layout' },
    { group: 'Tabs & Vizzes' },
    { key: 'hideTabPanel',              label: 'Hide tab panel',          type: 'bool', def: false, hint: 'Hide the tab navigation strip' },
    { key: 'isLiveboardMasterpiecesEnabled', label: 'Enable styling groups', type: 'bool', def: false, hint: 'Enable liveboard styling and grouping (Masterpieces)' },
    { key: 'enableVizTransformations',  label: 'Allow chart changes',     type: 'bool', def: false, hint: 'Users can switch chart types on the fly' },
    { group: 'Spotter in Liveboard' },
    { key: 'updatedSpotterChatPrompt',  label: 'Updated Spotter prompt',  type: 'bool', def: false, hint: 'Use the updated Spotter chat prompt UI' },
  ],
  viz: [
    { group: 'Layout' },
    { key: 'fullHeight',                label: 'Full height',             type: 'bool', def: false, hint: 'Expand to the chart\'s full height' },
    { group: 'Header' },
    { key: 'hideLiveboardHeader',       label: 'Hide header bar',         type: 'bool', def: false, hint: 'Remove the liveboard title bar' },
    { key: 'showLiveboardTitle',        label: 'Show title',              type: 'bool', def: false, hint: 'Show liveboard name in header' },
    { key: 'isLiveboardHeaderSticky',   label: 'Sticky header',           type: 'bool', def: false, hint: 'Keep header visible while scrolling' },
    { group: 'Chart' },
    { key: 'enableVizTransformations',  label: 'Allow chart changes',     type: 'bool', def: false, hint: 'Users can switch chart types on the fly' },
  ],
  fullapp: [
    { group: 'Navigation' },
    { key: 'showPrimaryNavbar',         label: 'Show top nav bar',        type: 'bool',   def: false, hint: 'Show ThoughtSpot top navigation bar' },
    { key: 'modularHomeExperience',     label: 'Modular home (V2)',       type: 'bool',   def: true,  hint: 'Use the modular home layout' },
    { key: 'hideHomepageLeftNav',       label: 'Hide home left nav',      type: 'bool',   def: false, hint: 'Hide left nav on the home page only' },
    { key: 'hideHamburger',             label: 'Hide hamburger icon',     type: 'bool',   def: false, hint: 'Hide the hamburger menu icon in top nav' },
    { group: 'Top Bar Controls' },
    { key: 'disableProfileAndHelp',     label: 'Hide profile & help',     type: 'bool',   def: false, hint: 'Hide the profile and ? buttons in nav bar' },
    { key: 'hideOrgSwitcher',           label: 'Hide org switcher',       type: 'bool',   def: false, hint: 'Hide the org-switching control' },
    { key: 'hideApplicationSwitcher',   label: 'Hide app switcher',       type: 'bool',   def: false, hint: 'Hide the application switcher icons' },
    { key: 'hideObjectSearch',          label: 'Hide object search',      type: 'bool',   def: false, hint: 'Hide the object search in top nav' },
    { key: 'hideNotification',          label: 'Hide notifications',      type: 'bool',   def: false, hint: 'Hide notification icon in top nav' },
    { group: 'Start Page' },
    { key: 'pageId', label: 'Start page', type: 'select', def: 'Home',
      opts: ['Home', 'Liveboards', 'Answers', 'Data', 'SpotterPage'],
      hint: 'Which page loads first when app embed opens' },
    { group: 'Spotter Sidebar' },
    { key: 'spotterSidebarConfig.enablePastConversationsSidebar', label: 'Chat history sidebar', type: 'bool', def: false, hint: 'Show past Spotter conversations in sidebar' },
    { key: 'spotterSidebarConfig.spotterSidebarDefaultExpanded',  label: 'Sidebar open by default', type: 'bool', def: false, hint: 'Show sidebar open on load' },
  ],
};

function _getNestedOpt(opts, key) {
  if (key.includes('.')) {
    const [obj, prop] = key.split('.');
    return (opts[obj] || {})[prop];
  }
  return opts[key];
}

function _countActiveOpts(section) {
  const opts = sectionOpts[section] || {};
  let n = 0;
  for (const v of Object.values(opts)) {
    n += (v !== null && typeof v === 'object') ? Object.keys(v).length : 1;
  }
  return n;
}

function _updateGearBadge(section) {
  const badge = document.getElementById('ngb-' + section);
  if (!badge) return;
  const n = _countActiveOpts(section);
  badge.textContent = n || '';
  badge.classList.toggle('has-opts', n > 0);
}

function _renderEoBody() {
  const section = currentEoSection;
  const schema  = EMBED_OPTS_SCHEMA[section] || [];
  const opts    = sectionOpts[section] || {};
  const meta    = SECTION_META[section];
  const activeCount = _countActiveOpts(section);

  document.getElementById('eo-badge').textContent = meta.badge;
  document.getElementById('eo-title').textContent =
    meta.title + ' Options' + (activeCount ? ` · ${activeCount} active` : '');

  const body = document.getElementById('eo-body');
  body.innerHTML = schema.map(s => {
    if (s.group !== undefined) {
      return `<div class="eo-group-lbl">${s.group}</div>`;
    }
    const raw     = _getNestedOpt(opts, s.key);
    const val     = raw !== undefined ? raw : s.def;
    const changed = raw !== undefined && raw !== s.def;
    const keyAttr = s.key.replace(/'/g, "\\'");
    const rowCls  = changed ? ' eo-row--changed' : '';
    if (s.type === 'bool') {
      return `<div class="eo-row${rowCls}">
        <div class="eo-row-lbl">
          <span class="eo-lbl" title="${s.hint || ''}">${s.label}</span>
          ${s.hint ? `<span class="eo-hint">${s.hint}</span>` : ''}
        </div>
        <label class="eo-toggle">
          <input type="checkbox" ${val ? 'checked' : ''} onchange="setEmbedOpt('${keyAttr}',this.checked)">
          <span class="eo-slider"></span>
        </label>
      </div>`;
    } else if (s.type === 'select') {
      return `<div class="eo-row${rowCls}">
        <div class="eo-row-lbl">
          <span class="eo-lbl" title="${s.hint || ''}">${s.label}</span>
          ${s.hint ? `<span class="eo-hint">${s.hint}</span>` : ''}
        </div>
        <select class="eo-select" onchange="setEmbedOpt('${keyAttr}',this.value)">
          ${(s.opts || []).map(o => `<option value="${o}"${val === o ? ' selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>`;
    }
    return '';
  }).join('');
}

window.openEmbedOpts = function(section, e) {
  e.stopPropagation();
  if (currentSection !== section) switchSection(section);
  currentEoSection = section;
  const panel   = document.getElementById('eo-panel');
  const overlay = document.getElementById('eo-overlay');
  const rect    = e.currentTarget.getBoundingClientRect();
  panel.style.top = Math.max(rect.top - 10, 60) + 'px';
  panel.classList.add('open');
  overlay.classList.add('open');
  _renderEoBody();
  // After rendering, clamp so the panel never overflows the bottom of the viewport
  requestAnimationFrame(() => {
    const pr = panel.getBoundingClientRect();
    if (pr.bottom > window.innerHeight - 12) {
      panel.style.top = Math.max(12, window.innerHeight - pr.height - 12) + 'px';
    }
  });
};

window.closeEmbedOpts = function() {
  document.getElementById('eo-panel').classList.remove('open');
  document.getElementById('eo-overlay').classList.remove('open');
  currentEoSection = null;
};

window.setEmbedOpt = function(key, value) {
  if (!currentEoSection) return;
  // Find default value from schema so we can remove no-op changes
  const schemaDef = (EMBED_OPTS_SCHEMA[currentEoSection] || []).find(s => s.key === key)?.def;
  if (key.includes('.')) {
    const [obj, prop] = key.split('.');
    if (!sectionOpts[currentEoSection][obj]) sectionOpts[currentEoSection][obj] = {};
    if (value === schemaDef) {
      delete sectionOpts[currentEoSection][obj][prop];
      if (!Object.keys(sectionOpts[currentEoSection][obj]).length) delete sectionOpts[currentEoSection][obj];
    } else {
      sectionOpts[currentEoSection][obj][prop] = value;
    }
  } else {
    if (value === schemaDef) {
      delete sectionOpts[currentEoSection][key];
    } else {
      sectionOpts[currentEoSection][key] = value;
    }
  }
  _updateGearBadge(currentEoSection);
  _renderEoBody(); // refresh changed indicators live
  if (currentSection === currentEoSection) {
    renderEmbedNow(currentEoSection);
    // Auto-refresh SDK Preview if it's open
    if (bottomExpanded && bottomTab === 'code') refreshCodeView();
  }
};

window.resetEmbedOpts = function() {
  if (!currentEoSection) return;
  sectionOpts[currentEoSection] = {};
  _updateGearBadge(currentEoSection);
  _renderEoBody();
  if (currentSection === currentEoSection) renderEmbedNow(currentEoSection);
  logEvent('EmbedOpts', `${SECTION_META[currentEoSection]?.badge} options reset to defaults`);
};

// ── Reset All ─────────────────────────────────────────────────────────
window.resetAll = function() {
  embedOptions = {
    hiddenActions: [], disabledActions: [], customActions: [],
    runtimeParameters: [], _hiddenKeys: [], _disabledKeys: [], _activeFilters: [],
  };
  delete window.TS_CONFIG._customStyles;

  // Restore TS_CONFIG to original defaults from config.js
  if (window._TS_CONFIG_DEFAULT) {
    Object.keys(window.TS_CONFIG).forEach(k => { delete window.TS_CONFIG[k]; });
    Object.assign(window.TS_CONFIG, window._TS_CONFIG_DEFAULT);
  }

  // Sync config panel UI fields to restored defaults
  const c = window.TS_CONFIG;
  const cfgHost = document.getElementById('cfg-host');
  if (cfgHost) {
    cfgHost.value = c.thoughtSpotHost || '';
    document.getElementById('cfg-worksheet').value      = c.worksheetId || '';
    document.getElementById('cfg-liveboard').value      = c.liveboardId || '';
    document.getElementById('cfg-viz').value            = c.vizId || '';
    document.getElementById('cfg-search-token').value   = c.searchTokenString || '';
    document.getElementById('cfg-execute-search').value = String(c.executeSearch ?? false);
    // Sync dropdowns to restored values if discovery is active
    if (discoveredObjects.liveboards.length > 0) _syncSelectsToConfig(c);
  }

  // Clear action checkboxes
  document.querySelectorAll('.act-hide, .act-disable').forEach(cb => cb.checked = false);

  // Clear filter + param rows
  document.getElementById('filter-rows').innerHTML = '';
  filterRowCount = 0;
  document.getElementById('param-rows').innerHTML = '';
  paramRowCount = 0;

  // Clear custom action UI
  _refreshCustomActionChips();
  window.__onCustomAction = null;
  document.getElementById('ca-payload-wrap').style.display = 'none';
  document.getElementById('ca-payload-lbl').style.display  = 'none';
  const ccaWrap = document.getElementById('cca-payload-wrap');
  if (ccaWrap) ccaWrap.style.display = 'none';

  // Reset custom styles controls
  document.getElementById('css-rule-rows').innerHTML = '';
  document.getElementById('cs-code-block').value = '';

  // Reset all gear panel (sectionOpts) options and clear badges
  for (const section of Object.keys(sectionOpts)) {
    sectionOpts[section] = {};
    _updateGearBadge(section);
  }
  // If gear panel is open, re-render it to show cleared state
  if (currentEoSection) _renderEoBody();

  sdkInitialized = false;
  initSDK(window.TS_CONFIG);
  sdkInitialized = true;

  if (currentSection) renderEmbedNow(currentSection);
  logEvent('Reset', 'All options cleared — actions, filters, styles and ⚙ embed options reset to defaults');
};

window.toggleCodeView = function() { window.switchBottomTab('code'); };

window.copyEmbedCode = function() {
  const code = generateEmbedCode();
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('cv-copy-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = 'var(--success)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1800);
  });
};
