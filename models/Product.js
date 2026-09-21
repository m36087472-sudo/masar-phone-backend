const mongoose = require("mongoose");
const { SUPPORTED_CURRENCIES } = require("../config/countries");

const SECTION_TYPES = [
  "design", "colors", "camera", "zoom", "low_light", "front_camera",
  "video", "performance", "cooling", "battery", "software", "ai",
  "safety", "accessories", "comparison", "custom",
];

const mediaSub = new mongoose.Schema({
  type:    { type: String, enum: ["image", "video", "poster"], default: "image" },
  url:     { type: String, required: true },
  urlMobile:  String,
  poster:     String,
  alt:        String,
  title:      String,
  sortOrder:  { type: Number, default: 0 },
}, { _id: true });

const sectionSub = new mongoose.Schema({
  type:        { type: String, required: true, enum: [...SECTION_TYPES, "custom"] },
  title:       String,
  subtitle:    String,
  description: String,
  content:     { type: mongoose.Schema.Types.Mixed, default: {} },
  media:       [mediaSub],
  sortOrder:   { type: Number, default: 0 },
  isActive:    { type: Boolean, default: true },
}, { _id: true });

/**
 * Per-country price entry.
 * originalPrice: base (crossed-out) price in the country's currency.
 * salePrice:     actual selling price (null = no discount, show originalPrice).
 * Both stored as exact values entered by admin — no runtime conversion.
 */
const countryPriceSub = new mongoose.Schema(
  {
    currency:      { type: String, required: true, enum: SUPPORTED_CURRENCIES },
    originalPrice: { type: Number, required: true, min: 0 },
    salePrice:     { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

/**
 * Per-country prices for each storage option inside a variant.
 */
const storageCountryPriceSub = new mongoose.Schema(
  {
    currency:      { type: String, required: true, enum: SUPPORTED_CURRENCIES },
    originalPrice: { type: Number, required: true, min: 0 },
    salePrice:     { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    brief: { type: String },
    originalPrice: { type: Number, required: true },
    salePrice: { type: Number },

    /**
     * countryPrices — keyed by currency code (SAR, AED, QAR, KWD, OMR).
     * SAR prices mirror originalPrice/salePrice for consistency.
     * Other currencies are populated by migration or admin input.
     * A missing key means "not available in that country".
     */
    countryPrices: {
      type: Map,
      of: countryPriceSub,
      default: {},
    },
    description: { type: String },
    image: { type: String },
    images: [{ type: String }],
    variants: [
      {
        color: String,
        colorCode: String,
        defaultStorage: String,
        images: [String],
        storageOptions: [
          {
            storage: String,
            ram: String,
            gpu: String,
            chip: String,
            size: String,
            originalPrice: Number,
            salePrice: Number,
            /** Per-country prices for this specific storage SKU */
            countryPrices: {
              type: Map,
              of: storageCountryPriceSub,
              default: {},
            },
          },
        ],
      },
    ],
    color: { type: String },
    storage: { type: String },
    network: { type: String },
    screenSize: { type: String },
    specs: {
      screen: String,
      processor: String,
      ram: String,
      storage: String,
      rearCamera: String,
      frontCamera: String,
      battery: String,
      batteryLife: String,
      charging: String,
      os: String,
      extras: String,
    },
    specGroups: [
      {
        group: { type: String, required: true },
        items: [{ key: String, value: String }],
      },
    ],
    sections: [sectionSub],
    freeDelivery: { type: Boolean, default: true },
    deliveryTime: { type: String, default: "24 ساعة" },
    warrantyYears: { type: Number, default: 2 },
    installment: {
      available: { type: Boolean, default: false },
      downPayment: Number,
      note: String,
      months: Number,
      conditions: [String],
      policy: String,
    },
    taxIncluded: { type: Boolean, default: true },
    category: { type: String },
    subCategory: { type: String },
    brand: { type: String },
    inStock: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["PRE_LAUNCH", "AVAILABLE", "OUT_OF_STOCK"],
      default: "AVAILABLE",
    },
    purchasable: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound indexes — يغطي الـ single-field queries أيضاً
productSchema.index({ createdAt: -1 });
productSchema.index({ category: 1, inStock: 1 });
productSchema.index({ brand: 1, inStock: 1 });
productSchema.index({ category: 1, brand: 1 });
productSchema.index({ subCategory: 1 });

productSchema.virtual("discountPercent").get(function () {
  if (this.salePrice != null && this.salePrice !== this.originalPrice) {
    return Math.round(((this.originalPrice - this.salePrice) / this.originalPrice) * 100);
  }
  return 0;
});

productSchema.virtual("price").get(function () {
  return this.salePrice || this.originalPrice;
});

module.exports = mongoose.model("Product", productSchema);
