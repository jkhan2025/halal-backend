// backend/models/Place.js
const mongoose = require('mongoose');
const { TrustSchema } = require('./Trust');
const { RestaurantTrustSchema } = require('./RestaurantTrust');
const { GroceryTrustSchema } = require('./GroceryTrust');

const PlaceSchema = new mongoose.Schema({
  type: { type: String, enum: ['restaurant', 'grocery'], required: true },

  name: { type: String, required: true },
  cuisine: String,
  tags: [String],
  address: String,
  city: String,
  state: String,
  postcode: String,

  price: Number,
  rating: Number,
  // Legacy fields retained for compatibility. Absence must remain unknown.
  halal: Boolean,
  certified: Boolean,
  trust: { type: TrustSchema, default: undefined },
  // Restaurant-specific claims and evidence. This remains separate from the
  // generic/product-oriented trust schema and is authoritative only after the
  // Restaurant Result Contract normalizer validates exact-location binding.
  restaurantTrust: { type: RestaurantTrustSchema, default: undefined },
  // Grocery-specific claims and evidence (Grocery Result Contract v1). Optional
  // and independent of restaurantTrust; authoritative only after
  // buildGroceryResultContract validates exact-location binding. Never
  // populated automatically from legacy halal/certified fields.
  groceryTrust: { type: GroceryTrustSchema, default: undefined },

  phone: String,
  website: String,
  photos: [String],

  hours: [{ day: Number, open: String, close: String }],
  hours_raw: mongoose.Schema.Types.Mixed,

  coords: {
    lat: Number,
    lng: Number,
  },

  // ❌ no defaults here — leave undefined unless we have coords
  geo: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },

  promo: {
    tier: { type: String, enum: ['none', 'sponsored', 'featured'], default: 'none' },
    active: { type: Boolean, default: false },
    startAt: Date,
    endAt: Date,
    // ❌ no defaults here either
    geoCenter: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    geoRadiusM: Number,
    priority: { type: Number, default: 0 },
  },

  metrics: {
    impressions: { type: Number, default: 0 },
    taps: { type: Number, default: 0 },
  },

  source: String,
  sourceId: String,
}, { timestamps: true });

// Indexes
PlaceSchema.index({ name: 'text', cuisine: 'text', city: 'text', tags: 'text' });
PlaceSchema.index({ geo: '2dsphere' });
PlaceSchema.index({ 'promo.active': 1, 'promo.tier': 1, 'promo.startAt': 1, 'promo.endAt': 1 });
PlaceSchema.index({ 'promo.geoCenter': '2dsphere' });

// Keep geo in sync on save
PlaceSchema.pre('save', function (next) {
  const c = this.coords || {};
  if (typeof c.lat === 'number' && typeof c.lng === 'number') {
    this.geo = { type: 'Point', coordinates: [c.lng, c.lat] };
  } else {
    this.geo = undefined; // important
  }
  next();
});

// Only explicit coordinate changes should synchronize geo. In particular,
// metrics/contact updates and maintenance of promo.geoCenter must leave it alone.
PlaceSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const upd = this.getUpdate() || {};
  const invalid = (reason) => next(new Error(`Invalid Place coordinate update: ${reason}`));

  // Pipelines can replace/project away coordinates or compute them from stored
  // data. Reject them rather than guessing at geography or reading the database.
  if (Array.isArray(upd)) return invalid('use explicit field updates, not a pipeline');

  const touches = (path, root) => typeof path === 'string' && (path === root || path.startsWith(`${root}.`));
  const writes = Object.entries(upd).flatMap(([key, value]) =>
    key.startsWith('$')
      ? Object.entries(value || {}).map(([path, v]) => ({ op: key, path, value: v }))
      : [{ op: '$set', path: key, value }]
  );
  const coordWrites = writes.filter(({ op, path, value }) =>
    touches(path, 'coords') || (op === '$rename' && touches(value, 'coords'))
  );
  if (!coordWrites.length) return next();

  const op = coordWrites[0].op;
  if (!['$set', '$setOnInsert', '$unset'].includes(op) || coordWrites.some((w) => w.op !== op)) {
    return invalid('coordinates require a single $set, $setOnInsert, or whole-field $unset');
  }

  let c;
  if (coordWrites.length === 1 && coordWrites[0].path === 'coords') {
    c = coordWrites[0].value;
  } else if (op !== '$unset' && coordWrites.length === 2 &&
      coordWrites.some((w) => w.path === 'coords.lat') && coordWrites.some((w) => w.path === 'coords.lng')) {
    c = {
      lat: coordWrites.find((w) => w.path === 'coords.lat').value,
      lng: coordWrites.find((w) => w.path === 'coords.lng').value,
    };
  } else {
    return invalid('supply both latitude and longitude, or explicitly unset all coords');
  }

  if (op !== '$unset' && (!c || Array.isArray(c) ||
      !Number.isFinite(c.lat) || !Number.isFinite(c.lng) ||
      Math.abs(c.lat) > 90 || Math.abs(c.lng) > 180)) {
    return invalid('latitude/longitude must be finite numbers within geographic bounds');
  }

  // Existing seed callers set full coords and geo together. Allow that shape,
  // deriving geo from coords, but reject competing operators or dotted geo edits.
  const conflictingGeo = writes.some(({ op: geoOp, path, value }) =>
    (touches(path, 'geo') && (geoOp !== op || path !== 'geo')) ||
    (geoOp === '$rename' && touches(value, 'geo'))
  );
  if (conflictingGeo) return invalid('coordinate and geography operations conflict');

  if (op === '$unset') {
    upd.$unset.geo = 1;
  } else {
    // Plain update fields are interpreted as $set by Mongoose.
    if (op === '$set') delete upd.geo;
    const fields = upd[op] || (upd[op] = {});
    fields.geo = { type: 'Point', coordinates: [c.lng, c.lat] };
  }

  this.setUpdate(upd);
  next();
});

module.exports = mongoose.models.Place || mongoose.model('Place', PlaceSchema);
