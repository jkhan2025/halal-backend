// backend/routes/groceries.routes.js
const router = require('express').Router();
const Place = require('../../models/Place');
const {
  buildGroceryListProjection,
  buildGroceryDetailProjection,
} = require('../domain/groceryTrust');
const {
  GroceryDiscoveryInputError,
  createGroceryDiscoveryPlan,
  loadGroceryCandidates,
  finalizeGroceryResults,
} = require('../domain/groceryDiscovery');
const ADMIN_KEY = process.env.ADMIN_KEY;

/**
 * GET /api/groceries
 * Query:
 *   q, state, city, tags (csv | multi), limit,
 *   lat, lng, radius (meters) — proximity requires all three together,
 *   promoFirst=true|false
 */
router.get('/', async (req, res) => {
  try {
    const plan = createGroceryDiscoveryPlan(req.query);
    const docs = await loadGroceryCandidates(Place, plan);
    const results = finalizeGroceryResults(docs, plan);

    // non-blocking impression bump
    const ids = results.map((d) => d._id).filter(Boolean);
    if (ids.length) {
      Place.updateMany({ _id: { $in: ids } }, { $inc: { 'metrics.impressions': 1 } }).exec();
    }

    // Public grocery discovery uses the curated Grocery Contract v1
    // projection. This intentionally excludes raw legacy halal/certified
    // booleans, the unvalidated groceryTrust storage shape, restaurantTrust,
    // and promo/metrics internals. Only a minimal isPromoted disclosure
    // survives, computed from eligibility decided before promoted ordering.
    res.json(results.map((place) => ({
      ...buildGroceryListProjection(place),
      isPromoted: Boolean(place._promoted),
    })));
  } catch (e) {
    if (e instanceof GroceryDiscoveryInputError) {
      return res.status(e.statusCode).json({ ok: false, error: e.code });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

function isStablePlaceId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function createGroceryDetailHandler({ PlaceModel = Place, logger = console } = {}) {
  return async (req, res) => {
    try {
      const placeId = String(req.params?.id || '').trim();
      if (!isStablePlaceId(placeId)) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      }
      const place = await PlaceModel.findOne({ _id: placeId, type: 'grocery' }).lean();
      if (!place) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.json({ ok: true, item: buildGroceryDetailProjection(place) });
    } catch (error) {
      logger.error(error);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  };
}

router.get('/:id', createGroceryDetailHandler());

// POST /api/groceries/bulk  (admin)
router.post('/bulk', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const arr = Array.isArray(req.body) ? req.body : [];
    if (!arr.length) return res.status(400).json({ ok: false, error: 'EMPTY' });

    // normalize docs to schema (photos: [String], set geo from coords)
    const docs = arr.map((g) => {
      const doc = {
        ...g,
        type: 'grocery',
        photos: Array.isArray(g.photos) ? g.photos.map(String) : [],
      };
      const c = g.coords || {};
      if (typeof c.lat === 'number' && typeof c.lng === 'number') {
        doc.geo = { type: 'Point', coordinates: [c.lng, c.lat] };
      }
      return doc;
    });

    // upsert behavior: replace per-state batch
    const states = [...new Set(docs.map((d) => d.state).filter(Boolean))];
    if (states.length) {
      await Place.deleteMany({ type: 'grocery', state: { $in: states } });
    } else {
      await Place.deleteMany({ type: 'grocery' });
    }

    const inserted = await Place.insertMany(docs, { ordered: false });
    res.json({ ok: true, inserted: inserted.length, states });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

module.exports = router;
module.exports.isStablePlaceId = isStablePlaceId;
module.exports.createGroceryDetailHandler = createGroceryDetailHandler;
