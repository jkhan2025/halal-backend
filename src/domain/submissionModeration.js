// backend/src/domain/submissionModeration.js
//
// Pure(-ish), dependency-injected moderation operations on Submission
// documents — the minimal internal review surface for POST /api/reports
// contributions. Mongo models are passed in so this stays testable with
// fakes, matching src/domain/productReports.js's existing pattern.
//
// ══════════════════════════════════════════════════════════════════════
// TRUST BOUNDARY (non-negotiable — see the moderation audit this pass
// implements): approving a submission means "a human reviewer accepted
// this as usable evidence." It does NOT mean "this product is halal."
// Nothing in this file ever reads or writes Product.verdict, Product.trust,
// Product.opinions, or Product.ingredients. linkSubmissionToProduct only
// confirms the target Product exists (by _id, selecting only _id — it
// never reads any other Product field) and records the relationship on
// the SUBMISSION side (Submission.linkedProductId). No function here
// calls Product.save/updateOne/findOneAndUpdate, and none ever will
// without that being its own, separately-designed, explicit change.
// ══════════════════════════════════════════════════════════════════════

const STATUS_VALUES = ["pending", "reviewing", "approved", "rejected"];

// pending -> reviewing|approved|rejected ; reviewing -> approved|rejected.
// approved/rejected are terminal in this v1 — no further status change.
const ALLOWED_TRANSITIONS = {
  pending: ["reviewing", "approved", "rejected"],
  reviewing: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function clampLimit(limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(n, MAX_LIST_LIMIT);
}

async function listSubmissions(Submission, { status, limit } = {}) {
  if (status !== undefined && !STATUS_VALUES.includes(status)) {
    return { ok: false, status: 400, error: "INVALID_STATUS" };
  }
  const query = status ? { status } : {};
  const boundedLimit = clampLimit(limit);
  const items = await Submission.find(query).sort({ createdAt: -1 }).limit(boundedLimit).lean();
  return { ok: true, status: 200, body: { ok: true, items, count: items.length, limit: boundedLimit } };
}

async function getSubmission(Submission, id) {
  let doc;
  try {
    doc = await Submission.findById(id).lean();
  } catch {
    return { ok: false, status: 400, error: "INVALID_ID" };
  }
  if (!doc) return { ok: false, status: 404, error: "NOT_FOUND" };
  return { ok: true, status: 200, body: { ok: true, submission: doc } };
}

async function updateSubmissionStatus(Submission, id, { toStatus, reviewedBy, reviewerNotes, rejectionReason } = {}) {
  if (!STATUS_VALUES.includes(toStatus)) {
    return { ok: false, status: 400, error: "INVALID_STATUS" };
  }
  let doc;
  try {
    doc = await Submission.findById(id);
  } catch {
    return { ok: false, status: 400, error: "INVALID_ID" };
  }
  if (!doc) return { ok: false, status: 404, error: "NOT_FOUND" };

  const allowed = ALLOWED_TRANSITIONS[doc.status] || [];
  if (!allowed.includes(toStatus)) {
    return {
      ok: false,
      status: 409,
      error: "INVALID_TRANSITION",
      hint: `${doc.status} -> ${toStatus} is not allowed`,
    };
  }

  doc.status = toStatus;
  doc.reviewedAt = new Date();
  if (typeof reviewedBy === "string" && reviewedBy.trim()) doc.reviewedBy = reviewedBy.trim();
  if (typeof reviewerNotes === "string") doc.reviewerNotes = reviewerNotes.trim();
  if (toStatus === "rejected" && typeof rejectionReason === "string") {
    doc.rejectionReason = rejectionReason.trim();
  }
  await doc.save();

  return { ok: true, status: 200, body: { ok: true, submission: doc.toObject ? doc.toObject() : doc } };
}

// Only an APPROVED submission may be linked — approval and linking are
// kept as two separate, explicit actions (see file header).
async function linkSubmissionToProduct(Submission, Product, submissionId, productId) {
  let doc;
  try {
    doc = await Submission.findById(submissionId);
  } catch {
    return { ok: false, status: 400, error: "INVALID_ID" };
  }
  if (!doc) return { ok: false, status: 404, error: "NOT_FOUND" };
  if (doc.status !== "approved") {
    return { ok: false, status: 409, error: "NOT_APPROVED", hint: "only an approved submission may be linked" };
  }

  let product;
  try {
    // Selecting only _id is deliberate: this code path must never read
    // (and therefore can never be tempted to write) verdict/trust/
    // opinions/ingredients — see the trust-boundary note above.
    product = await Product.findById(productId).select("_id").lean();
  } catch {
    return { ok: false, status: 400, error: "INVALID_PRODUCT_ID" };
  }
  if (!product) return { ok: false, status: 404, error: "PRODUCT_NOT_FOUND" };

  doc.linkedProductId = product._id;
  await doc.save();
  return { ok: true, status: 200, body: { ok: true, submission: doc.toObject ? doc.toObject() : doc } };
}

async function unlinkSubmissionFromProduct(Submission, submissionId) {
  let doc;
  try {
    doc = await Submission.findById(submissionId);
  } catch {
    return { ok: false, status: 400, error: "INVALID_ID" };
  }
  if (!doc) return { ok: false, status: 404, error: "NOT_FOUND" };
  doc.linkedProductId = null;
  await doc.save();
  return { ok: true, status: 200, body: { ok: true, submission: doc.toObject ? doc.toObject() : doc } };
}

module.exports = {
  STATUS_VALUES,
  ALLOWED_TRANSITIONS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  listSubmissions,
  getSubmission,
  updateSubmissionStatus,
  linkSubmissionToProduct,
  unlinkSubmissionFromProduct,
};
