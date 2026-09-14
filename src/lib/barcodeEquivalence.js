// backend/src/lib/barcodeEquivalence.js
//
// Narrow, explicit UPC-A <-> EAN-13 lookup equivalence for local Product
// barcode matching. This defines exactly ONE supported transform pair —
// it is not a generic barcode normalizer and must never be used to
// reinterpret arbitrary-length or non-numeric input:
//
//   - a 12-digit, all-numeric barcode ("XXXXXXXXXXXX") has exactly one
//     equivalent candidate: itself with a single leading zero prepended
//     ("0XXXXXXXXXXXX", 13 digits) — the standard UPC-A -> EAN-13 form.
//   - a 13-digit, all-numeric barcode that begins with "0" has exactly
//     one equivalent candidate: itself with that single leading zero
//     stripped (12 digits) — the reverse, EAN-13 -> UPC-A form.
//   - anything else (non-numeric, any other length, or a 13-digit code
//     that does not start with "0") has NO equivalent candidate.
//
// The originally-supplied value is always the first, and is never itself
// mutated, candidate.

function getBarcodeLookupCandidates(rawBarcode) {
  const original = typeof rawBarcode === "string" ? rawBarcode : String(rawBarcode ?? "");
  const candidates = [original];

  if (!/^\d+$/.test(original)) return candidates;

  if (original.length === 12) {
    candidates.push(`0${original}`);
  } else if (original.length === 13 && original.charAt(0) === "0") {
    candidates.push(original.slice(1));
  }

  return candidates;
}

module.exports = { getBarcodeLookupCandidates };
