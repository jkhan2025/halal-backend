const { Schema, model } = require('mongoose');

const ReportSchema = new Schema({
  code: { type: String, index: true, required: true },
  note: String,
  frontUri: String,
  ingrUri: String,
  status: { type: String, default: 'Pending' },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = model('Report', ReportSchema);
