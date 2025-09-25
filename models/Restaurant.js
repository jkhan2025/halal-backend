const mongoose = require('mongoose');

const RestaurantSchema = new mongoose.Schema({
  name: String,
  cuisine: String,
  city: String,
  state: String,
  price: Number,
  rating: Number,
  halal: Boolean,
  certified: Boolean,
  phone: String,
  website: String,
  coords: {
    lat: Number,
    lng: Number,
  },
  photos: [String],
  hours_raw: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

RestaurantSchema.index({ name: 'text', cuisine: 'text', city: 'text' });

module.exports = mongoose.model('Restaurant', RestaurantSchema);
