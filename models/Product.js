// backend/models/Product.js
const mongoose = require("mongoose");

/** Evidence/source for a verdict */
const SourceSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true }, // e.g. "Manufacturer email", "Official cert"
    url: { type: String, trim: true },
    kind: {
      type: String,
      enum: ["official", "brand", "ocr", "community", "other"],
      default: "other",
    },
  },
  { _id: false }
);

/** Opinion-specific verdict (for different schools) */
const OpinionSchema = new mongoose.Schema(
  {
    verdict: {
      type: String,
      enum: ["HALAL", "HARAM", "MUSHBOOH", "UNKNOWN"],
      default: "UNKNOWN",
    },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const ProductSchema = new mongoose.Schema(
  {
    // Mild sanitizer removes whitespace if any slips in
    barcode: {
      type: String,
      unique: true,
      index: true,
      required: true,
      trim: true,
      set: (v) => String(v || "").replace(/\s+/g, ""),
    },

    name: { type: String, required: true, trim: true },
    brand: { type: String, trim: true },
    category: { type: String, trim: true },

    imageUrl: { type: String, trim: true },
    // separate image for ingredients panel
    ingredientsImageUrl: { type: String, trim: true },

    ingredients: [{ type: String, trim: true }],

    verdict: {
      type: String,
      enum: ["HALAL", "HARAM", "MUSHBOOH", "UNKNOWN"],
      default: "UNKNOWN",
    },
    reason: { type: String, trim: true },

    confidence: { type: Number, min: 0, max: 100, default: 50 },

    opinions: {
      default: { type: OpinionSchema, default: { verdict: "UNKNOWN", note: "" } },
      hanafi: OpinionSchema,
      shafii: OpinionSchema,
      maliki: OpinionSchema,
      hanbali: OpinionSchema,
    },

    regionTags: [{ type: String, uppercase: true, trim: true }], // e.g. ["US","UK","MY"]
    lastCheckedAt: Date,

    sources: [SourceSchema],
  },
  { timestamps: true }
);

/* -----------------------------
   Indexes
----------------------------- */
// Weighted text index (name > brand > category) for better search ranking
ProductSchema.index(
  { name: "text", brand: "text", category: "text" },
  { weights: { name: 10, brand: 5, category: 2 } }
);
// Optional quick filters
ProductSchema.index({ brand: 1 });
ProductSchema.index({ category: 1 });
ProductSchema.index({ regionTags: 1 });

/* -----------------------------
   Normalization helpers
----------------------------- */
function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => String(s || "").trim()).filter(Boolean);
}
function normalizeRegionTags(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
}

/* -----------------------------
   Hooks: normalize on save/update
----------------------------- */
ProductSchema.pre("save", function () {
  this.ingredients = normalizeStringArray(this.ingredients);
  this.regionTags = normalizeRegionTags(this.regionTags);
});

ProductSchema.pre("findOneAndUpdate", function () {
  const u = this.getUpdate() || {};
  const $set = u.$set || u;

  if ($set.ingredients) {
    $set.ingredients = normalizeStringArray($set.ingredients);
  }
  if ($set.regionTags) {
    $set.regionTags = normalizeRegionTags($set.regionTags);
  }
  if (typeof $set.barcode === "string") {
    $set.barcode = $set.barcode.replace(/\s+/g, "");
  }

  // push normalized update back
  if (u.$set) u.$set = $set;
  else this.set($set);
});

/* -----------------------------
   JSON shape
----------------------------- */
ProductSchema.set("toJSON", {
  versionKey: false,
  transform: (_doc, ret) => ret,
});

module.exports = mongoose.model("Product", ProductSchema);
