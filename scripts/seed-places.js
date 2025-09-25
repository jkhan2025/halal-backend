// backend/scripts/seed-places.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Place = require("../models/Place");

// --- helpers ----------------------------------------------------
function firstExisting(...paths) {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}
function readJsonArray(filePath) {
  if (!filePath) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("⚠️  Failed to read:", filePath, e.message);
    return [];
  }
}
const hasCoords = (c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lng);

// Normalize a record from JSON into our Place shape
function normalizePlace(item, type) {
  const c = hasCoords(item.coords) ? { lat: item.coords.lat, lng: item.coords.lng } : undefined;

  const doc = {
    type,
    name: item.name,
    cuisine: item.cuisine || null,
    tags: item.tags || [],
    address: item.address || null,
    city: item.city || null,
    state: item.state || null,
    postcode: item.postcode || null,
    price: item.price ?? null,
    rating: item.rating ?? null,
    halal: item.halal !== false,
    certified: !!item.certified,
    phone: item.phone || null,
    website: item.website || null,
    photos: item.photos || [],
    hours: item.hours || null,
    hours_raw: item.hours_raw || null,
    source: "ct_seed",
    sourceId: item.id || null,
  };
  if (c) doc.coords = c; // only include when valid
  return doc;
}

// --- main -------------------------------------------------------
(async () => {
  const { MONGO_URI } = process.env;
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI missing. Put it in backend/.env");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("Mongo connected");

  const overrideDir = process.env.SEED_DATA_DIR; // optional
  const root = path.join(__dirname, "..");

  const rPath = firstExisting(
    overrideDir && path.join(overrideDir, "ct_restaurants.json"),
    path.join(root, "src", "data", "ct_restaurants.json"),
    path.join(root, "data", "ct_restaurants.json")
  );
  const gPath = firstExisting(
    overrideDir && path.join(overrideDir, "ct_groceries.json"),
    path.join(root, "src", "data", "ct_groceries.json"),
    path.join(root, "data", "ct_groceries.json")
  );

  console.log("Reading:", rPath || "(missing)", "and", gPath || "(missing)");

  const restaurantsIn = readJsonArray(rPath);
  const groceriesIn  = readJsonArray(gPath);

  let upserted = 0, missingCoordNames = [];

  async function upsertPlace(raw, type) {
    const data = normalizePlace(raw, type);
    const filter = data.sourceId
      ? { source: data.source, sourceId: data.sourceId }
      : { name: data.name, city: data.city, state: data.state, type: data.type };

    const update = { $set: data };
    if (hasCoords(data.coords)) {
      update.$set.geo = { type: "Point", coordinates: [data.coords.lng, data.coords.lat] };
    } else {
      update.$unset = { geo: 1 };
      missingCoordNames.push(data.name);
    }

    await Place.findOneAndUpdate(
      filter,
      update,
      { upsert: true, new: true, setDefaultsOnInsert: false } // don't invent defaults
    );
    upserted++;
  }

  for (const r of restaurantsIn) await upsertPlace(r, "restaurant");
  for (const g of groceriesIn)  await upsertPlace(g, "grocery");

  console.log(`✅ Seeded/updated places: ${upserted} (restaurants: ${restaurantsIn.length}, groceries: ${groceriesIn.length})`);
  if (missingCoordNames.length) {
    console.log(`ℹ️  ${missingCoordNames.length} items had no coords; geo was unset (OK):`);
    console.log("   - " + missingCoordNames.slice(0, 10).join("\n   - ") + (missingCoordNames.length > 10 ? "\n   …" : ""));
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
