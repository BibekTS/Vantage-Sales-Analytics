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

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/auth/config`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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
  await new Promise((r) => setTimeout(r, 1500)); // let the ES modules run

  const shellMounted = await page.$('#embed-list, .rail-group, #inspector') !== null;

  console.log(`HTTP status: ${resp.status()}`);
  console.log(`tool shell mounted: ${shellMounted}`);
  console.log(`JS console/page errors: ${errors.length}`);
  errors.forEach((e) => console.log('  -', e));
  console.log(`non-favicon bad responses: ${badResponses.length}`);
  badResponses.forEach((e) => console.log('  -', e));

  ok = resp.status() === 200 && shellMounted && errors.length === 0 && badResponses.length === 0;
  console.log(ok ? '\nBOOT CHECK: PASS' : '\nBOOT CHECK: FAIL');
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  clearTimeout(watchdog);
}
process.exit(ok ? 0 : 1);
