// backend/server.js
const runtimeSafety = require("./src/config/runtimeSafety").validateRuntime();

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

// Optional Supabase Storage (production evidence photo storage, protected
// mode only — see runtimeSafety.js, which forbids this driver locally)
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* ──────────────────────────────────────────────────────────────────────────
   CONFIG
────────────────────────────────────────────────────────────────────────── */
const {
  PORT = 5050,
  HOST = "0.0.0.0",
  MONGO_URI,
  NODE_ENV = "development",

  // Security
  API_KEY, // optional; if set, required for POST /v1/submissions
  ADMIN_KEY, // required by the startup safety boundary; gates /api/admin/* moderation routes
  CORS_ORIGIN, // optional; defaults to "*"

  // Storage
  STORAGE_DRIVER = "local", // "local" | "supabase"
  UPLOAD_BASE = "uploads", // local folder
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, // secret — backend-only, never sent to the frontend
  SUPABASE_STORAGE_BUCKET,
  CDN_BASE_URL, // optional; local mode only — see saveImageBuffer's supabase branch for why signed moderation URLs never depend on this
  STORAGE_KEY_PREFIX, // optional; supabase mode only — environment namespace prefix, e.g. "prod" (see src/lib/storageKey.js)
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
        key: String, // storage key (Supabase Storage path) or local relative path
      },
      ingredients: {
        url: String,
        width: Number,
        height: Number,
        key: String,
      },
    },
    // NEW: freeform report photos (0-5), distinct from the fixed front/
    // ingredients pair above — backs POST /api/reports.
    //
    // `key` (production object storage v1): the durable storage identity
    // for this photo — a local relative path or a Supabase Storage path.
    // Optional and absent on submissions created before this pass
    // (local-QA-era documents have `url` only) — nothing back-fills or
    // requires it on old documents. `url` remains populated for local-mode
    // submissions (unchanged, already-public /uploads path); it is
    // deliberately left null for new supabase-mode submissions, since a
    // private bucket makes a stored "public" URL misleading — see
    // saveImageBuffer's supabase branch.
    photos: [
      {
        url: String,
        key: String,
        kind: { type: String, enum: ["front", "ingredients"], default: "front" },
        _id: false,
      },
    ],

    // status/lifecycle
    status: {
      type: String,
      enum: ["pending", "reviewing", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // moderation metadata (submission moderation v1) — minimal audit trail
    // only. Deliberately does NOT include any Product-verdict field: see
    // the trust-boundary note above the moderation routes below.
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: null },
    reviewerNotes: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    linkedProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null, index: true },

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
const { buildProductLookupPayload } = require("./src/domain/trust");
const { findProductByBarcodeCandidates } = require("./src/domain/productLookup");
const { searchProducts } = require("./src/domain/productSearch");
const { createProductReport } = require("./src/domain/productReports");
const { buildHelmetOptions } = require("./src/config/httpSecurityHeaders");
const { createRequireAdminKey } = require("./src/config/adminAuth");
const {
  listSubmissions,
  getSubmission,
  updateSubmissionStatus,
  linkSubmissionToProduct,
  unlinkSubmissionFromProduct,
} = require("./src/domain/submissionModeration");
const { sanitizeKeyPrefix, isValidStorageKey } = require("./src/lib/storageKey");
const { createPhotoStorage } = require("./src/domain/photoStorage");
const { createSignedPhotoUrl } = require("./src/lib/signedPhotoUrl");
const { attachPhotoDisplayUrls, attachPhotoDisplayUrlsToList } = require("./src/domain/photoDisplayUrls");

// Validated once at startup — throws (crashing boot) if someone sets a
// malformed STORAGE_KEY_PREFIX, the same fail-fast posture already used
// for other storage misconfiguration (e.g. missing SUPABASE_STORAGE_BUCKET).
const RESOLVED_STORAGE_KEY_PREFIX = sanitizeKeyPrefix(STORAGE_KEY_PREFIX);

/* ──────────────────────────────────────────────────────────────────────────
   MIDDLEWARE
────────────────────────────────────────────────────────────────────────── */
app.set("trust proxy", 1);
app.use(helmet(buildHelmetOptions(runtimeSafety.mode)));
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
const UPLOAD_DIR = runtimeSafety.uploadRoot;
if (STORAGE_DRIVER === "local") {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));
}

/* ──────────────────────────────────────────────────────────────────────────
   STORAGE HELPERS (local or supabase)
────────────────────────────────────────────────────────────────────────── */
// The service-role key grants full, RLS-bypassing access — this client is
// constructed ONLY when STORAGE_DRIVER=supabase (itself only reachable in
// protected mode, per runtimeSafety.js) and is never exposed outside this
// server process; nothing here ever sends it to the frontend.
const supabaseStorageClient =
  STORAGE_DRIVER === "supabase" ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

function publicUrlForKey(key) {
  if (CDN_BASE_URL) return `${CDN_BASE_URL.replace(/\/+$/, "")}/${key}`;
  // local — supabase mode never calls this (see photoStorage.js's supabase
  // branch, which returns url: null for a private bucket instead).
  return `/uploads/${key}`;
}

// saveImageBuffer/deleteSavedImage themselves live in src/domain/photoStorage.js
// (production evidence photo storage v1) — extracted so the actual
// supabase/local upload+delete logic is unit-testable (this file can never
// be require()'d under NODE_ENV=test — see src/config/runtimeSafety.js).
// This wiring is the only place real sharp/fs/Supabase client instances are
// handed to it; nothing about the live behavior itself changes by being
// here instead of inline.
const { saveImageBuffer, deleteSavedImage } = createPhotoStorage({
  sharp,
  fs,
  path,
  storageDriver: STORAGE_DRIVER,
  uploadDir: UPLOAD_DIR,
  supabaseClient: supabaseStorageClient,
  bucket: SUPABASE_STORAGE_BUCKET,
  keyPrefix: RESOLVED_STORAGE_KEY_PREFIX,
  publicUrlForKey,
  isValidStorageKey,
});

// Signed, short-lived GET URL for a private Supabase evidence photo — used
// only by the moderation routes below, generated at READ TIME, never
// stored.
function signPhotoUrl(key) {
  return createSignedPhotoUrl({ supabaseClient: supabaseStorageClient, bucket: SUPABASE_STORAGE_BUCKET }, { key });
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

// Moderation endpoints use a SEPARATE, fail-closed gate (createRequireAdminKey)
// rather than requireApiKey above — unlike requireApiKey, this one never
// becomes public just because ADMIN_KEY is unset. See src/config/adminAuth.js.
const requireAdminKey = createRequireAdminKey(ADMIN_KEY);

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
   REPORTS: "product not found" reports (barcode + free-text message +
   exactly 2 photos). No API key — matches the public, unauthenticated
   /api/reports behavior already used by the mobile app's report flow.
   Request-shape/size/type validation lives in src/domain/productReports.js
   (runs BEFORE any disk write); this route adds its own rate limit since
   it is the one fully public, unauthenticated write endpoint in this file.

   req.ip / rate-limit assumption: `app.set("trust proxy", 1)` (above)
   makes req.ip honor exactly one hop of X-Forwarded-For, which is correct
   for a single reverse-proxy deployment (typical local dev / most PaaS
   setups). If a future production topology adds more proxy hops, "trust
   proxy" must be retuned accordingly, or a client that can reach this
   process directly could spoof X-Forwarded-For to defeat this per-IP limit.
────────────────────────────────────────────────────────────────────────── */
const reportsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  // Deliberately tighter than the API-key-gated /v1/submissions upload
  // limiter (60/10min) since this endpoint has no key at all. 20/10min is
  // generous enough that normal manual contribution QA (a handful of
  // reports in a session) is never throttled.
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMITED" },
});

app.post("/api/reports", reportsLimiter, async (req, res) => {
  try {
    const result = await createProductReport(
      { Submission, saveImageBuffer, uuidv4, deleteSavedImage },
      {
        barcode: req.body?.barcode,
        message: req.body?.message,
        photos: req.body?.photos,
        client: { ip: req.ip, ua: req.get("user-agent") || "" },
      }
    );
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error, hint: result.hint });
    }
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error("Report submission error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   INTERNAL MODERATION (submission moderation v1) — admin-key gated via
   requireAdminKey, which FAILS CLOSED: if ADMIN_KEY is unset, every route
   below returns 503 MODERATION_UNAVAILABLE, never falls through as public.

   ═══════════════════════════════════════════════════════════════════════
   TRUST BOUNDARY (non-negotiable): approving or linking a submission here
   means "a human reviewer accepted this as usable evidence." It NEVER
   means "this product is Halal." None of these routes read or write
   Product.verdict, Product.trust, Product.opinions, Product.ingredients,
   or invoke src/trust.js / any canonical verdict computation — see
   src/domain/submissionModeration.js's header for the enforced mechanism
   (linking only ever reads a Product's _id, never any other field).
   ═══════════════════════════════════════════════════════════════════════
────────────────────────────────────────────────────────────────────────── */
// Photo access (production evidence photo storage v1): local mode keeps
// exposing the already-public, already-stored `url` unchanged; supabase
// mode exposes a fresh short-lived signed `displayUrl` derived from the
// stored `key`, generated here at read time — never written back to Mongo.
// A legacy local-QA record with a `url` but no `key` gets displayUrl: null
// under supabase mode rather than any attempt to derive/guess one.
app.get("/api/admin/submissions", requireAdminKey, async (req, res) => {
  const result = await listSubmissions(Submission, { status: req.query.status, limit: req.query.limit });
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
  const items = await attachPhotoDisplayUrlsToList(result.body.items, { storageDriver: STORAGE_DRIVER, signPhotoUrl });
  return res.status(result.status).json({ ...result.body, items });
});

app.get("/api/admin/submissions/:id", requireAdminKey, async (req, res) => {
  const result = await getSubmission(Submission, req.params.id);
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
  const submission = await attachPhotoDisplayUrls(result.body.submission, { storageDriver: STORAGE_DRIVER, signPhotoUrl });
  return res.status(result.status).json({ ...result.body, submission });
});

app.patch("/api/admin/submissions/:id/status", requireAdminKey, async (req, res) => {
  const result = await updateSubmissionStatus(Submission, req.params.id, {
    toStatus: req.body?.status,
    reviewedBy: req.body?.reviewedBy,
    reviewerNotes: req.body?.reviewerNotes,
    rejectionReason: req.body?.rejectionReason,
  });
  return res.status(result.status).json(result.ok ? result.body : { ok: false, error: result.error, hint: result.hint });
});

app.post("/api/admin/submissions/:id/unlink", requireAdminKey, async (req, res) => {
  const result = await unlinkSubmissionFromProduct(Submission, req.params.id);
  return res.status(result.status).json(result.ok ? result.body : { ok: false, error: result.error });
});

if (Product) {
  app.post("/api/admin/submissions/:id/link", requireAdminKey, async (req, res) => {
    const result = await linkSubmissionToProduct(Submission, Product, req.params.id, req.body?.productId);
    return res.status(result.status).json(result.ok ? result.body : { ok: false, error: result.error, hint: result.hint });
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   PRODUCTS: search, and local → OFF fallback lookup (supports ?refresh=1 to
   force refetch)
────────────────────────────────────────────────────────────────────────── */
if (Product) {
  // Text search by name/brand/category (?query=, optional ?region=, ?limit=).
  app.get("/api/products", async (req, res) => {
    try {
      const result = await searchProducts(Product, {
        query: req.query.query,
        region: req.query.region,
        limit: req.query.limit,
      });
      return res.json(result);
    } catch (err) {
      console.error("Product search error:", err);
      return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  app.get("/api/products/:barcode", async (req, res) => {
    try {
      const barcode = String(req.params.barcode || "").replace(/\D/g, "");
      if (!barcode) return res.status(400).json({ ok: false, error: "BAD_BARCODE" });

      const force = String(req.query.refresh || req.query.force || "").toLowerCase();
      const shouldRefresh = force === "1" || force === "true" || force === "yes";

      // 1) Try local (the requested barcode, then its UPC-A/EAN-13
      // equivalent if it has one) unless refresh is requested
      if (!shouldRefresh) {
        const doc = await findProductByBarcodeCandidates(Product, barcode);
        if (doc) return res.json(buildProductLookupPayload(doc, "local"));
      }

      // 2) Fallback to OFF
      const ua = process.env.OFF_USER_AGENT || "HalalQuest/1.0 (+contact)";
      const normalized = await fetchFromOFF(barcode, ua);

      if (!normalized) {
        // If OFF fails but we have local, return local
        const fallback = await findProductByBarcodeCandidates(Product, barcode);
        if (fallback) return res.json(buildProductLookupPayload(fallback, "local"));
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // 3) Upsert into your DB
      const saved = await Product.findOneAndUpdate(
        { barcode },
        { $set: normalized },
        { new: true, upsert: true }
      ).lean();

      return res.json(buildProductLookupPayload(saved, "openfoodfacts"));
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

    app.listen(PORT, HOST, () => {
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
