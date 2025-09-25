const router = require("express").Router();
const Place = require("../models/Place");

// tiny helpers
const escapeRx = (s = "") => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toNum = (v, d = undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const formatDistance = (m) => (m == null ? "" : m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`);

// optionally enforce a fixed type ("restaurant" or "grocery")
function typeGuard(fixedType) {
  return (req, _res, next) => {
    if (fixedType) req.query.type = fixedType;
    next();
  };
}

/**
 * GET /api/places
 * Query params:
 * - type=restaurant|grocery
 * - q=free text (name/city/cuisine/tags)
 * - state=CT (exact match, case-insensitive)
 * - tag=Butcher (matches tags or cuisine)
 * - lat,lng,radius (meters) → geo sort + distance
 * - limit (max 200)
 * - sort=rating|name (default name; distance auto when lat/lng provided)
 */
router.get("/", async (req, res) => {
  try {
    const {
      type,
      q,
      state,
      tag,
      lat,
      lng,
      radius,
      sort,
    } = req.query;

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const filter = {};

    if (type) filter.type = String(type).toLowerCase();
    if (state) filter.state = new RegExp(`^${escapeRx(state)}$`, "i");

    const rxQ = q ? new RegExp(escapeRx(String(q)), "i") : null;
    const rxTag = tag ? new RegExp(escapeRx(String(tag)), "i") : null;

    if (rxQ) {
      filter.$or = [
        { name: rxQ },
        { city: rxQ },
        { cuisine: rxQ },
        { tags: rxQ },
      ];
    }
    if (rxTag) {
      // tag matches either a tag entry or cuisine text
      filter.$or = (filter.$or || []).concat([{ tags: rxTag }, { cuisine: rxTag }]);
    }

    const hasGeo = Number.isFinite(+lat) && Number.isFinite(+lng);
    if (hasGeo) {
      const pipeline = [
        {
          $geoNear: {
            near: { type: "Point", coordinates: [toNum(lng), toNum(lat)] },
            distanceField: "distance",
            spherical: true,
            ...(radius ? { maxDistance: toNum(radius) } : {}),
            query: filter,
          },
        },
        { $limit: limit },
      ];

      const docs = await Place.aggregate(pipeline);
      const out = docs.map((d) => ({
        ...d,
        distanceText: d.distance != null ? formatDistance(d.distance) : "",
      }));
      return res.json(out);
    }

    // no geo: classic find + sort
    let list = await Place.find(filter).limit(limit).lean();
    if (String(sort).toLowerCase() === "rating") {
      list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return res.json(list);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// ADMIN: create/update/bulk (simple key check)
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key") || req.query.key;
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}

router.post("/", requireAdmin, async (req, res) => {
  const doc = await Place.create(req.body);
  res.json({ ok: true, id: doc._id });
});

router.patch("/:id", requireAdmin, async (req, res) => {
  await Place.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ ok: true });
});

router.delete("/:id", requireAdmin, async (req, res) => {
  await Place.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

router.post("/bulk", requireAdmin, async (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : [];
  if (!arr.length) return res.status(400).json({ ok: false, error: "EMPTY" });
  const docs = await Place.insertMany(arr, { ordered: false });
  res.json({ ok: true, inserted: docs.length });
});

// Factories to mount as /restaurants and /groceries
const typed = {
  restaurants: [typeGuard("restaurant"), router],
  groceries: [typeGuard("grocery"), router],
};

module.exports = { router, typed };
