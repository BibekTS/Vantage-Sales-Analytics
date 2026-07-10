/**
 * scripts/check-ts-updates.mjs — ts-watch DETECTOR (never edits anything).
 *
 * The cheap, deterministic front half of the "keep up with ThoughtSpot" pipeline. It answers one
 * question: has anything the playground tracks drifted since the last merged watermark? It checks
 *   1. pin consistency  — ts-sdk-version.json === the version in js/embed.js (hard failure if not)
 *   2. npm              — latest @thoughtspot/visual-embed-sdk vs our pin
 *   3. GitHub releases   — SDK release tags newer than the last processed one (soft on rate-limit)
 *   4. watched doc pages — content hash vs the watermark (detects edits on unversioned pages)
 *
 * Exit-code contract (the scheduled routine branches on this):
 *   0  → no changes; the routine stops silently
 *   10 → changes detected; the routine follows docs/ts-watch-playbook.md
 *   1  → a real error (bad pin, unreadable files); the routine reports and stops
 *
 * Flags:  --json  emit a machine-readable block in addition to the human summary.
 * Zero dependencies, Node ≥18 (global fetch). Matches the style of the other scripts/*.mjs.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WANT_JSON = process.argv.includes('--json');
const NPM_PKG = '@thoughtspot/visual-embed-sdk';

const out = [];
const log = (s = '') => out.push(s);

function semverCmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
}

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'ts-watch-detector' }, ...opts });
  return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
}

// Strip HTML tags + collapse whitespace so a page's *content* is hashed, not incidental markup churn.
function contentHash(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

async function main() {
  const result = {
    pinConsistent: true,
    changes: [],           // human-facing change descriptions
    sdk: {},
    docs: {},
    errors: [],
  };

  // ---- 1. Pin consistency (hard requirement) --------------------------------
  const pin = (await readJson('ts-sdk-version.json')).version;
  const embed = await readFile(path.join(ROOT, 'js/embed.js'), 'utf8');
  const m = embed.match(/visual-embed-sdk@(\d+\.\d+\.\d+)/);
  const embedVersion = m ? m[1] : null;
  if (!embedVersion) {
    result.pinConsistent = false;
    result.errors.push('Could not find the SDK version in js/embed.js import URL.');
  } else if (embedVersion !== pin) {
    result.pinConsistent = false;
    result.errors.push(`Pin drift: ts-sdk-version.json=${pin} but js/embed.js=${embedVersion}. Reconcile before anything else.`);
  }
  result.sdk.pinnedVersion = pin;

  // ---- watermark ------------------------------------------------------------
  let watermark;
  try {
    watermark = await readJson('docs/.ts-watch.json');
  } catch (e) {
    result.errors.push('Cannot read docs/.ts-watch.json watermark: ' + e.message);
  }

  // ---- 2. npm latest --------------------------------------------------------
  try {
    const r = await fetchText(`https://registry.npmjs.org/${NPM_PKG}`);
    if (r.ok) {
      const reg = JSON.parse(r.text);
      const latest = reg['dist-tags']?.latest;
      result.sdk.npmLatest = latest;
      if (latest && semverCmp(latest, pin) > 0) {
        // versions published strictly newer than the pin (with dates from the time map)
        const newer = Object.keys(reg.time || {})
          .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && semverCmp(v, pin) > 0)
          .sort(semverCmp)
          .map((v) => `${v} (${(reg.time[v] || '').slice(0, 10)})`);
        result.sdk.newerVersions = newer;
        result.changes.push(`SDK: pinned ${pin} → npm latest ${latest}${newer.length ? ` (${newer.length} newer: ${newer.join(', ')})` : ''}`);
      }
    } else {
      result.errors.push(`npm registry returned ${r.status}`);
    }
  } catch (e) {
    result.errors.push('npm check failed: ' + e.message);
  }

  // ---- 3. GitHub releases (soft on rate-limit) ------------------------------
  try {
    const r = await fetchText('https://api.github.com/repos/thoughtspot/visual-embed-sdk/releases?per_page=10');
    if (r.ok) {
      const releases = JSON.parse(r.text);
      const lastProcessed = (watermark?.sdk?.lastProcessedGithubRelease || `v${pin}`).replace(/^v/, '');
      const fresh = releases
        .map((rel) => (rel.tag_name || '').replace(/^v/, ''))
        .filter((t) => /^\d+\.\d+\.\d+$/.test(t) && semverCmp(t, lastProcessed) > 0);
      result.sdk.newGithubReleases = fresh;
      if (fresh.length) result.changes.push(`GitHub: ${fresh.length} release(s) newer than v${lastProcessed}: ${fresh.join(', ')}`);
    } else if (r.status === 403) {
      log('  (GitHub releases: rate-limited (403) — skipped, not an error)');
    } else {
      result.errors.push(`GitHub releases returned ${r.status}`);
    }
  } catch (e) {
    result.errors.push('GitHub check failed: ' + e.message);
  }

  // ---- 4. watched doc pages -------------------------------------------------
  const watched = watermark?.releaseNotes?.watchedUrls || [];
  const knownHashes = watermark?.releaseNotes?.contentHashes || {};
  for (const url of watched) {
    try {
      const r = await fetchText(url);
      if (!r.ok) {
        result.docs[url] = { status: r.status, moved: r.status === 404 };
        result.changes.push(`DOC ${r.status}${r.status === 404 ? ' (moved? WebSearch for the successor page)' : ''}: ${url}`);
        continue;
      }
      const h = contentHash(r.text);
      const prev = knownHashes[url];
      result.docs[url] = { status: 200, changed: prev !== h, hash: h };
      if (prev && prev !== h) result.changes.push(`DOC changed: ${url}`);
      else if (!prev) result.changes.push(`DOC new (no baseline hash yet): ${url}`);
    } catch (e) {
      result.docs[url] = { error: e.message };
      result.errors.push(`doc fetch failed (${url}): ${e.message}`);
    }
  }

  // ---- report ---------------------------------------------------------------
  log('ts-watch detector');
  log('=================');
  log(`pin (ts-sdk-version.json): ${pin}` + (result.pinConsistent ? '  ✓ consistent with js/embed.js' : '  ✗ INCONSISTENT'));
  if (result.sdk.npmLatest) log(`npm latest: ${result.sdk.npmLatest}`);
  log('');
  if (result.changes.length) {
    log(`CHANGES DETECTED (${result.changes.length}):`);
    result.changes.forEach((c) => log('  • ' + c));
  } else {
    log('No changes detected.');
  }
  if (result.errors.length) {
    log('');
    log(`Errors (${result.errors.length}):`);
    result.errors.forEach((e) => log('  ! ' + e));
  }

  console.log(out.join('\n'));
  if (WANT_JSON) console.log('\n---JSON---\n' + JSON.stringify(result, null, 2));

  // Exit-code contract
  if (!result.pinConsistent || result.errors.length) return 1;
  if (result.changes.length) return 10;
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('ts-watch detector crashed:', e);
  process.exit(1);
});
