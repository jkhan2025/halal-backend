const mongoose = require('mongoose');

const GrocerySchema = new mongoose.Schema({
  name: String,
  city: String,
  state: String,
  address: String,
  phone: String,
  website: String,
  tags: [String],
  halal: Boolean,
  certified: Boolean,
  rating: Number,
  coords: {
    lat: Number,
    lng: Number,
  },
  photos: [String],
  hours_raw: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

GrocerySchema.index({ name: 'text', city: 'text', tags: 'text' });

module.exports = mongoose.model('Grocery', GrocerySchema);
