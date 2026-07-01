/**
 * scripts/setup.mjs — one-command setup for Trusted Auth (`npm run setup`).
 *
 * You do NOT need this to try the playground: `npm start` works with browser-session auth and no
 * .env at all. Run this only when you want the trusted-auth token service. It copies .env.example
 * to .env (never overwriting an existing .env) and tells you the two values to fill in.
 */

import { existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(ROOT, '.env');
const examplePath = path.join(ROOT, '.env.example');

if (existsSync(envPath)) {
  console.log('\n  .env already exists — leaving it untouched.');
  console.log('  Edit it directly if you want to change Trusted Auth settings.\n');
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error('\n  Could not find .env.example — are you running this from the project root?\n');
  process.exit(1);
}

copyFileSync(examplePath, envPath);
console.log(`
  ✓ Created .env from .env.example

  Open .env and fill in (only needed for Trusted Auth):

    THOUGHTSPOT_HOST   your instance URL, e.g. https://my-co.thoughtspot.cloud
    TS_SECRET_KEY      Develop → Customizations → Security Settings → Trusted authentication

  Then start the server:

    npm start

  (Browser-session auth needs neither value — just run npm start and click Connect.)
`);
