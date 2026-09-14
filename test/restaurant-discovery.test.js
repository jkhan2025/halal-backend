"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  MAX_PROXIMITY_RADIUS_M,
  RestaurantDiscoveryInputError,
  parseProximity,
  buildRestaurantMatch,
  createRestaurantDiscoveryPlan,
  loadRestaurantCandidates,
  finalizeRestaurantResults,
} = require("../src/domain/restaurantDiscovery");
const { buildRestaurantListProjection } = require("../src/domain/restaurantTrust");
const restaurantsRouter = require("../src/routes/restaurants.routes");

const listRouteHandler = restaurantsRouter.stack
  .find((layer) => layer.route?.path === "/" && layer.route?.methods?.get)
  .route.stack[0].handle;

function point(id, distance, lat = 41, lng = -73) {
  return {
    _id: id,
    type: "restaurant",
    name: `Synthetic Restaurant ${id}`,
    geo: { type: "Point", coordinates: [lng, lat] },
    coords: { lat, lng },
    distance,
  };
}

test("valid proximity input creates a strict location-scoped query", () => {
  const plan = createRestaurantDiscoveryPlan({ lat: "41.5", lng: "-72.7", radius: "20000", limit: "2" });
  assert.deepEqual(plan.proximity, { lat: 41.5, lng: -72.7, radius: 20000 });
  assert.equal(plan.limit, 2);
  assert.equal(plan.match.type, "restaurant");
});

for (const value of ["NaN", "Infinity", "-Infinity", "1e3", "not-a-number"]) {
  test(`malformed numeric input ${value} is rejected`, () => {
    assert.throws(
      () => parseProximity({ lat: value, lng: "-73", radius: "20000" }),
      (error) => error instanceof RestaurantDiscoveryInputError && error.code === "INVALID_LATITUDE"
    );
  });
}

for (const lat of ["-90.01", "90.01"]) {
  test(`latitude ${lat} is rejected`, () => {
    assert.throws(() => parseProximity({ lat, lng: "-73", radius: "20000" }), /INVALID_LATITUDE/);
  });
}

for (const lng of ["-180.01", "180.01", "NaN"]) {
  test(`longitude ${lng} is rejected`, () => {
    assert.throws(() => parseProximity({ lat: "41", lng, radius: "20000" }), /INVALID_LONGITUDE/);
  });
}

for (const radius of ["0", "-1", String(MAX_PROXIMITY_RADIUS_M + 1), "Infinity"]) {
  test(`radius ${radius} is rejected`, () => {
    assert.throws(() => parseProximity({ lat: "41", lng: "-73", radius }), /INVALID_RADIUS/);
  });
}

test("partial proximity parameters are rejected rather than becoming ordinary discovery", () => {
  assert.throws(
    () => createRestaurantDiscoveryPlan({ lat: "41", lng: "-73" }),
    /LOCATION_QUERY_REQUIRES_LAT_LNG_RADIUS/
  );
});

test("the restaurant API maps invalid proximity input to an explicit 400 response", async () => {
  let statusCode = 200;
  let payload;
  const response = {
    status(value) { statusCode = value; return response; },
    json(value) { payload = value; return response; },
  };
  await listRouteHandler({ query: { lat: "91", lng: "-73", radius: "20000" } }, response);
  assert.equal(statusCode, 400);
  assert.deepEqual(payload, { ok: false, error: "INVALID_LATITUDE" });
});

test("GeoJSON radius filtering is planned before the final result limit", async () => {
  let pipeline;
  const Place = {
    async aggregate(value) {
      pipeline = value;
      return [point("far", 19000), point("nearest", 100), point("near", 800)];
    },
  };
  const plan = createRestaurantDiscoveryPlan({ lat: "41", lng: "-73", radius: "20000", limit: "2", promoFirst: "false" });
  const docs = await loadRestaurantCandidates(Place, plan);
  const results = finalizeRestaurantResults(docs, plan);

  assert.ok(pipeline[0].$geoNear);
  assert.equal(pipeline[0].$geoNear.key, "geo");
  assert.equal(pipeline[0].$geoNear.maxDistance, 20000);
  assert.deepEqual(pipeline[0].$geoNear.near.coordinates, [-73, 41]);
  assert.equal(pipeline.some((stage) => stage.$limit), false);
  assert.deepEqual(results.map((item) => item._id), ["nearest", "near"]);
});

test("coordinate-less, malformed, and out-of-radius candidates are excluded", () => {
  const plan = createRestaurantDiscoveryPlan({ lat: "41", lng: "-73", radius: "20000" });
  const results = finalizeRestaurantResults([
    point("valid", 100),
    { _id: "missing", type: "restaurant", distance: 50 },
    { ...point("malformed", 75), geo: { type: "Point", coordinates: ["-73", 41] } },
    point("outside", 20001),
  ], plan);
  assert.deepEqual(results.map((item) => item._id), ["valid"]);
});

test("ordinary discovery uses find, remains non-proximity, and does not expose distance", async () => {
  let receivedMatch;
  const docs = [{ _id: "ordinary", type: "restaurant", name: "Synthetic Ordinary", distance: 123 }];
  const chain = {
    sort() { return chain; },
    limit() { return chain; },
    async lean() { return docs; },
  };
  const Place = {
    find(match) { receivedMatch = match; return chain; },
    aggregate() { throw new Error("ordinary discovery must not use geo aggregation"); },
  };
  const plan = createRestaurantDiscoveryPlan({ state: "ct" });
  const loaded = await loadRestaurantCandidates(Place, plan);
  const results = finalizeRestaurantResults(loaded, plan);
  assert.equal(plan.proximity, null);
  assert.equal(receivedMatch.state, "CT");
  assert.equal(Object.hasOwn(results[0], "distance"), false);
});

test("search covers name, cuisine, tags, city, address, and postcode", () => {
  const match = buildRestaurantMatch({ q: "06457" });
  const fields = match.$and[0].$or.map((entry) => Object.keys(entry)[0]);
  assert.deepEqual(fields, ["name", "cuisine", "tags", "city", "address", "postcode"]);
  assert.equal(match.$and[0].$or.find((entry) => entry.postcode).postcode.test("06457"), true);
});

test("address search is escaped and matched as ordinary text", () => {
  const match = buildRestaurantMatch({ q: "12 Main St." });
  const address = match.$and[0].$or.find((entry) => entry.address).address;
  assert.equal(address.test("12 Main St., Synthetic City"), true);
  assert.equal(address.test("12 Main StX, Synthetic City"), false);
});

test("category and free-text search remain separate compatible backend filters", () => {
  const match = buildRestaurantMatch({ q: "Main Street", category: "Burgers" });
  assert.equal(match.$and.length, 2);
  assert.deepEqual(match.$and[1].$or.map((entry) => Object.keys(entry)[0]), ["name", "cuisine", "tags"]);
});

test("safe restaurant projection remains authoritative after discovery", () => {
  const projection = buildRestaurantListProjection({
    ...point("projection", 100),
    halal: true,
    certified: true,
    restaurantTrust: { claims: [], evidence: [] },
  });
  assert.equal(projection.restaurantSummary.status, "UNVERIFIED");
  assert.equal(Object.hasOwn(projection, "halal"), false);
  assert.equal(Object.hasOwn(projection, "certified"), false);
  assert.equal(Object.hasOwn(projection, "restaurantTrust"), false);
});
