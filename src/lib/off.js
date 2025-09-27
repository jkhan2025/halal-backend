// backend/src/lib/off.js
const axios = require("axios");

/** Map OFF country tags to short region codes. */
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

/** Humanize a categories tag like "en:carbonated-soft-drinks" → "Carbonated soft drinks" */
function humanizeCategoryTag(tag = "") {
  const withoutLang = String(tag).replace(/^[a-z]{2}:/i, ""); // strip any lang prefix
  const spaced = withoutLang.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Convert OFF product into your Product schema shape. */
function normalizeOFF(barcode, p) {
  const brand =
    (p.brands || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "";

  const name =
    (p.product_name && String(p.product_name).trim()) ||
    (p.product_name_en && String(p.product_name_en).trim()) ||
    (p.generic_name && String(p.generic_name).trim()) ||
    (p.generic_name_en && String(p.generic_name_en).trim()) ||
    brand ||
    "Unknown product";

  let category = "";
  if (Array.isArray(p.categories_tags) && p.categories_tags.length) {
    const firstEn = p.categories_tags.find((t) => /^en:/i.test(t));
    category = humanizeCategoryTag(firstEn || p.categories_tags[0]);
  }

  const ingredients = Array.isArray(p.ingredients)
    ? p.ingredients
        .map((ing) =>
          ing && (ing.text || ing.id || ing.ingredient)
            ? String(ing.text || ing.id || ing.ingredient)
            : ""
        )
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    barcode,
    name,
    brand,
    category,
    imageUrl: p.image_front_url || "",
    ingredientsImageUrl: p.image_ingredients_url || "",
    ingredients,
    verdict: "UNKNOWN",
    reason: "",
    confidence: 50,
    regionTags: deriveRegionTags(p.countries_tags || []),
    lastCheckedAt: new Date(),
    sources: [
      {
        label: "Open Food Facts",
        url: p.url || (barcode ? `https://world.openfoodfacts.org/product/${barcode}` : ""),
        kind: "community",
      },
    ],
  };
}

/** Fetch from OFF and return a normalized Product object (or null). */
async function fetchFromOFF(barcode, userAgent = "HalalQuest/1.0 (+contact)") {
  if (!barcode) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`;
  try {
    const { status, data } = await axios.get(url, {
      headers: { "User-Agent": userAgent },
      timeout: 12000,
      // do not throw on non-2xx; we'll handle statuses below
      validateStatus: () => true,
    });

    if (status !== 200 || !data || data.status !== 1 || !data.product) {
      return null; // treat as "not found" / unusable
    }
    return normalizeOFF(barcode, data.product);
  } catch (_err) {
    // network error / timeout → treat as not found to avoid 500s
    return null;
  }
}

module.exports = { fetchFromOFF };
