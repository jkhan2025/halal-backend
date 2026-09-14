"use strict";

// Tests for src/domain/photoStorage.js — the actual save/delete logic
// behind the live POST /api/reports and POST /v1/submissions paths.
//
// Supabase mode: a FAKE Supabase client records every call made through
// .storage.from(bucket).upload()/.remove() and never performs a real
// network call — assertions inspect the exact path/body/options passed.
// This never imports the real @supabase/supabase-js client; the fake only
// mimics the {data,error} response shape its real methods resolve with.
//
// Local mode: uses a REAL temporary directory on disk (fs.mkdtempSync) —
// exercising the real fs/sharp code path without touching the project's
// own .local/uploads.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createPhotoStorage } = require("../src/domain/photoStorage");
const { isValidStorageKey } = require("../src/lib/storageKey");

async function tinyJpeg(n = 64) {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg({ quality: 60 })
    .toBuffer();
}

function makeTempUploadDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "halal-photo-storage-test-"));
}

function publicUrlForKeyLocal(key) {
  return `/uploads/${key}`;
}

// --- LOCAL mode --------------------------------------------------------

test("LOCAL: saveImageBuffer writes real full+thumb files to disk and returns matching keys/urls", async () => {
  const uploadDir = makeTempUploadDir();
  try {
    const storage = createPhotoStorage({
      sharp,
      fs,
      path,
      storageDriver: "local",
      uploadDir,
      publicUrlForKey: publicUrlForKeyLocal,
      isValidStorageKey,
    });

    const buffer = await tinyJpeg();
    const keyBase = "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c";
    const result = await storage.saveImageBuffer({ buffer, keyBase });

    assert.equal(result.full.key, `${keyBase}-full.jpg`);
    assert.equal(result.thumb.key, `${keyBase}-thumb.jpg`);
    assert.equal(result.full.url, `/uploads/${keyBase}-full.jpg`);
    assert.equal(result.thumb.url, `/uploads/${keyBase}-thumb.jpg`);
    assert.ok(fs.existsSync(path.join(uploadDir, result.full.key)), "full file must actually exist on disk");
    assert.ok(fs.existsSync(path.join(uploadDir, result.thumb.key)), "thumb file must actually exist on disk");
  } finally {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

test("LOCAL: deleteSavedImage removes the real file and is a no-op (never throws) for an already-gone or invalid key", async () => {
  const uploadDir = makeTempUploadDir();
  try {
    const storage = createPhotoStorage({
      sharp,
      fs,
      path,
      storageDriver: "local",
      uploadDir,
      publicUrlForKey: publicUrlForKeyLocal,
      isValidStorageKey,
    });

    const buffer = await tinyJpeg();
    const keyBase = "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c";
    const result = await storage.saveImageBuffer({ buffer, keyBase });
    assert.ok(fs.existsSync(path.join(uploadDir, result.full.key)));

    await storage.deleteSavedImage(result.full.key);
    assert.equal(fs.existsSync(path.join(uploadDir, result.full.key)), false, "file must be gone after deletion");

    // deleting again (already gone) must not throw
    await storage.deleteSavedImage(result.full.key);

    // an invalid/untrusted key must never be touched or throw
    await storage.deleteSavedImage("../../etc/passwd");
    await storage.deleteSavedImage(null);
  } finally {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

// --- SUPABASE mode ---------------------------------------------------------

// Mimics just enough of @supabase/supabase-js's storage client surface —
// client.storage.from(bucket).upload(path, body, opts) / .remove(paths) —
// each resolving { data, error } exactly like the real SDK, without ever
// importing or contacting it.
function fakeSupabaseClient({ uploadError = null, removeError = null, throwOnSend = false } = {}) {
  const calls = [];
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          async upload(objectPath, body, options) {
            calls.push({ op: "upload", bucket, path: objectPath, body, options });
            if (throwOnSend) throw new Error("simulated network failure");
            return uploadError ? { data: null, error: uploadError } : { data: { path: objectPath }, error: null };
          },
          async remove(paths) {
            calls.push({ op: "remove", bucket, paths });
            if (throwOnSend) throw new Error("simulated network failure");
            return removeError ? { data: null, error: removeError } : { data: paths.map((p) => ({ name: p })), error: null };
          },
        };
      },
    },
  };
}

function makeSupabaseStorage({ keyPrefix = "", ...clientOpts } = {}) {
  const supabaseClient = fakeSupabaseClient(clientOpts);
  const storage = createPhotoStorage({
    sharp,
    fs,
    path,
    storageDriver: "supabase",
    supabaseClient,
    bucket: "halalquest-prod",
    keyPrefix,
    isValidStorageKey,
  });
  return { storage, supabaseClient };
}

test("SUPABASE UPLOAD: .upload() is called with the correct bucket, path, JPEG content type, and private cache behavior — no public/ACL option is ever set", async () => {
  const { storage, supabaseClient } = makeSupabaseStorage();
  const buffer = await tinyJpeg();
  const keyBase = "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c";
  const result = await storage.saveImageBuffer({ buffer, keyBase, contentType: "image/jpeg" });

  assert.equal(supabaseClient.calls.length, 2, "one upload() call per variant (full + thumb)");
  for (const call of supabaseClient.calls) {
    assert.equal(call.op, "upload");
    assert.equal(call.bucket, "halalquest-prod");
    assert.equal(call.options.contentType, "image/jpeg");
    assert.equal(call.options.cacheControl, "31536000");
    assert.equal(call.options.upsert, false, "must never silently overwrite — each key is a fresh uuid");
    assert.equal(call.options.public, undefined, "no public-access option must ever be set on a private-bucket object");
    assert.ok(Buffer.isBuffer(call.body) || call.body instanceof Uint8Array);
  }
  assert.equal(supabaseClient.calls[0].path, `${keyBase}-full.jpg`);
  assert.equal(supabaseClient.calls[1].path, `${keyBase}-thumb.jpg`);
  assert.equal(result.full.key, `${keyBase}-full.jpg`);
  assert.equal(result.thumb.key, `${keyBase}-thumb.jpg`);
});

test("SUPABASE UPLOAD: the environment key prefix is applied to both full and thumb paths", async () => {
  const { storage, supabaseClient } = makeSupabaseStorage({ keyPrefix: "prod" });
  const buffer = await tinyJpeg();
  const keyBase = "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c";
  const result = await storage.saveImageBuffer({ buffer, keyBase });

  assert.equal(supabaseClient.calls[0].path, `prod/${keyBase}-full.jpg`);
  assert.equal(supabaseClient.calls[1].path, `prod/${keyBase}-thumb.jpg`);
  assert.equal(result.full.key, `prod/${keyBase}-full.jpg`);
  assert.equal(result.thumb.key, `prod/${keyBase}-thumb.jpg`);
});

test("SUPABASE UPLOAD: url is deliberately null — a private bucket must never be represented by a guessed public-style URL", async () => {
  const { storage } = makeSupabaseStorage();
  const buffer = await tinyJpeg();
  const result = await storage.saveImageBuffer({ buffer, keyBase: "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c" });
  assert.equal(result.full.url, null);
  assert.equal(result.thumb.url, null);
});

test("SUPABASE UPLOAD: throws if bucket is not configured (fail fast, same posture as before this pass)", async () => {
  const supabaseClient = fakeSupabaseClient();
  const storage = createPhotoStorage({
    sharp,
    fs,
    path,
    storageDriver: "supabase",
    supabaseClient,
    bucket: undefined,
    isValidStorageKey,
  });
  const buffer = await tinyJpeg();
  await assert.rejects(() => storage.saveImageBuffer({ buffer, keyBase: "reports/036000291452/x" }), /Supabase storage config missing/);
});

test("SUPABASE UPLOAD: a { error } response (the SDK's own failure shape — it never throws) is converted into a thrown error so upstream cleanup still triggers", async () => {
  const { storage } = makeSupabaseStorage({ uploadError: { message: "Bucket not found" } });
  const buffer = await tinyJpeg();
  await assert.rejects(
    () => storage.saveImageBuffer({ buffer, keyBase: "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c" }),
    /Supabase upload failed \(full\): Bucket not found/
  );
});

test("SUPABASE DELETE: .remove() is called with the exact stored key (as a 1-element array) and correct bucket", async () => {
  const { storage, supabaseClient } = makeSupabaseStorage();
  await storage.deleteSavedImage("reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c-full.jpg");

  assert.equal(supabaseClient.calls.length, 1);
  const call = supabaseClient.calls[0];
  assert.equal(call.op, "remove");
  assert.equal(call.bucket, "halalquest-prod");
  assert.deepEqual(call.paths, ["reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c-full.jpg"]);
});

test("SUPABASE DELETE: an invalid/untrusted key is never sent to Supabase at all — narrow key validation happens before any storage call", async () => {
  const { storage, supabaseClient } = makeSupabaseStorage();
  await storage.deleteSavedImage("../../etc/passwd");
  await storage.deleteSavedImage("not-a-real-key");
  await storage.deleteSavedImage(null);
  await storage.deleteSavedImage(undefined);
  assert.equal(supabaseClient.calls.length, 0, "no Supabase call must ever be made for an unvalidated key");
});

test("SUPABASE DELETE: a { error } response is logged, never thrown — best-effort contract", async () => {
  const { storage, supabaseClient } = makeSupabaseStorage({ removeError: { message: "simulated outage" } });
  // Must not throw/reject despite the simulated Supabase failure.
  await storage.deleteSavedImage("reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c-full.jpg");
  assert.equal(supabaseClient.calls.length, 1, "a delete attempt must still have been made");
});

test("SUPABASE DELETE: a thrown/rejected call (real network failure, not the { error } shape) is also caught and never propagates", async () => {
  const { storage, supabaseClient } = makeSupabaseStorage({ throwOnSend: true });
  await storage.deleteSavedImage("reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c-full.jpg");
  assert.equal(supabaseClient.calls.length, 1);
});
