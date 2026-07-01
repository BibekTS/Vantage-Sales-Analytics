/**
 * scripts/vendor-sdk.mjs — self-host the ThoughtSpot Visual Embed SDK (supply-chain hardening).
 *
 * By default the app loads the SDK from unpkg at runtime (zero-setup, but a third-party CDN you
 * load auth-token-handling code from with no integrity check). Run this to pull a pinned copy —
 * the entry bundle AND every chunk it lazy-imports — into ./vendor, then serve it from your own
 * origin (server.js already exposes /vendor).
 *
 *   node scripts/vendor-sdk.mjs
 *   # then in js/embed.js change the import URL to:  /vendor/visual-embed-sdk/tsembed.es.js
 *
 * Re-run after bumping SDK_VERSION to refresh the pin.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SDK_VERSION = '1.49.0';
const BASE = `https://unpkg.com/@thoughtspot/visual-embed-sdk@${SDK_VERSION}/dist/`;
const ENTRY = 'tsembed.es.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'vendor', 'visual-embed-sdk');

// Match static `from './x.js'` and dynamic `import('./x.js')` chunk references.
const CHUNK_RE = /(?:from|import)\s*\(?\s*['"](\.\/[^'"]+\.js)['"]/g;

async function main() {
  await mkdir(OUT, { recursive: true });
  const seen = new Set();
  const queue = [ENTRY];
  let count = 0;

  while (queue.length) {
    const name = queue.shift().replace(/^\.\//, '');
    if (seen.has(name)) continue;
    seen.add(name);

    const url = BASE + name;
    process.stdout.write(`  fetching ${name} … `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const code = await res.text();
    await writeFile(path.join(OUT, name), code, 'utf8');
    count += 1;
    console.log(`${(code.length / 1024).toFixed(0)} KB`);

    for (const m of code.matchAll(CHUNK_RE)) {
      const ref = m[1].replace(/^\.\//, '');
      if (!seen.has(ref)) queue.push(ref);
    }
  }

  console.log(`\nVendored ${count} file(s) → vendor/visual-embed-sdk/ (pinned @ ${SDK_VERSION})`);
  console.log("Next: in js/embed.js, change the SDK import URL to '/vendor/visual-embed-sdk/tsembed.es.js'");
}

main().catch(err => { console.error(`\nvendor-sdk failed: ${err.message}`); process.exit(1); });
