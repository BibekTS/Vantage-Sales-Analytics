/**
 * auth.js — ThoughtSpot session verification
 *
 * Exported function:
 *   checkAuth(host) → Promise<'ok' | 'unauthenticated' | 'cors' | {status:'error', msg:string}>
 */

/**
 * Checks whether the current browser session is authenticated with ThoughtSpot.
 *
 * @param {string} host  The ThoughtSpot instance base URL (e.g. https://example.thoughtspot.cloud)
 * @returns {Promise<'ok'|'unauthenticated'|'cors'|{status:'error',msg:string}>}
 *
 * Return values:
 *   'ok'              — HTTP 200, valid session
 *   'unauthenticated' — HTTP 401 / 403, not logged in
 *   'cors'            — AbortError (5 s timeout) or TypeError (CORS / network unreachable)
 *   {status:'error'}  — Unexpected HTTP status or unhandled exception
 */
export async function checkAuth(host) {
  const url = `${host.replace(/\/$/, '')}/api/rest/2.0/auth/session/user`;
  const controller = new AbortController();
  // 5 s timeout — CORS hangs from file:// never resolve on their own
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) return 'ok';
    if (resp.status === 401 || resp.status === 403) return 'unauthenticated';
    return { status: 'error', msg: `ThoughtSpot returned HTTP ${resp.status} — check the host URL.` };
  } catch (err) {
    clearTimeout(timer);
    // AbortError  → our 5 s timeout fired (CORS hang or very slow network)
    // TypeError   → CORS block or network unreachable (browser lumps these together)
    if (err.name === 'AbortError' || err instanceof TypeError) return 'cors';
    return { status: 'error', msg: err.message };
  }
}
