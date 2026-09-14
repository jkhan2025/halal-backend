// backend/src/domain/photoStorage.js
//
// The actual image-processing + storage-write/delete logic behind the live
// POST /api/reports and POST /v1/submissions paths, extracted out of
// server.js so it is independently unit-testable: server.js itself can
// never be require()'d under NODE_ENV=test (src/config/runtimeSafety.js
// fails startup outright in test mode), so anything that stays inline in
// server.js is untestable without a real process. This module changes
// WHERE the code lives, not what it does — server.js wires it up with its
// real sharp/fs/Supabase client instances; tests wire it up with a real
// temp directory (local mode) or a fake Supabase client whose storage
// methods never touch the network (supabase mode).
//
// PROVIDER SWAP (S3 -> Supabase Storage, per the approved audit): only the
// contents of the "supabase" branches below changed. saveImageBuffer's and
// deleteSavedImage's outward signatures, and every local-mode code path,
// are byte-for-byte what they were under S3 — see src/lib/storageKey.js,
// src/domain/productReports.js, and src/domain/photoDisplayUrls.js, none
// of which needed to change at all for this swap.

// Builds the two image variants (full + thumb) this app has always
// produced, then persists them via the local filesystem or Supabase
// Storage depending on `storageDriver` — unchanged sizing/quality from
// before this pass.
function createPhotoStorage({
  sharp,
  fs,
  path,
  storageDriver, // "local" | "supabase"
  uploadDir, // required for "local"
  supabaseClient, // required for "supabase" — a real or fake @supabase/supabase-js client
  bucket, // required for "supabase"
  keyPrefix = "", // "supabase" only — already validated by src/lib/storageKey.js's sanitizeKeyPrefix
  publicUrlForKey, // "local" only — server.js's existing, unchanged helper
  isValidStorageKey,
}) {
  async function saveImageBuffer({ buffer, keyBase, contentType = "image/jpeg" }) {
    const localFullKey = `${keyBase}-full.jpg`;
    const localThumbKey = `${keyBase}-thumb.jpg`;

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

    if (storageDriver === "supabase") {
      if (!supabaseClient || !bucket) throw new Error("Supabase storage config missing");
      const fullKey = keyPrefix ? `${keyPrefix}/${localFullKey}` : localFullKey;
      const thumbKey = keyPrefix ? `${keyPrefix}/${localThumbKey}` : localThumbKey;

      // Bucket is assumed private (created with public:false) — no object
      // is ever uploaded with any public-access option (see the
      // object-storage audit item 8). cacheControl is a max-age SECONDS
      // string per the Supabase JS client's own convention (not a full
      // Cache-Control header like S3's), set to a long value since keys
      // are effectively immutable (fresh UUID per photo, never overwritten
      // — upsert stays false).
      const fullResult = await supabaseClient.storage
        .from(bucket)
        .upload(fullKey, full.data, { contentType, cacheControl: "31536000", upsert: false });
      // The Supabase JS client never throws on a failed upload — it
      // resolves with { data, error } — so this must be converted into a
      // thrown error ourselves for the existing partial-write/DB-failure
      // cleanup in productReports.js (which relies on a rejected promise)
      // to keep working unchanged.
      if (fullResult.error) throw new Error(`Supabase upload failed (full): ${fullResult.error.message}`);

      const thumbResult = await supabaseClient.storage
        .from(bucket)
        .upload(thumbKey, thumb.data, { contentType, cacheControl: "31536000", upsert: false });
      if (thumbResult.error) throw new Error(`Supabase upload failed (thumb): ${thumbResult.error.message}`);

      return {
        // url is deliberately null, not a guessed public storage URL: the
        // bucket is private, so a plain object URL would 403/404 for
        // anyone without a signed token and falsely promise public
        // accessibility (see audit item 12). Moderation reads a
        // short-lived SIGNED url derived from `key` at read time instead —
        // see src/lib/signedPhotoUrl.js / src/domain/photoDisplayUrls.js —
        // nothing durable/public is ever stored.
        full: { key: fullKey, url: null, width: full.info.width, height: full.info.height },
        thumb: { key: thumbKey, url: null, width: thumb.info.width, height: thumb.info.height },
      };
    }

    // local — unchanged path/behavior from before this pass.
    const fullPath = path.join(uploadDir, localFullKey);
    const thumbPath = path.join(uploadDir, localThumbKey);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, full.data);
    fs.writeFileSync(thumbPath, thumb.data);

    return {
      full: { key: localFullKey, url: publicUrlForKey(localFullKey), width: full.info.width, height: full.info.height },
      thumb: { key: localThumbKey, url: publicUrlForKey(localThumbKey), width: thumb.info.width, height: thumb.info.height },
    };
  }

  // Used both for an explicit moderation-driven cleanup and (via
  // productReports.js) for automatic rollback of everything written
  // during one request when a LATER step in that same request fails.
  // Narrowly validates the key first — this never attempts to delete
  // anything that doesn't look like a key this module itself would have
  // generated (never derived from an untrusted URL, never an arbitrary
  // caller-supplied path).
  async function deleteSavedImage(key) {
    if (!isValidStorageKey(key)) return;
    if (storageDriver === "supabase") {
      try {
        // .remove() takes an array (Supabase's storage API is batch-
        // shaped) and resolves { data, error } rather than throwing —
        // logged, never thrown, matching the existing best-effort
        // contract this function has always had for local deletes too.
        const { error } = await supabaseClient.storage.from(bucket).remove([key]);
        if (error) console.error("Supabase delete failed for key", key, "-", error.message);
      } catch (err) {
        console.error("Supabase delete failed for key", key, "-", err?.message);
      }
      return;
    }
    try {
      fs.unlinkSync(path.join(uploadDir, key));
    } catch (_e) {
      // best-effort only — file may already be gone
    }
  }

  return { saveImageBuffer, deleteSavedImage };
}

module.exports = { createPhotoStorage };
