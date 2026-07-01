/**
 * server.js — ThoughtSpot Embed Playground token request service (Trusted Authentication)
 *
 * SECURITY MODEL
 * --------------
 * The ThoughtSpot trusted-auth `secret_key` MUST NEVER reach the browser. It lives only here,
 * in process.env (loaded from .env, which is gitignored). This server is the "token request
 * service": it holds the secret, calls ThoughtSpot's mint endpoint, and returns ONLY the
 * resulting short-lived bearer token to the browser.
 *
 * Two mint endpoints, selected by `tokenType`:
 *   • full   → /auth/token/full   — plain trusted auth (default).
 *   • custom → /auth/token/custom — ABAC via RLS formula variables. Accepts variable_values and a
 *              REQUIRED persist_option (we default to REPLACE; the API default APPEND silently
 *              accumulates entitlements across mints). NONE/RESET are invalid alongside variable_values.
 *
 *   browser ──POST /api/auth/token {username,tokenType}──▶ this server ──token/{full|custom} {secret_key}──▶ ThoughtSpot
 *   browser ◀──────────── { token } ────────────────────  this server ◀────────── { token } ──────────────  ThoughtSpot
 *
 * Fail-closed dev guards (override with env flags only when you understand them):
 *   • Username allowlist — the browser can only mint for known users (TS_USERNAME_ALLOWLIST).
 *   • JIT provisioning (auto_create) is REFUSED unless TS_ALLOW_JIT=true. Otherwise the browser
 *     could provision a brand-new user and side-step the allowlist entirely.
 *   • group_identifiers are refused unless each group is in TS_GROUP_ALLOWLIST (or it is '*').
 *     Otherwise the browser could mint a token into a privileged group (e.g. Administrator).
 *   • /api/filter-values forwards the CALLER'S OWN token — it never mints an admin token on the
 *     caller's behalf, so it cannot be used as an unauthenticated data-exfiltration proxy.
 *   • Static serving is restricted to the frontend assets (never source, .env, docs, or bundles).
 *
 * In production you would REMOVE the body-supplied username entirely and derive it from a
 * server-verified user session (SSO/cookie), minting only for that identity. See README.
 *
 * Endpoints:
 *   GET  /api/auth/config    — non-sensitive bootstrap (never exposes the secret)
 *   POST /api/auth/token     — mint a full OR custom (ABAC) token (allowlist + JIT/group guarded, rate-limited)
 *   POST /api/writeback      — sink for the write-back custom action (stub; TS_ALLOW_DEV_PROXY)
 *   POST /api/filter-values  — filter-value discovery using the CALLER'S bearer token (no minting)
 *   (static) /js /css /vendor /config.js /  — the frontend only
 */

require('dotenv').config();
const path = require('path');
const express = require('express');

// ── Node version guard (native fetch needs Node 18+) ────────────────────────────────────────
if (typeof fetch === 'undefined') {
  console.error('[fatal] global fetch is unavailable. Use Node >= 18, or `npm i node-fetch` and wire it up.');
  process.exit(1);
}

// ── Environment ─────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const TS_HOST = (process.env.THOUGHTSPOT_HOST || '').replace(/\/+$/, ''); // strip trailing slash
const TS_SECRET_KEY = process.env.TS_SECRET_KEY || '';
const DEFAULT_USERNAME = process.env.TS_DEFAULT_USERNAME || '';
const DEFAULT_ORG_ID = process.env.TS_DEFAULT_ORG_ID || '';
const VALIDITY_DEFAULT = 300;
const VALIDITY_MIN = 30;
const VALIDITY_MAX = 3600;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// Fail-closed dev guards (see SECURITY MODEL above).
const ALLOW_JIT = truthy(process.env.TS_ALLOW_JIT);             // permit auto_create (allowlist bypass)
const ALLOW_DEV_PROXY = truthy(process.env.TS_ALLOW_DEV_PROXY); // permit the /api/writeback stub sink
// '*' opts out of the group guard entirely (back to "any group"); otherwise an explicit set.
const GROUP_ALLOWLIST_RAW = (process.env.TS_GROUP_ALLOWLIST || '').split(',').map((g) => g.trim()).filter(Boolean);
const GROUP_WILDCARD = GROUP_ALLOWLIST_RAW.includes('*');
const GROUP_ALLOWLIST = new Set(GROUP_ALLOWLIST_RAW);

// Allowlist of usernames this server is willing to mint tokens for.
// Fail-closed: if the env var is empty, only the default username is allowed.
const ALLOWLIST = new Set(
  (process.env.TS_USERNAME_ALLOWLIST || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
);
if (ALLOWLIST.size === 0 && DEFAULT_USERNAME) ALLOWLIST.add(DEFAULT_USERNAME);

const secretConfigured = Boolean(TS_SECRET_KEY);

// ── Tiny in-memory fixed-window rate limiter (per IP) ─────────────────────────────────────────
// Not a substitute for a real gateway, but it stops a runaway loop or a local script from
// hammering the mint endpoint. Window + ceiling are deliberately generous for interactive use.
function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let rec = hits.get(ip);
    if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + windowMs }; hits.set(ip, rec); }
    rec.count += 1;
    if (rec.count > max) {
      res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}

// ── Upstream endpoint + request body (single source of truth for mint AND the redacted echo) ───
/** Map a token type to its ThoughtSpot v2 mint endpoint path. */
function tokenEndpointPath(tokenType) {
  return tokenType === 'custom'
    ? '/api/rest/2.0/auth/token/custom' // ABAC via RLS formula variables
    : '/api/rest/2.0/auth/token/full';  // plain trusted auth (default)
}

/** Build the exact body POSTed to the mint endpoint. The ONLY place the secret is added. */
function buildTokenRequestBody(params) {
  const {
    tokenType, username, validitySeconds, orgId, autoCreate, displayName, email, groups,
    userParameters, persistOption, variableValues, objects,
  } = params;
  const body = {
    username,
    secret_key: TS_SECRET_KEY,
    validity_time_in_sec: validitySeconds,
  };

  if (tokenType === 'custom') {
    // ── auth/token/custom — ABAC via RLS formula variables ──
    // org is a STRING identifier here (org_identifier), unlike /full's numeric org_id.
    if (orgId !== undefined && orgId !== null && orgId !== '') body.org_identifier = String(orgId);
    // persist_option is REQUIRED on /custom. We default to REPLACE so a stateless mint is
    // authoritative — the API default is APPEND, which silently ACCUMULATES entitlements across
    // mints (the slow-leak this whole pattern is meant to prevent).
    body.persist_option = persistOption || 'REPLACE';
    // auto_create DEFAULTS TO true on /custom, so set it explicitly — otherwise JIT would slip
    // past the ALLOW_JIT guard simply by omission.
    body.auto_create = !!autoCreate;
    if (displayName) body.display_name = displayName;
    if (email) body.email = email;
    // groups on /custom are objects: [{ identifier }] — NOT the string array /full uses.
    if (Array.isArray(groups) && groups.length) body.groups = groups.map((identifier) => ({ identifier }));
    if (Array.isArray(variableValues) && variableValues.length) {
      body.variable_values = variableValues
        .filter((v) => v && v.name)
        .map((v) => ({ name: v.name, values: Array.isArray(v.values) ? v.values : [] }));
    }
    if (Array.isArray(objects) && objects.length) {
      body.objects = objects.filter(Boolean).map((identifier) => ({ type: 'LOGICAL_TABLE', identifier }));
    }
    return body;
  }

  // ── auth/token/full (default) ──
  const org = orgId !== undefined && orgId !== null && orgId !== '' ? Number(orgId) : undefined;
  if (Number.isFinite(org)) body.org_id = org;
  if (autoCreate) body.auto_create = true;
  if (displayName) body.display_name = displayName;
  if (email) body.email = email;
  if (Array.isArray(groups) && groups.length) body.group_identifiers = groups;
  if (userParameters && typeof userParameters === 'object' && Object.keys(userParameters).length) {
    body.user_parameters = userParameters; // { runtime_filters, runtime_sorts, parameters }
  }
  return body;
}

/** Redacted copy of an upstream body for the browser-side Live Token Inspector. */
function redactBody(body) {
  return { ...body, secret_key: '***redacted***' };
}

/** Mint a token from ThoughtSpot (full or custom). Returns the parsed JSON response. Throws on failure. */
async function mintToken(params) {
  if (!secretConfigured) {
    const err = new Error('TS_SECRET_KEY not configured on server');
    err.statusCode = 503;
    throw err;
  }
  const body = buildTokenRequestBody(params);
  const resp = await fetch(`${TS_HOST}${tokenEndpointPath(params.tokenType)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!resp.ok) {
    const err = new Error(`ThoughtSpot token request failed (${resp.status})`);
    err.statusCode = resp.status;
    err.upstream = json ?? text;
    throw err;
  }
  return json;
}

// ── App ────────────────────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true); // so req.ip reflects X-Forwarded-For when fronted by a proxy
app.use(express.json({ limit: '256kb' }));

// If you prefer to keep the static frontend on VS Code Live Server (different origin), uncomment
// the CORS block below and set `window.TS_API_BASE = 'http://localhost:3000'` in config.js.
// const cors = require('cors');
// app.use(cors({ origin: ['http://localhost:5500', 'http://localhost:5501'] }));

// ── GET /api/auth/config — non-sensitive bootstrap for the UI ────────────────────────────────
app.get('/api/auth/config', (_req, res) => {
  res.json({
    thoughtSpotHost: TS_HOST,
    defaultUsername: DEFAULT_USERNAME,
    allowlist: [...ALLOWLIST],
    orgId: DEFAULT_ORG_ID || null,
    secretConfigured,            // boolean only — the secret itself is never sent
    allowJit: ALLOW_JIT,
    groupGuard: GROUP_WILDCARD ? 'any' : (GROUP_ALLOWLIST.size ? [...GROUP_ALLOWLIST] : 'none'),
    validityDefault: VALIDITY_DEFAULT,
    validityMin: VALIDITY_MIN,
    validityMax: VALIDITY_MAX,
  });
});

// ── POST /api/auth/token — mint a full OR custom (ABAC) token (the secure core) ──────────────
app.post('/api/auth/token', rateLimiter({ windowMs: 60_000, max: 60 }), async (req, res) => {
  try {
    const requested = (req.body?.username || '').trim() || DEFAULT_USERNAME;
    const autoCreate = !!req.body?.autoCreate;
    const groups = Array.isArray(req.body?.groups) ? req.body.groups.filter(Boolean) : [];
    const tokenType = req.body?.tokenType === 'custom' ? 'custom' : 'full';

    if (!requested) {
      return res.status(400).json({ error: 'No username provided and TS_DEFAULT_USERNAME is not set.' });
    }

    // ── Custom-token (ABAC) validation — persist_option is required and constrained ──
    let persistOption;
    let variableValues;
    let objects;
    if (tokenType === 'custom') {
      persistOption = String(req.body?.persistOption || 'REPLACE').toUpperCase();
      if (!['REPLACE', 'APPEND', 'NONE', 'RESET'].includes(persistOption)) {
        return res.status(400).json({ error: `Invalid persist_option '${persistOption}'. Use REPLACE, APPEND, NONE, or RESET.` });
      }
      variableValues = Array.isArray(req.body?.variableValues) ? req.body.variableValues : [];
      objects = Array.isArray(req.body?.objects) ? req.body.objects.filter(Boolean) : [];
      // ThoughtSpot rejects NONE/RESET when variable_values are present (docs: getCustomAccessToken).
      const hasVars = variableValues.some((v) => v && v.name);
      if (hasVars && (persistOption === 'NONE' || persistOption === 'RESET')) {
        return res.status(400).json({
          error: `persist_option ${persistOption} cannot be combined with variable_values — ThoughtSpot rejects it. Use REPLACE or APPEND, or remove the variable values.`,
        });
      }
    }

    // JIT guard — auto_create bypasses the username allowlist (it provisions a NEW user), so it is
    // refused unless explicitly enabled. This closes the "allowlist has a JIT-shaped hole" gap.
    if (autoCreate && !ALLOW_JIT) {
      return res.status(403).json({ error: 'JIT provisioning (auto_create) is disabled. Set TS_ALLOW_JIT=true to enable it for this dev playground.' });
    }

    // Group guard — refuse minting into groups the operator has not allowlisted. '*' opts out.
    if (groups.length && !GROUP_WILDCARD) {
      const denied = groups.filter((g) => !GROUP_ALLOWLIST.has(g));
      if (denied.length) {
        return res.status(403).json({
          error: `group_identifiers not permitted: ${denied.join(', ')}. Add them to TS_GROUP_ALLOWLIST (or set it to '*').`,
          allowedGroups: GROUP_ALLOWLIST.size ? [...GROUP_ALLOWLIST] : [],
        });
      }
    }

    // Allowlist safeguard — prevents browser-driven impersonation of arbitrary EXISTING users.
    if (!autoCreate && ALLOWLIST.size && !ALLOWLIST.has(requested)) {
      return res.status(403).json({
        error: `username '${requested}' is not in TS_USERNAME_ALLOWLIST`,
        allowed: [...ALLOWLIST],
      });
    }

    // Clamp validity so a UI typo can't mint a long-lived token.
    let validitySeconds = Number(req.body?.validitySeconds);
    if (!Number.isFinite(validitySeconds)) validitySeconds = VALIDITY_DEFAULT;
    validitySeconds = Math.min(VALIDITY_MAX, Math.max(VALIDITY_MIN, Math.round(validitySeconds)));

    const orgId = req.body?.orgId ?? (DEFAULT_ORG_ID || undefined);
    const params = {
      tokenType,
      username: requested,
      validitySeconds,
      orgId,
      autoCreate,
      displayName: req.body?.displayName,
      email: req.body?.email,
      groups: groups.length ? groups : undefined,
      userParameters: tokenType === 'full' ? req.body?.userParameters : undefined,
      persistOption,
      variableValues,
      objects,
    };

    let result;
    let warning;
    try {
      result = await mintToken(params);
    } catch (err) {
      // Some clusters have the token-level `user_parameters` (the "JWT Beta") path turned OFF.
      // A `full` mint that carries user_parameters then 400s with "JWT Beta endpoint is disabled".
      // Rather than dead-end the user, retry a PLAIN token so the embed can still authenticate —
      // but say clearly that the entitlements were dropped (this is a testing playground).
      const betaDisabled = err.statusCode === 400 && /JWT Beta endpoint is disabled/i.test(JSON.stringify(err.upstream || ''));
      if (betaDisabled && tokenType === 'full' && params.userParameters) {
        params.userParameters = undefined; // also fixes the echo below to reflect what we sent
        result = await mintToken(params);
        warning = 'This cluster has token-level filters (user_parameters) disabled, so a plain token was minted WITHOUT them. Apply filters via the embed’s Runtime filters panel, or switch Token type to "custom" and use variable_values for real RLS/ABAC.';
      } else {
        throw err;
      }
    }

    // Log only non-sensitive metadata.
    console.log(`[token] minted ${tokenType} for "${requested}" (validity ${validitySeconds}s, len ${result?.token?.length ?? 0})${warning ? ' [user_parameters dropped — beta path off]' : ''}`);

    res.json({
      token: result.token,
      creation_time_in_millis: result.creation_time_in_millis,
      expiration_time_in_millis: result.expiration_time_in_millis,
      valid_for_username: result.valid_for_username,
      valid_for_user_id: result.valid_for_user_id,
      scope: result.scope,
      warning, // present only when we auto-recovered from the beta-disabled 400
      // Echo is derived from the SAME body we actually sent, so the inspector can never drift.
      echo: { endpoint: tokenEndpointPath(tokenType), requestBody: redactBody(buildTokenRequestBody(params)) },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, upstream: err.upstream });
  }
});

// ── POST /api/writeback — write-back custom-action sink (stub; opt-in) ─────────────────────────
app.post('/api/writeback', (req, res) => {
  if (!ALLOW_DEV_PROXY) {
    return res.status(403).json({ error: 'Write-back sink is disabled. Set TS_ALLOW_DEV_PROXY=true to enable this dev stub.' });
  }
  const ticketId = `TKT-${Date.now()}`;
  const receivedAt = new Date().toISOString();
  console.log(`[writeback] ${ticketId} @ ${receivedAt}:`, JSON.stringify(req.body));
  // ── Real integration would go here (Jira / ServiceNow / DB insert / etc.) ──
  res.json({ ok: true, ticketId, receivedAt, received: req.body });
});

// ── POST /api/filter-values — filter-value discovery using the CALLER'S OWN token ──────────────
// Cookieless trusted-auth blocks the browser from calling TS REST cross-origin (CORS), so this
// endpoint relays the call. It uses the bearer token the CALLER already holds — it does NOT mint
// a token, so it only ever exposes data the caller could already reach. No caller token → 401.
app.post('/api/filter-values', rateLimiter({ windowMs: 60_000, max: 120 }), async (req, res) => {
  try {
    const liveboardId = (req.body?.liveboardId || '').trim();
    const column = (req.body?.column || '').trim();
    if (!liveboardId) return res.status(400).json({ error: 'liveboardId is required' });

    const auth = req.get('authorization') || '';
    const headerToken = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    const token = (headerToken || req.body?.token || '').trim();
    if (!token) {
      return res.status(401).json({ error: 'A caller bearer token is required (Authorization: Bearer <token>). This proxy never mints one for you.' });
    }

    const resp = await fetch(`${TS_HOST}/api/rest/2.0/metadata/liveboard/data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ metadata_identifier: liveboardId, record_size: 10000, record_offset: 0 }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!resp.ok) return res.status(resp.status).json({ error: 'liveboard/data failed', upstream: data ?? text });

    const contents = data?.contents ?? [];
    if (!column) return res.json({ contents }); // raw passthrough when no column requested

    const content = contents.find((c) => (c.column_names ?? []).includes(column));
    if (!content) return res.json({ column, values: [] });
    const cols = content.column_names ?? [];
    const rows = content.data_rows ?? [];
    const idx = cols.indexOf(column);
    const values = [...new Set(rows.map((r) => {
      const v = r[idx];
      return v === null || v === undefined ? '{Null}' : String(v);
    }))].sort();
    res.json({ column, values });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, upstream: err.upstream });
  }
});

// ── Static frontend — explicit allowlist of asset paths (never source, .env, docs, bundles) ────
const staticOpts = { dotfiles: 'ignore', index: false };
app.use('/js', express.static(path.join(__dirname, 'js'), staticOpts));
app.use('/css', express.static(path.join(__dirname, 'css'), staticOpts));
app.use('/vendor', express.static(path.join(__dirname, 'vendor'), staticOpts)); // self-hosted SDK (see scripts/vendor-sdk.mjs)
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js')));
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Bind to localhost only. Even with the guards above, keep the dev server off the LAN; front it
// with a reverse proxy (and real auth) before exposing it anywhere.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ➜  Embed Playground ready:  http://localhost:${PORT}\n`);
  console.log(`     Open it, paste your ThoughtSpot URL, click Connect (browser-session auth).`);
  if (!secretConfigured) {
    console.log(`     Trusted Auth is OFF — that's fine for browser-session use.`);
    console.log(`     To enable it: run \`npm run setup\`, fill in .env, then restart.\n`);
  }
  console.log(`  ── config ─────────────────────────────────────────────`);
  console.log(`     ThoughtSpot host : ${TS_HOST || '(not set — only needed for Trusted Auth)'}`);
  console.log(`     Trusted-auth key : ${secretConfigured ? 'configured ✓' : 'not set (Trusted Auth disabled)'}`);
  console.log(`     Default username : ${DEFAULT_USERNAME || '(none)'}`);
  console.log(`     Allowlist        : ${[...ALLOWLIST].join(', ') || '(empty)'}`);
  console.log(`     JIT (auto_create): ${ALLOW_JIT ? 'ENABLED (TS_ALLOW_JIT)' : 'disabled (fail-closed)'}`);
  console.log(`     Group guard      : ${GROUP_WILDCARD ? 'ANY (TS_GROUP_ALLOWLIST=*)' : (GROUP_ALLOWLIST.size ? [...GROUP_ALLOWLIST].join(', ') : 'none allowed')}`);
  console.log(`     Write-back stub  : ${ALLOW_DEV_PROXY ? 'enabled' : 'disabled'}\n`);
});

module.exports = app; // exported for the smoke test
