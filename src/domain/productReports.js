// backend/src/domain/productReports.js
//
// "Product not found" report creation, backing POST /api/reports.
// Ported from the working implementation in backend/index.js, but using
// server.js's OWN Submission model/schema and its own saveImageBuffer
// storage helper (server.js's canonical, already-connected persistence
// path) instead of the separate backend/models/Submission.js file index.js
// used — that keeps this on the one Submission architecture server.js
// already runs, and specifically avoids the orphaned reports.routes.js /
// nonexistent Report model.
//
// All Mongo/storage/id dependencies are passed in as parameters so this
// stays testable with fakes — no real Mongo connection or file I/O needed.
//
// HARDENING PASS (submission moderation v1 / public endpoint hardening):
// this file now does full server-side validation of an untrusted, public,
// unauthenticated request BEFORE any disk write happens — the mobile
// client's own ~900,000-char combined guard is a UX nicety, never the
// actual boundary. Bounds below are deliberately explicit and app-level
// (not just inherited from server.js's express.json({limit:"1mb"})),
// so they're independently testable and won't silently change if that
// unrelated body-size limit is ever retuned.

const { buildStorageKeyBase } = require("../lib/storageKey");

const MIN_BARCODE_LEN = 6;
const MAX_BARCODE_LEN = 18;
// Matches the barcode contract already established elsewhere in this app:
// frontend/src/scannerExperience.js's isValidBarcode() (6-18 digits) and
// server.js's own /v1/submissions normalizeBarcode() (>=6, sliced to 18).
const BARCODE_RE = new RegExp(`^\\d{${MIN_BARCODE_LEN},${MAX_BARCODE_LEN}}$`);

const MAX_MESSAGE_LEN = 2000;

// The live mobile client (ReportUnknownScreen.js) always submits exactly
// one front-label photo and one ingredients photo — never 0, 1, or more
// than 2. Locking to that exact, currently-supported count (rather than
// the old, never-actually-exercised "0-5 photos" allowance) is part of
// this hardening pass.
const REQUIRED_PHOTO_COUNT = 2;

// Decoded (post-base64) byte ceilings. The mobile client compresses to a
// max 1400px edge at JPEG quality 0.65, which in practice produces photos
// well under these limits (typically 80-300KB) — these are deliberately
// generous but bounded application-level caps, smaller than what the
// outer 1MB JSON body limit could ever actually carry for this shape of
// payload once base64 inflation + the second photo + JSON overhead are
// accounted for, so they are the constraint that actually fires in
// testing, not an accidental side effect of body-parser's own limit.
const PER_PHOTO_MAX_DECODED_BYTES = 900_000;
const COMBINED_PHOTOS_MAX_DECODED_BYTES = 1_400_000;

// Only the formats the mobile client can actually produce (always JPEG
// today) plus the two other common web-safe raster formats. HEIC/HEIF are
// deliberately excluded here (unlike the more-trusted, API-key-gated
// /v1/submissions multer filter) — the public, unauthenticated endpoint
// only needs to accept what its one real caller sends.
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

// Magic-byte sniffing: never trust the declared `data:<mime>` prefix on
// its own — confirm the decoded bytes actually look like that format.
const IMAGE_SIGNATURES = [
  {
    mime: "image/jpeg",
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    check: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/webp",
    check: (b) =>
      b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

function sniffImageMime(buffer) {
  const match = IMAGE_SIGNATURES.find((sig) => sig.check(buffer));
  return match ? match.mime : null;
}

// Kept for backward compatibility — some callers/tests decode a bare
// base64 string or a data URL without the stricter format/mime rules
// enforced below. No longer used internally by createProductReport,
// which now goes through the stricter validateReportPhotos() below.
function decodeBase64Image(input) {
  if (!input || typeof input !== "string") return null;
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(input);
  const base64 = match ? match[2] : input;
  if (!base64) return null;
  try {
    const buffer = Buffer.from(base64, "base64");
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

// Strict, discriminated result: { valid: true, barcode, message } or
// { valid: false, error }. Replaces the old null-on-failure contract so
// callers (and tests) can distinguish exactly which rule was violated.
function sanitizeReportInput({ barcode, message } = {}) {
  if (typeof barcode !== "string" || !barcode.trim()) {
    return { valid: false, error: "MISSING_BARCODE" };
  }
  const cleanBarcode = barcode.trim();
  if (!BARCODE_RE.test(cleanBarcode)) {
    return { valid: false, error: "INVALID_BARCODE" };
  }

  if (typeof message !== "string" || !message.trim()) {
    return { valid: false, error: "MISSING_MESSAGE" };
  }
  const cleanMessage = message.trim();
  if (cleanMessage.length > MAX_MESSAGE_LEN) {
    return { valid: false, error: "MESSAGE_TOO_LONG" };
  }

  return { valid: true, barcode: cleanBarcode, message: cleanMessage };
}

// Validates the ENTIRE photos array up front — format, decodability,
// declared-vs-actual image type, per-photo size, and combined size — and
// only returns decoded buffers once every entry has passed every rule.
// createProductReport never writes anything to disk until this returns
// { valid: true }, so a malformed/oversized payload never causes a
// partial or wasted disk write.
function validateReportPhotos(photos) {
  if (!Array.isArray(photos) || photos.length !== REQUIRED_PHOTO_COUNT) {
    return { valid: false, error: "WRONG_PHOTO_COUNT" };
  }

  const decoded = [];
  let combined = 0;
  for (let i = 0; i < photos.length; i++) {
    const raw = photos[i];
    if (typeof raw !== "string") {
      return { valid: false, error: "INVALID_PHOTO_FORMAT" };
    }
    const match = DATA_URL_RE.exec(raw);
    if (!match) {
      return { valid: false, error: "INVALID_PHOTO_FORMAT" };
    }
    const declaredMime = match[1];
    let buffer;
    try {
      buffer = Buffer.from(match[2], "base64");
    } catch {
      return { valid: false, error: "INVALID_PHOTO_FORMAT" };
    }
    if (!buffer.length) {
      return { valid: false, error: "INVALID_PHOTO_FORMAT" };
    }
    const sniffed = sniffImageMime(buffer);
    if (!sniffed || sniffed !== declaredMime) {
      return { valid: false, error: "UNSUPPORTED_IMAGE_TYPE" };
    }
    if (buffer.length > PER_PHOTO_MAX_DECODED_BYTES) {
      return { valid: false, error: "PHOTO_TOO_LARGE" };
    }
    combined += buffer.length;
    if (combined > COMBINED_PHOTOS_MAX_DECODED_BYTES) {
      return { valid: false, error: "PHOTOS_TOO_LARGE" };
    }
    decoded.push({ buffer, kind: i === 0 ? "front" : "ingredients" });
  }

  return { valid: true, photos: decoded };
}

async function createProductReport(
  { Submission, saveImageBuffer, uuidv4, deleteSavedImage },
  { barcode, message, photos, client = {} } = {}
) {
  const clean = sanitizeReportInput({ barcode, message });
  if (!clean.valid) {
    return { ok: false, status: 400, error: clean.error };
  }

  const photoCheck = validateReportPhotos(photos);
  if (!photoCheck.valid) {
    return { ok: false, status: 400, error: photoCheck.error };
  }

  // Every photo is already validated at this point — writes only start
  // once the whole request is known-good.
  const savedPhotos = [];
  const writtenKeys = [];
  try {
    for (const { buffer, kind } of photoCheck.photos) {
      const keyBase = buildStorageKeyBase({ barcode: clean.barcode, uuid: uuidv4() });
      const saved = await saveImageBuffer({ buffer, keyBase, contentType: "image/jpeg" });
      if (saved?.full?.key) writtenKeys.push(saved.full.key);
      if (saved?.thumb?.key) writtenKeys.push(saved.thumb.key);
      savedPhotos.push({ url: saved.full.url, key: saved.full.key, kind });
    }
  } catch (err) {
    // A later photo in the same request failed to write after an earlier
    // one succeeded (disk full, sharp error, Supabase upload failure, etc.) —
    // clean up everything already written for THIS request rather than
    // leaving orphan files/objects.
    await cleanupWrittenKeys(writtenKeys, deleteSavedImage);
    return { ok: false, status: 500, error: "PHOTO_STORAGE_FAILED" };
  }

  let doc;
  try {
    doc = await Submission.create({
      barcode: clean.barcode,
      notes: clean.message,
      photos: savedPhotos,
      client,
    });
  } catch (err) {
    // All photo uploads succeeded, but persisting the Submission document
    // failed — the request as a whole did not succeed, so nothing it
    // wrote to storage should survive it either. Only the objects/files
    // created during THIS request are ever cleanup candidates here.
    await cleanupWrittenKeys(writtenKeys, deleteSavedImage);
    return { ok: false, status: 500, error: "SUBMISSION_PERSIST_FAILED" };
  }

  return {
    ok: true,
    status: 200,
    body: { ok: true, id: doc._id, savedPhotos: savedPhotos.map((p) => p.url), count: savedPhotos.length },
  };
}

async function cleanupWrittenKeys(keys, deleteSavedImage) {
  if (typeof deleteSavedImage !== "function") return;
  for (const key of keys) {
    try {
      await deleteSavedImage(key);
    } catch {
      // best-effort cleanup only
    }
  }
}

module.exports = {
  createProductReport,
  decodeBase64Image,
  sanitizeReportInput,
  validateReportPhotos,
  sniffImageMime,
  MIN_BARCODE_LEN,
  MAX_BARCODE_LEN,
  MAX_MESSAGE_LEN,
  REQUIRED_PHOTO_COUNT,
  PER_PHOTO_MAX_DECODED_BYTES,
  COMBINED_PHOTOS_MAX_DECODED_BYTES,
};
