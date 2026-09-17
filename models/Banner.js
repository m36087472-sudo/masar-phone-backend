const mongoose = require("mongoose");

const bannerItemSchema = new mongoose.Schema(
  { url: { type: String, default: "" }, active: { type: Boolean, default: true } },
  { _id: false }
);

const bannerSchema = new mongoose.Schema({
  banners: { type: [bannerItemSchema], default: () => Array.from({ length: 5 }, () => ({ url: "", active: true })) },
}, { timestamps: true });

module.exports = mongoose.model("Banner", bannerSchema);
