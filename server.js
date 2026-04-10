/**
 * Simple backend proxy for ThoughtSpot REST API
 * Fetches liveboard data and returns distinct filter values
 * Run: node server.js (on port 3000)
 */

const http = require('http');
const url = require('url');
const https = require('https');

// Cache for auth tokens
let cachedAuthToken = null;
let tokenExpiry = 0;

async function fetchLiveboardData(liveboardId, cookies) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      metadata_identifier: liveboardId,
      record_size: 10000,
      record_offset: 0,
      data_format: 'FULL',
    });

    console.log(`[Backend] POST /api/rest/2.0/metadata/liveboard/data`);
    console.log(`[Backend] Liveboard ID: ${liveboardId}`);
    console.log(`[Backend] Cookies present: ${!!cookies}, length: ${cookies?.length || 0}`);
    console.log(`[Backend] Request body: ${postData}`);

    const options = {
      hostname: 'ps-internal.thoughtspot.cloud',
      port: 443,
      path: '/api/rest/2.0/metadata/liveboard/data',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Cookie': cookies || '',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Node.js Backend',
      },
    };

    console.log(`[Backend] Request headers:`, options.headers);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[Backend] ✓ Response received: ${res.statusCode} ${res.statusMessage}`);
        console.log(`[Backend] Content-Type: ${res.headers['content-type']}`);
        console.log(`[Backend] Data length: ${data.length} bytes`);
        console.log(`[Backend] First 1000 chars: ${data.substring(0, 1000)}`);

        // Check if response is HTML (error page)
        if (data.startsWith('<html') || data.startsWith('<!DOCTYPE')) {
          console.error(`[Backend] ✗ Got HTML response (likely an error page)`);
          console.error(`[Backend] HTML Response:\n${data.substring(0, 2000)}`);
          reject(new Error(`ThoughtSpot returned HTML (${res.statusCode}): ${data.substring(0, 200)}`));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          console.log(`[Backend] ✓ Successfully parsed JSON response`);
          if (res.statusCode >= 400) {
            console.error(`[Backend] ✗ API returned error: ${JSON.stringify(parsed)}`);
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            console.log(`[Backend] ✓ Success response with ${parsed.contents?.length || 0} content items`);
            resolve(parsed);
          }
        } catch (e) {
          console.error(`[Backend] ✗ Failed to parse JSON:`, e.message);
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Backend] ✗ Request error:`, err.message);
      reject(err);
    });

    req.on('socket', (socket) => {
      console.log(`[Backend] → Socket connected, sending request...`);
    });

    console.log(`[Backend] → Sending request...`);
    req.write(postData);
    req.end();
    console.log(`[Backend] → Request sent, waiting for response...`);
  });
}

function getDistinctValues(data, columnName) {
  try {
    console.log(`[Backend] Extracting values for column: ${columnName}`);
    const contents = data?.contents ?? [];

    if (!contents || contents.length === 0) {
      return { error: 'No data in response contents' };
    }

    const rows = contents[0]?.data_rows ?? [];
    const cols = contents[0]?.column_names ?? [];

    console.log(`[Backend] Found ${rows.length} rows and ${cols.length} columns`);
    console.log(`[Backend] Available columns: ${cols.join(', ')}`);

    const idx = cols.indexOf(columnName);

    if (idx === -1) {
      return { error: `Column "${columnName}" not found. Available: ${cols.join(', ')}` };
    }

    // Extract values and handle nulls by converting to "{Null}" string
    const rawValues = rows.map(r => {
      const val = r[idx];
      return val === null || val === undefined ? '{Null}' : String(val);
    });

    const distinctValues = [...new Set(rawValues)].sort((a, b) => {
      // Put {Null} first
      if (a === '{Null}') return -1;
      if (b === '{Null}') return 1;
      return a.localeCompare(b);
    });

    console.log(`[Backend] Found ${distinctValues.length} distinct values for ${columnName}: ${distinctValues.slice(0, 10).join(', ')}${distinctValues.length > 10 ? '...' : ''}`);
    return { column: columnName, values: distinctValues, count: distinctValues.length };
  } catch (err) {
    console.error(`[Backend] Error extracting values:`, err);
    return { error: err.message };
  }
}

const server = http.createServer(async (req, res) => {
  // Enable CORS with credentials support
  const origin = req.headers.origin;
  // Allow localhost origins with credentials
  if (origin && origin.includes('localhost') || origin?.includes('127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // GET /filter-values?liveboard=ID&column=NAME
  if (pathname === '/filter-values' && req.method === 'GET') {
    const { liveboard, column } = parsedUrl.query;

    if (!liveboard || !column) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing liveboard or column query param' }));
      return;
    }

    try {
      // Get cookies from the browser request to maintain auth session
      const cookies = req.headers.cookie || '';
      console.log(`[Backend] Request for column="${column}" from liveboard="${liveboard}"`);
      console.log(`[Backend] Cookies received: ${cookies.substring(0, 50)}...`);

      const data = await fetchLiveboardData(liveboard, cookies);
      const result = getDistinctValues(data, column);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[Backend] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DEBUG endpoint: /debug?liveboard=ID
  if (pathname === '/debug' && req.method === 'GET') {
    const { liveboard } = parsedUrl.query;
    if (!liveboard) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing liveboard param' }));
      return;
    }

    try {
      const cookies = req.headers.cookie || '';
      console.log(`[DEBUG] Fetching raw data for liveboard: ${liveboard}`);
      const data = await fetchLiveboardData(liveboard, cookies);

      // Return summary of the data
      const summary = {
        has_contents: !!data.contents,
        contents_length: data.contents?.length || 0,
        first_content: data.contents?.[0] ? {
          column_names: data.contents[0].column_names || [],
          data_rows_count: data.contents[0].data_rows?.length || 0,
          first_row: data.contents[0].data_rows?.[0] || null,
        } : null,
        raw_response_keys: Object.keys(data),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary, null, 2));
    } catch (err) {
      console.error('[DEBUG] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Try /filter-values?liveboard=ID&column=NAME or /debug?liveboard=ID' }));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Filter proxy running on http://localhost:${PORT}`);
  console.log(`   Endpoint: GET /filter-values?liveboard=ID&column=NAME`);
});
