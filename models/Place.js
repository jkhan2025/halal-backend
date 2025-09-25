// backend/models/Place.js
const mongoose = require('mongoose');

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
  halal: { type: Boolean, default: true },
  certified: { type: Boolean, default: false },

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

// Keep geo in sync on updates (and UNSET when coords missing)
PlaceSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const upd = this.getUpdate() || {};
  const $set = upd.$set || (upd.$set = {});
  const $unset = upd.$unset || (upd.$unset = {});
  const c = $set.coords ?? upd.coords;

  if (c && typeof c.lat === 'number' && typeof c.lng === 'number') {
    $set.geo = { type: 'Point', coordinates: [c.lng, c.lat] };
  } else {
    $unset.geo = 1; // <-- remove bad/empty geo
  }

  this.setUpdate(upd);
  next();
});

module.exports = mongoose.models.Place || mongoose.model('Place', PlaceSchema);
