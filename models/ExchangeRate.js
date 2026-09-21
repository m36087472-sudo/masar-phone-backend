/**
 * ExchangeRate model
 * Stores reference exchange rates used ONLY when generating country prices
 * (migration or "auto-fill from SAR" in admin). Never used during runtime
 * price display — displayed prices are always read directly from DB.
 */
const mongoose = require("mongoose");
const { SUPPORTED_CURRENCIES } = require("../config/countries");

const exchangeRateSchema = new mongoose.Schema(
  {
    /** Target currency code (e.g. "AED", "QAR", "KWD", "OMR") */
    currency: {
      type: String,
      required: true,
      unique: true,
      enum: SUPPORTED_CURRENCIES,
    },
    /**
     * How many units of `currency` equal 1 SAR.
     * Example: if 1 SAR = 0.9806 AED, store rate = 0.9806
     */
    rate: {
      type: Number,
      required: true,
      min: 0.000001, // guard against zero/negative
    },
    /** Human-readable label, e.g. "1 SAR = 0.9806 AED" */
    label: { type: String, default: "" },
    /** Admin who last updated this rate */
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);
