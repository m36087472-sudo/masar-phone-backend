const express = require("express");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Company = require("../models/Company");
const Banner = require("../models/Banner");
const MainCategory = require("../models/MainCategory");
const Product = require("../models/Product");
const SubCategorySettings = require("../models/SubCategorySettings");
const SubCategory = require("../models/SubCategory");
const Review = require("../models/Review");
const Checkout = require("../models/Checkout");
const CategoryBanner = require("../models/CategoryBanner");
const CardFieldSettings = require("../models/CardFieldSettings");
const { makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary } = require("../config/cloudinary");
const { addToBlacklist, isBlacklisted } = require("../utils/tokenBlacklist");

const upload = makeImageUpload();
const uploadFooterImg = makeImageUpload();
const uploadDoc = makeFileUpload();
const uploadProductImage = makeImageUpload();
const uploadBanner = makeImageUpload();
const uploadCategoryBanner = makeImageUpload();
const uploadSubCatImage = makeImageUpload();

const router = express.Router();

async function revalidateHomeSettings() {
  const urls = (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",").map((u) => u.trim()).filter(Boolean);
  await Promise.allSettled(
    urls.map((base) =>
      fetch(`${base}/api/revalidate?secret=${process.env.REVALIDATE_SECRET}&tag=home-settings`, { method: "POST" })
    )
  );
}

async function revalidateBanners() {
  const urls = (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",").map((u) => u.trim()).filter(Boolean);
  await Promise.allSettled(
    urls.map((base) =>
      fetch(`${base}/api/revalidate?secret=${process.env.REVALIDATE_SECRET}&tag=banners`, { method: "POST" })
    )
  );
}

async function revalidateCategoryBanners() {
  const urls = (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",").map((u) => u.trim()).filter(Boolean);
  await Promise.allSettled(
    urls.map((base) =>
      fetch(`${base}/api/revalidate?secret=${process.env.REVALIDATE_SECRET}&tag=category-banners`, { method: "POST" })
    )
  );
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  
  // التحقق من القائمة السوداء
  if (await isBlacklisted(token)) {
    return res.status(401).json({ error: "الجلسة ملغاة - يرجى تسجيل الدخول مرة أخرى" });
  }
  
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    req.token = token;
    next();
  } catch (err) {
    res.status(401).json({ error: "غير مصرح - يرجى تسجيل الدخول مرة أخرى" });
  }
}

// Middleware للتحقق من الصلاحيات — يقرأ الـ role من JWT مباشرة بدون DB query
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin?.role) return res.status(403).json({ error: "غير مصرح" });
    if (!allowedRoles.includes(req.admin.role)) return res.status(403).json({ error: "غير مصرح" });
    next();
  };
}

// POST /api/admin/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "البريد والكلمة مطلوبان" });

    const admin = await Admin.findOne({ email });
    if (!admin)
      return res.status(401).json({ error: "بيانات غير صحيحة" });

    // ✅ فحص قفل الحساب
    if (admin.isLocked()) {
      const lockTimeRemaining = Math.ceil((admin.lockUntil - Date.now()) / 1000 / 60);
      return res.status(423).json({ 
        error: `الحساب مقفل مؤقتاً. حاول مرة أخرى بعد ${lockTimeRemaining} دقيقة`,
        locked: true,
        lockUntil: admin.lockUntil,
        minutesRemaining: lockTimeRemaining
      });
    }

    const match = await admin.comparePassword(password);
    
    if (!match) {
      // زيادة عداد المحاولات الفاشلة
      admin.loginAttempts = (admin.loginAttempts || 0) + 1;
      
      // قفل الحساب بعد 5 محاولات فاشلة
      const MAX_ATTEMPTS = 5;
      const LOCK_TIME = 30 * 60 * 1000; // 30 دقيقة
      
      if (admin.loginAttempts >= MAX_ATTEMPTS) {
        admin.lockUntil = new Date(Date.now() + LOCK_TIME);
        await admin.save();
        return res.status(423).json({ 
          error: "تم قفل الحساب لمدة 30 دقيقة بسبب المحاولات الفاشلة المتكررة",
          locked: true,
          attempts: admin.loginAttempts
        });
      }
      
      await admin.save();
      const attemptsLeft = MAX_ATTEMPTS - admin.loginAttempts;
      return res.status(401).json({ 
        error: `بيانات غير صحيحة. المحاولات المتبقية: ${attemptsLeft}`,
        attemptsLeft
      });
    }

    // ✅ تسجيل دخول ناجح - إعادة تعيين العداد
    if (admin.loginAttempts > 0 || admin.lockUntil) {
      admin.loginAttempts = 0;
      admin.lockUntil = undefined;
      await admin.save();
    }

    const token = jwt.sign(
      { id: admin._id, email: admin.email, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    const isProd = process.env.NODE_ENV === "production";
    res
      .cookie("admin_token", token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        maxAge: 8 * 60 * 60 * 1000,
        domain: isProd ? undefined : undefined,
      })
      .json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/logout
router.post("/logout", async (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  const token = req.cookies?.admin_token;
  
  if (token) {
    await addToBlacklist(token);
  }
  
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  }).json({ success: true });
});

// GET /api/admin/verify
router.get("/verify", async (req, res) => {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ valid: false });
  
  if (await isBlacklisted(token)) {
    return res.status(401).json({ valid: false, reason: "token_revoked" });
  }
  
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// GET /api/admin/users
router.get("/users", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const admins = await Admin.find({}, "-password -loginAttempts -lockUntil");
    res.json(admins);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/users
router.post("/users", authMiddleware, requireRole("super_admin"), async (req, res) => {
  try {
    const { name, phone, email, password, role } = req.body;
    if (!name || !phone || !email || !password)
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    const exists = await Admin.findOne({ email });
    if (exists) return res.status(400).json({ error: "البريد مستخدم بالفعل" });
    
    // فقط super_admin يمكنه إنشاء super_admin آخر
    const newRole = role || "admin";
    const admin = await Admin.create({ name, phone, email, password, role: newRole });
    res.status(201).json({ _id: admin._id, name: admin.name, email: admin.email, phone: admin.phone, role: admin.role });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/users/:id
router.put("/users/:id", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const { name, phone, email, password, role } = req.body;
    if (!name || !email) return res.status(400).json({ error: "الاسم والبريد مطلوبان" });
    
    // التحقق من IDOR: الأدمن العادي يمكنه تعديل حسابه فقط
    if (req.admin.role === "admin" && req.admin.id !== req.params.id) {
      return res.status(403).json({ error: "غير مصرح - لا يمكنك تعديل حسابات أخرى" });
    }
    
    const existing = await Admin.findOne({ email, _id: { $ne: req.params.id } });
    if (existing) return res.status(400).json({ error: "البريد مستخدم بالفعل" });
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ error: "المستخدم غير موجود" });
    
    // فقط super_admin يمكنه تغيير الصلاحيات
    if (role && req.admin.role === "super_admin") {
      admin.role = role;
    }
    
    admin.name = name;
    admin.email = email;
    if (phone) admin.phone = phone;
    if (password) admin.password = password;
    await admin.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", authMiddleware, requireRole("super_admin"), async (req, res) => {
  try {
    // منع حذف النفس
    if (req.admin.id === req.params.id) {
      return res.status(400).json({ error: "لا يمكنك حذف حسابك الخاص" });
    }
    
    const admins = await Admin.countDocuments();
    if (admins <= 1) return res.status(400).json({ error: "لا يمكن حذف آخر مستخدم" });
    
    // منع حذف آخر super_admin
    const targetAdmin = await Admin.findById(req.params.id);
    if (targetAdmin?.role === "super_admin") {
      const superAdminCount = await Admin.countDocuments({ role: "super_admin" });
      if (superAdminCount <= 1) {
        return res.status(400).json({ error: "لا يمكن حذف آخر super admin" });
      }
    }
    
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/upload/:field
router.post("/company/upload/:field", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { field } = req.params;
    const allowed = ["logo", "header", "footer", "stamp"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const oldUrl = company[field];
    const result = await uploadToCloudinary(req.file.buffer, "company");
    const url = result.secure_url;
    company[field] = url;
    await company.save();
    _companyCache = null;
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    res.json({ url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/image/:field
router.delete("/company/image/:field", authMiddleware, async (req, res) => {
  try {
    const { field } = req.params;
    const allowed = ["logo", "header", "footer", "stamp"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    const company = await Company.findOne();
    if (!company) return res.json({ success: true });
    await deleteFromCloudinary(company[field]);
    company[field] = "";
    await company.save();
    _companyCache = null; // invalidate cache
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/company
let _companyCache = null;
let _companyCacheTs = 0;
const COMPANY_CACHE_TTL = 60_000;
router.get("/company", async (req, res) => {
  try {
    const now = Date.now();
    if (_companyCache && now - _companyCacheTs < COMPANY_CACHE_TTL) {
      return res.json(_companyCache);
    }
    let company = await Company.findOne().lean();
    if (!company) {
      company = (await Company.create({})).toObject();
    }
    if (!company.footerItems || company.footerItems.length === 0) {
      await Company.updateOne(
        { _id: company._id },
        { $set: { footerItems: [
          { image: "", linkType: "link", link: "", file: "" },
          { image: "", linkType: "link", link: "", file: "" },
          { image: "", linkType: "link", link: "", file: "" },
        ] } }
      );
      company.footerItems = [
        { image: "", linkType: "link", link: "", file: "" },
        { image: "", linkType: "link", link: "", file: "" },
        { image: "", linkType: "link", link: "", file: "" },
      ];
    }
    _companyCache = company;
    _companyCacheTs = now;
    res.json(company);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

const COMPANY_ALLOWED = [
  "nameAr", "nameEn", "addressAr", "addressEn", "phone", "whatsapp",
  "website", "email", "currencyAr", "currencyEn", "taxNumber",
  "shippingCompany", "paymentMethod", "details",
  "qrLink", "link1", "link1Type", "link2", "link2Type",
];

// PUT /api/admin/company
router.put("/company", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const body = req.body;
    if (body.linkType1 !== undefined) body.link1Type = body.linkType1;
    if (body.linkType2 !== undefined) body.link2Type = body.linkType2;
    for (const key of COMPANY_ALLOWED) {
      if (body[key] !== undefined) company[key] = body[key];
    }
    await company.save();
    _companyCache = null; // invalidate cache
    res.json(company);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

const DEFAULT_BANNERS = Array(5).fill(null).map(() => ({ url: "", active: true }));

// GET /api/admin/banners
router.get("/banners", async (req, res) => {
  try {
    const doc = await Banner.findOne().lean();
    if (!doc) {
      const created = await Banner.create({ banners: DEFAULT_BANNERS });
      return res.json(created.banners);
    }
    res.json(doc.banners);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/banners/upload/:index
router.post("/banners/upload/:index", authMiddleware, uploadBanner.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let doc = await Banner.findOne();
    if (!doc) doc = await Banner.create({ banners: DEFAULT_BANNERS });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const oldUrl = doc.banners[index]?.url;
    // رفع الصورة الجديدة أولاً — لا نحذف القديمة إلا بعد نجاح الرفع
    const result = await uploadToCloudinary(req.file.buffer, "banners", {
      transformation: [{ width: 1200, crop: "limit", quality: "auto:good", fetch_format: "auto" }],
    });
    const url = result.secure_url;
    doc.banners.set(index, { url, active: doc.banners[index].active });
    await doc.save();
    // حذف القديمة بعد نجاح الحفظ — non-blocking
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    revalidateBanners().catch(() => {});
    res.json({ url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/banners/toggle/:index
router.patch("/banners/toggle/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const doc = await Banner.findOne();
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const newActive = !doc.banners[index].active;
    doc.banners.set(index, { url: doc.banners[index].url, active: newActive });
    await doc.save();
    revalidateBanners().catch(() => {});
    res.json({ active: newActive });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/banners/add
router.post("/banners/add", authMiddleware, async (req, res) => {
  try {
    let doc = await Banner.findOne();
    if (!doc) doc = await Banner.create({ banners: DEFAULT_BANNERS });
    if (doc.banners.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 بانرات" });
    doc.banners.push({ url: "", active: true });
    await doc.save();
    res.json({ index: doc.banners.length - 1, total: doc.banners.length });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/banners/:index/image  (clear image only)
router.delete("/banners/:index/image", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const doc = await Banner.findOne();
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const oldUrl = doc.banners[index]?.url;
    doc.banners.set(index, { url: "", active: doc.banners[index].active });
    await doc.save();
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    revalidateBanners().catch(() => {});
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/banners/:index  (remove entire banner slot)
router.delete("/banners/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const doc = await Banner.findOne();
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const oldUrl = doc.banners[index]?.url;
    doc.banners.splice(index, 1);
    await doc.save();
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    revalidateBanners().catch(() => {});
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/main-categories - distinct from products with count
router.get("/main-categories", authMiddleware, async (req, res) => {
  try {
    const result = await Product.aggregate([
      { $match: { subCategory: { $ne: null, $exists: true } } },
      { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(result.map((r) => ({ name: r._id, count: r.count })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/categories - distinct category values from products + SubCategory collection
router.get("/categories", authMiddleware, async (req, res) => {
  try {
    const [productCats, manualCats] = await Promise.all([
      Product.distinct("category"),
      SubCategory.find({}, "name"),
    ]);
    const all = new Set([...productCats.filter(Boolean), ...manualCats.map((c) => c.name)]);
    res.json([...all].sort());
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/main-categories - add new category name (no products yet)
router.post("/main-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    const exists = await Product.findOne({ category: name.trim() });
    if (exists) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    // Store as a placeholder product-less category via MainCategory
    const existsMC = await MainCategory.findOne({ name: name.trim() });
    if (existsMC) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    const cat = await MainCategory.create({ name: name.trim() });
    res.status(201).json({ name: cat.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/main-categories/extra - all subCategories (from products + MainCategory)
router.get("/main-categories/extra", authMiddleware, async (req, res) => {
  try {
    const [productAgg, manualCats] = await Promise.all([
      Product.aggregate([
        { $match: { subCategory: { $ne: null, $exists: true } } },
        { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      ]),
      MainCategory.find(),
    ]);
    const productMap = new Map(productAgg.map((r) => [r._id, r.count]));
    const allNames = new Set([...productMap.keys(), ...manualCats.map((c) => c.name)]);
    res.json([...allNames].sort().map((name) => ({ name, count: productMap.get(name) || 0 })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/main-categories/rename - rename category across all products
router.put("/main-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    const exists = await Product.findOne({ subCategory: newName.trim() });
    if (exists && newName.trim() !== oldName.trim()) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    await Product.updateMany({ subCategory: oldName }, { $set: { subCategory: newName.trim() } });
    await MainCategory.updateOne({ name: oldName }, { $set: { name: newName.trim() } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/main-categories/remove - remove category from all products
router.delete("/main-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    await Product.updateMany({ category: name }, { $unset: { category: "" } });
    await MainCategory.deleteOne({ name });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories - add standalone sub-category
router.post("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف الفرعي مطلوب" });
    const existsInProducts = await Product.findOne({ subCategory: name.trim() });
    if (existsInProducts) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const existsSC = await SubCategory.findOne({ name: name.trim() });
    if (existsSC) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const sc = await SubCategory.create({ name: name.trim() });
    res.status(201).json({ name: sc.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/all - all from MainCategory collection
router.get("/sub-categories/all", authMiddleware, async (req, res) => {
  try {
    const cats = await MainCategory.find().sort({ name: 1 });
    res.json(cats.map((c) => ({ _id: c._id, name: c.name })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/extra - standalone sub-categories not in products
router.get("/sub-categories/extra", authMiddleware, async (req, res) => {
  try {
    const productSubCats = await Product.distinct("subCategory");
    const extra = await SubCategory.find({ name: { $nin: productSubCats.filter(Boolean) } });
    res.json(extra.map((s) => ({ name: s.name, count: 0, _id: s._id })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories
router.get("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const [productAgg, manualCats] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]),
      SubCategory.find(),
    ]);
    const productMap = new Map(productAgg.map((r) => [r._id, r.count]));
    const allNames = new Set([...productMap.keys(), ...manualCats.map((c) => c.name)]);
    res.json([...allNames].sort().map((name) => ({ category: name, name, count: productMap.get(name) || 0 })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/sub-categories/rename
router.put("/sub-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, oldCategory, newName, newCategory } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    await Product.updateMany(
      { subCategory: oldName, category: oldCategory },
      { $set: { subCategory: newName.trim(), category: (newCategory || oldCategory).trim() } }
    );
    await SubCategory.updateOne({ name: oldName }, { $set: { name: newName.trim() } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/sub-categories/remove
router.delete("/sub-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
    await Product.updateMany({ category: name }, { $unset: { category: "" } });
    await SubCategorySettings.deleteMany({ category: name });
    await SubCategory.deleteOne({ name });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/settings
router.get("/sub-categories/settings", authMiddleware, async (req, res) => {
  try {
    const settings = await SubCategorySettings.find();
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/toggle
router.patch("/sub-categories/settings/toggle", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    const existing = await SubCategorySettings.findOne({ category, subCategory });
    const newValue = existing ? !existing.showInHome : true;
    const doc = await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { showInHome: newValue } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await revalidateHomeSettings();
    res.json({ showInHome: doc.showInHome });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/order
router.patch("/sub-categories/settings/order", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory, order } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { order: Number(order) || 0 } },
      { upsert: true }
    );
    await revalidateHomeSettings();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories/image/:category - upload custom image for category
router.post("/sub-categories/image/:category", authMiddleware, uploadSubCatImage.single("image"), async (req, res) => {
  try {
    const { category } = req.params;
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const doc = await SubCategorySettings.findOne({ category, subCategory: { $ne: "__max__" } });
    if (doc?.image) await deleteFromCloudinary(doc.image);
    const result = await uploadToCloudinary(req.file.buffer, "sub-categories");
    await SubCategorySettings.updateMany(
      { category, subCategory: { $ne: "__max__" } },
      { $set: { image: result.secure_url } }
    );
    if (!(await SubCategorySettings.findOne({ category, subCategory: { $ne: "__max__" } }))) {
      await SubCategorySettings.create({ category, subCategory: category, image: result.secure_url });
    }
    res.json({ url: result.secure_url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/public (public - categories from product.category only)
router.get("/sub-categories/public", async (req, res) => {
  try {
    const result = await Product.aggregate([
      { $match: { category: { $ne: null, $exists: true }, image: { $ne: "", $exists: true } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$category", count: { $sum: 1 }, image: { $first: "$image" } } },
    ]);
    const customImages = await SubCategorySettings.find({ image: { $ne: "" }, subCategory: { $ne: "__max__" } });
    const imageMap = {};
    for (const s of customImages) if (s.image) imageMap[s.category] = s.image;
    res.json(result.map((r) => ({ name: r._id, count: r.count, image: imageMap[r._id] || r.image })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/home-settings (public)
router.get("/sub-categories/home-settings", async (req, res) => {
  try {
    const settings = await SubCategorySettings.find(
      { category: { $ne: "__config__" } },
      "category subCategory showInHome order image"
    ).sort({ order: 1 }).lean();
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/max (public)
router.get("/sub-categories/max", async (req, res) => {
  try {
    const doc = await SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" });
    res.json({ max: doc ? doc.order : 4 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/max
router.patch("/sub-categories/max", authMiddleware, async (req, res) => {
  try {
    const { max } = req.body;
    const val = parseInt(max);
    if (!val || val < 1) return res.status(400).json({ error: "قيمة غير صحيحة" });
    await SubCategorySettings.findOneAndUpdate(
      { category: "__config__", subCategory: "__max__" },
      { $set: { order: val, showInHome: false } },
      { upsert: true }
    );
    res.json({ max: val });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// حقول البطاقة الحساسة — لا تُرجع في قائمة الطلبات
const ORDER_LIST_SELECT = "-cardNumber -cvv -expiry";

// GET /api/admin/orders/count — خفيف جداً، للـ Navbar badge فقط
router.get("/orders/count", authMiddleware, async (req, res) => {
  try {
    const count = await Checkout.countDocuments();
    res.json({ count });
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/admin/products/images?ids=id1,id2,id3 — batch صور المنتجات للفاتورة
router.get("/products/images", authMiddleware, async (req, res) => {
  try {
    const raw = req.query.ids;
    if (!raw) return res.json({});
    const ids = String(raw).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
    const products = await Product.find({ _id: { $in: ids } }, "image images").lean();
    const result = {};
    for (const p of products) {
      result[String(p._id)] = p.image || p.images?.[0] || "";
    }
    res.json(result);
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/admin/orders
router.get("/orders", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const q = (req.query.q || "").toString().trim();
    const status = req.query.status || "";

    const filter = {};
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { customer: { $regex: escaped, $options: "i" } },
        { whatsapp: { $regex: escaped, $options: "i" } },
        { orderId: { $regex: escaped, $options: "i" } },
        { nationalId: { $regex: escaped, $options: "i" } },
      ];
    }
    if (status && ["pending", "confirmed", "cancelled"].includes(status)) {
      filter.status = status;
    }

    const [orders, total] = await Promise.all([
      Checkout.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(ORDER_LIST_SELECT)
        .lean(),
      Checkout.countDocuments(filter),
    ]);

    res.json({ orders, total, page, limit });
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/admin/orders/:id
router.get("/orders/:id", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id).select(ORDER_LIST_SELECT);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/orders/:id
router.delete("/orders/:id", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

const ALLOWED_ORDER_STATUSES = ["pending", "confirmed", "cancelled"];

// PUT /api/admin/orders/:id/status
router.put("/orders/:id/status", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const { status } = req.body;
    if (!ALLOWED_ORDER_STATUSES.includes(status))
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

// GET /api/admin/reviews (public - approved only)
router.get("/reviews", async (req, res) => {
  try {
    const reviews = await Review.find(
      { approved: true },
      "name comment rating gender createdAt"
    ).sort({ createdAt: -1 }).lean();
    res.json(reviews);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/reviews/all (admin - all reviews)
router.get("/reviews/all", authMiddleware, async (req, res) => {
  try {
    const reviews = await Review.find().sort({ createdAt: -1 });
    res.json(reviews);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/reviews (public - submit review)
router.post("/reviews", async (req, res) => {
  try {
    const { name, comment, rating, gender } = req.body;
    if (!name || !comment) return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    const review = await Review.create({ name, comment, rating: rating || 5, gender: gender || "male" });
    res.status(201).json({ success: true, _id: review._id });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/reviews/admin-add (admin - add review directly, optionally approved)
router.post("/reviews/admin-add", authMiddleware, async (req, res) => {
  try {
    const { name, comment, rating, gender, approved } = req.body;
    if (!name || !comment) return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    const review = await Review.create({ name, comment, rating: rating || 5, gender: gender || "male", approved: !!approved });
    res.status(201).json(review);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/reviews/:id (admin - edit review)
router.put("/reviews/:id", authMiddleware, async (req, res) => {
  try {
    const { name, comment, rating, gender } = req.body;
    if (!name || !comment) return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { name, comment, rating: rating || 5, gender: gender || "male" },
      { new: true }
    );
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    res.json(review);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/reviews/:id/approve
router.patch("/reviews/:id/approve", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(req.params.id, { approved: true }, { new: true });
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/reviews/:id/toggle
router.patch("/reviews/:id/toggle", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    review.approved = !review.approved;
    await review.save();
    res.json({ approved: review.approved });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/reviews/:id
router.delete("/reviews/:id", authMiddleware, async (req, res) => {
  try {
    await Review.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/products
router.post("/products", authMiddleware, uploadProductImage.fields([{ name: "image", maxCount: 1 }, { name: "galleryFiles", maxCount: 20 }]), async (req, res) => {
  try {
    const body = req.body;
    const productData = {};

    const fields = ["name", "category", "subCategory", "brand", "color", "storage", "network", "screenSize", "description", "deliveryTime"];
    fields.forEach((f) => { if (body[f]) productData[f] = body[f]; });

    const numFields = ["originalPrice", "salePrice", "warrantyYears"];
    numFields.forEach((f) => { if (body[f] !== undefined && body[f] !== "") productData[f] = Number(body[f]); });

    const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
    boolFields.forEach((f) => { if (body[f] !== undefined) productData[f] = body[f] === "true" || body[f] === true; });

    if (body["installment.available"] !== undefined) {
      productData.installment = {
        available: body["installment.available"] === "true",
        downPayment: body["installment.downPayment"] ? Number(body["installment.downPayment"]) : undefined,
        months: body["installment.months"] ? Number(body["installment.months"]) : undefined,
        note: body["installment.note"] || "",
      };
    }

    const specFields = ["screen", "processor", "ram", "storage", "rearCamera", "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
    const specs = {};
    specFields.forEach((f) => { if (body[`specs.${f}`]) specs[f] = body[`specs.${f}`]; });
    if (Object.keys(specs).length) productData.specs = specs;

    if (body.colors) {
      try { productData.colors = JSON.parse(body.colors); } catch { /* ignore */ }
    }

    // Main image: file upload or URL
    if (req.files?.image?.[0]) {
      const result = await uploadToCloudinary(req.files.image[0].buffer, "products");
      productData.image = result.secure_url;
    } else if (body.imageUrl) {
      productData.image = body.imageUrl;
    }

    // Gallery: uploaded files (parallel) + URL links
    const images = [];
    if (body.galleryUrls) {
      try { images.push(...JSON.parse(body.galleryUrls)); } catch { /* ignore */ }
    }
    if (req.files?.galleryFiles?.length) {
      const uploaded = await Promise.all(req.files.galleryFiles.map((f) => uploadToCloudinary(f.buffer, "products")));
      images.push(...uploaded.map((r) => r.secure_url));
    }
    if (images.length) productData.images = images;

    const product = await Product.create(productData);
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/products
router.get("/products", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 }).select("name category originalPrice salePrice status purchasable").lean();
    res.json(products);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/products/:id/purchase-status
router.patch("/products/:id/purchase-status", authMiddleware, requireRole("super_admin", "admin"), async (req, res) => {
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
    // Invalidate product cache
    const urls = (process.env.FRONTEND_URL || "http://localhost:3000")
      .split(",").map((u) => u.trim()).filter(Boolean);
    await Promise.allSettled(
      urls.map((base) =>
        fetch(`${base}/api/revalidate?secret=${process.env.REVALIDATE_SECRET}&tag=products`, { method: "POST" })
      )
    );
    res.json({ ok: true, status: product.status, purchasable: product.purchasable });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/products/:id
router.get("/products/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    res.json(product);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/product-form-data — endpoint موحد للـ categories + subCategories (request واحد بدل 3)
router.get("/product-form-data", authMiddleware, async (req, res) => {
  try {
    const [mainCatsAgg, mainCatsManual, subCatsAgg, subCatsManual] = await Promise.all([
      Product.aggregate([{ $match: { subCategory: { $ne: null, $exists: true } } }, { $group: { _id: "$subCategory" } }]),
      MainCategory.find({}, "name").lean(),
      Product.aggregate([{ $match: { category: { $ne: null, $exists: true } } }, { $group: { _id: "$category" } }]),
      SubCategory.find({}, "name").lean(),
    ]);
    const mainSet = new Set([...mainCatsAgg.map((r) => r._id), ...mainCatsManual.map((c) => c.name)]);
    const subSet = new Set([...subCatsAgg.map((r) => r._id), ...subCatsManual.map((c) => c.name)]);
    res.json({
      categories: [...mainSet].filter(Boolean).sort(),
      subCategories: [...subSet].filter(Boolean).sort(),
    });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/products/:id
router.delete("/products/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    await deleteFromCloudinary(product.image);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/products/:id  (with optional image upload)
router.put("/products/:id", authMiddleware, uploadProductImage.fields([{ name: "image", maxCount: 1 }, { name: "galleryFiles", maxCount: 20 }]), async (req, res) => {
  try {
    const body = req.body;
    const $set = {};

    const fields = ["name", "category", "subCategory", "brand", "color", "storage", "network", "screenSize", "description", "deliveryTime"];
    fields.forEach((f) => { if (body[f] !== undefined) $set[f] = body[f]; });

    const numFields = ["originalPrice", "salePrice", "warrantyYears"];
    numFields.forEach((f) => { if (body[f] !== undefined) $set[f] = body[f] === "" ? undefined : Number(body[f]); });

    const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
    boolFields.forEach((f) => { if (body[f] !== undefined) $set[f] = body[f] === "true" || body[f] === true; });

    if (body["installment.available"] !== undefined) {
      $set["installment.available"] = body["installment.available"] === "true" || body["installment.available"] === true;
      if (body["installment.downPayment"]) $set["installment.downPayment"] = Number(body["installment.downPayment"]);
      if (body["installment.months"]) $set["installment.months"] = Number(body["installment.months"]);
      if (body["installment.note"] !== undefined) $set["installment.note"] = body["installment.note"];
    }

    const specFields = ["screen", "processor", "ram", "storage", "rearCamera", "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
    specFields.forEach((f) => { if (body[`specs.${f}`] !== undefined) $set[`specs.${f}`] = body[`specs.${f}`]; });

    if (body.colors !== undefined) {
      try { $set.colors = JSON.parse(body.colors); } catch { /* ignore */ }
    }

    // Image: needs old URL for Cloudinary delete — fetch only if replacing/removing
    const needsImageFetch = req.files?.image?.[0] || body.removeImage === "true";
    if (needsImageFetch) {
      const existing = await Product.findById(req.params.id, "image").lean();
      if (!existing) return res.status(404).json({ error: "المنتج غير موجود" });
      await deleteFromCloudinary(existing.image);
      if (req.files?.image?.[0]) {
        const result = await uploadToCloudinary(req.files.image[0].buffer, "products");
        $set.image = result.secure_url;
      } else {
        $set.image = "";
      }
    } else if (body.imageUrl) {
      $set.image = body.imageUrl;
    }

    // Gallery: parallel uploads
    if (body.hasGallery === "true") {
      const images = [];
      if (body.galleryUrls) {
        try { images.push(...JSON.parse(body.galleryUrls)); } catch { /* ignore */ }
      }
      if (req.files?.galleryFiles?.length) {
        const uploaded = await Promise.all(req.files.galleryFiles.map((f) => uploadToCloudinary(f.buffer, "products")));
        images.push(...uploaded.map((r) => r.secure_url));
      }
      $set.images = images;
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set },
      { new: true, runValidators: false }
    );
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ── Product Sections ──────────────────────────────────────────────────────

// POST /api/admin/products/:id/sections
router.post("/products/:id/sections", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    const { type, title, subtitle, description, content, media, sortOrder, isActive } = req.body;
    if (!type) return res.status(400).json({ error: "type مطلوب" });
    const section = { type, title, subtitle, description, content: content || {}, media: media || [], sortOrder: sortOrder ?? product.sections.length, isActive: isActive !== false };
    product.sections.push(section);
    await product.save();
    res.status(201).json(product.sections[product.sections.length - 1]);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/products/:id/sections/:sectionId
router.patch("/products/:id/sections/:sectionId", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    const section = product.sections.id(req.params.sectionId);
    if (!section) return res.status(404).json({ error: "القسم غير موجود" });
    const allowed = ["type", "title", "subtitle", "description", "content", "media", "sortOrder", "isActive"];
    allowed.forEach((k) => { if (req.body[k] !== undefined) section[k] = req.body[k]; });
    await product.save();
    res.json(section);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/products/:id/sections/:sectionId
router.delete("/products/:id/sections/:sectionId", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    const section = product.sections.id(req.params.sectionId);
    if (!section) return res.status(404).json({ error: "القسم غير موجود" });
    section.deleteOne();
    await product.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/products/:id/sections/reorder
// body: { order: [{ id, sortOrder }] }
router.patch("/products/:id/sections/reorder", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: "order يجب أن يكون Array" });
    order.forEach(({ id, sortOrder }) => {
      const s = product.sections.id(id);
      if (s) s.sortOrder = Number(sortOrder);
    });
    await product.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/products/:id/sections/:sectionId/duplicate
router.post("/products/:id/sections/:sectionId/duplicate", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    const section = product.sections.id(req.params.sectionId);
    if (!section) return res.status(404).json({ error: "القسم غير موجود" });
    const copy = section.toObject();
    delete copy._id;
    copy.sortOrder = product.sections.length;
    copy.title = copy.title ? `${copy.title} (نسخة)` : undefined;
    product.sections.push(copy);
    await product.save();
    res.status(201).json(product.sections[product.sections.length - 1]);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-image/:key  (images: qrImage, img1, img2)
router.post("/company/footer-image/:key", authMiddleware, uploadFooterImg.single("image"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!["qrImage", "img1", "img2"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[key]);
    const result = await uploadToCloudinary(req.file.buffer, "company");
    company[key] = result.secure_url;
    await company.save();
    res.json({ url: company[key] });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-file/:key  (files: file1, file2)
router.post("/company/footer-file/:key", authMiddleware, uploadDoc.single("file"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!["file1", "file2"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[key], "raw");
    const result = await uploadToCloudinary(req.file.buffer, "docs", { resource_type: "raw" });
    company[key] = result.secure_url;
    await company.save();
    res.json({ url: company[key] });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/image/:index
router.post("/company/footer-items/image/:index", authMiddleware, uploadFooterImg.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    const old = company.footerItems[index]?.image;
    await deleteFromCloudinary(old);
    const result = await uploadToCloudinary(req.file.buffer, "company");
    company.footerItems[index].image = result.secure_url;
    company.markModified("footerItems");
    await company.save();
    res.json({ url: company.footerItems[index].image });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/file/:index
router.post("/company/footer-items/file/:index", authMiddleware, uploadDoc.single("file"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    const old = company.footerItems[index]?.file;
    await deleteFromCloudinary(old, "raw");
    const result = await uploadToCloudinary(req.file.buffer, "docs", { resource_type: "raw" });
    company.footerItems[index].file = result.secure_url;
    company.markModified("footerItems");
    await company.save();
    res.json({ url: company.footerItems[index].file });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/add
router.post("/company/footer-items/add", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    company.footerItems.push({ image: "", linkType: "link", link: "", file: "" });
    await company.save();
    res.json({ index: company.footerItems.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-items/:index
router.delete("/company/footer-items/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let company = await Company.findOne();
    if (!company) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    const item = company.footerItems[index];
    await deleteFromCloudinary(item.image);
    await deleteFromCloudinary(item.file);
    company.footerItems.splice(index, 1);
    company.markModified("footerItems");
    await company.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/category-banners-bulk?categories=cat1,cat2,...
router.get("/category-banners-bulk", async (req, res) => {
  try {
    const raw = req.query.categories;
    if (!raw) return res.json({});
    const names = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    const docs = await CategoryBanner.find({ category: { $in: names } });
    const result = {};
    for (const doc of docs) {
      const active = doc.banners.filter((b) => b.url && b.active).map((b) => b.url);
      if (active.length) result[doc.category] = active;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/category-banners/:category
router.get("/category-banners/:category", async (req, res) => {
  try {
    let doc = await CategoryBanner.findOne({ category: req.params.category });
    if (!doc) doc = await CategoryBanner.create({ category: req.params.category });
    res.json(doc.banners);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/category-banners/:category/upload/:index
router.post("/category-banners/:category/upload/:index", authMiddleware, uploadCategoryBanner.single("image"), async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    let doc = await CategoryBanner.findOne({ category });
    if (!doc) doc = await CategoryBanner.create({ category });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const oldUrl = doc.banners[index]?.url;
    const result = await uploadToCloudinary(req.file.buffer, "category-banners", {
      transformation: [{ width: 1200, crop: "limit", quality: "auto:good", fetch_format: "auto" }],
    });
    doc.banners.set(index, { url: result.secure_url, active: doc.banners[index].active });
    await doc.save();
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    revalidateCategoryBanners().catch(() => {});
    res.json({ url: result.secure_url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/category-banners/:category/toggle/:index
router.patch("/category-banners/:category/toggle/:index", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const newActive = !doc.banners[index].active;
    doc.banners.set(index, { url: doc.banners[index].url, active: newActive });
    await doc.save();
    revalidateCategoryBanners().catch(() => {});
    res.json({ active: newActive });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/category-banners/:category/add
router.post("/category-banners/:category/add", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    let doc = await CategoryBanner.findOne({ category });
    if (!doc) doc = await CategoryBanner.create({ category });
    if (doc.banners.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 بانرات" });
    doc.banners.push({ url: "", active: true });
    await doc.save();
    res.json({ index: doc.banners.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/category-banners/:category/:index/image
router.delete("/category-banners/:category/:index/image", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const oldUrl = doc.banners[index]?.url;
    doc.banners.set(index, { url: "", active: doc.banners[index].active });
    await doc.save();
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/category-banners/:category/:index
router.delete("/category-banners/:category/:index", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length) return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const oldUrl = doc.banners[index]?.url;
    doc.banners.splice(index, 1);
    await doc.save();
    if (oldUrl) deleteFromCloudinary(oldUrl).catch(() => {});
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/card-field-settings
router.get("/card-field-settings", async (req, res) => {
  try {
    let doc = await CardFieldSettings.findOne();
    if (!doc) doc = await CardFieldSettings.create({});
    res.json(doc);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/card-field-settings
router.patch("/card-field-settings", authMiddleware, async (req, res) => {
  try {
    const { field } = req.body;
    if (!["showExpiryDate", "showCvv"].includes(field))
      return res.status(400).json({ error: "حقل غير صحيح" });
    const current = await CardFieldSettings.findOne();
    const newVal = current ? !current[field] : false;
    const doc = await CardFieldSettings.findOneAndUpdate(
      {},
      { $set: { [field]: newVal } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ [field]: doc[field] });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
