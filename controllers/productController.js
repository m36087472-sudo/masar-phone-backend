const Product = require("../models/Product");
const jwt = require("jsonwebtoken");

async function revalidateProducts() {
  try {
    const url = `${process.env.FRONTEND_URL}/api/revalidate?secret=${process.env.REVALIDATE_SECRET}&tag=products`;
    await fetch(url, { method: "POST" });
  } catch { /* non-blocking */ }
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "غير مصرح" });
  }
}

function normalizeArabic(str) {
  return str
    .replace(/[أإآا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

const ALLOWED_FIELDS = [
  "name", "brief", "category", "subCategory", "brand", "color", "storage",
  "network", "screenSize", "description", "deliveryTime",
  "originalPrice", "salePrice", "warrantyYears",
  "freeDelivery", "taxIncluded", "inStock",
  "installment", "specs", "specGroups", "sections", "colors", "variants", "image", "images",
];

function pickAllowed(body) {
  return ALLOWED_FIELDS.reduce((acc, key) => {
    if (body[key] !== undefined) acc[key] = body[key];
    return acc;
  }, {});
}

// Fields for listing/homepage — no description, sections, specGroups, specs
const LIST_PROJECTION = "name brief category subCategory brand color storage originalPrice salePrice warrantyYears freeDelivery taxIncluded inStock status purchasable installment variants image images";

// Trim each variant to only what ProductCard needs:
// - images[0] only (not the full gallery)
// - color, colorCode, defaultStorage, storageOptions kept
// Also trim product.images to [images[0]] since card only uses first image
function slimVariants(products) {
  for (const p of products) {
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        if (Array.isArray(v.images) && v.images.length > 1) {
          v.images = [v.images[0]];
        }
      }
    }
    // keep only first image in the root images array
    if (Array.isArray(p.images) && p.images.length > 1) {
      p.images = [p.images[0]];
    }
  }
  return products;
}

exports.getProducts = async (req, res) => {
  try {
    const { q, brand } = req.query;
    const query = {};
    if (brand) query.brand = { $regex: new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") };
    if (!q) return res.json(slimVariants(await Product.find(query, LIST_PROJECTION).lean()));

    const normalized = normalizeArabic(String(q).slice(0, 100));
    const products = await Product.find(query, LIST_PROJECTION).limit(200).lean();
    const filtered = products.filter((p) =>
      normalizeArabic(p.name).includes(normalized)
    );
    res.json(slimVariants(filtered));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
};

// POST /api/products/verify-cart
// يجيب فقط المنتجات المطلوبة بـ IDs محددة، ويرجع fields خفيفة فقط
exports.verifyCart = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20) {
      return res.status(400).json({ error: "ids غير صحيحة" });
    }
    const products = await Product.find(
      { _id: { $in: ids } },
      "name originalPrice salePrice inStock status purchasable"
    ).lean();
    res.json(products);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
};

exports.updatePurchaseStatus = [requireAdmin, async (req, res) => {
  try {
    const { purchasable } = req.body;
    if (typeof purchasable !== "boolean") {
      return res.status(400).json({ error: "purchasable يجب أن يكون boolean" });
    }
    const status = purchasable ? "AVAILABLE" : "PRE_LAUNCH";
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { purchasable, status } },
      { new: true, select: "name status purchasable" }
    );
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    revalidateProducts();
    res.json({ ok: true, status: product.status, purchasable: product.purchasable });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
}];

exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: "Product not found" });
    // Add virtual fields manually since lean() skips them
    product.price = product.salePrice || product.originalPrice;
    product.discountPercent =
      product.salePrice != null && product.salePrice !== product.originalPrice
        ? Math.round(((product.originalPrice - product.salePrice) / product.originalPrice) * 100)
        : 0;
    res.json(product);
  } catch {
    res.status(404).json({ message: "Product not found" });
  }
};

exports.createProduct = [requireAdmin, async (req, res) => {
  try {
    const data = pickAllowed(req.body);
    const product = await Product.create(data);
    revalidateProducts();
    res.status(201).json(product);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
}];

exports.updateProduct = [requireAdmin, async (req, res) => {
  try {
    const data = pickAllowed(req.body);
    const product = await Product.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!product) return res.status(404).json({ message: "Product not found" });
    revalidateProducts();
    res.json(product);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
}];

exports.deleteProduct = [requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    revalidateProducts();
    res.json({ message: "Product deleted" });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
}];
