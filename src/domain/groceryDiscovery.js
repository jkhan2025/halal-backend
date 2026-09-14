"use strict";

// Grocery-specific discovery planner. Mirrors the $geoNear-based architecture
// proven by restaurantDiscovery.js (geographic eligibility applied at the
// database query level, before any result truncation) without modifying
// Restaurant Discovery or assuming grocery-specific filters match restaurant
// ones (no cuisine/price; grocery uses category tags instead).

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PROXIMITY_RADIUS_M = 50000;

class GroceryDiscoveryInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "GroceryDiscoveryInputError";
    this.code = code;
    this.statusCode = 400;
  }
}

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== "";
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (value) => hasValue(value) ? String(value).trim() : "";
const exactInsensitive = (value) => new RegExp(`^${escapeRegex(text(value))}$`, "i");
const containsInsensitive = (value) => new RegExp(escapeRegex(text(value)), "i");

function parseStrictNumber(value, code) {
  const raw = text(value);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
    throw new GroceryDiscoveryInputError(code);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new GroceryDiscoveryInputError(code);
  return parsed;
}

function normalizeLimit(value) {
  if (!hasValue(value)) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseProximity(query) {
  const supplied = ["lat", "lng", "radius"].filter((key) => hasValue(query[key]));
  if (!supplied.length) return null;
  if (supplied.length !== 3) {
    throw new GroceryDiscoveryInputError("LOCATION_QUERY_REQUIRES_LAT_LNG_RADIUS");
  }

  const lat = parseStrictNumber(query.lat, "INVALID_LATITUDE");
  const lng = parseStrictNumber(query.lng, "INVALID_LONGITUDE");
  const radius = parseStrictNumber(query.radius, "INVALID_RADIUS");
  if (lat < -90 || lat > 90) throw new GroceryDiscoveryInputError("INVALID_LATITUDE");
  if (lng < -180 || lng > 180) throw new GroceryDiscoveryInputError("INVALID_LONGITUDE");
  if (radius <= 0 || radius > MAX_PROXIMITY_RADIUS_M) {
    throw new GroceryDiscoveryInputError("INVALID_RADIUS");
  }
  return { lat, lng, radius };
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return hasValue(value) ? String(value).split(",").map(text).filter(Boolean) : [];
}

function buildGroceryMatch(query) {
  const match = { type: "grocery" };
  const clauses = [];
  const state = text(query.state);
  const city = text(query.city);
  const tags = asArray(query.tags);
  const q = text(query.q);

  if (state) match.state = state.toUpperCase();
  if (city) match.city = containsInsensitive(city);
  if (tags.length) match.tags = { $in: tags.map(exactInsensitive) };

  if (q) {
    const rx = containsInsensitive(q);
    clauses.push({
      $or: [
        { name: rx },
        { tags: rx },
        { city: rx },
        { address: rx },
        { postcode: rx },
      ],
    });
  }

  if (clauses.length) match.$and = clauses;
  return match;
}

function createGroceryDiscoveryPlan(query = {}) {
  return {
    proximity: parseProximity(query),
    match: buildGroceryMatch(query),
    limit: normalizeLimit(query.limit),
    promoFirst: String(query.promoFirst ?? "true").toLowerCase() === "true",
  };
}

async function loadGroceryCandidates(Place, plan) {
  if (plan.proximity) {
    return Place.aggregate([{
      $geoNear: {
        near: {
          type: "Point",
          coordinates: [plan.proximity.lng, plan.proximity.lat],
        },
        key: "geo",
        distanceField: "distance",
        maxDistance: plan.proximity.radius,
        spherical: true,
        query: plan.match,
      },
    }]);
  }

  return Place.find(plan.match).sort({ name: 1, _id: 1 }).limit(plan.limit).lean();
}

function geoCoordinates(value) {
  const coordinates = value?.geo?.coordinates;
  if (value?.geo?.type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2) return null;
  const lng = coordinates[0];
  const lat = coordinates[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

const toRad = (degrees) => degrees * Math.PI / 180;
function haversineMeters(a, b) {
  const earthRadiusM = 6371e3;
  const latDelta = toRad(b.lat - a.lat);
  const lngDelta = toRad(b.lng - a.lng);
  const value = Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(lngDelta / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function promoIsActive(promo, now) {
  return Boolean(promo?.active) &&
    (!promo.startAt || new Date(promo.startAt) <= now) &&
    (!promo.endAt || new Date(promo.endAt) >= now);
}

function promoApplies(promo, reference) {
  const coordinates = promo?.geoCenter?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2 || !promo.geoRadiusM) return true;
  if (!reference || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) return false;
  return haversineMeters(reference, { lat: coordinates[1], lng: coordinates[0] }) <= promo.geoRadiusM;
}

// Eligibility (geography, coverage) is decided BEFORE promoted/organic
// bucketing, so promotion can never surface an out-of-radius or otherwise
// ineligible grocery. Each surviving item is tagged with an internal
// `_promoted` boolean; callers may surface it as a minimal, safe disclosure
// (e.g. `isPromoted`) without leaking `promo` tier/priority/metrics.
function finalizeGroceryResults(docs, plan, { now = new Date() } = {}) {
  const input = Array.isArray(docs) ? docs : [];
  const reference = plan.proximity ? { lat: plan.proximity.lat, lng: plan.proximity.lng } : null;
  const eligible = input.flatMap((raw) => {
    const item = raw && typeof raw === "object" ? raw : {};
    if (!plan.proximity) {
      const { distance, ...withoutDistance } = item;
      return [withoutDistance];
    }
    const coords = geoCoordinates(item);
    if (!coords || !Number.isFinite(item.distance) || item.distance < 0 || item.distance > plan.proximity.radius) {
      return [];
    }
    return [{ ...item, coords, distance: item.distance }];
  });

  const promoted = [];
  const organic = [];
  for (const item of eligible) {
    if (promoIsActive(item.promo, now) && promoApplies(item.promo, reference)) promoted.push({ ...item, _promoted: true });
    else organic.push({ ...item, _promoted: false });
  }

  const byDistanceThenName = (a, b) =>
    (plan.proximity ? a.distance - b.distance : 0) ||
    String(a.name || "").localeCompare(String(b.name || ""));
  const promoRank = { featured: 2, sponsored: 1, none: 0 };
  promoted.sort((a, b) =>
    (promoRank[b?.promo?.tier || "none"] || 0) - (promoRank[a?.promo?.tier || "none"] || 0) ||
    (b?.promo?.priority ?? 0) - (a?.promo?.priority ?? 0) ||
    byDistanceThenName(a, b)
  );
  organic.sort(byDistanceThenName);

  const ordered = plan.promoFirst ? [...promoted, ...organic] : [...organic, ...promoted];
  return ordered.slice(0, plan.limit);
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PROXIMITY_RADIUS_M,
  GroceryDiscoveryInputError,
  parseProximity,
  buildGroceryMatch,
  createGroceryDiscoveryPlan,
  loadGroceryCandidates,
  geoCoordinates,
  finalizeGroceryResults,
};
