// backend/config/env.js
require("dotenv").config();
const path = require("path");

function num(key, def) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : def;
}

const PORT = process.env.PORT || "5050";
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || "uploads");
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const MAX_JSON_MB = num("MAX_JSON_MB", 15);   // JSON body limit
const MAX_IMAGE_MB = num("MAX_IMAGE_MB", 8);  // raw image size limit

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/halaldb";

module.exports = {
  PORT,
  HOST,
  CORS_ORIGIN,
  UPLOAD_DIR,
  ADMIN_KEY,
  MAX_JSON_MB,
  MAX_IMAGE_MB,
  MONGO_URI,
};
