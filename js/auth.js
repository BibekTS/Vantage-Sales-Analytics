/**
 * auth.js — Trusted Auth token-claims playground.
 *
 * Lets a tester mint ThoughtSpot full-access tokens with the full (non-secret)
 * claim surface and watch the result live:
 *   • identity + JIT provisioning  (username, auto_create, display_name, email, org)
 *   • group_identifiers[]          (group-keyed RLS / ABAC)
 *   • user_parameters              (ABAC/RLS entitlements: runtime_filters, runtime_sorts, parameters)
 *
 * The secret_key never reaches the browser — the Node token server injects it.
 * `user_parameters` is deprecated in TS 10.4.0.cl+; group_identifiers is the durable path.
 */

import { getState, setAuth, setState } from './state.js';

const API_BASE = window.TS_API_BASE || '';
const OPERATORS = ['EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'IN', 'NOT_IN', 'BW', 'CONTAINS', 'BEGINS_WITH', 'ENDS_WITH', 'LIKE'];

let _log = () => {};
let _onApplied = () => {};
let _countdown = null;
let _lastToken = '';

export function seedAuthHooks({ logEvent, onTokenApplied }) {
  _log = logEvent || _log;
  _onApplied = onTokenApplied || _onApplied;
  window.__onAuthToken = renderInspector; // embed.js calls this on every getAuthToken (incl. autoLogin)
}

/** state.auth → cfg.trustedAuth (consumed by embed.js / initSDK). */
export function buildTrustedAuthConfig(auth) {
  const custom = auth.tokenType === 'custom';
  return {
    tokenEndpoint: '/api/auth/token',
    tokenType: auth.tokenType || 'full',
    username: auth.username,
    validitySeconds: auth.validitySeconds,
    orgId: auth.orgId || null,
    autoLogin: true,
    autoCreate: auth.autoCreate,
    displayName: auth.displayName,
    email: auth.email,
    groups: auth.groups,
    // full path (deprecated 10.4.0.cl+) vs custom path — only send the one that applies.
    userParameters: custom ? undefined : buildUserParameters(auth),
    persistOption: custom ? (auth.persistOption || 'REPLACE') : undefined,
    variableValues: custom ? (auth.variableValues || []).filter(v => v.name) : undefined,
    objects: custom ? (auth.objects || []).filter(Boolean) : undefined,
  };
}

function buildUserParameters(auth) {
  const up = {};
  const f = (auth.runtimeFilters || []).filter(x => x.column);
  const so = (auth.runtimeSorts || []).filter(x => x.column);
  const p = (auth.parameters || []).filter(x => x.name);
  if (f.length) up.runtime_filters = f.map(x => ({ column_name: x.column, operator: x.opKey, values: x.values, persist: !!x.persist }));
  if (so.length) up.runtime_sorts = so.map(x => ({ column_name: x.column, order: x.order, persist: !!x.persist }));
  if (p.length) up.parameters = p.map(x => ({ name: x.name, values: x.values, persist: !!x.persist }));
  return Object.keys(up).length ? up : undefined;
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  modal.hidden = false;
  modal.querySelectorAll('[data-close="auth"]').forEach(b => b.onclick = () => { modal.hidden = true; });
  renderBody();
  loadServerStatus();
}

const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

function renderBody() {
  const a = getState().auth;
  const body = document.getElementById('auth-body');
  body.innerHTML = '';

  // Server status
  const status = el('div', 'auth-status');
  status.id = 'auth-server-status';
  status.innerHTML = `<div class="as-row"><span>Token server</span><span id="as-state">checking…</span></div>
    <div class="as-row"><span>Secret</span><span id="as-secret">—</span></div>
    <div class="as-row"><span>Host</span><span id="as-host">—</span></div>
    <div class="as-row as-allow"><span>Allowlist</span><span id="as-allow">—</span></div>`;
  body.appendChild(status);

  const custom = a.tokenType === 'custom';

  // Token type — picks the mint endpoint and which ABAC surface is available.
  body.appendChild(group('Token type', [
    selectField('Endpoint', a.tokenType || 'full', [
      { v: 'full', t: 'full — auth/token/full (plain trusted auth)' },
      { v: 'custom', t: 'custom — auth/token/custom (ABAC via RLS variables)' },
    ], v => { setAuth({ tokenType: v }); renderBody(); }),
    hint(custom
      ? 'custom is the ABAC endpoint — it accepts variable_values (modern RLS) + a required persist_option. A cluster runs ONE token workflow at a time (full OR custom), not both in parallel.'
      : 'full is the default. Switch to custom to test ABAC via RLS formula variables (variable_values).'),
  ]));

  // Identity
  body.appendChild(group('Identity & provisioning', [
    field('Username', a.username, v => setAuth({ username: v }), '(server default)'),
    twoCol(
      field('Validity (sec)', a.validitySeconds, v => setAuth({ validitySeconds: Number(v) || 300 }), '300', 'number'),
      field(custom ? 'Org identifier' : 'Org ID', a.orgId, v => setAuth({ orgId: v }), '(default)'),
    ),
    toggle('Auto-create user (JIT)', a.autoCreate, v => setAuth({ autoCreate: v })),
    twoCol(
      field('Display name', a.displayName, v => setAuth({ displayName: v }), 'For JIT'),
      field('Email', a.email, v => setAuth({ email: v }), 'For JIT'),
    ),
  ]));

  // Groups
  body.appendChild(group(custom ? 'Groups (groups[].identifier)' : 'Groups (group_identifiers)', [
    chipsEditor(a.groups, list => setAuth({ groups: list }), 'Add group name, Enter'),
    hint('Group membership drives group-keyed RLS/ABAC rules on the worksheet. Durable path.'),
  ]));

  if (custom) {
    // Modern ABAC: variable_values on auth/token/custom (10.14.0.cl+).
    body.appendChild(group('ABAC via RLS variables (variable_values)', [
      hint('Each name is a formula variable referenced in an RLS rule via ts_var(name). Values become a WHERE clause at query time (= → IN for multi-value). The forward-track replacement for user_parameters.'),
      selectField('persist_option', a.persistOption || 'REPLACE', [
        { v: 'REPLACE', t: 'REPLACE — overwrite persisted set (right for a stateless mint)' },
        { v: 'APPEND', t: 'APPEND — add to persisted (API default; accumulates/leaks)' },
        { v: 'NONE', t: 'NONE — do not persist (not allowed with variable_values)' },
        { v: 'RESET', t: 'RESET — clear persisted (not allowed with variable_values)' },
      ], v => { setAuth({ persistOption: v }); renderBody(); }),
      hint(a.persistOption === 'NONE' || a.persistOption === 'RESET'
        ? '⚠ NONE/RESET are rejected by ThoughtSpot when variable_values are present — the server will 400. Use REPLACE or APPEND, or clear the variables below.'
        : 'REPLACE makes each mint authoritative. APPEND is the API default and silently accumulates entitlements across mints — the slow-leak this pattern prevents.'),
      subhead('Variables'),
      variableEditor('variableValues'),
      subhead('Scope to models (optional)'),
      chipsEditor(a.objects, list => setAuth({ objects: list }), 'LOGICAL_TABLE GUID or name, Enter'),
      hint('Limits the variable_values to specific models (objects[].identifier, type LOGICAL_TABLE). Leave empty to apply everywhere.'),
    ]));
  } else {
    // Legacy ABAC entitlements baked into the session (full endpoint).
    body.appendChild(group('ABAC / RLS entitlements (user_parameters)', [
      hint('⚠ Deprecated in TS 10.4.0.cl+ — switch the token type to "custom" and use variable_values. Still works on full for now.'),
      subhead('Runtime filters'),
      filterEditor('runtimeFilters'),
      subhead('Runtime sorts'),
      sortEditor('runtimeSorts'),
      subhead('Parameters'),
      paramEditor('parameters'),
    ]));
  }

  // Actions
  const actions = el('div', 'auth-actions');
  const mint = el('button', 'tb-btn', 'Mint token (inspect)');
  mint.onclick = () => mintToken(false);
  const apply = el('button', 'tb-btn tb-btn-primary', 'Mint & apply to embed');
  apply.onclick = () => mintToken(true);
  actions.append(mint, apply);
  body.appendChild(actions);

  // Inspector
  const insp = el('div', 'tok-inspect');
  insp.innerHTML = `
    <div class="tok-block"><div class="tok-lbl">Request to token server <span class="tok-redact">secret redacted</span></div><pre id="tok-req">—</pre></div>
    <div class="tok-block"><div class="tok-lbl">Raw token <span id="tok-exp" class="tok-exp"></span> <button id="tok-copy" class="bp-mini">Copy</button></div><pre id="tok-raw">—</pre></div>
    <div class="tok-block"><div class="tok-lbl">Decoded JWT claims</div><pre id="tok-dec">—</pre></div>
    <div class="tok-block"><div class="tok-lbl">getAuthToken invocations</div><div id="tok-log" class="tok-log"><div class="tok-empty">No requests yet.</div></div></div>`;
  body.appendChild(insp);
  document.getElementById('tok-copy').onclick = () => { if (_lastToken) navigator.clipboard.writeText(_lastToken); };
}

// ── Field builders ───────────────────────────────────────────────────────────
function group(title, children) {
  const g = el('div', 'auth-group');
  g.appendChild(el('div', 'auth-group-t', title));
  children.forEach(c => g.appendChild(c));
  return g;
}
function subhead(t) { return el('div', 'auth-sub', t); }
function hint(t) { return el('div', 'fld-hint', t); }
function twoCol(a, b) { const r = el('div', 'two-col'); r.append(a, b); return r; }
function field(label, value, onChange, ph, type = 'text') {
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', label));
  const i = el('input', 'inp'); i.type = type; i.value = value ?? ''; i.placeholder = ph || '';
  i.addEventListener('change', () => onChange(i.value.trim()));
  f.appendChild(i); return f;
}
function toggle(label, value, onChange) {
  const f = el('label', 'tgl'); f.innerHTML = `<span>${label}</span>`;
  const i = el('input'); i.type = 'checkbox'; i.checked = !!value;
  i.addEventListener('change', () => onChange(i.checked));
  f.append(i, el('span', 'tgl-slider')); return f;
}
function selectField(label, value, opts, onChange) {
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', label));
  const sel = el('select', 'inp');
  opts.forEach(o => { const op = el('option'); op.value = o.v; op.textContent = o.t; if (o.v === value) op.selected = true; sel.appendChild(op); });
  sel.addEventListener('change', () => onChange(sel.value));
  f.appendChild(sel); return f;
}
function variableEditor(key) {
  const a = getState().auth; const rows = el('div', 'rows');
  (a[key] || []).forEach((v, i) => {
    const r = el('div', 'frow');
    const name = mkInp('formula variable name', v.name);
    const val = mkInp('values, comma-sep', (v.values || []).join(', '));
    const x = el('button', 'frow-x', '✕');
    name.onchange = val.onchange = () => updateAuthRow(key, i, { name: name.value.trim(), values: val.value.split(',').map(s => s.trim()).filter(Boolean) });
    x.onclick = () => removeAuthRow(key, i);
    r.append(name, val, x); rows.appendChild(r);
  });
  const add = el('button', 'sec-add', '+ Add variable');
  add.onclick = () => addAuthRow(key, { name: '', values: [] });
  const w = el('div'); w.append(rows, add); return w;
}
function chipsEditor(list, onChange, ph) {
  const wrap = el('div', 'chips-editor');
  const chips = el('div', 'chips');
  (list || []).forEach((g, i) => {
    const c = el('span', 'chip');
    c.textContent = g; // g is hash-controlled (state.auth.groups/objects) — must not be HTML
    const x = el('button', 'chip-x', '✕');
    x.onclick = () => { const l = [...list]; l.splice(i, 1); onChange(l); renderBody(); };
    c.appendChild(x); chips.appendChild(c);
  });
  const inp = el('input', 'inp'); inp.placeholder = ph;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value.trim()) { onChange([...(list || []), inp.value.trim()]); renderBody(); } });
  wrap.append(chips, inp); return wrap;
}
function filterEditor(key) {
  const a = getState().auth; const rows = el('div', 'rows');
  (a[key] || []).forEach((f, i) => {
    const r = el('div', 'frow');
    const col = mkInp('column', f.column);
    const op = el('select', 'inp inp-sm'); op.innerHTML = OPERATORS.map(o => `<option${o === f.opKey ? ' selected' : ''}>${o}</option>`).join('');
    const val = mkInp('values, comma-sep', (f.values || []).join(', '));
    const x = el('button', 'frow-x', '✕');
    const commit = () => updateAuthRow(key, i, { column: col.value.trim(), opKey: op.value, values: val.value.split(',').map(v => v.trim()).filter(Boolean), persist: f.persist });
    col.onchange = op.onchange = val.onchange = commit;
    x.onclick = () => removeAuthRow(key, i);
    r.append(col, op, val, x); rows.appendChild(r);
  });
  const add = el('button', 'sec-add', '+ Add filter');
  add.onclick = () => addAuthRow(key, { column: '', opKey: 'EQ', values: [], persist: false });
  const w = el('div'); w.append(rows, add); return w;
}
function sortEditor(key) {
  const a = getState().auth; const rows = el('div', 'rows');
  (a[key] || []).forEach((f, i) => {
    const r = el('div', 'frow');
    const col = mkInp('column', f.column);
    const ord = el('select', 'inp inp-sm'); ord.innerHTML = ['ASC', 'DESC'].map(o => `<option${o === f.order ? ' selected' : ''}>${o}</option>`).join('');
    const x = el('button', 'frow-x', '✕');
    col.onchange = ord.onchange = () => updateAuthRow(key, i, { column: col.value.trim(), order: ord.value, persist: f.persist });
    x.onclick = () => removeAuthRow(key, i);
    r.append(col, ord, x); rows.appendChild(r);
  });
  const add = el('button', 'sec-add', '+ Add sort');
  add.onclick = () => addAuthRow(key, { column: '', order: 'ASC', persist: false });
  const w = el('div'); w.append(rows, add); return w;
}
function paramEditor(key) {
  const a = getState().auth; const rows = el('div', 'rows');
  (a[key] || []).forEach((p, i) => {
    const r = el('div', 'frow');
    const name = mkInp('name', p.name);
    const val = mkInp('values, comma-sep', (p.values || []).join(', '));
    const x = el('button', 'frow-x', '✕');
    name.onchange = val.onchange = () => updateAuthRow(key, i, { name: name.value.trim(), values: val.value.split(',').map(v => v.trim()).filter(Boolean), persist: p.persist });
    x.onclick = () => removeAuthRow(key, i);
    r.append(name, val, x); rows.appendChild(r);
  });
  const add = el('button', 'sec-add', '+ Add parameter');
  add.onclick = () => addAuthRow(key, { name: '', values: [], persist: false });
  const w = el('div'); w.append(rows, add); return w;
}
function mkInp(ph, val) { const i = el('input', 'inp inp-sm'); i.placeholder = ph; i.value = val || ''; return i; }
function addAuthRow(key, row) { const a = getState().auth; setAuth({ [key]: [...(a[key] || []), row] }); renderBody(); }
function updateAuthRow(key, i, row) { const a = getState().auth; const l = [...(a[key] || [])]; l[i] = row; setAuth({ [key]: l }); }
function removeAuthRow(key, i) { const a = getState().auth; const l = [...(a[key] || [])]; l.splice(i, 1); setAuth({ [key]: l }); renderBody(); }

// ── Server status + mint ───────────────────────────────────────────────────
async function loadServerStatus() {
  const setTxt = (id, txt, cls) => { const e = document.getElementById(id); if (e) { e.textContent = txt; if (cls) e.className = cls; } };
  try {
    const res = await fetch(`${API_BASE}/api/auth/config`);
    try { window.__onApiCall?.({ scope: 'playground', method: 'GET', path: '/api/auth/config', status: res.status }); } catch (_) {}
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    setTxt('as-state', 'online ✓', 'as-ok');
    setTxt('as-secret', cfg.secretConfigured ? 'configured ✓' : 'NOT configured ✗', cfg.secretConfigured ? 'as-ok' : 'as-bad');
    setTxt('as-host', cfg.thoughtSpotHost || '(not set)');
    const allow = document.getElementById('as-allow');
    if (allow) {
      allow.innerHTML = '';
      (cfg.allowlist || []).forEach(u => { const c = el('button', 'auth-chip'); c.textContent = u; c.onclick = () => { setAuth({ username: u }); renderBody(); loadServerStatus(); }; allow.appendChild(c); });
      if (!(cfg.allowlist || []).length) allow.textContent = '(none)';
    }
  } catch (e) {
    setTxt('as-state', `offline — run: npm start`, 'as-bad');
    setTxt('as-secret', '—');
  }
}

async function mintToken(apply) {
  const a = getState().auth;
  const custom = a.tokenType === 'custom';
  const body = {
    tokenType: a.tokenType || 'full',
    username: a.username || undefined,
    validitySeconds: a.validitySeconds,
    orgId: a.orgId || undefined,
    autoCreate: a.autoCreate || undefined,
    displayName: a.displayName || undefined,
    email: a.email || undefined,
    groups: a.groups?.length ? a.groups : undefined,
    // full path (deprecated) vs custom path (ABAC via RLS variables) — send only the relevant one.
    userParameters: custom ? undefined : buildUserParameters(a),
    persistOption: custom ? (a.persistOption || 'REPLACE') : undefined,
    variableValues: custom && a.variableValues?.some(v => v.name) ? a.variableValues.filter(v => v.name) : undefined,
    objects: custom && a.objects?.length ? a.objects.filter(Boolean) : undefined,
  };
  _log('Auth', `Minting token (user: ${body.username || '(default)'}, groups: [${(a.groups || []).join(', ')}])`);
  try {
    const res = await fetch(`${API_BASE}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try { window.__onApiCall?.({ scope: 'playground', method: 'POST', path: '/api/auth/token', status: res.status }); } catch (_) {}
    const data = await res.json();
    if (!res.ok) { renderInspector({ requestBody: body, error: data.error || `HTTP ${res.status}`, response: data }); _log('Auth', `✗ ${data.error || res.status}`); return; }
    renderInspector({ requestBody: data.echo?.requestBody || body, response: data });
    _log('Auth', `✓ token minted for ${data.valid_for_username || body.username || '(default)'}`);
    if (apply) {
      setState({ authType: 'TrustedAuthTokenCookieless' });
      document.getElementById('auth-select').value = 'TrustedAuthTokenCookieless';
      _onApplied(data.token);
      document.getElementById('auth-modal').hidden = true;
    }
  } catch (err) {
    renderInspector({ requestBody: body, error: err.message });
    _log('Auth', `✗ ${err.message} — is the Node server running?`);
  }
}

// ── Inspector rendering (also called on every getAuthToken via window.__onAuthToken) ──
function renderInspector(info = {}) {
  const req = document.getElementById('tok-req');
  if (req && info.requestBody) req.textContent = JSON.stringify(info.requestBody, null, 2);
  appendLog(info);
  const raw = document.getElementById('tok-raw');
  const dec = document.getElementById('tok-dec');
  if (info.error) { if (raw) raw.textContent = `Error: ${info.error}`; if (dec) dec.textContent = '—'; stopCountdown(); return; }
  const token = info.response?.token || '';
  _lastToken = token;
  if (raw) raw.textContent = token || '—';
  if (dec) {
    try {
      const parts = token.split('.');
      dec.textContent = parts.length >= 2
        ? JSON.stringify({ header: decodeSeg(parts[0]), payload: decodeSeg(parts[1]) }, null, 2)
        : 'Opaque token (not a decodable JWT).';
    } catch { dec.textContent = 'Opaque token (not a decodable JWT).'; }
  }
  let exp = info.response?.expiration_time_in_millis;
  if (!exp) { try { exp = decodeSeg(token.split('.')[1]).exp * 1000; } catch { exp = 0; } }
  startCountdown(exp);
}
function decodeSeg(seg) {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function appendLog(info) {
  const log = document.getElementById('tok-log');
  if (!log) return;
  const empty = log.querySelector('.tok-empty'); if (empty) empty.remove();
  const t = new Date().toTimeString().slice(0, 8);
  const line = el('div', 'tok-line');
  const timeEl = el('span', 'tl-t'); timeEl.textContent = t;
  line.append(timeEl, document.createTextNode(' '));
  if (info.error) {
    // info.error may contain upstream TS error text (attacker-controllable) — use textContent.
    const errEl = el('span', 'tl-bad'); errEl.textContent = `✗ ${info.error}`;
    line.appendChild(errEl);
  } else {
    const user = info.response?.valid_for_username || info.requestBody?.username || '(default)';
    const okEl = el('span', 'tl-ok'); okEl.textContent = '✓ minted';
    line.append(okEl, document.createTextNode(` for ${user}`));
  }
  log.insertBefore(line, log.firstChild);
}
function startCountdown(exp) {
  stopCountdown();
  const e = document.getElementById('tok-exp');
  if (!e || !exp) { if (e) e.textContent = ''; return; }
  const tick = () => {
    const r = Math.max(0, exp - Date.now()); const s = Math.floor(r / 1000);
    e.textContent = `expires in ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    e.classList.toggle('warn', r < 30000);
    if (r <= 0) { e.textContent = 'expired'; stopCountdown(); }
  };
  tick(); _countdown = setInterval(tick, 1000);
}
function stopCountdown() { if (_countdown) { clearInterval(_countdown); _countdown = null; } }
