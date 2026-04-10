/**
 * Vantage Sales — ThoughtSpot Embed Configuration
 * Edit this file to update your ThoughtSpot connection and object GUIDs.
 */
window.TS_CONFIG = {
  // ── ThoughtSpot Instance ──────────────────────────────────────────────────
  thoughtSpotHost: 'https://ps-internal.thoughtspot.cloud',
  authType: 'None', // Options: None | TrustedAuthToken | EmbedSecret | SAMLRedirect | OIDCRedirect

  // ── Data Objects ──────────────────────────────────────────────────────────
  worksheetId: '04d7c86c-cac6-410d-ac7d-9698bda8b21b', // Used by Search + Spotter
  liveboardId: '47074597-d3fa-4dd1-944b-258254353a04', // Used by Liveboard + Visualization
  vizId:       '429e43c4-7368-4959-9a60-4ecbea225bcd', // Used by Visualization (paired with liveboardId)

  // ── Search Defaults ───────────────────────────────────────────────────────
  searchTokenString: '[Sales Amount] [Region]',   // Optional: pre-populate the search bar e.g. '[Sales Amount] [Region]'
  executeSearch: true,    // If true, auto-runs the searchTokenString on load

  // ── Custom Filters ────────────────────────────────────────────────────────
  filterColumns: ['Territory'],  // Backend will fetch distinct values from the liveboard

  // devFeatures: true,  // Uncomment to force-show dev-only features (Custom Actions, Code-Based Actions, Host Events) in production
};
