// backend/models/Submission.js
const mongoose = require("mongoose");

const PhotoSchema = new mongoose.Schema(
  { url: String, kind: { type: String, enum: ["front", "ingredients"], default: "front" } },
  { _id: false }
);

const SubmissionSchema = new mongoose.Schema({
  barcode: { type: String, index: true, required: true },
  message: String,
  photos: [PhotoSchema],
  status: { type: String, enum: ["NEW", "REVIEWING", "DONE"], default: "NEW" },
}, { timestamps: true });

module.exports = mongoose.model("Submission", SubmissionSchema);
