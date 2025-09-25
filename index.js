// backend/index.js
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const multer = require("multer"); // NEW

// Models
const Product = require("./models/Product");
const Submission = require("./models/Submission");
const Place = require("./models/Place"); // for /api/restaurants and /api/groceries

// Storage helper (local uploads or S3 if env is set)
const { saveImageBuffer, isS3Enabled } = require("./src/lib/storage");

/* -------------------------------------------
   Env / config
------------------------------------------- */
const PORT = Number(process.env.PORT || 5050);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_JSON_MB = Number(process.env.MAX_JSON_MB || 15);
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 8);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const API_KEY = process.env.API_KEY || ""; // NEW: for /v1/submissions
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(__dirname, process.env.UPLOAD_DIR)
  : path.join(__dirname, "uploads");

/* -------------------------------------------
   App + middleware
------------------------------------------- */
const app = express();
app.set("trust proxy", 1); // NEW: for cloud proxy / HTTPS friendliness

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
  })
);
app.options("*", cors());
app.use(express.json({ limit: `${MAX_JSON_MB}mb` }));
app.use(express.urlencoded({ extended: true, limit: `${MAX_JSON_MB}mb` }));
app.use(morgan("dev"));

/* -------------------------------------------
   Static uploads (works for local mode)
------------------------------------------- */
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", fallthrough: true }));

/* -------------------------------------------
   Helpers
------------------------------------------- */
const OP_KEYS = new Set(["default", "hanafi", "shafii", "maliki", "hanbali"]);

function escapeRx(s = "") {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectProduct(doc, opParam) {
  const p = { ...doc };
  const op = String(opParam || "default").toLowerCase();
  const validOp = OP_KEYS.has(op) ? op : "default";

  let effectiveVerdict = p.verdict || "UNKNOWN";
  let effectiveReason = p.reason || "";

  if (p.opinions && p.opinions[validOp]) {
    const o = p.opinions[validOp];
    if (o?.verdict && o.verdict !== "UNKNOWN") effectiveVerdict = o.verdict;
    if (o?.note) effectiveReason = o.note;
  } else if (p.opinions && p.opinions.default) {
    const d = p.opinions.default;
    if (d?.verdict && d.verdict !== "UNKNOWN") effectiveVerdict = d.verdict;
    if (d?.note) effectiveReason = d.note;
  }

  return {
    _id: p._id,
    barcode: p.barcode,
    name: p.name,
    brand: p.brand,
    category: p.category,
    imageUrl: p.imageUrl,
    ingredientsImageUrl: p.ingredientsImageUrl,
    ingredients: p.ingredients || [],
    verdict: p.verdict || "UNKNOWN",
    reason: p.reason || "",
    effectiveVerdict,
    effectiveReason,
    opinions: p.opinions || {},
    confidence: typeof p.confidence === "number" ? p.confidence : 50,
    regionTags: p.regionTags || [],
    lastCheckedAt: p.lastCheckedAt || null,
    sources: p.sources || [],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// Admin key guard
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  next();
}

// NEW: API key guard for public multipart submissions
function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: "SERVER_NOT_CONFIGURED" });
  const key = req.headers["x-api-key"] || "";
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}

// Decode data URL or raw base64 → compress → return Buffer (JPEG)
async function toCompressedJpegBuffer(input) {
  if (!input || typeof input !== "string") throw new Error("dataUrl required");

  // Accept "data:image/...;base64,..." OR raw base64 string
  let base64 = input;
  const rx = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;
  const m = rx.exec(input);
  if (m) base64 = m[2];

  if (!base64) throw new Error("Invalid image data");
  const raw = Buffer.from(base64, "base64");

  // size guard on raw buffer (pre-compress)
  const maxBytes = MAX_IMAGE_MB * 1024 * 1024;
  if (raw.length > maxBytes * 2) {
    // allow up to 2× before compression, otherwise likely too big
    throw new Error(`Image too large (${(raw.length / 1024 / 1024).toFixed(1)}MB)`);
  }

  // Compress to web-friendly JPEG
  const out = await sharp(raw)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  if (out.length > maxBytes) {
    throw new Error(
      `Image exceeds limit after compression (${(out.length / 1024 / 1024).toFixed(1)}MB > ${MAX_IMAGE_MB}MB)`
    );
  }

  return out; // JPEG buffer
}

// NEW: Multer for multipart FormData (keeps files in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 },
});

/* -------------------------------------------
   Health & debug
------------------------------------------- */
app.get("/", (_req, res) =>
  res.json({
    ok: true,
    service: "halal-api",
    file: __filename,
    storage: isS3Enabled() ? "s3" : "local",
  })
);
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/v1/health", (_req, res) => res.json({ ok: true, ts: Date.now() })); // NEW
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || "development",
    cfg: { PORT, HOST, CORS_ORIGIN, MAX_JSON_MB, MAX_IMAGE_MB, UPLOAD_DIR, storage: isS3Enabled() ? "s3" : "local" },
  })
);

app.get("/__routes", (_req, res) => {
  const routes =
    app._router?.stack
      ?.filter((r) => r.route)
      ?.map((r) => {
        const methods = Object.keys(r.route.methods).join(",").toUpperCase();
        return `${methods} ${r.route.path}`;
      }) || [];
  res.json(routes);
});

/* -------------------------------------------
   Product read/search APIs
------------------------------------------- */
// Get product by barcode (?op=hanafi etc.)
app.get("/api/products/:barcode", async (req, res) => {
  try {
    const doc = await Product.findOne({ barcode: String(req.params.barcode).trim() }).lean();
    if (!doc) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json(projectProduct(doc, req.query.op));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Search products by text (name/brand/category) and optional region
app.get("/api/products", async (req, res) => {
  const q = (req.query.query || "").trim();
  const region = (req.query.region || "").trim().toUpperCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const op = req.query.op;

  if (!q) return res.json([]);

  try {
    let items = [];
    try {
      items = await Product.find(
        region
          ? { $text: { $search: q }, regionTags: { $in: [region] } }
          : { $text: { $search: q } }
      )
        .limit(limit)
        .lean();
    } catch {
      const rx = new RegExp(escapeRx(q), "i");
      const cond = { $or: [{ name: rx }, { brand: rx }, { category: rx }] };
      const regionCond = region ? { regionTags: { $in: [region] } } : {};
      items = await Product.find({ ...cond, ...regionCond }).limit(limit).lean();
    }
    return res.json(items.map((d) => projectProduct(d, op)));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Batch checklist by barcodes (?barcodes=111,222&op=hanafi)
app.get("/api/checklist", async (req, res) => {
  try {
    const op = req.query.op;
    const ids = String(req.query.barcodes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) return res.json([]);

    const docs = await Product.find({ barcode: { $in: ids } }).lean();
    const map = new Map(docs.map((d) => [String(d.barcode), d]));

    const out = ids.map((b) => {
      const d = map.get(b);
      return d ? projectProduct(d, op) : { barcode: b, ok: false, error: "NOT_FOUND" };
    });

    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Simple references list (brand/category/name match)
app.get("/api/reference", async (req, res) => {
  const q = (req.query.query || "").trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 30);
  if (!q) return res.json([]);

  try {
    const rx = new RegExp(escapeRx(q), "i");
    const docs = await Product.find({
      $or: [{ brand: rx }, { category: rx }, { name: rx }],
    })
      .limit(limit)
      .lean();

    const items = docs.map((d) => ({
      _id: d._id,
      title: d.name,
      brand: d.brand,
      category: d.category,
      verdict: d.verdict || "UNKNOWN",
      sourceUrl: null,
    }));

    return res.json(items);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

/* -------------------------------------------
   Places: restaurants & groceries
------------------------------------------- */
function buildPlaceQuery(req, type) {
  const q = (req.query.q || "").trim();
  const state = (req.query.state || "").trim().toUpperCase();
  const city = (req.query.city || "").trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const cond = { type };
  if (state) cond.state = state;
  if (city) cond.city = new RegExp(`^${city}$`, "i");

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    cond.$or = [{ name: rx }, { cuisine: rx }, { tags: rx }, { city: rx }];
  }
  return { cond, limit };
}

app.get("/api/restaurants", async (req, res) => {
  try {
    const { cond, limit } = buildPlaceQuery(req, "restaurant");
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = Math.min(parseInt(req.query.radius, 10) || 25000, 100000);

    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      const docs = await Place.aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [lng, lat] },
            distanceField: "distance",
            maxDistance: radius,
            query: cond,
            spherical: true,
          },
        },
        { $limit: limit },
      ]);
      return res.json(docs);
    } else {
      const docs = await Place.find(cond).limit(limit).sort({ name: 1 }).lean();
      return res.json(docs);
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

app.get("/api/groceries", async (req, res) => {
  try {
    const { cond, limit } = buildPlaceQuery(req, "grocery");
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = Math.min(parseInt(req.query.radius, 10) || 25000, 100000);

    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      const docs = await Place.aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [lng, lat] },
            distanceField: "distance",
            maxDistance: radius,
            query: cond,
            spherical: true,
          },
        },
        { $limit: limit },
      ]);
      return res.json(docs);
    } else {
      const docs = await Place.find(cond).limit(limit).sort({ name: 1 }).lean();
      return res.json(docs);
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

/* -------------------------------------------
   Reports: save photos + DB record  (no admin key)
------------------------------------------- */
app.post("/api/reports", async (req, res) => {
  try {
    const { barcode, message, photos = [] } = req.body || {};
    if (!barcode || !message) {
      return res
        .status(400)
        .json({ ok: false, error: "BAD_REQUEST", hint: "barcode & message required" });
    }

    const urls = [];
    for (let i = 0; i < Math.min(photos.length, 5); i++) {
      const raw = photos[i];
      if (!raw || typeof raw !== "string") continue;

      // Compress and save (local or S3)
      const jpeg = await toCompressedJpegBuffer(raw);
      const url = await saveImageBuffer(jpeg, {
        ext: "jpg",
        prefix: "reports",
        contentType: "image/jpeg",
      });
      urls.push(url);
    }

    const doc = await Submission.create({
      barcode,
      message: message || "",
      photos: urls.map((u, idx) => ({ url: u, kind: idx === 0 ? "front" : "ingredients" })), // reusing model
      status: "NEW",
    });

    console.log("[REPORT]", { barcode, message, photos: urls, id: String(doc._id) });
    return res.json({ ok: true, id: doc._id, savedPhotos: urls, count: urls.length });
  } catch (e) {
    console.error(e);
    const msg = e?.message || "SERVER_ERROR";
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* -------------------------------------------
   NEW: Public multipart submissions (with x-api-key)
------------------------------------------- */
/**
 * POST /v1/submissions
 * FormData (multipart):
 *  - barcode (text)
 *  - productName? (text)
 *  - brand? (text)
 *  - region? (text)
 *  - notes? (text)
 *  - front (file)
 *  - ingredients (file)
 * Header:
 *  - x-api-key: <API_KEY>
 */
app.post(
  "/v1/submissions",
  requireApiKey,
  upload.fields([
    { name: "front", maxCount: 1 },
    { name: "ingredients", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { barcode, productName = "", brand = "", region = "", notes = "" } = req.body || {};
      if (!barcode) return res.status(400).json({ ok: false, error: "BARCODE_REQUIRED" });

      const front = req.files?.front?.[0];
      const ingredients = req.files?.ingredients?.[0];
      if (!front || !ingredients) {
        return res.status(400).json({ ok: false, error: "FRONT_AND_INGREDIENTS_REQUIRED" });
      }

      // Compress
      const frontBuf = await sharp(front.buffer)
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();

      const ingredientsBuf = await sharp(ingredients.buffer)
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();

      // Save (S3 or local)
      const urlFront = await saveImageBuffer(frontBuf, {
        ext: "jpg",
        prefix: "submissions",
        contentType: "image/jpeg",
      });
      const urlIngredients = await saveImageBuffer(ingredientsBuf, {
        ext: "jpg",
        prefix: "submissions",
        contentType: "image/jpeg",
      });

      // DB record
      const doc = await Submission.create({
        barcode: String(barcode).trim(),
        message: String(notes || ""),
        photos: [
          { url: urlFront, kind: "front" },
          { url: urlIngredients, kind: "ingredients" },
        ],
        meta: { productName, brand, region }, // will be ignored if schema is strict; kept for future
        status: "NEW",
      });

      return res.json({
        ok: true,
        submission: {
          id: String(doc._id),
          barcode: String(barcode).trim(),
          frontUrl: urlFront,
          ingredientsUrl: urlIngredients,
          storage: isS3Enabled() ? "s3" : "local",
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: e?.message || "SERVER_ERROR" });
    }
  }
);

/* -------------------------------------------
   Admin: base64 image upload + product ingest
------------------------------------------- */
app.post("/api/uploads/base64", requireAdmin, async (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ ok: false, error: "NO_IMAGE" });
    }

    const jpeg = await toCompressedJpegBuffer(dataUrl);
    const url = await saveImageBuffer(jpeg, {
      ext: "jpg",
      prefix: "uploads",
      contentType: "image/jpeg",
    });

    return res.json({ ok: true, url });
  } catch (e) {
    console.error(e);
    const msg = e?.message || "SERVER_ERROR";
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/products/ingest", requireAdmin, async (req, res) => {
  try {
    const {
      barcode,
      name,
      brand = "",
      category = "",
      ingredients = [],
      imageUrl = "",
      ingredientsImageUrl = "",
      verdict = "UNKNOWN",
      reason = "",
      regionTags = [],
      confidence = 50,
      opinions = {},       // madhhab map
      sources = [],        // citations / refs
      lastCheckedAt,       // optional
    } = req.body || {};

    if (!barcode || !name) {
      return res.status(400).json({ ok: false, error: "BARCODE_AND_NAME_REQUIRED" });
    }

    const doc = await Product.findOneAndUpdate(
      { barcode: String(barcode).trim() },
      {
        $set: {
          name: String(name).trim(),
          brand: String(brand).trim(),
          category: String(category).trim(),
          ingredients: Array.isArray(ingredients)
            ? ingredients
            : String(ingredients || "")
                .split(/[,;/]+/)
                .map((s) => s.trim())
                .filter(Boolean),
          imageUrl,
          ingredientsImageUrl,
          verdict,
          reason,
          regionTags,
          confidence: Number(confidence),
          lastCheckedAt: lastCheckedAt ? new Date(lastCheckedAt) : new Date(),
          opinions,
          sources,
        },
      },
      { new: true, upsert: true }
    ).lean();

    return res.json({ ok: true, item: doc });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

/* -------------------------------------------
   Start
------------------------------------------- */
(async () => {
  try {
    if (!MONGO_URI) {
      console.error("❌ MONGO_URI is missing. Check backend/.env");
      process.exit(1);
    }
    await mongoose.connect(MONGO_URI);
    console.log("Mongo connected");
    app.listen(PORT, HOST, () => {
      console.log(`API running at http://${HOST}:${PORT}`);
      console.log(`Serving uploads from ${UPLOAD_DIR}`);
      console.log(`Storage mode: ${isS3Enabled() ? "S3" : "Local filesystem"}`);
    });
  } catch (e) {
    console.error("Failed to start:", e);
    process.exit(1);
  }
})();
