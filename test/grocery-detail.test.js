"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createGroceryDetailHandler,
  isStablePlaceId,
} = require("../src/routes/groceries.routes");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const CERTIFICATE_ID = "synthetic-detail-cert";
const CLAIM_ID = "synthetic-detail-claim";
const AUTHORITY = "Synthetic Test Grocery Certification Authority";

function certifiedGroceryPlace(placeId) {
  return {
    _id: placeId,
    type: "grocery",
    name: "Synthetic Detail Grocery",
    city: "Fixture City",
    state: "ZZ",
    halal: true,
    certified: true,
    arbitraryPrivateField: "must not escape",
    rating: 4.2,
    price: 2,
    photos: ["synthetic-photo.jpg"],
    hours: [{ day: 1, open: "09:00", close: "21:00" }],
    groceryTrust: {
      version: 1,
      claims: [{
        id: CLAIM_ID,
        type: "INDEPENDENT_CERTIFICATION",
        position: "AFFIRMS",
        subject: { placeId },
        coverage: { kind: "ENTIRE_STORE", placeId },
        reviewState: "ACCEPTED",
        evidenceRefs: [CERTIFICATE_ID],
      }],
      evidence: [{
        id: CERTIFICATE_ID,
        type: "CERTIFICATE",
        subject: { placeId },
        coverage: { kind: "ENTIRE_STORE", placeId },
        issuer: { type: "CERTIFICATION_AUTHORITY", id: "synthetic-authority", name: AUTHORITY },
        sourceRef: "synthetic-certificate-source",
        reviewState: "ACCEPTED",
        certification: {
          authorityName: AUTHORITY,
          certificateId: "SYNTHETIC-GROCERY-DETAIL-001",
          status: "ACTIVE",
          validFrom: "2025-01-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      }],
    },
  };
}

test("exact grocery detail retrieval uses stable place identity and the Contract v1 projection", async () => {
  const placeId = "507f1f77bcf86cd799439021";
  const place = certifiedGroceryPlace(placeId);
  let filter;
  const PlaceModel = {
    findOne(value) {
      filter = value;
      return { lean: async () => place };
    },
  };
  const handler = createGroceryDetailHandler({ PlaceModel, logger: { error() {} } });
  const res = responseRecorder();
  await handler({ params: { id: placeId } }, res);

  assert.deepEqual(filter, { _id: placeId, type: "grocery" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.id, placeId);
  assert.equal(res.body.item.groceryResult.contractVersion, 1);
  assert.equal(res.body.item.groceryResult.summary.status, "CERTIFIED");
  assert.equal(res.body.item.grocerySummary.status, "CERTIFIED");
  assert.equal(Object.hasOwn(res.body.item, "groceryTrust"), false);
  assert.equal(Object.hasOwn(res.body.item, "restaurantTrust"), false);
  assert.equal(Object.hasOwn(res.body.item, "halal"), false);
  assert.equal(Object.hasOwn(res.body.item, "certified"), false);
  assert.equal(Object.hasOwn(res.body.item, "arbitraryPrivateField"), false);
  for (const key of ["trust", "rating", "price", "photos", "hours", "hours_raw", "distance", "promo", "metrics"]) {
    assert.equal(Object.hasOwn(res.body.item, key), false, `${key} must not enter Grocery Detail API output`);
  }
});

test("grocery detail distinguishes not found from operational failure", async () => {
  assert.equal(isStablePlaceId("507f1f77bcf86cd799439011"), true);
  assert.equal(isStablePlaceId("not-a-place-id"), false);

  const notFound = responseRecorder();
  const notFoundHandler = createGroceryDetailHandler({
    PlaceModel: { findOne: () => ({ lean: async () => null }) },
    logger: { error() {} },
  });
  await notFoundHandler({ params: { id: "507f1f77bcf86cd799439012" } }, notFound);
  assert.equal(notFound.statusCode, 404);
  assert.deepEqual(notFound.body, { ok: false, error: "NOT_FOUND" });

  const invalid = responseRecorder();
  await notFoundHandler({ params: { id: "invalid" } }, invalid);
  assert.equal(invalid.statusCode, 404);

  const failed = responseRecorder();
  const failedHandler = createGroceryDetailHandler({
    PlaceModel: { findOne: () => ({ lean: async () => { throw new Error("synthetic database failure"); } }) },
    logger: { error() {} },
  });
  await failedHandler({ params: { id: "507f1f77bcf86cd799439013" } }, failed);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.body, { ok: false, error: "SERVER_ERROR" });
});

test("a restaurant-type Place ID does not resolve as a grocery detail", async () => {
  const placeId = "507f1f77bcf86cd799439014";
  const PlaceModel = {
    findOne(filter) {
      // The handler always queries with type: 'grocery'; a real Mongo query
      // against a restaurant-typed document would find nothing, so the mock
      // enforces that exact contract.
      assert.equal(filter.type, "grocery");
      return { lean: async () => null };
    },
  };
  const handler = createGroceryDetailHandler({ PlaceModel, logger: { error() {} } });
  const res = responseRecorder();
  await handler({ params: { id: placeId } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, error: "NOT_FOUND" });
});

test("malformed grocery evidence references are excluded even in the detail projection", async () => {
  const placeId = "507f1f77bcf86cd799439015";
  const place = {
    _id: placeId,
    type: "grocery",
    name: "Synthetic Incomplete Grocery",
    groceryTrust: {
      claims: [{
        id: "dangling-claim",
        type: "INDEPENDENT_CERTIFICATION",
        position: "AFFIRMS",
        subject: { placeId },
        coverage: { kind: "ENTIRE_STORE", placeId },
        reviewState: "ACCEPTED",
        evidenceRefs: ["missing-evidence"],
      }],
      evidence: [],
    },
  };
  const handler = createGroceryDetailHandler({
    PlaceModel: { findOne: () => ({ lean: async () => place }) },
    logger: { error() {} },
  });
  const res = responseRecorder();
  await handler({ params: { id: placeId } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.item.groceryResult.summary.status, "UNVERIFIED");
  assert.deepEqual(res.body.item.groceryResult.acceptedClaims, []);
});
