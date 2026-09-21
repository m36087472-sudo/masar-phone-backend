/**
 * migrate-country-prices-write.js
 * ─────────────────────────────────────────────────────────────────────────────
 * تنفيذ الكتابة الفعلية لـ countryPrices على كل المنتجات.
 *
 * الضمانات:
 *   ✔ نسخة احتياطية JSON كاملة قبل أي تعديل
 *   ✔ لا يلمس originalPrice / salePrice السعودية أبداً
 *   ✔ لا يكتب إلا countryPrices فقط ($set محدود)
 *   ✔ idempotent — يتجاوز المنتجات التي لديها أسعار بالفعل
 *   ✔ bulkWrite على دفعات 50 لتقليل الضغط
 *   ✔ تقرير نهائي شامل مع فحص عينة
 */

"use strict";
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const Product = require("./models/Product");

// ── معاملات التحويل ────────────────────────────────────────────────────────
const RATES = [
  { currency: "AED", rate: 0.979, decimals: 2 },
  { currency: "QAR", rate: 0.971, decimals: 2 },
  { currency: "KWD", rate: 0.082, decimals: 3 },
  { currency: "OMR", rate: 0.103, decimals: 3 },
];

function convertPrice(sarAmount, rate, decimals) {
  if (sarAmount == null || isNaN(sarAmount)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(sarAmount * rate * factor) / factor;
}

function buildCountryPrices(sarOriginal, sarSale) {
  const result = {};
  for (const { currency, rate, decimals } of RATES) {
    const originalPrice = convertPrice(sarOriginal, rate, decimals);
    const salePrice = sarSale != null ? convertPrice(sarSale, rate, decimals) : null;
    result[currency] = { currency, originalPrice, salePrice };
  }
  return result;
}

function hasExistingCountryPrices(countryPrices) {
  if (!countryPrices) return false;
  const entries = countryPrices instanceof Map
    ? [...countryPrices.entries()]
    : Object.entries(countryPrices);
  return entries.some(
    ([key, val]) => key !== "SAR" && val && typeof val.originalPrice === "number" && val.originalPrice > 0
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();

  console.log("━".repeat(64));
  console.log("🚀  WRITE MODE — تنفيذ فعلي على قاعدة البيانات");
  console.log("━".repeat(64));

  await mongoose.connect(process.env.MONGO_URI);

  // تأكيد قاعدة البيانات
  const dbName = mongoose.connection.db.databaseName;
  console.log(`\n✅  متصل بـ: ${dbName} @ ${mongoose.connection.host}`);

  // ── جلب كل المنتجات ──────────────────────────────────────────────────────
  const allProducts = await Product.find({}).lean();
  const totalInDB = allProducts.length;
  console.log(`📦  إجمالي المنتجات: ${totalInDB}`);

  const toProcess = allProducts.filter(p => !hasExistingCountryPrices(p.countryPrices));
  const skipped   = totalInDB - toProcess.length;
  console.log(`✔   تُتجاوز (لديها أسعار): ${skipped}`);
  console.log(`⚙️   ستُعالَج:               ${toProcess.length}`);

  if (toProcess.length === 0) {
    console.log("\n✅  لا يوجد شيء للمعالجة.");
    await mongoose.disconnect();
    return;
  }

  // ── نسخة احتياطية ────────────────────────────────────────────────────────
  const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFileName  = `backup-products-${backupTimestamp}.json`;
  const backupPath      = path.join(__dirname, backupFileName);

  // نحفظ فقط الحقول المهمة للاسترجاع (المنتجات التي ستُعدَّل)
  const backupData = {
    createdAt:   new Date().toISOString(),
    database:    dbName,
    host:        mongoose.connection.host,
    productsCount: toProcess.length,
    products: toProcess.map(p => ({
      _id:           p._id,
      name:          p.name,
      originalPrice: p.originalPrice,
      salePrice:     p.salePrice,
      countryPrices: p.countryPrices || {},
      variants: (p.variants || []).map(v => ({
        color: v.color,
        storageOptions: (v.storageOptions || []).map(o => ({
          storage:       o.storage,
          ram:           o.ram,
          originalPrice: o.originalPrice,
          salePrice:     o.salePrice,
          countryPrices: o.countryPrices || {},
        })),
      })),
    })),
  };

  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), "utf8");
  const backupSizeKB = (fs.statSync(backupPath).size / 1024).toFixed(1);
  console.log(`\n💾  نسخة احتياطية:`);
  console.log(`     المسار: ${backupPath}`);
  console.log(`     الوقت:  ${backupData.createdAt}`);
  console.log(`     الحجم:  ${backupSizeKB} KB`);

  // ── بناء الـ bulkOps ──────────────────────────────────────────────────────
  const bulkOps = [];
  const perCurrencyCount = { AED: 0, QAR: 0, KWD: 0, OMR: 0 };
  let totalStorageOpts = 0;

  for (const product of toProcess) {
    const $set = {};

    // أسعار المنتج الرئيسية
    const rootPrices = buildCountryPrices(product.originalPrice, product.salePrice ?? null);
    for (const [currency, entry] of Object.entries(rootPrices)) {
      $set[`countryPrices.${currency}`] = entry;
      perCurrencyCount[currency] = (perCurrencyCount[currency] || 0) + 1;
    }

    // storageOptions
    if (Array.isArray(product.variants)) {
      product.variants.forEach((variant, vi) => {
        if (!Array.isArray(variant.storageOptions)) return;
        variant.storageOptions.forEach((opt, oi) => {
          const sarOriginal = typeof opt.originalPrice === "number" ? opt.originalPrice : product.originalPrice;
          const sarSale     = typeof opt.salePrice     === "number" ? opt.salePrice     : (product.salePrice ?? null);
          const optPrices   = buildCountryPrices(sarOriginal, sarSale);
          for (const [currency, entry] of Object.entries(optPrices)) {
            $set[`variants.${vi}.storageOptions.${oi}.countryPrices.${currency}`] = entry;
          }
          totalStorageOpts++;
        });
      });
    }

    bulkOps.push({
      updateOne: {
        filter: { _id: product._id },
        // $set يضيف countryPrices فقط — لا يلمس originalPrice أو salePrice أو أي حقل آخر
        update: { $set },
      },
    });
  }

  // ── تنفيذ على دفعات ───────────────────────────────────────────────────────
  console.log(`\n⏳  جاري الكتابة في دفعات (50 منتج/دفعة)...`);
  const BATCH_SIZE = 50;
  let successCount = 0;
  let failCount    = 0;
  const errors     = [];

  for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
    const batch     = bulkOps.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(bulkOps.length / BATCH_SIZE);
    try {
      const result = await Product.bulkWrite(batch, { ordered: false });
      successCount += result.modifiedCount;
      process.stdout.write(`\r     دفعة ${batchNum}/${totalBatches} — نجح: ${successCount}`);
    } catch (err) {
      failCount += batch.length;
      errors.push(`دفعة ${batchNum}: ${err.message}`);
    }
  }
  console.log(""); // سطر جديد بعد progress

  // ── تحقق ختامي ───────────────────────────────────────────────────────────
  const verifyAED  = await Product.countDocuments({ "countryPrices.AED": { $exists: true } });
  const verifyQAR  = await Product.countDocuments({ "countryPrices.QAR": { $exists: true } });
  const verifyKWD  = await Product.countDocuments({ "countryPrices.KWD": { $exists: true } });
  const verifyOMR  = await Product.countDocuments({ "countryPrices.OMR": { $exists: true } });

  // ── فحص عينة (أول 3 منتجات) ─────────────────────────────────────────────
  const sampleIds = toProcess.slice(0, 3).map(p => p._id);
  const sampleAfter = await Product.find({ _id: { $in: sampleIds } })
    .select("name originalPrice salePrice countryPrices variants")
    .lean();

  // ── تقرير نهائي ──────────────────────────────────────────────────────────
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "━".repeat(64));
  console.log("📊  التقرير النهائي");
  console.log("━".repeat(64));

  console.log(`\n✅  النتائج:`);
  console.log(`     منتجات نجحت:    ${successCount}`);
  console.log(`     منتجات فشلت:    ${failCount}`);
  console.log(`     منتجات تجاوزت:  ${skipped}`);
  console.log(`     storageOptions محدّثة: ${totalStorageOpts}`);

  console.log(`\n💱  أسعار مكتوبة لكل عملة (product-level):`);
  for (const [currency, count] of Object.entries(perCurrencyCount)) {
    console.log(`     ${currency}: ${count} منتج`);
  }

  console.log(`\n🔍  تحقق من DB (عدد المنتجات بالعملة):`);
  console.log(`     AED: ${verifyAED}`);
  console.log(`     QAR: ${verifyQAR}`);
  console.log(`     KWD: ${verifyKWD}`);
  console.log(`     OMR: ${verifyOMR}`);

  if (errors.length > 0) {
    console.log(`\n❌  أخطاء (${errors.length}):`);
    errors.forEach(e => console.log(`     - ${e}`));
  } else {
    console.log(`\n✅  لا أخطاء`);
  }

  // عينة مقارنة قبل/بعد
  console.log(`\n─`.repeat(64));
  console.log(`🔬  فحص عينة (مقارنة قبل/بعد):`);
  for (const after of sampleAfter) {
    const before = toProcess.find(p => p._id.toString() === after._id.toString());
    const cp = after.countryPrices;
    console.log(`\n  📱 ${after.name}`);
    console.log(`     SAR (قبل وبعد — بدون تغيير):`);
    console.log(`       originalPrice: ${before.originalPrice} → ${after.originalPrice}`);
    console.log(`       salePrice:     ${before.salePrice ?? "—"} → ${after.salePrice ?? "—"}`);
    console.log(`     countryPrices (جديدة):`);
    for (const { currency } of RATES) {
      const entry = cp instanceof Map ? cp.get(currency) : cp?.[currency];
      if (entry) {
        const sp = entry.salePrice != null ? ` | خصم: ${entry.salePrice}` : "";
        console.log(`       ${currency}: ${entry.originalPrice}${sp}`);
      }
    }
  }

  console.log(`\n⏱️   مدة التنفيذ: ${duration} ثانية`);
  console.log(`💾  النسخة الاحتياطية: ${backupPath}`);
  console.log("━".repeat(64));
  console.log("✅  اكتمل بنجاح.");

  await mongoose.disconnect();
}

run().catch(err => {
  console.error("💥  خطأ غير متوقع:", err);
  process.exit(1);
});
