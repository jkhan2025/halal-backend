const mongoose = require('mongoose');

const ClaimSchema = new mongoose.Schema({
  place: { type: mongoose.Schema.Types.ObjectId, ref: 'Place', required: true, index: true },
  token: { type: String, required: true, unique: true, index: true },
  email: String,
  status: { type: String, enum: ['pending', 'used', 'expired'], default: 'pending' },
  expiresAt: { type: Date, required: true }, // for TTL
}, { timestamps: true });

// Auto-delete when expiresAt passes
ClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Claim || mongoose.model('Claim', ClaimSchema);
