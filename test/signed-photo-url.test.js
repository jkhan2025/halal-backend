"use strict";

// Tests for src/lib/signedPhotoUrl.js. The Supabase client is faked here —
// this never makes a real network call and never imports the real
// @supabase/supabase-js client.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSignedPhotoUrl, clampExpires, DEFAULT_EXPIRES_SECONDS, MAX_EXPIRES_SECONDS } = require("../src/lib/signedPhotoUrl");

const VALID_KEY = "reports/036000291452/c269b8a6-3fb7-4aa3-9345-c0314432df8c-full.jpg";

function fakeSupabaseClient({ error = null, signedUrl = "https://signed.example/default" } = {}) {
  const calls = [];
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          async createSignedUrl(objectPath, expiresIn) {
            calls.push({ bucket, path: objectPath, expiresIn });
            if (error) return { data: null, error };
            return { data: { signedUrl: `${signedUrl}/${objectPath}?expires=${expiresIn}` }, error: null };
          },
        };
      },
    },
  };
}

test("uses createSignedUrl with the stored key and bucket", async () => {
  const supabaseClient = fakeSupabaseClient();
  const url = await createSignedPhotoUrl({ supabaseClient, bucket: "halalquest-prod" }, { key: VALID_KEY });

  assert.equal(supabaseClient.calls.length, 1);
  assert.equal(supabaseClient.calls[0].bucket, "halalquest-prod");
  assert.equal(supabaseClient.calls[0].path, VALID_KEY);
  assert.equal(url, `https://signed.example/default/${VALID_KEY}?expires=${DEFAULT_EXPIRES_SECONDS}`);
});

test("defaults to a 10-minute expiration when none is given", async () => {
  const supabaseClient = fakeSupabaseClient();
  await createSignedPhotoUrl({ supabaseClient, bucket: "b" }, { key: VALID_KEY });
  assert.equal(supabaseClient.calls[0].expiresIn, DEFAULT_EXPIRES_SECONDS);
  assert.equal(DEFAULT_EXPIRES_SECONDS, 600);
});

test("expiration is bounded to a safe maximum (15 minutes) even if a larger value is requested", async () => {
  const supabaseClient = fakeSupabaseClient();
  await createSignedPhotoUrl({ supabaseClient, bucket: "b" }, { key: VALID_KEY, expiresInSeconds: 999999 });
  assert.equal(supabaseClient.calls[0].expiresIn, MAX_EXPIRES_SECONDS);
  assert.equal(MAX_EXPIRES_SECONDS, 900);
});

test("a smaller, valid custom expiration is honored", async () => {
  const supabaseClient = fakeSupabaseClient();
  await createSignedPhotoUrl({ supabaseClient, bucket: "b" }, { key: VALID_KEY, expiresInSeconds: 120 });
  assert.equal(supabaseClient.calls[0].expiresIn, 120);
});

test("clampExpires falls back to the default for non-positive or non-numeric input", () => {
  assert.equal(clampExpires(0), DEFAULT_EXPIRES_SECONDS);
  assert.equal(clampExpires(-5), DEFAULT_EXPIRES_SECONDS);
  assert.equal(clampExpires("not-a-number"), DEFAULT_EXPIRES_SECONDS);
  assert.equal(clampExpires(undefined), DEFAULT_EXPIRES_SECONDS);
});

test("a missing or invalid key is rejected safely — returns null and never calls createSignedUrl", async () => {
  const supabaseClient = fakeSupabaseClient();
  for (const badKey of [undefined, null, "", "../../etc/passwd", "not-a-real-key", 42]) {
    const url = await createSignedPhotoUrl({ supabaseClient, bucket: "b" }, { key: badKey });
    assert.equal(url, null, `expected null for key ${JSON.stringify(badKey)}`);
  }
  assert.equal(supabaseClient.calls.length, 0, "createSignedUrl must never be called for an invalid key");
});

test("a Supabase { error } response (signing failed) is converted to null, not thrown — one bad photo must never break a whole moderation list response", async () => {
  const supabaseClient = fakeSupabaseClient({ error: { message: "object not found" } });
  const url = await createSignedPhotoUrl({ supabaseClient, bucket: "b" }, { key: VALID_KEY });
  assert.equal(url, null);
});

test("unlike S3's local-only signing, Supabase signing does make a real call through the client — but never a raw network request bypassing the injected fake", async () => {
  const supabaseClient = fakeSupabaseClient();
  await createSignedPhotoUrl({ supabaseClient, bucket: "b" }, { key: VALID_KEY });
  assert.equal(supabaseClient.calls.length, 1, "createSignedUrl must be called exactly once through the injected client");
});
