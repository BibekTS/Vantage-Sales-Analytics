/**
 * config.js — OPTIONAL seed defaults for the ThoughtSpot Embed Playground.
 *
 * You do NOT need to edit this file to use the playground — set everything in the
 * UI (top connection bar + the Object section) and share your setup with a link.
 * Anything you put here just pre-fills the inputs on first load (before any saved
 * state or shared link takes over). Leave blank to start empty.
 *
 * Precedence at boot: URL hash (#s=…) > localStorage > this seed > built-in defaults.
 */
window.TS_CONFIG = {
  thoughtSpotHost: '',   // e.g. 'https://your-instance.thoughtspot.cloud'
  worksheetId:     '',   // optional starter Worksheet/Model GUID
  liveboardId:     '',   // optional starter Liveboard GUID
  vizId:           '',   // optional starter Visualization GUID
  searchTokenString: '', // optional: pre-fill the Search embed query
  executeSearch:   false,
};

// If you serve the static frontend from a DIFFERENT origin than the token server
// (e.g. VS Code Live Server on :5500 while `npm start` runs on :3000), point the
// API calls at the server here. Same-origin (npm start serving everything) needs nothing.
// window.TS_API_BASE = 'http://localhost:3000';
