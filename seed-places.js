require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Place = require("./models/Place");

async function load(file) {
  const p = path.join(__dirname, "data", file);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

(async () => {
  try {
    const { MONGO_URI } = process.env;
    if (!MONGO_URI) throw new Error("MONGO_URI missing");
    await mongoose.connect(MONGO_URI);
    console.log("Mongo connected");

    const restaurants = await load("restaurants.ct.json");
    const groceries = await load("groceries.ct.json");

    const all = [...restaurants, ...groceries];
    if (!all.length) {
      console.log("No data files found under backend/data/");
      process.exit(0);
    }

    await Place.insertMany(all, { ordered: false });
    console.log(`Inserted places: ${all.length}`);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
