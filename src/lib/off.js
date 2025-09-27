// backend/src/lib/off.js
const axios = require("axios");

/** Map OFF country tags to short region codes (very light heuristic). */
function deriveRegionTags(tags = []) {
  if (!Array.isArray(tags)) return [];
  const t = tags.map((s) => String(s || "").toLowerCase());
  const out = [];
  if (t.includes("en:united-states")) out.push("US");
  if (t.includes("en:canada")) out.push("CA");
  if (t.includes("en:united-kingdom")) out.push("UK");
  if (t.includes("en:france")) out.push("FR");
  if (t.includes("en:germany")) out.push("DE");
  return out;
}

const firstNonEmpty = (...vals) => {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : v;
    if (s) return s;
  }
  return "";
};

const cleanBrand = (brands) => {
  // OFF may return comma-separated brands; keep the first
  const b =
    (brands || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "";
  return b;
};

function cleanName(rawName, brand) {
  // preferred name, with fallbacks handled by caller
  let n = (rawName || "").trim();

  // If we have a brand and the name is either equal to the brand (ignoring punctuation)
  // or looks like a repeated token like "cola cola", collapse to the brand.
  const simple = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const nSimple = simple(n);
  const bSimple = simple(brand || "");

  const looksRepeatedWord = /\b(\w+)(?:\s+\1)+\b/i.test(n); // e.g. "cola cola"
  if (brand && (nSimple === bSimple || looksRepeatedWord)) {
    return brand.trim();
  }

  // Otherwise, de-duplicate obvious consecutive repeats inside the name itself.
  // "Zero Zero Sugar" -> "Zero Sugar" (keeps one occurrence)
  n = n.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");

  return n || brand || "Unknown product";
}

/** Derive a friendly category. */
function deriveCategory(p) {
  // Try categories_hierarchy (often has "en:..."), else categories_tags, else categories string.
  let raw = "";
  if (Array.isArray(p.categories_hierarchy) && p.categories_hierarchy.length) {
    raw = p.categories_hierarchy[p.categories_hierarchy.length - 1];
  } else if (Array.isArray(p.categories_tags) && p.categories_tags.length) {
    raw = p.categories_tags.find((t) => t.startsWith("en:")) || p.categories_tags[0];
  } else {
    raw = p.categories || "";
  }
  raw = String(raw || "").replace(/^en:/, "");
  if (!raw) return "";
  // Humanize a bit
  const s = raw.replace(/[-_]/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** Make a best-effort ingredients list. */
function deriveIngredients(p) {
  // Prefer structured array
  if (Array.isArray(p.ingredients) && p.ingredients.length) {
    return p.ingredients
      .map((ing) =>
        ing && (ing.text || ing.id || ing.ingredient)
          ? String(ing.text || ing.id || ing.ingredient)
          : ""
      )
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Fallback to text
  const text = firstNonEmpty(p.ingredients_text_en, p.ingredients_text);
  if (!text) return [];
  return text
    .split(/[,;•\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Convert OFF product into your Product schema shape. */
function normalizeOFF(barcode, p) {
  const brand = cleanBrand(firstNonEmpty(p.brands, p.brand_owner));
  const rawName = firstNonEmpty(p.product_name_en, p.product_name, p.generic_name_en, p.generic_name, brand);
  const name = cleanName(rawName, brand);

  const category = deriveCategory(p);
  const ingredients = deriveIngredients(p);

  const imageUrl = firstNonEmpty(p.image_front_url, p.image_url);
  const ingredientsImageUrl = firstNonEmpty(p.image_ingredients_url);

  return {
    barcode: String(barcode),
    name,
    brand: brand || "",
    category: category || "",
    imageUrl: imageUrl || "",
    ingredientsImageUrl: ingredientsImageUrl || "",
    ingredients,
    verdict: "UNKNOWN",
    reason: "",
    confidence: 50,
    opinions: { default: { verdict: "UNKNOWN", note: "" } },
    regionTags: deriveRegionTags(p.countries_tags || []),
    lastCheckedAt: new Date(),
    sources: [
      {
        label: "Open Food Facts",
        url: p.url || (barcode ? `https://world.openfoodfacts.org/product/${encodeURIComponent(barcode)}` : ""),
        kind: "community",
      },
    ],
  };
}

/**
 * Fetch from Open Food Facts and return a Product-shaped object (or null).
 * Uses v2; you can switch to v0 if you prefer.
 */
async function fetchFromOFF(barcode, userAgent = process.env.OFF_USER_AGENT || "HalalQuest/1.0 (+contact)") {
  if (!barcode) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": userAgent },
    timeout: 12000,
  });
  if (!data || data.status !== 1 || !data.product) return null;
  return normalizeOFF(barcode, data.product);
}

module.exports = { fetchFromOFF };
