/**
 * lib/multipart.js — a small, dependency-free, binary-safe multipart/form-data parser.
 *
 * ThoughtSpot delivers a scheduled-Liveboard (LIVEBOARD_SCHEDULE) webhook to a plain endpoint as
 * `multipart/form-data`: a JSON metadata part plus the rendered report as a binary file attachment
 * (PDF/CSV/XLSX). Express has no built-in multipart parser and the project keeps dependencies to a
 * minimum, so this parses the raw request bytes directly. It is intentionally small — enough to pull
 * out the text/JSON fields and the file parts of a well-formed body; it is NOT a general RFC-7578
 * implementation (no nested multipart, no base64 transfer-encoding).
 *
 * Binary-safety matters: the report bytes can contain anything, so splitting is done on the
 * CRLF-prefixed boundary (`\r\n--boundary`) over Buffers — never by decoding the body to a string.
 */

'use strict';

/** Extract the boundary token from a Content-Type header value. Returns '' if absent. */
function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return m ? (m[1] || m[2] || '').trim() : '';
}

/**
 * Parse a multipart/form-data body.
 * @param {Buffer} buf   raw request body bytes
 * @param {string} boundary  the boundary token (without leading dashes)
 * @returns {Array<{name:string|null, filename:string|null, contentType:string|null, data:Buffer}>}
 */
function parseMultipart(buf, boundary) {
  const parts = [];
  if (!Buffer.isBuffer(buf) || !boundary) return parts;

  const dash = Buffer.from(`--${boundary}`);
  const crlfDash = Buffer.from(`\r\n--${boundary}`);
  const headerSep = Buffer.from('\r\n\r\n');

  let start = buf.indexOf(dash); // opening boundary has no leading CRLF
  if (start < 0) return parts;
  start += dash.length;

  while (start < buf.length) {
    // Right after a boundary: "--" ⇒ closing boundary (done); "\r\n" ⇒ another part follows.
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;

    const next = buf.indexOf(crlfDash, start);
    if (next < 0) break;

    const seg = buf.slice(start, next);
    const hEnd = seg.indexOf(headerSep);
    if (hEnd >= 0) {
      const headerStr = seg.slice(0, hEnd).toString('utf8');
      const data = seg.slice(hEnd + headerSep.length);
      const headers = {};
      headerStr.split('\r\n').forEach((line) => {
        const c = line.indexOf(':');
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      });
      const cd = headers['content-disposition'] || '';
      const name = (/name="([^"]*)"/.exec(cd) || [])[1] ?? null;
      const filename = (/filename="([^"]*)"/.exec(cd) || [])[1] ?? null;
      parts.push({ name, filename, contentType: headers['content-type'] || null, data });
    }

    // Advance past this delimiter to the start of the next part (or the closing boundary).
    start = next + 2 + dash.length; // skip the leading CRLF, then "--boundary"
  }
  return parts;
}

/**
 * Given parsed parts, split them into the JSON metadata object and the file attachments.
 * The metadata part is the first non-file part whose body parses as JSON (ThoughtSpot's field name
 * for it is not contractually fixed, so we detect by content, not by name). Falls back to exposing
 * any remaining text fields as a plain object.
 * @returns {{ meta: object, files: Array<{name:string|null, filename:string, contentType:string|null, data:Buffer}> }}
 */
function splitMultipart(parts) {
  const files = [];
  let meta = null;
  const textFields = {};
  for (const p of parts) {
    if (p.filename) { files.push(p); continue; }
    const text = p.data.toString('utf8');
    if (meta == null) {
      try { meta = JSON.parse(text); continue; } catch { /* not the JSON part */ }
    }
    if (p.name) textFields[p.name] = text;
  }
  if (meta == null) meta = textFields;
  else if (Object.keys(textFields).length) meta.__fields = textFields;
  return { meta, files };
}

module.exports = { boundaryOf, parseMultipart, splitMultipart };
