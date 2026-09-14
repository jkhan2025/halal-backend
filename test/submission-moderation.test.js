"use strict";

// Pure, dependency-injected tests for src/domain/submissionModeration.js —
// no real Mongo, no network. Fakes mimic just enough of the Mongoose
// document API (find/findById/.lean()/.save()/.toObject()) that the domain
// module actually exercises.
//
// The TRUST-BOUNDARY tests at the bottom are the most important tests in
// this file: they prove that approving, rejecting, and linking a
// submission never mutates a Product document's verdict/trust/opinions/
// ingredients — the non-negotiable requirement from the moderation audit
// this pass implements.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  STATUS_VALUES,
  ALLOWED_TRANSITIONS,
  listSubmissions,
  getSubmission,
  updateSubmissionStatus,
  linkSubmissionToProduct,
  unlinkSubmissionFromProduct,
} = require("../src/domain/submissionModeration");

// --- fake Submission "model" -----------------------------------------------

function makeFakeSubmissionModel(seedDocs = []) {
  const docs = seedDocs.map((d) => ({ ...d }));

  function wrap(doc) {
    if (!doc) return null;
    return {
      ...doc,
      save: async function () {
        const idx = docs.findIndex((d) => d._id === this._id);
        if (idx >= 0) docs[idx] = { ...this };
        return this;
      },
      toObject: function () {
        const { save, toObject, ...rest } = this;
        return rest;
      },
    };
  }

  return {
    docs,
    find(query = {}) {
      const filtered = docs.filter((d) => (query.status ? d.status === query.status : true));
      return {
        sort: () => ({
          limit: (n) => ({
            lean: async () => filtered.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, n),
          }),
        }),
      };
    },
    findById(id) {
      const found = docs.find((d) => d._id === id) || null;
      const wrapped = wrap(found);
      return {
        lean: async () => (found ? { ...found } : null),
        then: (resolve) => resolve(wrapped), // allow `await Submission.findById(id)` directly too
      };
    },
  };
}

function makeFakeProductModel(seedDocs = []) {
  const docs = seedDocs.map((d) => ({ ...d }));
  return {
    docs,
    findById(id) {
      return {
        select: () => ({
          lean: async () => docs.find((d) => d._id === id) || null,
        }),
      };
    },
  };
}

// --- listSubmissions / getSubmission ---------------------------------------

test("listSubmissions returns newest-first and respects a status filter", async () => {
  const Submission = makeFakeSubmissionModel([
    { _id: "a", status: "pending", createdAt: 1 },
    { _id: "b", status: "approved", createdAt: 3 },
    { _id: "c", status: "pending", createdAt: 2 },
  ]);
  const all = await listSubmissions(Submission, {});
  assert.equal(all.ok, true);
  assert.deepEqual(all.body.items.map((d) => d._id), ["b", "c", "a"]);

  const pendingOnly = await listSubmissions(Submission, { status: "pending" });
  assert.deepEqual(pendingOnly.body.items.map((d) => d._id), ["c", "a"]);
});

test("listSubmissions rejects an invalid status filter", async () => {
  const Submission = makeFakeSubmissionModel([]);
  const result = await listSubmissions(Submission, { status: "not-a-real-status" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, "INVALID_STATUS");
});

test("listSubmissions bounds an excessive limit to MAX_LIST_LIMIT and defaults an invalid one", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ _id: `id${i}`, status: "pending", createdAt: i }));
  const Submission = makeFakeSubmissionModel(many);
  const capped = await listSubmissions(Submission, { limit: 9999 });
  assert.equal(capped.body.items.length, 100);
  const defaulted = await listSubmissions(Submission, { limit: "not-a-number" });
  assert.equal(defaulted.body.items.length, 20);
});

test("getSubmission retrieves one by id, 404s for an unknown id", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "pending" }]);
  const found = await getSubmission(Submission, "a");
  assert.equal(found.ok, true);
  assert.equal(found.body.submission._id, "a");

  const missing = await getSubmission(Submission, "nope");
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
});

// --- updateSubmissionStatus / state machine --------------------------------

test("STATUS_VALUES and ALLOWED_TRANSITIONS document the intended v1 state machine", () => {
  assert.deepEqual(STATUS_VALUES, ["pending", "reviewing", "approved", "rejected"]);
  assert.deepEqual(ALLOWED_TRANSITIONS.pending, ["reviewing", "approved", "rejected"]);
  assert.deepEqual(ALLOWED_TRANSITIONS.reviewing, ["approved", "rejected"]);
  assert.deepEqual(ALLOWED_TRANSITIONS.approved, []);
  assert.deepEqual(ALLOWED_TRANSITIONS.rejected, []);
});

test("pending -> reviewing works and records reviewer metadata", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "pending" }]);
  const result = await updateSubmissionStatus(Submission, "a", {
    toStatus: "reviewing",
    reviewedBy: "moderator-1",
    reviewerNotes: "looking into it",
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.submission.status, "reviewing");
  assert.equal(result.body.submission.reviewedBy, "moderator-1");
  assert.equal(result.body.submission.reviewerNotes, "looking into it");
  assert.ok(result.body.submission.reviewedAt instanceof Date);
});

test("pending -> approved and reviewing -> approved both work", async () => {
  const Submission = makeFakeSubmissionModel([
    { _id: "a", status: "pending" },
    { _id: "b", status: "reviewing" },
  ]);
  const r1 = await updateSubmissionStatus(Submission, "a", { toStatus: "approved", reviewedBy: "m1" });
  assert.equal(r1.ok, true);
  assert.equal(r1.body.submission.status, "approved");

  const r2 = await updateSubmissionStatus(Submission, "b", { toStatus: "approved", reviewedBy: "m1" });
  assert.equal(r2.ok, true);
  assert.equal(r2.body.submission.status, "approved");
});

test("pending -> rejected and reviewing -> rejected both work and record a rejection reason", async () => {
  const Submission = makeFakeSubmissionModel([
    { _id: "a", status: "pending" },
    { _id: "b", status: "reviewing" },
  ]);
  const r1 = await updateSubmissionStatus(Submission, "a", {
    toStatus: "rejected",
    reviewedBy: "m1",
    rejectionReason: "blurry photos",
  });
  assert.equal(r1.body.submission.status, "rejected");
  assert.equal(r1.body.submission.rejectionReason, "blurry photos");

  const r2 = await updateSubmissionStatus(Submission, "b", { toStatus: "rejected", reviewedBy: "m1" });
  assert.equal(r2.body.submission.status, "rejected");
});

test("terminal states reject any further transition (approved/rejected -> anything)", async () => {
  const Submission = makeFakeSubmissionModel([
    { _id: "a", status: "approved" },
    { _id: "b", status: "rejected" },
  ]);
  for (const [id, toStatus] of [
    ["a", "pending"],
    ["a", "rejected"],
    ["b", "approved"],
    ["b", "pending"],
  ]) {
    const result = await updateSubmissionStatus(Submission, id, { toStatus });
    assert.equal(result.ok, false, `${id} -> ${toStatus} must be rejected`);
    assert.equal(result.status, 409);
    assert.equal(result.error, "INVALID_TRANSITION");
  }
});

test("an invalid target status value is rejected before any lookup", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "pending" }]);
  const result = await updateSubmissionStatus(Submission, "a", { toStatus: "definitely-not-a-status" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, "INVALID_STATUS");
});

test("updateSubmissionStatus 404s for an unknown submission id", async () => {
  const Submission = makeFakeSubmissionModel([]);
  const result = await updateSubmissionStatus(Submission, "nope", { toStatus: "approved" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

// --- linking / unlinking ----------------------------------------------------

test("an approved submission can link to an existing Product", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "approved", linkedProductId: null }]);
  const Product = makeFakeProductModel([{ _id: "prod-1", verdict: "UNKNOWN" }]);
  const result = await linkSubmissionToProduct(Submission, Product, "a", "prod-1");
  assert.equal(result.ok, true);
  assert.equal(result.body.submission.linkedProductId, "prod-1");
});

test("a non-approved submission (pending/reviewing/rejected) may exist without a Product link, and cannot be linked", async () => {
  const Submission = makeFakeSubmissionModel([
    { _id: "a", status: "pending" },
    { _id: "b", status: "reviewing" },
    { _id: "c", status: "rejected" },
  ]);
  const Product = makeFakeProductModel([{ _id: "prod-1" }]);
  for (const id of ["a", "b", "c"]) {
    const result = await linkSubmissionToProduct(Submission, Product, id, "prod-1");
    assert.equal(result.ok, false, `${id} must not be linkable`);
    assert.equal(result.status, 409);
    assert.equal(result.error, "NOT_APPROVED");
  }
});

test("linking to a nonexistent Product id is rejected", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "approved" }]);
  const Product = makeFakeProductModel([]); // no products at all
  const result = await linkSubmissionToProduct(Submission, Product, "a", "does-not-exist");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, "PRODUCT_NOT_FOUND");
});

test("unlink clears linkedProductId", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "approved", linkedProductId: "prod-1" }]);
  const result = await unlinkSubmissionFromProduct(Submission, "a");
  assert.equal(result.ok, true);
  assert.equal(result.body.submission.linkedProductId, null);
});

// --- TRUST BOUNDARY (the non-negotiable requirement) -----------------------

test("TRUST BOUNDARY: approving a submission does not touch the Product document at all", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "pending" }]);
  const Product = makeFakeProductModel([{ _id: "prod-1", verdict: "HALAL", trust: { score: 90 }, opinions: { hanafi: "Halal" }, ingredients: ["water"] }]);
  const before = JSON.parse(JSON.stringify(Product.docs[0]));

  await updateSubmissionStatus(Submission, "a", { toStatus: "approved", reviewedBy: "m1" });

  assert.deepEqual(Product.docs[0], before, "Product document must be byte/deep-equal to its prior value");
});

test("TRUST BOUNDARY: rejecting a submission does not touch the Product document at all", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "pending" }]);
  const Product = makeFakeProductModel([{ _id: "prod-1", verdict: "HARAM", trust: { score: 10 } }]);
  const before = JSON.parse(JSON.stringify(Product.docs[0]));

  await updateSubmissionStatus(Submission, "a", { toStatus: "rejected", rejectionReason: "not enough evidence" });

  assert.deepEqual(Product.docs[0], before);
});

test("TRUST BOUNDARY: linking an approved submission to a Product leaves that Product's verdict/trust/opinions/ingredients deep-equal to their prior values — only the Submission side changes", async () => {
  const Submission = makeFakeSubmissionModel([{ _id: "a", status: "approved", linkedProductId: null }]);
  const Product = makeFakeProductModel([
    { _id: "prod-1", verdict: "NEEDS_REVIEW", trust: { score: 50 }, opinions: { hanafi: "Mushbooh" }, ingredients: ["sugar", "salt"] },
  ]);
  const before = JSON.parse(JSON.stringify(Product.docs[0]));

  const result = await linkSubmissionToProduct(Submission, Product, "a", "prod-1");

  assert.equal(result.ok, true);
  assert.deepEqual(Product.docs[0], before, "linking must never mutate the Product document");
  assert.equal(result.body.submission.linkedProductId, "prod-1", "only the Submission records the relationship");
});

test("TRUST BOUNDARY: linkSubmissionToProduct's Product lookup only ever selects _id — it structurally cannot read or later write verdict/trust/opinions/ingredients", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/domain/submissionModeration.js"), "utf8");
  assert.match(source, /Product\.findById\(productId\)\.select\("_id"\)\.lean\(\)/);
  assert.doesNotMatch(source, /Product\.(save|updateOne|findOneAndUpdate|create)\(/);
});

test("TRUST BOUNDARY: no moderation function in this module ever requires/touches src/trust.js or any verdict-recomputation helper", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/domain/submissionModeration.js"), "utf8");
  assert.doesNotMatch(source, /trust\.js|evaluateByMadhhab|normalizeProductTrust|buildProductResultContract/);
});
