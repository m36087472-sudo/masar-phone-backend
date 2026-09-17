const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    // Composite identity key: "anon:clientId"
    key: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true, index: true },

    // Counters
    requestCount: { type: Number, default: 0 },
    windowRequests: { type: Number, default: 0 }, // attempts in current window

    // Block state
    level: { type: Number, default: 0 },           // 0=initial, 1+=post-block
    blockedUntil: { type: Date, default: null },
    blockDuration: { type: Number, default: 0 },   // seconds
    totalBlocks: { type: Number, default: 0 },

    lastRequestAt: { type: Date, default: null },
    lastOrderAt: { type: Date, default: null },
    ipHistory: { type: [String], default: [] },
  },
  { timestamps: true }
);

// Auto-delete records inactive for 30 days
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("OrderRateLimit", schema);
