const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  { url: { type: String, default: "" }, active: { type: Boolean, default: true } },
  { _id: false }
);

const categoryBannerSchema = new mongoose.Schema({
  category: { type: String, required: true, unique: true },
  banners: { type: [itemSchema], default: () => [{ url: "", active: true }] },
}, { timestamps: true });

module.exports = mongoose.model("CategoryBanner", categoryBannerSchema);
