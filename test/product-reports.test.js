"use strict";

const assert = require("node:assert/strict");
const { test, after, mock } = require("node:test");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");

// Proves POST /api/reports (the route the frontend's reportUnknownProduct()
// actually calls) is really registered in server.js, uses server.js's own
// Submission model (not the broken orphan reports.routes.js / a nonexistent
// Report model), and behaves correctly — without loading server.js itself
// or touching a real database/network/filesystem.
const forbiddenAttempts = [];
const forbid = (operation) => () => {
  forbiddenAttempts.push(operation);
  throw new Error(`Isolated test forbids ${operation}`);
};
mock.method(net.Socket.prototype, "connect", forbid("network connection"));
mock.method(tls, "connect", forbid("TLS connection"));

const mongoose = require("mongoose");
mock.method(mongoose, "connect", forbid("mongoose.connect"));
mock.method(mongoose, "createConnection", forbid("mongoose.createConnection"));
mock.method(mongoose.Connection.prototype, "openUri", forbid("database connection"));

const {
  createProductReport,
  decodeBase64Image,
  sanitizeReportInput,
  validateReportPhotos,
  MAX_MESSAGE_LEN,
  PER_PHOTO_MAX_DECODED_BYTES,
  COMBINED_PHOTOS_MAX_DECODED_BYTES,
} = require("../src/domain/productReports");

// A minimal, valid JPEG-signature buffer of a controllable total size —
// used throughout instead of arbitrary text bytes, since the hardening
// pass added magic-byte sniffing that real text would fail.
function fakeJpegBuffer(totalBytes = 32) {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const filler = Buffer.alloc(Math.max(totalBytes - header.length, 0), 0xaa);
  return Buffer.concat([header, filler]);
}
function fakeJpegDataUrl(totalBytes = 32) {
  return `data:image/jpeg;base64,${fakeJpegBuffer(totalBytes).toString("base64")}`;
}

after(() => {
  try {
    assert.deepEqual(forbiddenAttempts, []);
    assert.equal(mongoose.connection.readyState, 0);
    for (const filename of ["../server.js", "../index.js", "../src/app.js"]) {
      assert.equal(require.cache[require.resolve(filename)], undefined, "application server must not load");
    }
  } finally {
    mock.restoreAll();
  }
});

test("POST /api/reports is registered in server.js (the canonical, deployed entrypoint), reusing server.js's own Submission model", () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /app\.post\(\s*"\/api\/reports",\s*reportsLimiter,\s*async/);
  assert.match(serverSource, /createProductReport\(\s*\{ Submission, saveImageBuffer, uuidv4 \}/);
  // Must never depend on the broken orphan router or its nonexistent model.
  assert.doesNotMatch(serverSource, /reports\.routes/);
});

test("the orphan reports.routes.js is confirmed broken (requires a nonexistent Report model) — proving why it could not be reused as-is", () => {
  const reportsRoutesPath = path.resolve(__dirname, "../src/routes/reports.routes.js");
  if (!fs.existsSync(reportsRoutesPath)) return; // nothing to prove if it's gone
  const source = fs.readFileSync(reportsRoutesPath, "utf8");
  const modelRequireMatch = source.match(/require\(["'](\.\.\/models\/[^"']+)["']\)/);
  assert.ok(modelRequireMatch, "expected reports.routes.js to require a models/* file");
  const modelPath = path.resolve(path.dirname(reportsRoutesPath), modelRequireMatch[1] + ".js");
  assert.equal(fs.existsSync(modelPath), false, `${modelRequireMatch[1]} must not exist — this is the known-broken dependency`);
});

// --- sanitizeReportInput / decodeBase64Image (pure) ------------------------
//
// HARDENING PASS: sanitizeReportInput now returns a discriminated
// { valid, ... } result (instead of null-on-failure) so each rejection
// reason is independently assertable, and it now also enforces the
// barcode format/length bounds (6-18 digits, matching the scanner
// contract in frontend/src/scannerExperience.js) and a message length
// cap — neither of which the original permissive version checked.

test("sanitizeReportInput rejects a missing/blank barcode", () => {
  assert.deepEqual(sanitizeReportInput({}), { valid: false, error: "MISSING_BARCODE" });
  assert.deepEqual(sanitizeReportInput({ barcode: "  ", message: "hi" }), { valid: false, error: "MISSING_BARCODE" });
});

test("sanitizeReportInput rejects a barcode that is the wrong shape/length", () => {
  // Too short (below the scanner contract's 6-digit floor).
  assert.deepEqual(sanitizeReportInput({ barcode: "123", message: "hi" }), { valid: false, error: "INVALID_BARCODE" });
  // Too long (above the scanner contract's 18-digit ceiling).
  assert.deepEqual(sanitizeReportInput({ barcode: "1".repeat(19), message: "hi" }), {
    valid: false,
    error: "INVALID_BARCODE",
  });
  // Non-digit characters are rejected outright, not silently stripped.
  assert.deepEqual(sanitizeReportInput({ barcode: "12345-6", message: "hi" }), {
    valid: false,
    error: "INVALID_BARCODE",
  });
});

test("sanitizeReportInput rejects a missing/blank message, and one over the length cap", () => {
  assert.deepEqual(sanitizeReportInput({ barcode: "123456", message: "   " }), {
    valid: false,
    error: "MISSING_MESSAGE",
  });
  assert.deepEqual(sanitizeReportInput({ barcode: "123456", message: "x".repeat(MAX_MESSAGE_LEN + 1) }), {
    valid: false,
    error: "MESSAGE_TOO_LONG",
  });
});

test("sanitizeReportInput trims and accepts a realistic 6-18 digit barcode and a message within the cap", () => {
  assert.deepEqual(sanitizeReportInput({ barcode: " 036000291452 ", message: " hi " }), {
    valid: true,
    barcode: "036000291452",
    message: "hi",
  });
  assert.deepEqual(sanitizeReportInput({ barcode: "123456", message: "x".repeat(MAX_MESSAGE_LEN) }).valid, true);
});

test("decodeBase64Image (legacy helper, kept for backward compatibility) still accepts a data URL or raw base64, rejects garbage", () => {
  const dataUrl = `data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}`;
  assert.deepEqual(decodeBase64Image(dataUrl), Buffer.from("fake-jpeg-bytes"));
  assert.deepEqual(decodeBase64Image(Buffer.from("raw").toString("base64")), Buffer.from("raw"));
  assert.equal(decodeBase64Image(""), null);
  assert.equal(decodeBase64Image(null), null);
  assert.equal(decodeBase64Image(123), null);
});

// --- validateReportPhotos (pure) -------------------------------------------

test("validateReportPhotos requires exactly 2 photos", () => {
  assert.deepEqual(validateReportPhotos(undefined), { valid: false, error: "WRONG_PHOTO_COUNT" });
  assert.deepEqual(validateReportPhotos([]), { valid: false, error: "WRONG_PHOTO_COUNT" });
  assert.deepEqual(validateReportPhotos([fakeJpegDataUrl()]), { valid: false, error: "WRONG_PHOTO_COUNT" });
  assert.deepEqual(validateReportPhotos([fakeJpegDataUrl(), fakeJpegDataUrl(), fakeJpegDataUrl()]), {
    valid: false,
    error: "WRONG_PHOTO_COUNT",
  });
});

test("validateReportPhotos rejects a malformed data URL", () => {
  const bad = [fakeJpegDataUrl(), "not-a-data-url"];
  assert.deepEqual(validateReportPhotos(bad), { valid: false, error: "INVALID_PHOTO_FORMAT" });
  const bareBase64 = [fakeJpegDataUrl(), Buffer.from("no prefix").toString("base64")];
  assert.deepEqual(validateReportPhotos(bareBase64), { valid: false, error: "INVALID_PHOTO_FORMAT" });
});

test("validateReportPhotos rejects an unsupported/mismatched image type", () => {
  // Declares image/jpeg but the decoded bytes don't have a JPEG signature.
  const spoofed = `data:image/jpeg;base64,${Buffer.from("not a real jpeg").toString("base64")}`;
  assert.deepEqual(validateReportPhotos([fakeJpegDataUrl(), spoofed]), {
    valid: false,
    error: "UNSUPPORTED_IMAGE_TYPE",
  });
});

test("validateReportPhotos rejects a single oversized photo", () => {
  const oversized = fakeJpegDataUrl(PER_PHOTO_MAX_DECODED_BYTES + 1);
  const result = validateReportPhotos([fakeJpegDataUrl(), oversized]);
  assert.deepEqual(result, { valid: false, error: "PHOTO_TOO_LARGE" });
});

test("validateReportPhotos rejects photos that are individually fine but too large combined", () => {
  const half = Math.floor(COMBINED_PHOTOS_MAX_DECODED_BYTES / 2) + 1000;
  assert.ok(half < PER_PHOTO_MAX_DECODED_BYTES, "test fixture assumption: half must still pass the per-photo cap");
  const result = validateReportPhotos([fakeJpegDataUrl(half), fakeJpegDataUrl(half)]);
  assert.deepEqual(result, { valid: false, error: "PHOTOS_TOO_LARGE" });
});

test("validateReportPhotos accepts exactly 2 well-formed photos and labels them front/ingredients in order", () => {
  const result = validateReportPhotos([fakeJpegDataUrl(64), fakeJpegDataUrl(64)]);
  assert.equal(result.valid, true);
  assert.equal(result.photos.length, 2);
  assert.equal(result.photos[0].kind, "front");
  assert.equal(result.photos[1].kind, "ingredients");
});

// --- createProductReport, with a mocked Submission model / storage --------

// A real, v4-shaped UUID string — buildStorageKeyBase (used inside
// createProductReport since production evidence photo storage v1)
// re-validates that the injected uuidv4() actually looks like a UUID.
const FIXED_UUID = "c269b8a6-3fb7-4aa3-9345-c0314432df8c";

function fakeDeps({ savePhotoSpy, failOnCall, deleteSpy } = {}) {
  const created = [];
  const deleted = [];
  let saveCallCount = 0;
  return {
    Submission: {
      async create(doc) {
        created.push(doc);
        return { _id: "fake-id-1", ...doc };
      },
    },
    saveImageBuffer: async (args) => {
      saveCallCount += 1;
      savePhotoSpy?.(args);
      if (failOnCall && saveCallCount === failOnCall) {
        throw new Error("simulated disk failure");
      }
      return {
        full: { url: `/uploads/${args.keyBase}-full.jpg`, key: `${args.keyBase}-full.jpg` },
        thumb: { url: `/uploads/${args.keyBase}-thumb.jpg`, key: `${args.keyBase}-thumb.jpg` },
      };
    },
    deleteSavedImage: async (key) => {
      deleted.push(key);
      deleteSpy?.(key);
    },
    uuidv4: () => FIXED_UUID,
    created,
    deleted,
  };
}

const VALID_PHOTOS = [fakeJpegDataUrl(64), fakeJpegDataUrl(64)];

test("rejects with MISSING_BARCODE / INVALID_BARCODE / MISSING_MESSAGE / MESSAGE_TOO_LONG before ever touching storage", async () => {
  const cases = [
    [{ barcode: "", message: "hi", photos: VALID_PHOTOS }, "MISSING_BARCODE"],
    [{ barcode: "123", message: "hi", photos: VALID_PHOTOS }, "INVALID_BARCODE"],
    [{ barcode: "123456", message: "", photos: VALID_PHOTOS }, "MISSING_MESSAGE"],
    [{ barcode: "123456", message: "x".repeat(MAX_MESSAGE_LEN + 1), photos: VALID_PHOTOS }, "MESSAGE_TOO_LONG"],
  ];
  for (const [input, expectedError] of cases) {
    const deps = fakeDeps();
    const result = await createProductReport(deps, input);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, expectedError);
    assert.equal(deps.created.length, 0, `must not create a Submission for ${expectedError}`);
  }
});

test("rejects wrong photo count / malformed / unsupported type / oversized photos, all BEFORE any disk write", async () => {
  const savePhotoCalls = [];
  const cases = [
    [[], "WRONG_PHOTO_COUNT"],
    [[fakeJpegDataUrl()], "WRONG_PHOTO_COUNT"],
    [["not-a-data-url", fakeJpegDataUrl()], "INVALID_PHOTO_FORMAT"],
    [[`data:image/jpeg;base64,${Buffer.from("fake").toString("base64")}`, fakeJpegDataUrl()], "UNSUPPORTED_IMAGE_TYPE"],
    [[fakeJpegDataUrl(PER_PHOTO_MAX_DECODED_BYTES + 1), fakeJpegDataUrl()], "PHOTO_TOO_LARGE"],
  ];
  for (const [photos, expectedError] of cases) {
    const deps = fakeDeps({ savePhotoSpy: (args) => savePhotoCalls.push(args) });
    const result = await createProductReport(deps, { barcode: "123456", message: "hi", photos });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, expectedError);
    assert.equal(deps.created.length, 0, `must not create a Submission for ${expectedError}`);
  }
  assert.equal(savePhotoCalls.length, 0, "validation failures must never reach saveImageBuffer — no disk writes");
});

test("creates a Submission with the message stored as notes, and exactly 2 photos labeled front/ingredients in order", async () => {
  const savedPhotoCalls = [];
  const deps = fakeDeps({ savePhotoSpy: (args) => savedPhotoCalls.push(args) });

  const result = await createProductReport(deps, {
    barcode: "036000291452",
    message: "Ingredients look uncertain",
    photos: VALID_PHOTOS,
    client: { ip: "127.0.0.1", ua: "test-agent" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.count, 2);
  assert.equal(result.body.savedPhotos.length, 2);

  assert.equal(deps.created.length, 1);
  const doc = deps.created[0];
  assert.equal(doc.barcode, "036000291452");
  assert.equal(doc.notes, "Ingredients look uncertain");
  assert.equal(doc.photos.length, 2);
  assert.equal(doc.photos[0].kind, "front");
  assert.equal(doc.photos[1].kind, "ingredients");
  assert.deepEqual(doc.client, { ip: "127.0.0.1", ua: "test-agent" });
  assert.equal(savedPhotoCalls.length, 2);
  // Barcode is validated as digits-only (6-18 chars) BEFORE it is ever used
  // to build a storage key/path — this is what makes path traversal via
  // barcode structurally impossible, not an incidental side effect.
  assert.equal(savedPhotoCalls[0].keyBase, `reports/036000291452/${FIXED_UUID}`);
  // Production evidence photo storage v1: the storage key is now
  // persisted alongside url on each photo (backward-compatible addition —
  // old local-QA documents simply have no `key`).
  assert.equal(doc.photos[0].key, `reports/036000291452/${FIXED_UUID}-full.jpg`);
  assert.equal(doc.photos[1].key, `reports/036000291452/${FIXED_UUID}-full.jpg`);
});

test("a partial multi-photo write failure (second photo fails after the first succeeded) leaves no orphan files — cleanup runs for every key already written this request", async () => {
  const deps = fakeDeps({ failOnCall: 2 }); // the 2nd saveImageBuffer call throws
  const result = await createProductReport(deps, {
    barcode: "123456",
    message: "hi",
    photos: VALID_PHOTOS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, "PHOTO_STORAGE_FAILED");
  assert.equal(deps.created.length, 0, "no Submission must be created when photo storage fails");
  // The first photo's full+thumb keys must both have been cleaned up.
  assert.equal(deps.deleted.length, 2);
  assert.ok(deps.deleted.every((k) => k.startsWith(`reports/123456/${FIXED_UUID}-full`) || k.startsWith(`reports/123456/${FIXED_UUID}-thumb`)));
});

test("DB-CREATE-FAILURE CLEANUP: all photo uploads succeed but Submission.create() fails — every object/file written during this request is cleaned up, and no pre-existing object is ever touched", async () => {
  const deleted = [];
  const deps = {
    Submission: {
      async create() {
        throw new Error("simulated Mongo write failure");
      },
    },
    saveImageBuffer: async (args) => ({
      full: { url: `/uploads/${args.keyBase}-full.jpg`, key: `${args.keyBase}-full.jpg` },
      thumb: { url: `/uploads/${args.keyBase}-thumb.jpg`, key: `${args.keyBase}-thumb.jpg` },
    }),
    deleteSavedImage: async (key) => deleted.push(key),
    uuidv4: () => FIXED_UUID,
  };

  const result = await createProductReport(deps, { barcode: "123456", message: "hi", photos: VALID_PHOTOS });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, "SUBMISSION_PERSIST_FAILED");
  // Exactly the 4 objects written THIS request (2 photos x full+thumb) —
  // never anything else, since nothing else was ever written.
  assert.equal(deleted.length, 4);
  const expectedKeyBase = `reports/123456/${FIXED_UUID}`;
  assert.ok(deleted.every((k) => k.startsWith(`${expectedKeyBase}-full`) || k.startsWith(`${expectedKeyBase}-thumb`)));
});

test("DB-CREATE-FAILURE CLEANUP works the same way when deleteSavedImage represents an S3 deletion (dependency-injected — this file never touches real S3)", async () => {
  const s3DeleteCalls = [];
  const deps = {
    Submission: { async create() { throw new Error("simulated Mongo write failure"); } },
    saveImageBuffer: async (args) => ({
      full: { url: null, key: `prod/${args.keyBase}-full.jpg` },
      thumb: { url: null, key: `prod/${args.keyBase}-thumb.jpg` },
    }),
    deleteSavedImage: async (key) => s3DeleteCalls.push(key), // stands in for an S3 DeleteObjectCommand call
    uuidv4: () => FIXED_UUID,
  };

  const result = await createProductReport(deps, { barcode: "123456", message: "hi", photos: VALID_PHOTOS });

  assert.equal(result.error, "SUBMISSION_PERSIST_FAILED");
  assert.equal(s3DeleteCalls.length, 4);
  assert.ok(s3DeleteCalls.every((k) => k.startsWith(`prod/reports/123456/${FIXED_UUID}`)));
});
