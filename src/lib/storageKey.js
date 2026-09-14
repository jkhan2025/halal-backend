// backend/src/lib/storageKey.js
//
// Storage-key construction and validation shared by upload (saveImageBuffer),
// deletion (deleteSavedImage), and signed-URL generation. Centralized so
// "what does a valid key look like" can never drift between the code that
// WRITES a key and the code that later DELETES or SIGNS one.
//
// Key shape (supabase mode adds an optional single-segment environment
// prefix; local mode never does — see photoStorage.js):
//   [<prefix>/]reports/<barcode>/<uuid>-<full|thumb>.jpg

const KEY_PREFIX_RE = /^[A-Za-z0-9_-]{1,40}$/;
const BARCODE_RE = /^\d{6,18}$/;
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STORAGE_KEY_RE = new RegExp(`^(?:[A-Za-z0-9_-]{1,40}/)?reports/\\d{6,18}/${UUID_SOURCE}-(?:full|thumb)\\.jpg$`);

// Validates STORAGE_KEY_PREFIX. Empty/unset is fine (means "no prefix" —
// today's exact unprefixed behavior). A configured value must be a single
// path segment: no "/", no "..", no leading/trailing whitespace tricks —
// this is what makes "no arbitrary slash injection" and "no path
// traversal" structural rather than a matter of caller discipline.
function sanitizeKeyPrefix(rawPrefix) {
  if (rawPrefix === undefined || rawPrefix === null) return "";
  const trimmed = String(rawPrefix).trim();
  if (!trimmed) return "";
  if (!KEY_PREFIX_RE.test(trimmed)) {
    throw new Error(
      `STORAGE_KEY_PREFIX is invalid: "${trimmed}" — must be 1-40 chars of letters, digits, "_" or "-" only (no "/", no ".")`
    );
  }
  return trimmed;
}

// barcode is expected to already be validated (digits-only, 6-18) by
// sanitizeReportInput before this is ever called — this re-checks
// defensively so a key can never be built from an unvalidated barcode even
// if this function is ever called from a new caller later.
function buildStorageKeyBase({ prefix = "", barcode, uuid }) {
  if (!BARCODE_RE.test(barcode)) {
    throw new Error("buildStorageKeyBase: barcode must already be validated digits (6-18)");
  }
  if (!UUID_RE_STRICT.test(uuid)) {
    throw new Error("buildStorageKeyBase: uuid must be a v4-shaped UUID string");
  }
  const base = `reports/${barcode}/${uuid}`;
  return prefix ? `${prefix}/${base}` : base;
}
const UUID_RE_STRICT = new RegExp(`^${UUID_SOURCE}$`);

function isValidStorageKey(key) {
  return typeof key === "string" && STORAGE_KEY_RE.test(key);
}

module.exports = {
  sanitizeKeyPrefix,
  buildStorageKeyBase,
  isValidStorageKey,
  KEY_PREFIX_RE,
  BARCODE_RE,
  STORAGE_KEY_RE,
};
