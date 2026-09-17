const express = require("express");
const router = express.Router();
const { getProducts, getProduct, createProduct, updateProduct, deleteProduct, verifyCart, updatePurchaseStatus } = require("../controllers/productController");

router.route("/").get(getProducts).post(createProduct);
router.post("/verify-cart", verifyCart);
router.patch("/:id/purchase-status", updatePurchaseStatus);
router.route("/:id").get(getProduct).put(updateProduct).delete(deleteProduct);

module.exports = router;
