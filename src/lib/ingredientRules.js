// backend/lib/ingredientRules.js
// Simple rule-based halal checker with E-number support.
// Tweak the regex lists below and expand ./enumbers.js as needed.

const EN = require("./enumbers");

// Normalize text for matching
function normalize(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/\u00A0/g, " ") // non-breaking space
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const has = (text, rx) => rx.test(text);

// Strong HARAM signals
const HARAM = [
  /pork|porcine|bacon|ham|lard|animal\s+fat/i,
  /\bgelat[iy]n\b/i, // gelatin/gelatine (exceptions handled below)
  /\bcochineal\b|\bcarmine\b|\b(e\s*120)\b/i,
  /\b(alcohol|ethanol|wine|rum|brandy|beer)\b/i, // not counting "sugar alcohols" (exceptions below)
];

// MUSHBOOH (doubtful) signals
const MUSHBOOH = [
  /\b(e\s*471|e\s*472[a-f]?)\b/i,
  /mono[\s-]?and[\s-]?diglycerides?|monoglycerides?|diglycerides?/i,
  /\brennet\b|\benzymes?\b|\blipase\b/i,
  /\bshortening\b/i,
  /\bglycerin|glycerine|glycerol|\b(e\s*422)\b/i,
  /\bemulsifier(s)?\b|\bstabilizer(s)?\b|\bflavou?r(s)?\b/i,
];

// Whitelist / clarifications (do not auto-haram if these are present)
const EXCEPTIONS = [
  /fish\s+gelat[iy]n|gelat[iy]n\s*\(fish\)/i,
  /halal\s+gelat[iy]n/i,
  /vegetable\s+glycerin|plant\s+glycerin/i,
  /sugar\s+alcohols?/i, // erythritol, xylitol, etc.
  /fatty\s+alcohols?/i,
];

// E-number pattern (matches: E471, E 471, e-471, E472b, etc.)
const enRx = /\bE\s*[-\s]?([0-9]{3,4}[a-f]?)\b/ig;

// Small util: unique values
const unique = (arr) => [...new Set(arr)];

function analyzeIngredients(input) {
  // Accept string or array
  const text = Array.isArray(input) ? input.join(" ") : String(input || "");
  const norm = normalize(text);

  const matchedHaram = [];
  const matchedMush = [];
  const matchedExceptions = [];

  // Record exceptions first (for explanation)
  for (const rx of EXCEPTIONS) if (has(norm, rx)) matchedExceptions.push(rx.source);

  // HARAM, with exceptions (fish/halal gelatin, sugar/fatty alcohols)
  for (const rx of HARAM) {
    if (!has(norm, rx)) continue;

    // Special case for gelatin → allow if clearly fish/halal
    if (String(rx).includes("gelat") && (has(norm, /fish\s+gelat[iy]n/i) || has(norm, /halal\s+gelat[iy]n/i))) {
      continue;
    }
    // "alcohol" but not "sugar/fatty alcohols"
    if (String(rx).includes("alcohol") && (has(norm, /sugar\s+alcohols?/i) || has(norm, /fatty\s+alcohols?/i))) {
      continue;
    }
    matchedHaram.push(rx.source);
  }

  // MUSHBOOH
  for (const rx of MUSHBOOH) {
    if (has(norm, rx)) matchedMush.push(rx.source);
  }

  // E-number detection via ./enumbers.js
  // EN should be an object like: { E120: { verdict: "HARAM", note: "Carmine" }, E471: { verdict: "MUSHBOOH", note: "Mono-/diglycerides" }, ... }
  let code;
  while ((code = enRx.exec(norm)) !== null) {
    const key = ("E" + code[1]).toUpperCase().replace(/\s/g, "");
    const entry = EN[key];
    if (!entry) continue;
    const tag = `${key} (${entry.note || entry.verdict})`;
    if (entry.verdict === "HARAM") {
      matchedHaram.push(tag);
    } else if (entry.verdict === "MUSHBOOH") {
      matchedMush.push(tag);
    }
    // If an E-number is explicitly HALAL in your map, we ignore it here.
  }

  // Decide verdict
  let verdict = "HALAL";
  const uHaram = unique(matchedHaram);
  const uMush = unique(matchedMush);
  const uExcept = unique(matchedExceptions);

  const reasons = [];
  if (uHaram.length) {
    verdict = "HARAM";
    reasons.push("Detected haram indicators: " + uHaram.join(", "));
  } else if (uMush.length) {
    verdict = "MUSHBOOH";
    reasons.push("Detected doubtful indicators: " + uMush.join(", "));
  } else {
    reasons.push("No conflicting ingredients detected.");
  }
  if (uExcept.length) {
    reasons.push("Exceptions/notes: " + uExcept.join(", "));
  }

  return {
    verdict,
    reasons,
    matchedHaram: uHaram,
    matchedMush: uMush,
    matchedExceptions: uExcept,
  };
}

module.exports = { analyzeIngredients };
