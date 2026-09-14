// backend/src/domain/photoDisplayUrls.js
//
// Read-time-only enrichment of a Submission's photos[] for moderation
// responses (GET /api/admin/submissions, GET /api/admin/submissions/:id).
// Never writes to Mongo — this only transforms the response object.
//
//   local mode: reuse the already-stored, already-public `url` (unchanged
//   behavior from before this pass).
//
//   supabase mode: derive a short-lived signed GET URL from the stored
//   `key`. A legacy record with a `url` but no `key` (a local-QA-era
//   submission, or any record predating storage-key persistence) is left
//   with displayUrl: null — this deliberately never tries to derive/guess
//   a storage key from an old URL string (see the object-storage audit's
//   "never derive a storage key from an untrusted arbitrary URL"
//   requirement).

async function attachPhotoDisplayUrls(submission, { storageDriver, signPhotoUrl }) {
  if (!submission || !Array.isArray(submission.photos)) return submission;
  const photos = await Promise.all(
    submission.photos.map(async (photo) => {
      if (storageDriver !== "supabase") {
        return { ...photo, displayUrl: photo.url || null };
      }
      if (!photo.key) return { ...photo, displayUrl: null };
      const displayUrl = await signPhotoUrl(photo.key);
      return { ...photo, displayUrl };
    })
  );
  return { ...submission, photos };
}

async function attachPhotoDisplayUrlsToList(submissions, opts) {
  return Promise.all((submissions || []).map((s) => attachPhotoDisplayUrls(s, opts)));
}

module.exports = { attachPhotoDisplayUrls, attachPhotoDisplayUrlsToList };
