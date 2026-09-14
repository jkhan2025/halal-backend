// backend/src/config/adminAuth.js
//
// Fail-closed admin-secret check for internal moderation endpoints.
//
// This is DELIBERATELY different from server.js's existing requireApiKey,
// which silently becomes public when API_KEY is unset (`if (!API_KEY)
// return next();`) — that's an acceptable default for its one, optional,
// non-moderation use. Moderation endpoints must never become reachable
// just because ADMIN_KEY happens to be empty or misconfigured, so this
// module fails CLOSED: no configured key means the endpoint is
// unavailable, not public.
//
// The key is passed in by the caller (server.js reads it from
// process.env once at boot) rather than read from process.env here, so
// this stays a pure, unit-testable function with no environment coupling.

const crypto = require("node:crypto");

// Constant-time comparison. crypto.timingSafeEqual requires equal-length
// buffers, so a length mismatch is handled by comparing the provided value
// against itself (still constant-time for that length) before returning
// false — this avoids a fast-path early-return purely on length that could
// otherwise leak the secret's length via response timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function createRequireAdminKey(adminKey, { headerName = "x-admin-key" } = {}) {
  const configured = typeof adminKey === "string" ? adminKey.trim() : "";
  return function requireAdminKey(req, res, next) {
    if (!configured) {
      // Fail closed — never fall through to `next()` here.
      return res.status(503).json({ ok: false, error: "MODERATION_UNAVAILABLE" });
    }
    const provided = req.header(headerName) || "";
    if (!provided || !safeEqual(provided, configured)) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }
    return next();
  };
}

module.exports = { createRequireAdminKey, safeEqual };
