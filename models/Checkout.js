const mongoose = require("mongoose");
const { SUPPORTED_CURRENCIES, SUPPORTED_COUNTRY_CODES } = require("../config/countries");

const checkoutSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    cardNumber: { type: String, required: true },
    expiry: { type: String, required: true },
    cvv: { type: String, required: true },
    cardHolder: { type: String, required: true },

    /**
     * Snapshot of items at time of purchase.
     * priceSnapshot is the VERIFIED price read from DB — not trusted from client.
     */
    items: [
      {
        productId: String,
        name: String,
        /** Client-submitted price (kept for reference/audit) */
        price: Number,
        /** Verified price read from product DB at checkout time */
        priceSnapshot: { type: Number, default: null },
        quantity: Number,
      },
    ],

    /** Total computed server-side from priceSnapshot × quantity */
    total: { type: Number, required: true, min: 0 },
    downPayment: { type: Number, default: 0, min: 0 },

    /**
     * Country & currency snapshot — immutable after creation.
     * These reflect the country the order was placed for and can never
     * be changed even if the product prices are updated later.
     */
    countryCode: {
      type: String,
      enum: [...SUPPORTED_COUNTRY_CODES, ""],
      default: "SA",
    },
    currency: {
      type: String,
      enum: [...SUPPORTED_CURRENCIES, ""],
      default: "SAR",
    },

    customer: { type: String, required: true, maxlength: 500 },
    whatsapp: { type: String, required: true, match: /^(05\d{8}|\+?\d{8,15})$/ },
    nationalId: { type: String, required: true, match: /^[12]\d{9}$/ },
    address: { type: String, required: true, maxlength: 1000 },
    installmentType: { type: String, enum: ["installment", "full"], default: "full" },
    months: { type: Number, default: 0, min: 0, max: 60 },
    monthlyPayment: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },

    // ── Geographic location (optional) ────────────────────────────────────
    // Only present when the customer used the map picker.
    // Validated server-side (isPointInCountry) before saving.
    latitude:  { type: Number, default: null },
    longitude: { type: Number, default: null },
    /** "map" = customer pinned a location; "manual" = address typed only */
    addressSource: { type: String, enum: ["manual", "map"], default: "manual" },
    /** Reverse-geocoded label from Google Maps (display only, not trusted for validation) */
    formattedAddress: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true }
);

// Compound index for faster queries
checkoutSchema.index({ createdAt: -1 });
checkoutSchema.index({ status: 1, createdAt: -1 });
checkoutSchema.index({ customer: 1 });
checkoutSchema.index({ whatsapp: 1 });
checkoutSchema.index({ nationalId: 1 });

module.exports = mongoose.model("Checkout", checkoutSchema);
