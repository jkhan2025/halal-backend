// backend/src/config/httpSecurityHeaders.js
//
// Builds the helmet() options object for the current runtime mode.
//
// Local/LAN dev mode serves plain HTTP only (enforced by runtimeSafety —
// local MONGO_URI/PUBLIC_BASE_URL/etc. all require http:, never https:).
// helmet's defaults include Strict-Transport-Security (HSTS) and CSP's
// upgrade-insecure-requests directive on every response, including error
// responses like a 404. Sending those over plain HTTP is not just useless —
// on some mobile HTTP client stacks, receiving an HSTS header (even over
// plain HTTP, where browsers ignore it per spec, but not every client
// stack does) can cause the client to attempt to upgrade its NEXT request
// to this exact host to HTTPS. This dev server never serves HTTPS, so that
// upgraded request fails outright — breaking every request after the
// first response from this host, with no visible connection to the
// original (perfectly fine) response that triggered it.
//
// So local/LAN mode never sends either header; protected (real HTTPS)
// mode keeps the full, unmodified helmet defaults.

function buildHelmetOptions(mode) {
  const options = { crossOriginResourcePolicy: { policy: "cross-origin" } };
  if (mode !== "protected") {
    options.hsts = false;
    options.contentSecurityPolicy = { useDefaults: true, directives: { upgradeInsecureRequests: null } };
  }
  return options;
}

module.exports = { buildHelmetOptions };
