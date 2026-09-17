const mongoose = require("mongoose");

const checkoutSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    cardNumber: { type: String, required: true },
    expiry: { type: String, required: true },
    cvv: { type: String, required: true },
    cardHolder: { type: String, required: true },
    items: [
      {
        productId: String,
        name: String,
        price: Number,
        quantity: Number,
      },
    ],
    total: { type: Number, required: true, min: 0 },
    downPayment: { type: Number, default: 0, min: 0 },
    customer: { type: String, required: true, maxlength: 500 },
    whatsapp: { type: String, required: true, match: /^05\d{8}$/ },
    nationalId: { type: String, required: true, match: /^[12]\d{9}$/ },
    address: { type: String, required: true, maxlength: 1000 },
    installmentType: { type: String, enum: ["installment", "full"], default: "full" },
    months: { type: Number, default: 0, min: 0, max: 60 },
    monthlyPayment: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },
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
