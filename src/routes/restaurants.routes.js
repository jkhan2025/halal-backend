const router = require('express').Router();
const Place = require('../../models/Place');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev123';

const toRad = (d) => (d * Math.PI) / 180;
function haversineMeters(a, b) {
  if (
    !a || !b ||
    typeof a.lat !== 'number' || typeof a.lng !== 'number' ||
    typeof b.lat !== 'number' || typeof b.lng !== 'number'
  ) return null;
  const R = 6371e3;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);
  const s = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

const asArray = (v) =>
  Array.isArray(v) ? v
  : v == null ? []
  : String(v).split(',').map(s => s.trim()).filter(Boolean);

const PROMO_RANK = { featured: 2, sponsored: 1, none: 0 };

/**
 * GET /api/restaurants
 * Query:
 *   q, state, city, cuisine, tags (csv | multi), priceMin, priceMax,
 *   lat, lng, radius (meters), limit, promoFirst=true|false
 */
router.get('/', async (req, res) => {
  try {
    const {
      q = '',
      state = '',
      city = '',
      cuisine = '',
      tags,
      priceMin,
      priceMax,
      lat,
      lng,
      radius,
      limit = '50',
      promoFirst = 'true',
    } = req.query;

    const lim = Math.min(parseInt(limit, 10) || 50, 100);
    const tagArr = asArray(tags);

    // Base condition
    const cond = { type: 'restaurant' };
    if (state) cond.state = String(state).toUpperCase();
    if (city) cond.city = new RegExp(String(city).trim(), 'i');
    if (cuisine) cond.cuisine = new RegExp(String(cuisine).trim(), 'i');
    if (tagArr.length) cond.tags = { $in: tagArr };

    if (priceMin || priceMax) {
      cond.price = {};
      if (priceMin) cond.price.$gte = Number(priceMin);
      if (priceMax) cond.price.$lte = Number(priceMax);
    }

    // Text search with safe fallback
    let docs = [];
    if (q.trim()) {
      try {
        docs = await Place.find({ ...cond, $text: { $search: q.trim() } })
          .limit(lim)
          .lean();
      } catch {
        const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        docs = await Place.find({
          ...cond,
          $or: [{ name: rx }, { cuisine: rx }, { tags: rx }, { city: rx }],
        })
          .limit(lim)
          .lean();
      }
    } else {
      docs = await Place.find(cond).limit(lim).lean();
    }

    // Distance calc + optional radius filtering
    const ref =
      lat != null && lng != null
        ? { lat: parseFloat(lat), lng: parseFloat(lng) }
        : null;
    const maxR = radius ? parseFloat(radius) : null;

    let items = docs.map((d) => {
      const hasCoords = d?.coords && typeof d.coords.lat === 'number' && typeof d.coords.lng === 'number';
      const dist = ref && hasCoords ? haversineMeters(ref, d.coords) : null;
      return { ...d, distance: dist };
    });

    if (ref && maxR) {
      items = items.filter((d) => d.distance == null || d.distance <= maxR);
    }

    // --- Promo ordering (optional) ---
    const now = new Date();
    const isPromoActive = (p) =>
      !!(p && p.active) &&
      (!p.startAt || new Date(p.startAt) <= now) &&
      (!p.endAt || new Date(p.endAt) >= now);

    const inPromoFence = (p) => {
      if (!p || !p.geoCenter || !Array.isArray(p.geoCenter.coordinates) || p.geoCenter.coordinates.length < 2 || !p.geoRadiusM) {
        return true; // global or no fence
      }
      if (!ref) return true; // no user ref: allow
      const center = { lat: p.geoCenter.coordinates[1], lng: p.geoCenter.coordinates[0] };
      const d = haversineMeters(ref, center);
      return d != null && d <= p.geoRadiusM;
    };

    const promoted = [];
    const organic = [];
    for (const it of items) {
      if (isPromoActive(it.promo) && inPromoFence(it.promo)) promoted.push(it);
      else organic.push(it);
    }

    const sortByDistanceThenName = (a, b) =>
      (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
      (a.name || '').localeCompare(b.name || '');

    promoted.sort((a, b) => {
      const ar = PROMO_RANK[a?.promo?.tier || 'none'] || 0;
      const br = PROMO_RANK[b?.promo?.tier || 'none'] || 0;
      if (br !== ar) return br - ar;                // featured > sponsored
      const ap = a?.promo?.priority ?? 0;
      const bp = b?.promo?.priority ?? 0;
      if (bp !== ap) return bp - ap;                // higher priority first
      return sortByDistanceThenName(a, b);
    });

    organic.sort(sortByDistanceThenName);

    const result =
      String(promoFirst).toLowerCase() === 'true'
        ? [...promoted, ...organic].slice(0, lim)
        : [...organic, ...promoted].slice(0, lim);

    // non-blocking impression bump
    const ids = result.map((d) => d._id).filter(Boolean);
    if (ids.length) {
      Place.updateMany({ _id: { $in: ids } }, { $inc: { 'metrics.impressions': 1 } }).exec();
    }

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

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
