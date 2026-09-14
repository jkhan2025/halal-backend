const router = require('express').Router();
const Place = require('../../models/Place');
const {
  buildRestaurantListProjection,
  buildRestaurantDetailProjection,
} = require('../domain/restaurantTrust');
const {
  RestaurantDiscoveryInputError,
  createRestaurantDiscoveryPlan,
  loadRestaurantCandidates,
  finalizeRestaurantResults,
} = require('../domain/restaurantDiscovery');
const ADMIN_KEY = process.env.ADMIN_KEY;

/**
 * GET /api/restaurants
 * Query:
 *   q, state, city, cuisine, tags (csv | multi), priceMin, priceMax,
 *   lat, lng, radius (meters), limit, promoFirst=true|false
 */
router.get('/', async (req, res) => {
  try {
    const plan = createRestaurantDiscoveryPlan(req.query);
    const docs = await loadRestaurantCandidates(Place, plan);
    const result = finalizeRestaurantResults(docs, plan);

    // non-blocking impression bump
    const ids = result.map((d) => d._id).filter(Boolean);
    if (ids.length) {
      Place.updateMany({ _id: { $in: ids } }, { $inc: { 'metrics.impressions': 1 } }).exec();
    }

    // Public restaurant discovery uses the restaurant-specific projection.
    // This intentionally excludes raw legacy halal/certified booleans and the
    // unvalidated restaurantTrust storage shape.
    res.json(result.map((place) => buildRestaurantListProjection(place)));
  } catch (e) {
    if (e instanceof RestaurantDiscoveryInputError) {
      return res.status(e.statusCode).json({ ok: false, error: e.code });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

function isStablePlaceId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function createRestaurantDetailHandler({ PlaceModel = Place, logger = console } = {}) {
  return async (req, res) => {
    try {
      const placeId = String(req.params?.id || '').trim();
      if (!isStablePlaceId(placeId)) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      }
      const place = await PlaceModel.findOne({ _id: placeId, type: 'restaurant' }).lean();
      if (!place) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.json({ ok: true, item: buildRestaurantDetailProjection(place) });
    } catch (error) {
      logger.error(error);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  };
}

router.get('/:id', createRestaurantDetailHandler());

/**
 * POST /api/restaurants/bulk
 * Body: array of restaurant docs (we’ll coerce photos to [String] and set geo from coords)
 * Header: x-admin-key: <ADMIN_KEY>
 */
router.post('/bulk', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const arr = Array.isArray(req.body) ? req.body : [];
    if (!arr.length) return res.status(400).json({ ok: false, error: 'EMPTY' });

    const docs = arr.map((r) => {
      const doc = {
        ...r,
        type: 'restaurant',
        photos: Array.isArray(r.photos) ? r.photos.map(String) : [],
      };
      const c = r.coords || {};
      if (typeof c.lat === 'number' && typeof c.lng === 'number') {
        doc.geo = { type: 'Point', coordinates: [c.lng, c.lat] };
      }
      return doc;
    });

    // Replace by state batch to keep simple idempotent seeding
    const states = [...new Set(docs.map((d) => d.state).filter(Boolean))];
    if (states.length) {
      await Place.deleteMany({ type: 'restaurant', state: { $in: states } });
    } else {
      await Place.deleteMany({ type: 'restaurant' });
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
module.exports.createRestaurantDetailHandler = createRestaurantDetailHandler;
