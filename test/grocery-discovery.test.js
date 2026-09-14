"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  MAX_PROXIMITY_RADIUS_M,
  MAX_LIMIT,
  GroceryDiscoveryInputError,
  parseProximity,
  buildGroceryMatch,
  createGroceryDiscoveryPlan,
  loadGroceryCandidates,
  finalizeGroceryResults,
} = require("../src/domain/groceryDiscovery");
const { buildGroceryListProjection } = require("../src/domain/groceryTrust");
const groceriesRouter = require("../src/routes/groceries.routes");

const listRouteHandler = groceriesRouter.stack
  .find((layer) => layer.route?.path === "/" && layer.route?.methods?.get)
  .route.stack[0].handle;

function point(id, distance, lat = 41, lng = -73, extra = {}) {
  return {
    _id: id,
    type: "grocery",
    name: `Synthetic Grocery ${id}`,
    geo: { type: "Point", coordinates: [lng, lat] },
    coords: { lat, lng },
    distance,
    ...extra,
  };
}

test("valid proximity input creates a strict location-scoped query", () => {
  const plan = createGroceryDiscoveryPlan({ lat: "41.5", lng: "-72.7", radius: "20000", limit: "2" });
  assert.deepEqual(plan.proximity, { lat: 41.5, lng: -72.7, radius: 20000 });
  assert.equal(plan.limit, 2);
  assert.equal(plan.match.type, "grocery");
});

test("Near Me never receives a hidden CT/state fallback", () => {
  const plan = createGroceryDiscoveryPlan({ lat: "41.5", lng: "-72.7", radius: "20000" });
  assert.equal(Object.hasOwn(plan.match, "state"), false);
});

for (const value of ["NaN", "Infinity", "-Infinity", "1e3", "not-a-number"]) {
  test(`malformed latitude input ${value} is rejected`, () => {
    assert.throws(
      () => parseProximity({ lat: value, lng: "-73", radius: "20000" }),
      (error) => error instanceof GroceryDiscoveryInputError && error.code === "INVALID_LATITUDE"
    );
  });
}

for (const lat of ["-90.01", "90.01"]) {
  test(`out-of-range latitude ${lat} is rejected`, () => {
    assert.throws(() => parseProximity({ lat, lng: "-73", radius: "20000" }), /INVALID_LATITUDE/);
  });
}

for (const lng of ["-180.01", "180.01", "NaN"]) {
  test(`out-of-range/malformed longitude ${lng} is rejected`, () => {
    assert.throws(() => parseProximity({ lat: "41", lng, radius: "20000" }), /INVALID_LONGITUDE/);
  });
}

for (const radius of ["0", "-1", String(MAX_PROXIMITY_RADIUS_M + 1), "Infinity", "not-a-number"]) {
  test(`invalid radius ${radius} is rejected`, () => {
    assert.throws(() => parseProximity({ lat: "41", lng: "-73", radius }), /INVALID_RADIUS/);
  });
}

test("radius is capped at MAX_PROXIMITY_RADIUS_M", () => {
  assert.throws(
    () => parseProximity({ lat: "41", lng: "-73", radius: String(MAX_PROXIMITY_RADIUS_M + 1) }),
    /INVALID_RADIUS/
  );
  const plan = createGroceryDiscoveryPlan({ lat: "41", lng: "-73", radius: String(MAX_PROXIMITY_RADIUS_M) });
  assert.equal(plan.proximity.radius, MAX_PROXIMITY_RADIUS_M);
});

test("invalid limit input falls back to the safe default rather than erroring", () => {
  assert.equal(createGroceryDiscoveryPlan({ limit: "not-a-number" }).limit, 50);
  assert.equal(createGroceryDiscoveryPlan({ limit: "-5" }).limit, 50);
  assert.equal(createGroceryDiscoveryPlan({ limit: "0" }).limit, 50);
});

test("limit is capped at MAX_LIMIT", () => {
  const plan = createGroceryDiscoveryPlan({ limit: String(MAX_LIMIT + 500) });
  assert.equal(plan.limit, MAX_LIMIT);
});

test("partial proximity parameters are rejected rather than becoming ordinary discovery", () => {
  assert.throws(
    () => createGroceryDiscoveryPlan({ lat: "41", lng: "-73" }),
    /LOCATION_QUERY_REQUIRES_LAT_LNG_RADIUS/
  );
});

test("the grocery API maps invalid proximity input to an explicit 400 response", async () => {
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

test("GeoJSON radius filtering is planned before the final result limit (nearby candidates selected before limit)", async () => {
  let pipeline;
  const Place = {
    async aggregate(value) {
      pipeline = value;
      return [point("far", 19000), point("nearest", 100), point("near", 800)];
    },
  };
  const plan = createGroceryDiscoveryPlan({ lat: "41", lng: "-73", radius: "20000", limit: "2", promoFirst: "false" });
  const docs = await loadGroceryCandidates(Place, plan);
  const results = finalizeGroceryResults(docs, plan);

  assert.ok(pipeline[0].$geoNear);
  assert.equal(pipeline[0].$geoNear.key, "geo");
  assert.equal(pipeline[0].$geoNear.maxDistance, 20000);
  assert.deepEqual(pipeline[0].$geoNear.near.coordinates, [-73, 41]);
  assert.equal(pipeline.some((stage) => stage.$limit), false);
  assert.deepEqual(results.map((item) => item._id), ["nearest", "near"]);
});

test("coordinate-less, malformed, and out-of-radius candidates are excluded", () => {
  const plan = createGroceryDiscoveryPlan({ lat: "41", lng: "-73", radius: "20000" });
  const results = finalizeGroceryResults([
    point("valid", 100),
    { _id: "missing", type: "grocery", distance: 50 },
    { ...point("malformed", 75), geo: { type: "Point", coordinates: ["-73", 41] } },
    point("outside", 20001),
  ], plan);
  assert.deepEqual(results.map((item) => item._id), ["valid"]);
});

test("nearest-first ordering is preserved end to end", () => {
  const plan = createGroceryDiscoveryPlan({ lat: "41", lng: "-73", radius: "20000", promoFirst: "false" });
  const results = finalizeGroceryResults([
    point("mid", 5000),
    point("closest", 200),
    point("farthest", 15000),
  ], plan);
  assert.deepEqual(results.map((item) => item._id), ["closest", "mid", "farthest"]);
});

test("a promoted grocery outside the search radius is still excluded, not just re-ranked", () => {
  const plan = createGroceryDiscoveryPlan({ lat: "41", lng: "-73", radius: "20000" });
  const results = finalizeGroceryResults([
    point("nearby", 500),
    point("far-but-promoted", 25000, 41, -73, { promo: { tier: "featured", active: true } }),
  ], plan);
  assert.deepEqual(results.map((item) => item._id), ["nearby"]);
});

test("ordinary discovery uses find, remains non-proximity, and does not expose distance", async () => {
  let receivedMatch;
  const docs = [{ _id: "ordinary", type: "grocery", name: "Synthetic Ordinary", distance: 123 }];
  const chain = {
    sort() { return chain; },
    limit() { return chain; },
    async lean() { return docs; },
  };
  const Place = {
    find(match) { receivedMatch = match; return chain; },
    aggregate() { throw new Error("ordinary discovery must not use geo aggregation"); },
  };
  const plan = createGroceryDiscoveryPlan({ state: "ct" });
  const loaded = await loadGroceryCandidates(Place, plan);
  const results = finalizeGroceryResults(loaded, plan);
  assert.equal(plan.proximity, null);
  assert.equal(receivedMatch.state, "CT");
  assert.equal(Object.hasOwn(results[0], "distance"), false);
});

test("search covers name, tags, city, address, and postcode (no cuisine/menu fields)", () => {
  const match = buildGroceryMatch({ q: "06457" });
  const fields = match.$and[0].$or.map((entry) => Object.keys(entry)[0]);
  assert.deepEqual(fields, ["name", "tags", "city", "address", "postcode"]);
  assert.equal(match.$and[0].$or.find((entry) => entry.postcode).postcode.test("06457"), true);
});

test("category tag filtering matches case-insensitively", () => {
  const match = buildGroceryMatch({ tags: "butcher" });
  assert.equal(match.tags.$in[0].test("Butcher"), true);
  assert.equal(match.tags.$in[0].test("Bakery"), false);
});

test("address search is escaped and matched as ordinary text", () => {
  const match = buildGroceryMatch({ q: "12 Main St." });
  const address = match.$and[0].$or.find((entry) => entry.address).address;
  assert.equal(address.test("12 Main St., Synthetic City"), true);
  assert.equal(address.test("12 Main StX, Synthetic City"), false);
});

test("safe grocery projection remains authoritative after discovery and strips internal fields", () => {
  const projection = buildGroceryListProjection({
    ...point("projection", 100),
    halal: true,
    certified: true,
    groceryTrust: { claims: [], evidence: [] },
    restaurantTrust: { claims: [] },
    promo: { tier: "featured", active: true },
    metrics: { impressions: 50 },
  });
  assert.equal(projection.grocerySummary.status, "UNVERIFIED");
  assert.equal(Object.hasOwn(projection, "halal"), false);
  assert.equal(Object.hasOwn(projection, "certified"), false);
  assert.equal(Object.hasOwn(projection, "groceryTrust"), false);
  assert.equal(Object.hasOwn(projection, "restaurantTrust"), false);
  assert.equal(Object.hasOwn(projection, "promo"), false);
  assert.equal(Object.hasOwn(projection, "metrics"), false);
});

test("the grocery list response shape carries only isPromoted, never raw promo/metrics", async () => {
  const chain = {
    sort() { return chain; },
    limit() { return chain; },
    async lean() {
      return [
        { ...point("promoted-item", null), promo: { tier: "featured", active: true, priority: 5 }, metrics: { impressions: 10 } },
      ];
    },
  };
  const Place = { find() { return chain; } };
  const plan = createGroceryDiscoveryPlan({});
  const docs = await loadGroceryCandidates(Place, plan);
  const results = finalizeGroceryResults(docs, plan);
  const item = { ...buildGroceryListProjection(results[0]), isPromoted: Boolean(results[0]._promoted) };
  assert.equal(item.isPromoted, true);
  assert.equal(Object.hasOwn(item, "promo"), false);
  assert.equal(Object.hasOwn(item, "metrics"), false);
  assert.equal(Object.hasOwn(item, "_promoted"), false);
});
