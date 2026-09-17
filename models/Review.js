const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    comment: { type: String, required: true },
    rating: { type: Number, min: 1, max: 5, default: 5 },
    gender: { type: String, enum: ["male", "female"], default: "male" },
    approved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Compound index: approved filter + createdAt sort
reviewSchema.index({ approved: 1, createdAt: -1 });

module.exports = mongoose.model("Review", reviewSchema);
