"use strict";

// Pure unit tests for src/lib/storageKey.js — prefix sanitization, key
// construction, and key validation. No network, no filesystem, no Mongo.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { sanitizeKeyPrefix, buildStorageKeyBase, isValidStorageKey } = require("../src/lib/storageKey");

const SAMPLE_UUID = "c269b8a6-3fb7-4aa3-9345-c0314432df8c";
const SAMPLE_BARCODE = "036000291452";

test("sanitizeKeyPrefix: unset/empty is allowed and normalizes to an empty string (no prefix)", () => {
  assert.equal(sanitizeKeyPrefix(undefined), "");
  assert.equal(sanitizeKeyPrefix(null), "");
  assert.equal(sanitizeKeyPrefix(""), "");
  assert.equal(sanitizeKeyPrefix("   "), "");
});

test("sanitizeKeyPrefix: a valid production prefix is accepted and trimmed", () => {
  assert.equal(sanitizeKeyPrefix("prod"), "prod");
  assert.equal(sanitizeKeyPrefix("  staging  "), "staging");
  assert.equal(sanitizeKeyPrefix("prod-2"), "prod-2");
  assert.equal(sanitizeKeyPrefix("a".repeat(40)), "a".repeat(40));
});

test("sanitizeKeyPrefix: rejects a malformed prefix (path traversal / slash injection / too long)", () => {
  for (const bad of ["bad/prefix", "../etc", "..", "/leading-slash", "trailing-slash/", "a".repeat(41), "has space", "semi;colon"]) {
    assert.throws(() => sanitizeKeyPrefix(bad), /STORAGE_KEY_PREFIX is invalid/, `expected "${bad}" to be rejected`);
  }
});

test("buildStorageKeyBase: produces the unprefixed reports/<barcode>/<uuid> shape by default", () => {
  assert.equal(buildStorageKeyBase({ barcode: SAMPLE_BARCODE, uuid: SAMPLE_UUID }), `reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}`);
});

test("buildStorageKeyBase: prepends an already-sanitized prefix when given one", () => {
  assert.equal(
    buildStorageKeyBase({ prefix: "prod", barcode: SAMPLE_BARCODE, uuid: SAMPLE_UUID }),
    `prod/reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}`
  );
});

test("buildStorageKeyBase: the server always generates the UUID — barcode cannot smuggle path traversal because it is re-validated as digits-only here too", () => {
  for (const badBarcode of ["../../etc/passwd", "12/../34", "abc123", "12 34", "123456789012345678901", "12345"]) {
    assert.throws(
      () => buildStorageKeyBase({ barcode: badBarcode, uuid: SAMPLE_UUID }),
      /barcode must already be validated digits/,
      `expected "${badBarcode}" to be rejected`
    );
  }
});

test("buildStorageKeyBase: rejects a non-UUID-shaped uuid argument (defense in depth — callers always pass a real uuidv4())", () => {
  assert.throws(() => buildStorageKeyBase({ barcode: SAMPLE_BARCODE, uuid: "not-a-uuid" }), /uuid must be a v4-shaped UUID/);
});

test("isValidStorageKey: accepts the exact unprefixed and prefixed shapes this app generates", () => {
  assert.equal(isValidStorageKey(`reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}-full.jpg`), true);
  assert.equal(isValidStorageKey(`reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}-thumb.jpg`), true);
  assert.equal(isValidStorageKey(`prod/reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}-full.jpg`), true);
});

test("isValidStorageKey: rejects path traversal, arbitrary strings, wrong suffix, and non-string input", () => {
  const bad = [
    "../../etc/passwd",
    `reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}-full.jpg/../../../etc/passwd`,
    `reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}-medium.jpg`, // not full/thumb
    `reports/abc/${SAMPLE_UUID}-full.jpg`, // non-digit barcode
    `reports/12345/${SAMPLE_UUID}-full.jpg`, // barcode too short (5 digits)
    `bad//prefix/reports/${SAMPLE_BARCODE}/${SAMPLE_UUID}-full.jpg`, // double-segment prefix
    "",
    null,
    undefined,
    42,
  ];
  for (const key of bad) {
    assert.equal(isValidStorageKey(key), false, `expected ${JSON.stringify(key)} to be invalid`);
  }
});
