"use strict";

const assert = require("node:assert/strict");
const { test, after, mock } = require("node:test");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");

// Proves GET /api/products (the route the frontend's searchProducts()
// actually calls) is really registered in server.js, the canonical/
// deployed entrypoint — and that the search logic backing it behaves
// correctly — without ever loading server.js itself (it connects to Mongo
// and binds a port as a side effect of being required) or touching a real
// database/network.
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
const { searchProducts, clampLimit } = require("../src/domain/productSearch");

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

test("GET /api/products is registered in server.js (the canonical, deployed entrypoint), not just the non-deployed index.js", () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /app\.get\("\/api\/products",\s*async/);
  assert.match(serverSource, /searchProducts\(Product,/);
  // It must remain distinct from the existing single-barcode route.
  assert.match(serverSource, /app\.get\("\/api\/products\/:barcode",\s*async/);
});

test("empty/missing query returns an empty result without querying Mongo at all", async (t) => {
  const find = t.mock.method(Product, "find", () => {
    throw new Error("Product.find must not be called for an empty query");
  });
  const result = await searchProducts(Product, { query: "" });
  assert.deepEqual(result, { ok: true, items: [] });
  assert.equal(find.mock.callCount(), 0);
});

test("matches use the canonical trust/result-contract shape (buildProductLookupPayload), never the legacy opinions/effectiveVerdict shape", async (t) => {
  t.mock.method(Product, "find", () => ({
    limit: () => ({
      lean: async () => [
        { barcode: "036000291452", name: "Halal Snack Bar", brand: "Acme", trust: undefined },
      ],
    }),
  }));
  const result = await searchProducts(Product, { query: "snack" });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.source, "local");
  assert.ok(item.item, "must include the canonical item (withProductTrust output)");
  assert.ok(item.result, "must include the canonical result contract (buildProductResultContract output)");
  assert.ok("verdict" in item.result, "result contract must carry a canonical verdict field");
  assert.equal("effectiveVerdict" in item, false, "must not leak the legacy per-madhhab opinions shape");
  assert.equal("opinions" in item, false, "must not leak the legacy per-madhhab opinions shape");
});

test("falls back to a case-insensitive regex match across name/brand/category when $text is unavailable", async (t) => {
  let call = 0;
  t.mock.method(Product, "find", (filter) => {
    call += 1;
    if (call === 1) {
      assert.ok(filter.$text, "first attempt must be a $text query");
      return { limit: () => ({ lean: async () => { throw new Error("no text index"); } }) };
    }
    assert.ok(filter.$or, "fallback attempt must be a regex $or query");
    return { limit: () => ({ lean: async () => [{ barcode: "1", name: "Match", brand: "", category: "" }] }) };
  });
  const result = await searchProducts(Product, { query: "match" });
  assert.equal(result.items.length, 1);
  assert.equal(call, 2);
});

test("region filter is applied, and limit is clamped to the documented [1,50] range", async (t) => {
  let capturedFilter = null;
  let capturedLimit = null;
  t.mock.method(Product, "find", (filter) => {
    capturedFilter = filter;
    return {
      limit: (n) => {
        capturedLimit = n;
        return { lean: async () => [] };
      },
    };
  });
  await searchProducts(Product, { query: "gum", region: "us", limit: 9999 });
  assert.deepEqual(capturedFilter.regionTags, { $in: ["US"] });
  assert.equal(capturedLimit, 50);

  await searchProducts(Product, { query: "gum", limit: "banana" });
  assert.equal(capturedLimit, 20, "a non-numeric limit falls back to the default of 20");

  await searchProducts(Product, { query: "gum", limit: -5 });
  assert.equal(capturedLimit, 1, "an out-of-range (but valid) limit is clamped to the minimum, not defaulted");
});

test("clampLimit is a pure, deterministic helper", () => {
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit("not a number"), 20);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(1000), 50);
  assert.equal(clampLimit(30), 30);
});
