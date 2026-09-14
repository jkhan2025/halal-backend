"use strict";

// Tests for src/domain/photoDisplayUrls.js — the read-time-only photo URL
// enrichment used by the moderation list/retrieve routes. No Mongo, no
// network; signPhotoUrl is a fake function here. This module was fully
// unaffected by the S3->Supabase provider swap except for the
// storageDriver string literal it compares against — see photoStorage.js.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { attachPhotoDisplayUrls, attachPhotoDisplayUrlsToList } = require("../src/domain/photoDisplayUrls");

function fakeSigner() {
  const calls = [];
  const signPhotoUrl = async (key) => {
    calls.push(key);
    return `https://signed.example/${key}`;
  };
  return { calls, signPhotoUrl };
}

test("local mode: reuses the existing stored url unchanged, never calls the signer", async () => {
  const { calls, signPhotoUrl } = fakeSigner();
  const submission = {
    _id: "s1",
    photos: [
      { url: "/uploads/reports/123456/uuid1-full.jpg", key: "reports/123456/uuid1-full.jpg", kind: "front" },
      { url: "/uploads/reports/123456/uuid2-full.jpg", key: "reports/123456/uuid2-full.jpg", kind: "ingredients" },
    ],
  };
  const result = await attachPhotoDisplayUrls(submission, { storageDriver: "local", signPhotoUrl });
  assert.equal(result.photos[0].displayUrl, "/uploads/reports/123456/uuid1-full.jpg");
  assert.equal(result.photos[1].displayUrl, "/uploads/reports/123456/uuid2-full.jpg");
  assert.equal(calls.length, 0, "local mode must never call the signer");
});

test("supabase mode: derives a signed displayUrl from the stored key for each photo", async () => {
  const { calls, signPhotoUrl } = fakeSigner();
  const submission = {
    _id: "s1",
    photos: [
      { url: null, key: "reports/123456/uuid1-full.jpg", kind: "front" },
      { url: null, key: "reports/123456/uuid2-full.jpg", kind: "ingredients" },
    ],
  };
  const result = await attachPhotoDisplayUrls(submission, { storageDriver: "supabase", signPhotoUrl });
  assert.equal(result.photos[0].displayUrl, "https://signed.example/reports/123456/uuid1-full.jpg");
  assert.equal(result.photos[1].displayUrl, "https://signed.example/reports/123456/uuid2-full.jpg");
  assert.deepEqual(calls, ["reports/123456/uuid1-full.jpg", "reports/123456/uuid2-full.jpg"]);
});

test("supabase mode: a legacy local-QA record with url but no key gets displayUrl null — never guesses/derives a key from the old url", async () => {
  const { calls, signPhotoUrl } = fakeSigner();
  const submission = {
    _id: "legacy",
    photos: [{ url: "/uploads/reports/123456/legacy-full.jpg", kind: "front" }], // no `key`
  };
  const result = await attachPhotoDisplayUrls(submission, { storageDriver: "supabase", signPhotoUrl });
  assert.equal(result.photos[0].displayUrl, null);
  assert.equal(calls.length, 0, "must never attempt to sign for a photo with no stored key");
});

test("does not mutate the original submission object or its photos array (Mongo is never touched, and callers get a fresh object)", async () => {
  const { signPhotoUrl } = fakeSigner();
  const submission = { _id: "s1", status: "approved", photos: [{ url: "/uploads/x.jpg", key: "reports/123456/uuid-full.jpg", kind: "front" }] };
  const original = JSON.parse(JSON.stringify(submission));
  const result = await attachPhotoDisplayUrls(submission, { storageDriver: "local", signPhotoUrl });
  assert.deepEqual(submission, original, "the input object itself must be unchanged");
  assert.notEqual(result, submission, "a new object must be returned");
  assert.equal(result.status, "approved", "non-photo fields are preserved");
});

test("gracefully handles a submission with no photos array (e.g. null/malformed input)", async () => {
  const { signPhotoUrl } = fakeSigner();
  assert.equal(await attachPhotoDisplayUrls(null, { storageDriver: "local", signPhotoUrl }), null);
  const noPhotos = { _id: "s1" };
  const result = await attachPhotoDisplayUrls(noPhotos, { storageDriver: "supabase", signPhotoUrl });
  assert.equal(result, noPhotos);
});

test("attachPhotoDisplayUrlsToList enriches every submission in a list, preserving order", async () => {
  const { signPhotoUrl } = fakeSigner();
  const submissions = [
    { _id: "a", photos: [{ url: "/uploads/a.jpg", key: "reports/111111/u1-full.jpg", kind: "front" }] },
    { _id: "b", photos: [{ url: "/uploads/b.jpg", key: "reports/222222/u2-full.jpg", kind: "front" }] },
  ];
  const result = await attachPhotoDisplayUrlsToList(submissions, { storageDriver: "local", signPhotoUrl });
  assert.equal(result.length, 2);
  assert.equal(result[0]._id, "a");
  assert.equal(result[1]._id, "b");
  assert.equal(result[0].photos[0].displayUrl, "/uploads/a.jpg");
});

test("attachPhotoDisplayUrlsToList handles an empty/undefined list", async () => {
  const { signPhotoUrl } = fakeSigner();
  assert.deepEqual(await attachPhotoDisplayUrlsToList([], { storageDriver: "local", signPhotoUrl }), []);
  assert.deepEqual(await attachPhotoDisplayUrlsToList(undefined, { storageDriver: "local", signPhotoUrl }), []);
});
