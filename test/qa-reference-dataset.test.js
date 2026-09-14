"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { mock } = require("node:test");

// This test validates the QA Reference Dataset V1 entirely in memory, against
// the real production trust/contract builders. It must never touch a
// database or the network — block both so a regression here fails loudly
// instead of silently reaching out.
const forbidden = [];
const deny = (name) => {
  forbidden.push(name);
  throw new Error(`Isolated QA reference dataset test forbids ${name}`);
};
mock.method(net.Socket.prototype, "connect", () => deny("network"));
mock.method(tls, "connect", () => deny("TLS"));

const { buildRestaurantResultContract } = require("../src/domain/restaurantTrust");
const { buildGroceryResultContract } = require("../src/domain/groceryTrust");
const { normalizeProductTrust } = require("../src/domain/trust");

const DATA_DIR = path.join(__dirname, "..", "src", "data");
const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

const places = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "qa_reference_places.json"), "utf8"));
const products = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "qa_reference_products.json"), "utf8"));
const restaurants = places.filter((p) => p.type === "restaurant");
const groceries = places.filter((p) => p.type === "grocery");

const seedSource = fs.readFileSync(path.join(SCRIPTS_DIR, "seed-qa-reference.js"), "utf8");
const resetSource = fs.readFileSync(path.join(SCRIPTS_DIR, "reset-qa-reference.js"), "utf8");

// Intended status/verdict for every record, by its deterministic identity.
// This is the same intent the dataset was designed against; the tests below
// prove the REAL domain builders independently arrive at the same result.
const INTENDED_PLACE_STATUS = {
  "qa-rest-001": "CERTIFIED",
  "qa-rest-002": "BUSINESS_CONFIRMED",
  "qa-rest-003": "CERTIFIED",
  "qa-rest-004": "PARTIAL_SUPPORT",
  "qa-rest-005": "PARTIAL_SUPPORT",
  "qa-rest-006": "COMMUNITY_REPORTED",
  "qa-rest-007": "UNVERIFIED",
  "qa-rest-008": "COMMUNITY_REPORTED",
  "qa-rest-009": "BUSINESS_CONFIRMED",
  "qa-rest-010": "UNVERIFIED",
  "qa-grocery-001": "CERTIFIED",
  "qa-grocery-002": "PARTIAL_SUPPORT",
  "qa-grocery-003": "BUSINESS_CONFIRMED",
  "qa-grocery-004": "PARTIAL_SUPPORT",
  "qa-grocery-005": "COMMUNITY_REPORTED",
  "qa-grocery-006": "CERTIFIED",
  "qa-grocery-007": "UNVERIFIED",
  "qa-grocery-008": "UNVERIFIED",
};

const INTENDED_PRODUCT_VERDICT = {
  "991000000001": "HALAL", "991000000002": "HALAL", "991000000003": "HALAL",
  "991000000004": "HARAM", "991000000005": "HARAM", "991000000006": "HARAM",
  "991000000007": "NEEDS_REVIEW", "991000000008": "NEEDS_REVIEW",
  "991000000009": "NEEDS_REVIEW", "991000000010": "NEEDS_REVIEW",
  "991000000011": "UNKNOWN", "991000000012": "UNKNOWN", "991000000013": "UNKNOWN",
  "991000000014": "UNKNOWN", "991000000015": "UNKNOWN", "991000000016": "UNKNOWN",
  "991000000017": "UNKNOWN", "991000000018": "UNKNOWN", "991000000019": "UNKNOWN",
  "991000000020": "UNKNOWN",
};

test("dataset has exactly 10 restaurants, 8 groceries, and 20 products", () => {
  assert.equal(restaurants.length, 10);
  assert.equal(groceries.length, 8);
  assert.equal(products.length, 20);
});

test("every place has a unique sourceId and a unique, valid deterministic _id", () => {
  const sourceIds = places.map((p) => p.sourceId);
  assert.equal(new Set(sourceIds).size, places.length, "sourceIds must be unique");
  for (const p of places) {
    assert.match(p._id, /^[0-9a-f]{24}$/, `${p.sourceId} must have a valid 24-hex ObjectId-shaped _id`);
  }
  assert.equal(new Set(places.map((p) => p._id)).size, places.length, "_id values must be unique");
});

test("every product has a unique, distinct-range barcode (not colliding with the existing preview fixture range)", () => {
  const barcodes = products.map((p) => p.barcode);
  assert.equal(new Set(barcodes).size, barcodes.length, "barcodes must be unique");
  for (const barcode of barcodes) {
    assert.match(barcode, /^991000000\d{3}$/, `${barcode} must be in the 991000000xxx QA reference range`);
    assert.doesNotMatch(barcode, /^9900000004/, "must not collide with the existing productResultPreview.js fixture range");
  }
});

test("every restaurant's production-derived status matches its intended status", () => {
  for (const place of restaurants) {
    const contract = buildRestaurantResultContract(place, { now: new Date("2026-08-15T00:00:00.000Z") });
    const expected = INTENDED_PLACE_STATUS[place.sourceId];
    assert.ok(expected, `${place.sourceId} must have an intended status recorded in this test`);
    assert.equal(contract.summary.status, expected, `${place.sourceId} (${place.name}) expected ${expected}, got ${contract.summary.status}`);
  }
});

test("every grocery's production-derived status matches its intended status", () => {
  for (const place of groceries) {
    const contract = buildGroceryResultContract(place, { now: new Date("2026-08-15T00:00:00.000Z") });
    const expected = INTENDED_PLACE_STATUS[place.sourceId];
    assert.ok(expected, `${place.sourceId} must have an intended status recorded in this test`);
    assert.equal(contract.summary.status, expected, `${place.sourceId} (${place.name}) expected ${expected}, got ${contract.summary.status}`);
  }
});

test("every product's production-derived verdict matches its intended verdict, using only the canonical verdict system", () => {
  for (const product of products) {
    const trust = normalizeProductTrust(product);
    const expected = INTENDED_PRODUCT_VERDICT[product.barcode];
    assert.ok(expected, `${product.barcode} must have an intended verdict recorded in this test`);
    assert.equal(trust.verdict, expected, `${product.barcode} (${product.name}) expected ${expected}, got ${trust.verdict}`);
    assert.ok(["HALAL", "HARAM", "NEEDS_REVIEW", "UNKNOWN"].includes(trust.verdict), "verdict must be one of the 4 canonical values");
  }
  // MUSHBOOH must never appear as a stored/intended verdict anywhere in V1.
  assert.ok(!Object.values(INTENDED_PRODUCT_VERDICT).includes("MUSHBOOH"));
  for (const product of products) {
    assert.notEqual(product.trust?.verdict, "MUSHBOOH");
  }
});

test("the verdict mix matches the requested distribution intent", () => {
  const counts = { HALAL: 0, HARAM: 0, NEEDS_REVIEW: 0, UNKNOWN: 0 };
  for (const v of Object.values(INTENDED_PRODUCT_VERDICT)) counts[v]++;
  assert.equal(counts.HALAL, 3);
  assert.equal(counts.HARAM, 3);
  assert.equal(counts.NEEDS_REVIEW, 4);
  assert.equal(counts.UNKNOWN, 10);
});

test("legacy halal:true booleans without qualifying trust evidence never elevate status/verdict", () => {
  const legacyRestaurant = restaurants.find((r) => r.sourceId === "qa-rest-010");
  assert.equal(legacyRestaurant.halal, true);
  assert.equal(legacyRestaurant.restaurantTrust, undefined);
  const contract = buildRestaurantResultContract(legacyRestaurant, { now: new Date("2026-08-15T00:00:00.000Z") });
  assert.equal(contract.summary.status, "UNVERIFIED");

  const legacyProduct = products.find((p) => p.barcode === "991000000013");
  assert.equal(legacyProduct.halal, true);
  assert.equal(legacyProduct.trust, undefined);
  const trust = normalizeProductTrust(legacyProduct);
  assert.equal(trust.verdict, "UNKNOWN");
  assert.ok(trust.unverified.some((note) => /legacy halal-status claim/i.test(note)));
});

test("seed script is safety-gated and upserts idempotently by deterministic identity", () => {
  assert.match(seedSource, /require\("\.\.\/src\/config\/runtimeSafety"\)\.assertMaintenanceAllowed\(\)/);
  assert.match(seedSource, /findOneAndUpdate\(\s*\{ source: SOURCE, sourceId \}/);
  assert.match(seedSource, /findOneAndUpdate\(\s*\{ barcode: raw\.barcode \}/);
  assert.match(seedSource, /upsert: true/);
  assert.doesNotMatch(seedSource, /deleteMany\(\{\}\)/);
  assert.doesNotMatch(seedSource, /\.drop\(\)|dropDatabase/);
});

test("reset script is safety-gated and scoped only to V1 reference identities, never a blanket wipe", () => {
  assert.match(resetSource, /require\("\.\.\/src\/config\/runtimeSafety"\)\.assertMaintenanceAllowed\(\)/);
  assert.match(resetSource, /Place\.deleteMany\(\{ source: SOURCE \}\)/);
  assert.match(resetSource, /Product\.deleteMany\(\{ barcode: \{ \$in: barcodes \} \}\)/);
  // Explicit deterministic barcode list, not a broad prefix regex.
  assert.doesNotMatch(resetSource, /\$regex.*991|barcode:\s*\/\^991/);
  assert.doesNotMatch(resetSource, /deleteMany\(\{\}\)/);
  assert.doesNotMatch(resetSource, /\.drop\(\)|dropDatabase/);
});

test("no accidental network/database access occurred while validating this dataset", () => {
  assert.deepEqual(forbidden, []);
});
