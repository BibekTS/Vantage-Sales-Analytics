/**
 * scripts/boot-check.mjs — boots the real server and loads the app in headless Chrome.
 *
 * The third gate of the verification bar (see CLAUDE.md): smoke-test proves the server's
 * security contract; this proves the FRONTEND actually boots — all ES modules import, the
 * tool shell mounts, and the console stays clean. A syntax error anywhere in js/*.js fails
 * here even though the smoke test (which only asserts the file is served) stays green.
 *
 * Run with `npm run boot-check`. Pass criteria:
 *   ✓ page loads (HTTP 200) and the tool shell mounts (#embed-list / .rail-group / #inspector)
 *   ✓ zero JS console/page errors
 *   ✓ no non-favicon 4xx/5xx responses (the /favicon.ico 404 on the restricted static
 *     server is pre-existing and allowed)
 *   ✓ XSS probe (BACKLOG S1): an <img onerror> payload in a #s=-hash group name renders as
 *     inert text in the auth chips and the Event Log — it must never execute
 *
 * Chrome resolution: $CHROME_PATH, then the standard macOS / Linux install locations
 * (GitHub's ubuntu runners ship google-chrome). Requires devDependency puppeteer-core.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 34921; // distinct from smoke-test's 34917 and dev's 3000/5500
const BASE = `http://127.0.0.1:${PORT}`;

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.error('boot-check: no Chrome binary found — set CHROME_PATH.');
  process.exit(1);
}

// Whole-run watchdog: a hung CDN fetch or navigation must not stall CI indefinitely.
const watchdog = setTimeout(() => {
  console.error('boot-check: watchdog timeout (120s) — treating as failure.');
  process.exit(1);
}, 120_000);

// Clean env like smoke-test: the frontend boot must not depend on the developer's .env.
const env = { ...process.env, PORT: String(PORT), THOUGHTSPOT_HOST: '', TS_SECRET_KEY: '' };
const server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/auth/config`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

// XSS regression probe (BACKLOG S1): an <img onerror> payload smuggled into state.auth.groups
// via the #s= share hash must render as INERT TEXT in both sinks it can reach — the auth
// modal's group chips (chipsEditor) and the Event Log (mintToken interpolates the group list
// into logEvent's message). A regression to innerHTML in either sink executes the payload and
// sets window.__xss. Runs on its own page so the vuln-case GET /x 404 can't pollute the shell
// contract; the assertion is the window flag, NOT error capture — a successful inline onerror
// throws nothing and its resource-load console line is filtered anyway. Clicks are retried
// under waitForFunction (not fixed sleeps): the handlers bind only after the whole module
// graph executes, and a too-early click is a silent no-op that would flake the gate.
async function runXssProbe(browser) {
  const XSS = '<img src=x onerror="window.__xss=1">';
  const hash = Buffer.from(
    JSON.stringify({ authType: 'TrustedAuthTokenCookieless', auth: { groups: [XSS] } }), 'utf8'
  ).toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = []; // diagnostics only — tells "app crashed" apart from "sink regressed"
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    // 30s cap (not the main goto's 60s): assets are already in the browser cache from the
    // primary page, and two full 60s budgets would eat the 120s whole-run watchdog.
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    const retryUntil = (fn) =>
      probe.waitForFunction(fn, { polling: 500, timeout: 20_000 }).then(() => true, () => false);
    // Positive controls: the payload must actually REACH each sink as text, otherwise a UI
    // change (renamed button, modal not opening) would turn this probe into a silent no-op.
    const inChip = await retryUntil(() => {
      const hit = [...document.querySelectorAll('.chip')].some((c) => c.textContent.includes('<img src=x'));
      if (!hit) document.getElementById('auth-config-btn')?.click();
      return hit;
    });
    const inLog = await retryUntil(() => {
      const hit = (document.getElementById('log-list')?.textContent || '').includes('<img src=x');
      if (!hit) document.querySelector('.auth-actions button')?.click(); // "Mint token (inspect)"
      return hit;
    });
    await sleep(600); // a would-be onerror task needs a beat to fire before we read the flag
    const executed = await probe.evaluate(() => window.__xss === 1);
    return { executed, inChip, inLog, probeErrors };
  } finally {
    await probe.close();
  }
}

let ok = false;
let browser;
try {
  if (!(await waitForReady())) {
    console.error('boot-check: server did not become ready.\n' + serverErr);
    process.exit(1);
  }

  const errors = [];       // JS console errors (resource-load failures judged via responses)
  const badResponses = []; // non-favicon 4xx/5xx

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return;
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`);
  });

  const resp = await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(1500); // let the ES modules run

  const shellMounted = await page.$('#embed-list, .rail-group, #inspector') !== null;

  console.log(`HTTP status: ${resp.status()}`);
  console.log(`tool shell mounted: ${shellMounted}`);
  console.log(`JS console/page errors: ${errors.length}`);
  errors.forEach((e) => console.log('  -', e));
  console.log(`non-favicon bad responses: ${badResponses.length}`);
  badResponses.forEach((e) => console.log('  -', e));

  const xss = await runXssProbe(browser);
  console.log(`XSS probe — payload executed: ${xss.executed}`);
  console.log(`XSS probe — rendered inert in auth group chips: ${xss.inChip}`);
  console.log(`XSS probe — rendered inert in event log: ${xss.inLog}`);
  xss.probeErrors.forEach((e) => console.log('  - probe page:', e));

  ok = resp.status() === 200 && shellMounted && errors.length === 0 && badResponses.length === 0
    && !xss.executed && xss.inChip && xss.inLog;
  console.log(ok ? '\nBOOT CHECK: PASS' : '\nBOOT CHECK: FAIL');
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  clearTimeout(watchdog);
}
process.exit(ok ? 0 : 1);
