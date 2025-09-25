// backend/seed.js
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("./models/Product");

const { MONGO_URI } = process.env;

const sample = [
  {
    barcode: "8901234567890",
    name: "Acme Dark Chocolate 70%",
    brand: "Acme",
    imageUrl: "",
    ingredients: ["Cocoa mass", "Sugar", "Emulsifier (E471)", "Vanilla"],
    verdict: "MUSHBOOH",
    reason: "Contains E471 (source may be animal- or plant-derived).",
    sources: [{ label: "Label check", url: "" }],
  },
  {
    barcode: "012345678905",
    name: "Sunrise Strawberry Gelatin Dessert",
    brand: "Sunrise",
    imageUrl: "",
    ingredients: ["Sugar", "Gelatin", "Strawberry flavor", "Color (E120)"],
    verdict: "HARAM",
    reason: "Gelatin and E120 (carmine) are animal-derived.",
    sources: [{ label: "Label check", url: "" }],
  },
  {
    barcode: "978020137962",
    name: "Pure Cane Sugar",
    brand: "Green Valley",
    imageUrl: "",
    ingredients: ["Sugar"],
    verdict: "HALAL",
    reason: "No conflicting ingredients detected.",
    sources: [{ label: "Common knowledge", url: "" }],
  },
];

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Mongo connected");
    await Product.deleteMany({});
    await Product.insertMany(sample);
    console.log("Seeded products:", sample.length);
  } catch (e) {
    console.error(e);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}
run();
