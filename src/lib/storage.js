// backend/src/lib/storage.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { randomUUID } = require("crypto");

/* ------------------------ Env + config ------------------------ */
/**
 * Supports both AWS_* and S3_* style names.
 * S3 is considered "enabled" only if the required vars are present
 * and S3_ENABLED is truthy (default "1").
 */
const BUCKET = process.env.S3_BUCKET || "";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "";
const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";
const PUBLIC_BASE =
  process.env.S3_PUBLIC_BASE ||
  (BUCKET && REGION ? `https://${BUCKET}.s3.${REGION}.amazonaws.com` : "");
const MAX_MB = Number(process.env.MAX_IMAGE_MB || 8);
const S3_TOGGLE = String(process.env.S3_ENABLED ?? "1").toLowerCase();

const isTruthy = (v) => {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
};
const isS3ConfiguredHard = () =>
  isTruthy(S3_TOGGLE) && !!BUCKET && !!REGION && !!ACCESS_KEY_ID && !!SECRET_ACCESS_KEY;

/* ------------------------ AWS SDK lazy init ------------------------ */
let s3 = null;
let PutObjectCommand = null;

if (isS3ConfiguredHard()) {
  try {
    const sdk = require("@aws-sdk/client-s3");
    PutObjectCommand = sdk.PutObjectCommand;
    s3 = new sdk.S3Client({
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  } catch (err) {
    console.warn("⚠️  AWS SDK not available; falling back to local storage:", err?.message);
    s3 = null;
  }
}

function isS3Enabled() {
  return !!s3;
}

function s3Status() {
  return {
    enabledFlag: isTruthy(S3_TOGGLE),
    hasBucket: !!BUCKET,
    hasRegion: !!REGION,
    hasAccessKey: !!ACCESS_KEY_ID,
    hasSecret: !!SECRET_ACCESS_KEY,
    sdkReady: !!s3,
  };
}

function storageInfo() {
  return isS3Enabled()
    ? { mode: "s3", bucket: BUCKET, region: REGION, publicBase: PUBLIC_BASE }
    : { mode: "local", root: "/uploads" };
}

/* ------------------------ Local uploads dir ------------------------ */
const LOCAL_UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(LOCAL_UPLOAD_DIR)) fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });

/* ------------------------ Mime helpers ------------------------ */
function mimeFromExt(ext = "jpg") {
  const e = String(ext || "jpg").toLowerCase().replace(/^\./, "");
  if (e === "png") return "image/png";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  return "image/jpeg";
}
function extFromMime(mime = "image/jpeg") {
  const t = String(mime || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  return "jpg";
}
const publicS3Url = (key) => `${PUBLIC_BASE}/${key}`;

/* ------------------------ Writers ------------------------ */
async function saveToS3(buffer, { ext = "jpg", prefix = "uploads", contentType } = {}) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const safeExt = String(ext || "jpg").toLowerCase().replace(/^\./, "");
  const key = `${prefix}/${y}/${m}/${d}/${randomUUID()}.${safeExt}`;

  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || mimeFromExt(safeExt),
    // If your bucket policy grants public read for GetObject, ACL not needed.
    // ACL: "public-read",
  });

  await s3.send(cmd);
  return publicS3Url(key);
}

async function saveToLocal(buffer, { ext = "jpg", prefix = "uploads" } = {}) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");

  const safeExt = String(ext || "jpg").toLowerCase().replace(/^\./, "");
  const relDir = path.join(prefix, String(y), String(m), String(d));
  const absDir = path.join(LOCAL_UPLOAD_DIR, relDir);
  fs.mkdirSync(absDir, { recursive: true });

  const filename = `${randomUUID()}.${safeExt}`;
  const abs = path.join(absDir, filename);
  fs.writeFileSync(abs, buffer);

  // Served by Express static: app.use("/uploads", express.static(LOCAL_UPLOAD_DIR))
  return `/uploads/${relDir.replace(/\\/g, "/")}/${filename}`;
}

/**
 * Save an image buffer to S3 (if enabled) or local disk.
 * Returns a public URL (S3) or a served /uploads path (local).
 */
async function saveImageBuffer(buffer, opts = {}) {
  if (isS3Enabled()) {
    try {
      return await saveToS3(buffer, opts);
    } catch (err) {
      console.error("S3 upload failed; falling back to local:", err?.message);
      return await saveToLocal(buffer, opts);
    }
  }
  return await saveToLocal(buffer, opts);
}

/**
 * Accepts a data URL or raw base64, compresses to ~1600px wide JPEG,
 * enforces size limit, saves via saveImageBuffer, and returns { url, bytes, mime }.
 */
async function saveBase64Image(dataUrl, prefix = "uploads") {
  if (!dataUrl || typeof dataUrl !== "string") throw new Error("dataUrl required");

  // Allow full data URL or raw base64
  let base64 = dataUrl;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (m) base64 = m[2] || "";
  if (!base64) throw new Error("Invalid image data");

  const buf = Buffer.from(base64, "base64");

  // Guard: allow up to ~2× the configured limit before compression
  const maxBytes = MAX_MB * 1024 * 1024;
  if (buf.length > maxBytes * 2) {
    throw new Error(`Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
  }

  const out = await sharp(buf)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  if (out.length > maxBytes) {
    throw new Error(
      `Image exceeds limit after compression (${(out.length / 1024 / 1024).toFixed(1)}MB > ${MAX_MB}MB)`
    );
  }

  const url = await saveImageBuffer(out, { ext: "jpg", prefix, contentType: "image/jpeg" });
  return { url, bytes: out.length, mime: "image/jpeg" };
}

module.exports = {
  saveImageBuffer,
  saveBase64Image,
  isS3Enabled,
  storageInfo,
  s3Status,          // <— for quick debugging in server logs
  LOCAL_UPLOAD_DIR,
  mimeFromExt,
  extFromMime,
};
