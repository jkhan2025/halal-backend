// backend/src/domain/productLookup.js
//
// Local Product barcode lookup, aware of the UPC-A/EAN-13 equivalence
// (see src/lib/barcodeEquivalence.js). Takes the Product model as a
// parameter (not required at module scope) so this stays testable with a
// fake/mocked model — no real Mongo connection needed.

const { getBarcodeLookupCandidates } = require("../lib/barcodeEquivalence");

// Tries the originally-supplied barcode first, then its UPC-A/EAN-13
// equivalent (if the barcode qualifies for one) — never any other
// transformation. Returns the first matching stored document, or null.
async function findProductByBarcodeCandidates(Product, rawBarcode) {
  const candidates = getBarcodeLookupCandidates(rawBarcode);
  for (const candidate of candidates) {
    const doc = await Product.findOne({ barcode: candidate }).lean();
    if (doc) return doc;
  }
  return null;
}

module.exports = { findProductByBarcodeCandidates };
