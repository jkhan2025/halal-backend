// backend/scripts/reset-qa-reference.js
//
// Removes ONLY the QA Reference Dataset V1 records seeded by
// backend/scripts/seed-qa-reference.js:
//   - Places tagged source:"qa_reference_v1" (the 10 restaurants + 8 groceries)
//   - Products matching the exact deterministic barcode list read from
//     backend/src/data/qa_reference_products.json (never a barcode prefix
//     regex — an explicit id list, per the approved design)
//
// Safe by construction:
//  - Same runtimeSafety.assertMaintenanceAllowed() gate as every other
//    maintenance script in this repo. Cannot run against Atlas, production,
//    or any host/database other than mongodb://127.0.0.1:27018/halal_quest_dev.
//  - Never calls an unscoped/blanket delete, never drops a collection, never
//    drops the database. Every delete is scoped to an explicit filter
//    identifying exactly the V1 reference records and nothing else.
require("../src/config/runtimeSafety").assertMaintenanceAllowed();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Place = require("../models/Place");
const Product = require("../models/Product");

const SOURCE = "qa_reference_v1";
const DATA_DIR = path.join(__dirname, "..", "src", "data");

(async () => {
  const { MONGO_URI } = process.env;
  await mongoose.connect(MONGO_URI);
  console.log("Mongo connected:", MONGO_URI);

  const products = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "qa_reference_products.json"), "utf8"));
  const barcodes = products.map((p) => p.barcode).filter(Boolean);
  if (!barcodes.length) throw new Error("Refusing to reset: no QA reference product barcodes were found to scope the delete.");

  const placeResult = await Place.deleteMany({ source: SOURCE });
  const productResult = await Product.deleteMany({ barcode: { $in: barcodes } });

  console.log(`Removed ${placeResult.deletedCount} QA reference place(s) (source="${SOURCE}").`);
  console.log(`Removed ${productResult.deletedCount} QA reference product(s) (${barcodes.length} exact barcodes checked).`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
