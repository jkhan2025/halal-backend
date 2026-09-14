// backend/scripts/seed-qa-reference.js
//
// Seeds the small, deterministic QA Reference Dataset V1:
//   10 restaurants + 8 grocery stores (backend/src/data/qa_reference_places.json)
//   20 products (backend/src/data/qa_reference_products.json)
//
// Safe by construction:
//  - Refuses to run unless runtimeSafety.assertMaintenanceAllowed() resolves
//    to the reserved local dev database (mongodb://127.0.0.1:27018/halal_quest_dev)
//    with HALAL_ALLOW_MAINTENANCE=1 explicitly set. Same gate every other
//    seed script in this repo already uses — not duplicated or weakened here.
//  - Idempotent: places are upserted by {source:"qa_reference_v1", sourceId},
//    products are upserted by their unique barcode. Re-running this script
//    any number of times converges to the same 18 places + 20 products.
//  - Every place is written with a deterministic, pre-computed _id so that
//    the restaurantTrust/groceryTrust claims/evidence embedded in the JSON
//    (which reference that exact _id as subject.placeId/coverage.placeId)
//    resolve correctly the moment the document exists.
require("../src/config/runtimeSafety").assertMaintenanceAllowed();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Place = require("../models/Place");
const Product = require("../models/Product");

const SOURCE = "qa_reference_v1";
const DATA_DIR = path.join(__dirname, "..", "src", "data");

function readJsonArray(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error(`Expected a JSON array in ${filePath}`);
  return data;
}

async function upsertPlace(raw) {
  const { sourceId, _id, coords, ...rest } = raw;
  if (!sourceId) throw new Error(`QA reference place missing sourceId: ${raw.name}`);
  if (!/^[0-9a-f]{24}$/.test(_id)) throw new Error(`QA reference place ${sourceId} has an invalid deterministic _id`);

  const data = { ...rest, source: SOURCE, sourceId };
  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    data.coords = coords;
    data.geo = { type: "Point", coordinates: [coords.lng, coords.lat] };
  }

  await Place.findOneAndUpdate(
    { source: SOURCE, sourceId },
    { $set: data, $setOnInsert: { _id: new mongoose.Types.ObjectId(_id) } },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  );
}

async function upsertProduct(raw) {
  if (!raw.barcode) throw new Error(`QA reference product missing barcode: ${raw.name}`);
  await Product.findOneAndUpdate(
    { barcode: raw.barcode },
    { $set: raw },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  );
}

(async () => {
  const { MONGO_URI } = process.env;
  await mongoose.connect(MONGO_URI);
  console.log("Mongo connected:", MONGO_URI);

  const places = readJsonArray(path.join(DATA_DIR, "qa_reference_places.json"));
  const products = readJsonArray(path.join(DATA_DIR, "qa_reference_products.json"));

  for (const place of places) await upsertPlace(place);
  for (const product of products) await upsertProduct(product);

  const restaurants = places.filter((p) => p.type === "restaurant").length;
  const groceries = places.filter((p) => p.type === "grocery").length;
  console.log(`Seeded QA Reference Dataset V1: ${restaurants} restaurants, ${groceries} groceries, ${products.length} products.`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
