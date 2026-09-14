// backend/src/domain/productSearch.js
//
// Product text search (name/brand/category), backing GET /api/products.
// Ported from the working implementation in backend/index.js, with one
// deliberate change: each result is projected through the SAME canonical
// trust/result-contract builder (buildProductLookupPayload, from
// src/domain/trust.js) already used by GET /api/products/:barcode — not
// the legacy per-madhhab "opinions"/effectiveVerdict shape index.js used.
// This keeps exactly one product trust architecture in the app.
//
// Takes the Product model as a parameter so this stays testable with a
// fake/mocked model — no real Mongo connection needed.

const { buildProductLookupPayload } = require("./trust");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampLimit(value, { fallback = 20, min = 1, max = 50 } = {}) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function searchProducts(Product, { query, region, limit } = {}) {
  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  if (!trimmedQuery) return { ok: true, items: [] };

  const cleanRegion = typeof region === "string" ? region.trim().toUpperCase() : "";
  const cappedLimit = clampLimit(limit);
  const regionFilter = cleanRegion ? { regionTags: { $in: [cleanRegion] } } : {};

  let docs;
  try {
    docs = await Product.find({ $text: { $search: trimmedQuery }, ...regionFilter })
      .limit(cappedLimit)
      .lean();
  } catch {
    // No text index available (or an invalid $text query) — fall back to
    // a case-insensitive substring match across the same fields.
    const rx = new RegExp(escapeRegExp(trimmedQuery), "i");
    docs = await Product.find({
      $or: [{ name: rx }, { brand: rx }, { category: rx }],
      ...regionFilter,
    })
      .limit(cappedLimit)
      .lean();
  }

  return { ok: true, items: docs.map((doc) => buildProductLookupPayload(doc, "local")) };
}

module.exports = { searchProducts, clampLimit, escapeRegExp };
