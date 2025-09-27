// backend/server.js
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const slugify = require("slugify");

// Optional S3
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

/* ──────────────────────────────────────────────────────────────────────────
   CONFIG
────────────────────────────────────────────────────────────────────────── */
const {
  PORT = 5050,
  MONGO_URI,
  NODE_ENV = "development",

  // Security
  API_KEY, // optional; if set, required for POST /v1/submissions
  CORS_ORIGIN, // optional; defaults to "*"

  // Storage
  STORAGE_DRIVER = "local", // "local" | "s3"
  UPLOAD_BASE = "uploads", // local folder
  S3_REGION,
  S3_BUCKET,
  S3_ENDPOINT, // optional (e.g. Cloudflare R2/MinIO)
  CDN_BASE_URL, // optional: if set, returned URLs are CDN_BASE_URL/<key>
} = process.env;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in backend/.env");
  process.exit(1);
}

/* ──────────────────────────────────────────────────────────────────────────
   DB (inline model so you don't need extra files right now)
────────────────────────────────────────────────────────────────────────── */
const SubmissionSchema = new mongoose.Schema(
  {
    // basic product fields
    barcode: { type: String, index: true, required: true },
    productName: { type: String },
    brand: { type: String },
    region: { type: String, default: "US" },
    notes: { type: String },

    // images
    images: {
      front: {
        url: String,
        width: Number,
        height: Number,
        key: String, // s3 key or local relative path
      },
      ingredients: {
        url: String,
        width: Number,
        height: Number,
        key: String,
      },
    },

    // status/lifecycle
    status: {
      type: String,
      enum: ["pending", "reviewing", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // meta
    client: {
      ip: String,
      ua: String,
      appVersion: String,
    },
  },
  { timestamps: true }
);
const Submission = mongoose.model("Submission", SubmissionSchema);

// NEW: Optional Product model + OFF helper
let Product;
try {
  Product = require("./models/Product");
} catch (e) {
  console.warn("Product model not found; OFF lookup route will be disabled.");
}
const { fetchFromOFF } = require("./src/lib/off");

/* ──────────────────────────────────────────────────────────────────────────
   MIDDLEWARE
────────────────────────────────────────────────────────────────────────── */
app.set("trust proxy", 1);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(
  cors({
    origin: CORS_ORIGIN ? CORS_ORIGIN.split(",").map((s) => s.trim()) : "*",
    credentials: false,
  })
);
app.use(compression());
app.use(express.json({ limit: "1mb" })); // JSON body (uploads are multipart)
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

// Global rate-limit (soft), plus a stricter one for uploads later
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600, // 600 requests per 15 min per IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ──────────────────────────────────────────────────────────────────────────
   STATIC (local uploads)
────────────────────────────────────────────────────────────────────────── */
const UPLOAD_DIR = path.join(__dirname, UPLOAD_BASE);
if (STORAGE_DRIVER === "local") {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));
}

/* ──────────────────────────────────────────────────────────────────────────
   STORAGE HELPERS (local or s3)
────────────────────────────────────────────────────────────────────────── */
const s3 =
  STORAGE_DRIVER === "s3"
    ? new S3Client({
        region: S3_REGION,
        endpoint: S3_ENDPOINT || undefined,
        forcePathStyle: !!S3_ENDPOINT, // for R2/MinIO
      })
    : null;

function publicUrlForKey(key) {
  if (CDN_BASE_URL) return `${CDN_BASE_URL.replace(/\/+$/, "")}/${key}`;
  if (STORAGE_DRIVER === "s3") return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
  // local
  return `/${UPLOAD_BASE}/${key}`;
}

async function saveImageBuffer({ buffer, keyBase, contentType = "image/jpeg" }) {
  // Create 2 variants: full (max 1600w) and thumb (max 480w)
  const fullKey = `${keyBase}-full.jpg`;
  const thumbKey = `${keyBase}-thumb.jpg`;

  const full = await sharp(buffer)
    .rotate()
    .jpeg({ quality: 82, mozjpeg: true })
    .resize({ width: 1600, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const thumb = await sharp(buffer)
    .rotate()
    .jpeg({ quality: 76, mozjpeg: true })
    .resize({ width: 480, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  if (STORAGE_DRIVER === "s3") {
    if (!S3_BUCKET || !S3_REGION) throw new Error("S3 config missing");

    // IMPORTANT: No ACL on Bucket owner enforced buckets.
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fullKey,
        Body: full.data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: thumbKey,
        Body: thumb.data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  } else {
    const fullPath = path.join(UPLOAD_DIR, fullKey);
    const thumbPath = path.join(UPLOAD_DIR, thumbKey);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, full.data);
    fs.writeFileSync(thumbPath, thumb.data);
  }

  return {
    full: {
      key: fullKey,
      url: publicUrlForKey(fullKey),
      width: full.info.width,
      height: full.info.height,
    },
    thumb: {
      key: thumbKey,
      url: publicUrlForKey(thumbKey),
      width: thumb.info.width,
      height: thumb.info.height,
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   AUTH MIDDLEWARE (optional x-api-key for field uploads)
────────────────────────────────────────────────────────────────────────── */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // disabled
  const key = req.header("x-api-key");
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/* ──────────────────────────────────────────────────────────────────────────
   MULTER (in-memory; we pass buffers to sharp)
────────────────────────────────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024, // 6 MB per file (front / ingredients)
    files: 2,
  },
  fileFilter: (_req, file, cb) => {
    if (!/image\/(jpe?g|png|webp|heic|heif)/i.test(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }
    cb(null, true);
  },
});

/* ──────────────────────────────────────────────────────────────────────────
   HEALTH
────────────────────────────────────────────────────────────────────────── */
app.get("/", (_req, res) => res.json({ ok: true, service: "halal-api", file: __filename }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/v1/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ──────────────────────────────────────────────────────────────────────────
   EXISTING ROUTES (unchanged)
────────────────────────────────────────────────────────────────────────── */
// Adjust these paths to match where your files actually live:
try {
  const groceriesRouter = require("./src/routes/groceries.routes");
  const restaurantsRouter = require("./src/routes/restaurants.routes");
  const ownerRouter = require("./src/routes/owner.routes");
  app.use(ownerRouter); // serves both /api/owner/* and /owner/*
  app.use("/api/groceries", groceriesRouter);
  app.use("/api/restaurants", restaurantsRouter);
} catch (e) {
  // If those files aren’t present yet, don’t crash during early setup:
  console.warn("ℹ️ Some optional routers not loaded:", e?.message);
}

/* ──────────────────────────────────────────────────────────────────────────
   NEW: SUBMISSIONS (barcode + photos)
────────────────────────────────────────────────────────────────────────── */

// Stricter per-IP rate for uploads
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60, // 60 uploads per 10 min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

function normalizeBarcode(s = "") {
  return String(s).replace(/\D/g, "").slice(0, 18);
}

app.post(
  "/v1/submissions",
  requireApiKey,
  uploadLimiter,
  upload.fields([
    { name: "front", maxCount: 1 },
    { name: "ingredients", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const barcode = normalizeBarcode(req.body.barcode || "");
      if (!barcode || barcode.length < 6) {
        return res.status(400).json({ ok: false, error: "barcode is required (6-18 digits)" });
      }

      const productName = (req.body.productName || "").toString().trim();
      const brand = (req.body.brand || "").toString().trim();
      const region = (req.body.region || "US").toString().trim();
      const notes = (req.body.notes || "").toString().trim();
      const appVersion = (req.body.appVersion || "").toString().trim();

      const fFront = (req.files?.front || [])[0];
      const fIngr = (req.files?.ingredients || [])[0];

      if (!fFront || !fIngr) {
        return res
          .status(400)
          .json({ ok: false, error: "Both front and ingredients images are required" });
      }

      // Slug for key base
      const slug =
        slugify([brand, productName].filter(Boolean).join(" "), { lower: true, strict: true }) ||
        "product";

      const uid = uuidv4().slice(0, 12);
      const baseDir = `products/${barcode}/${uid}-${slug}`;

      // Process/save
      const frontOut = await saveImageBuffer({
        buffer: fFront.buffer,
        keyBase: `${baseDir}-front`,
      });
      const ingrOut = await saveImageBuffer({
        buffer: fIngr.buffer,
        keyBase: `${baseDir}-ingredients`,
      });

      const doc = await Submission.create({
        barcode,
        productName,
        brand,
        region,
        notes,
        images: {
          front: {
            url: frontOut.full.url,
            width: frontOut.full.width,
            height: frontOut.full.height,
            key: frontOut.full.key,
          },
          ingredients: {
            url: ingrOut.full.url,
            width: ingrOut.full.width,
            height: ingrOut.full.height,
            key: ingrOut.full.key,
          },
        },
        client: {
          ip: req.ip,
          ua: req.get("user-agent"),
          appVersion,
        },
      });

      return res.status(201).json({
        ok: true,
        submission: {
          id: doc._id,
          barcode: doc.barcode,
          productName: doc.productName,
          brand: doc.brand,
          region: doc.region,
          status: doc.status,
          images: {
            front: { url: doc.images.front.url },
            ingredients: { url: doc.images.ingredients.url },
          },
          createdAt: doc.createdAt,
        },
      });
    } catch (err) {
      console.error("submit error:", err);
      return res.status(500).json({ ok: false, error: "Upload failed" });
    }
  }
);

// Quick fetch by id
app.get("/v1/submissions/:id", requireApiKey, async (req, res) => {
  try {
    const doc = await Submission.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, submission: doc });
  } catch (e) {
    res.status(400).json({ ok: false, error: "Invalid id" });
  }
});

// List by barcode (for your app to check if already submitted)
app.get("/v1/submissions", requireApiKey, async (req, res) => {
  const bc = normalizeBarcode(req.query.barcode || "");
  const q = {};
  if (bc) q.barcode = bc;
  const docs = await Submission.find(q).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ ok: true, items: docs });
});

/* ──────────────────────────────────────────────────────────────────────────
   PRODUCTS: local → OFF fallback lookup (supports ?refresh=1 to force refetch)
────────────────────────────────────────────────────────────────────────── */
if (Product) {
  app.get("/api/products/:barcode", async (req, res) => {
    try {
      const barcode = String(req.params.barcode || "").replace(/\D/g, "");
      if (!barcode) return res.status(400).json({ ok: false, error: "BAD_BARCODE" });

      const force = String(req.query.refresh || req.query.force || "").toLowerCase();
      const shouldRefresh = force === "1" || force === "true" || force === "yes";

      // 1) Try local unless refresh is requested
      if (!shouldRefresh) {
        const doc = await Product.findOne({ barcode }).lean();
        if (doc) return res.json({ ok: true, source: "local", item: doc });
      }

      // 2) Fallback to OFF
      const ua = process.env.OFF_USER_AGENT || "HalalQuest/1.0 (+contact)";
      const normalized = await fetchFromOFF(barcode, ua);

      if (!normalized) {
        // If OFF fails but we have local, return local
        const fallback = await Product.findOne({ barcode }).lean();
        if (fallback) return res.json({ ok: true, source: "local", item: fallback });
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // 3) Upsert into your DB
      const saved = await Product.findOneAndUpdate(
        { barcode },
        { $set: normalized },
        { new: true, upsert: true }
      ).lean();

      return res.json({ ok: true, source: "openfoodfacts", item: saved });
    } catch (err) {
      console.error("OFF lookup error:", err);
      return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   404 + ERROR HANDLERS
────────────────────────────────────────────────────────────────────────── */
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

/* ──────────────────────────────────────────────────────────────────────────
   BOOT
────────────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Mongo connected");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 API on http://localhost:${PORT}`);
      console.log(
        `   Storage: ${STORAGE_DRIVER}${
          STORAGE_DRIVER === "local" ? ` -> /${UPLOAD_BASE}` : ""
        }`
      );
    });
  } catch (e) {
    console.error("❌ Failed to start:", e);
    process.exit(1);
  }
})();
