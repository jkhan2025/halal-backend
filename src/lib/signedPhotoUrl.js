// backend/src/lib/signedPhotoUrl.js
//
// Generates short-lived signed GET URLs for private Supabase Storage
// evidence photos. Unlike S3's getSignedUrl (pure local signing, no
// network), Supabase's createSignedUrl() makes a real API call to mint the
// token — this is the one behavior difference called out in the approved
// S3->Supabase audit (item 9). A failed/unreachable signing call is
// converted to `null` + a logged error rather than a thrown rejection, so
// one bad photo never breaks an entire moderation list response — safely
// unit-testable with a fake Supabase client; no real Supabase access
// needed.

const { isValidStorageKey } = require("./storageKey");

const DEFAULT_EXPIRES_SECONDS = 600; // 10 minutes
const MAX_EXPIRES_SECONDS = 900; // 15 minutes — the requested 10-15 min bound

function clampExpires(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EXPIRES_SECONDS;
  return Math.min(n, MAX_EXPIRES_SECONDS);
}

// Returns a signed URL string, or null if the key isn't a well-formed
// storage key this app would have generated (never signs an arbitrary
// caller-supplied string), or if Supabase's signing call itself fails.
async function createSignedPhotoUrl({ supabaseClient, bucket }, { key, expiresInSeconds } = {}) {
  if (!isValidStorageKey(key)) return null;
  const { data, error } = await supabaseClient.storage.from(bucket).createSignedUrl(key, clampExpires(expiresInSeconds));
  if (error) {
    console.error("Supabase sign failed for key", key, "-", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

module.exports = { createSignedPhotoUrl, clampExpires, DEFAULT_EXPIRES_SECONDS, MAX_EXPIRES_SECONDS };
