"use strict";

const assert = require("node:assert/strict");
const { test, after, mock } = require("node:test");
const net = require("node:net");
const tls = require("node:tls");

// This suite never touches a real database or network. It proves (a) the
// pure UPC-A/EAN-13 candidate-generation rule in isolation, and (b) that
// the local Product lookup actually tries those candidates against a
// mocked Product model, in priority order (originally-supplied first).
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

const Product = require("../models/Product");
const { getBarcodeLookupCandidates } = require("../src/lib/barcodeEquivalence");
const { findProductByBarcodeCandidates } = require("../src/domain/productLookup");

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

// --- pure candidate generation -------------------------------------------

test("12-digit UPC-A gets exactly one equivalent: itself zero-prefixed to 13 digits", () => {
  assert.deepEqual(getBarcodeLookupCandidates("036000291452"), ["036000291452", "0036000291452"]);
});

test("13-digit EAN starting with 0 gets exactly one equivalent: itself with the leading zero stripped", () => {
  assert.deepEqual(getBarcodeLookupCandidates("0036000291452"), ["0036000291452", "036000291452"]);
});

test("13-digit EAN NOT starting with 0 has no equivalent — unchanged", () => {
  assert.deepEqual(getBarcodeLookupCandidates("4006381333931"), ["4006381333931"]);
});

test("malformed/non-numeric input is never transformed", () => {
  assert.deepEqual(getBarcodeLookupCandidates("abc123456789"), ["abc123456789"]);
  assert.deepEqual(getBarcodeLookupCandidates("12345-67890AB"), ["12345-67890AB"]);
  assert.deepEqual(getBarcodeLookupCandidates(""), [""]);
});

test("unsupported numeric lengths are never transformed", () => {
  assert.deepEqual(getBarcodeLookupCandidates("12345678"), ["12345678"]); // 8 digits
  assert.deepEqual(getBarcodeLookupCandidates("123456789012345"), ["123456789012345"]); // 15 digits
});

test("the originally-supplied value is always first and is never itself mutated", () => {
  const candidates = getBarcodeLookupCandidates("036000291452");
  assert.equal(candidates[0], "036000291452");
});

// --- local lookup against a mocked Product model --------------------------

function mockFindOne(t, storedDocs) {
  t.mock.method(Product, "findOne", (filter) => ({
    lean: async () => storedDocs.find((doc) => doc.barcode === filter.barcode) || null,
  }));
}

test("stored 12-digit, request 12-digit: exact match, no transform needed", async (t) => {
  mockFindOne(t, [{ barcode: "036000291452", name: "Stored UPC-A item" }]);
  const doc = await findProductByBarcodeCandidates(Product, "036000291452");
  assert.equal(doc?.name, "Stored UPC-A item");
});

test("stored 12-digit, request zero-prefixed 13-digit: resolves via the equivalent candidate", async (t) => {
  mockFindOne(t, [{ barcode: "036000291452", name: "Stored UPC-A item" }]);
  const doc = await findProductByBarcodeCandidates(Product, "0036000291452");
  assert.equal(doc?.name, "Stored UPC-A item");
});

test("stored zero-prefixed 13-digit, request 12-digit: resolves via the equivalent candidate", async (t) => {
  mockFindOne(t, [{ barcode: "0036000291452", name: "Stored EAN-13 item" }]);
  const doc = await findProductByBarcodeCandidates(Product, "036000291452");
  assert.equal(doc?.name, "Stored EAN-13 item");
});

test("stored 13-digit non-zero-prefixed EAN remains reachable only by its exact form", async (t) => {
  mockFindOne(t, [{ barcode: "4006381333931", name: "Stored EAN-13 (non-UPC) item" }]);
  const exact = await findProductByBarcodeCandidates(Product, "4006381333931");
  assert.equal(exact?.name, "Stored EAN-13 (non-UPC) item");
  // No 12-digit or other variant should incorrectly resolve to it.
  const miss = await findProductByBarcodeCandidates(Product, "006381333931");
  assert.equal(miss, null);
});

test("malformed/unsupported-length requests never spuriously match an unrelated stored barcode", async (t) => {
  mockFindOne(t, [{ barcode: "036000291452", name: "Stored UPC-A item" }]);
  assert.equal(await findProductByBarcodeCandidates(Product, "abc123456789"), null);
  assert.equal(await findProductByBarcodeCandidates(Product, "12345678"), null);
});

test("the exact/originally-supplied form is preferred when both it and its equivalent exist as separate stored docs", async (t) => {
  mockFindOne(t, [
    { barcode: "036000291452", name: "Exact 12-digit doc" },
    { barcode: "0036000291452", name: "Equivalent 13-digit doc" },
  ]);
  const doc = await findProductByBarcodeCandidates(Product, "036000291452");
  assert.equal(doc?.name, "Exact 12-digit doc");
});
