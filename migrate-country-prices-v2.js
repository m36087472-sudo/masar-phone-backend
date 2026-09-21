/**
 * migrate-country-prices-v2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * يضيف countryPrices لكل المنتجات التي لا تحتوي عليها بعد،
 * ويطبّق التحويل على أسعار المنتج الرئيسية وعلى كل storageOptions داخل variants.
 *
 * معاملات التحويل (من SAR):
 *   SAR  → 1.000  (لا يُخزَّن — الأسعار السعودية موجودة في originalPrice/salePrice)
 *   AED  → 0.979  (منزلتان عشريتان)
 *   QAR  → 0.971  (منزلتان عشريتان)
 *   KWD  → 0.082  (ثلاث منازل عشرية)
 *   OMR  → 0.103  (ثلاث منازل عشرية)
 *
 * الضمانات:
 *   ✔ Dry Run افتراضي — لا يكتب في DB إلا بتمرير --write
 *   ✔ لا يعدّل منتجاً لديه countryPrices بالفعل (idempotent)
 *   ✔ لا يلمس originalPrice/salePrice السعودية
 *   ✔ يعالج storageOptions بأسعارها المستقلة إذا وُجدت
 *   ✔ يستخدم Math.round مع ضرب في 10^decimals لتجنب float drift
 *   ✔ نسخة احتياطية JSON قبل أي كتابة
 * ─────────────────────────────────────────────────────────────────────────────
 * الاستخدام:
 *   node migrate-country-prices-v2.js           ← Dry Run (آمن، لا يكتب)
 *   node migrate-country-prices-v2.js --write   ← تنفيذ فعلي + نسخة احتياطية
 */

"use strict";
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const Product = require("./models/Product");

// ── إعدادات التحويل ────────────────────────────────────────────────────────
const RATES = [
  { currency: "AED", rate: 0.979, decimals: 2 },
  { currency: "QAR", rate: 0.971, decimals: 2 },
  { currency: "KWD", rate: 0.082, decimals: 3 },
  { currency: "OMR", rate: 0.103, decimals: 3 },
];

// ── وضع التشغيل ───────────────────────────────────────────────────────────
const WRITE_MODE = process.argv.includes("--write");

// ── دوال مساعدة ───────────────────────────────────────────────────────────

/**
 * تحوّل قيمة SAR إلى العملة المستهدفة مع تقريب صحيح بدون float drift.
 * مثال: convertPrice(5699, 0.979, 2) → 5579.12
 */
function convertPrice(sarAmount, rate, decimals) {
  if (sarAmount == null || isNaN(sarAmount)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(sarAmount * rate * factor) / factor;
}

/**
 * تبني كائن countryPrices لسعر SAR معين (product-level أو storageOption-level).
 */
function buildCountryPrices(sarOriginal, sarSale) {
  const result = {};
  for (const { currency, rate, decimals } of RATES) {
    const originalPrice = convertPrice(sarOriginal, rate, decimals);
    const salePrice = sarSale != null ? convertPrice(sarSale, rate, decimals) : null;
    result[currency] = { currency, originalPrice, salePrice };
  }
  return result;
}

/**
 * تتحقق هل المنتج لديه countryPrices مفيدة بالفعل.
 * Mongoose يُعيد Map أو plain object حسب .lean().
 */
function hasExistingCountryPrices(countryPrices) {
  if (!countryPrices) return false;
  const entries = countryPrices instanceof Map
    ? [...countryPrices.entries()]
    : Object.entries(countryPrices);
  // نعتبر "موجود" إذا فيه على الأقل عملة واحدة غير SAR بسعر حقيقي
  return entries.some(
    ([key, val]) => key !== "SAR" && val && typeof val.originalPrice === "number" && val.originalPrice > 0
  );
}

// ── المنطق الرئيسي ────────────────────────────────────────────────────────
async function run() {
  console.log("━".repeat(60));
  console.log(WRITE_MODE ? "🚀  وضع الكتابة — سيتم التعديل على قاعدة البيانات" : "🔍  Dry Run — لا تعديل على قاعدة البيانات");
  console.log("━".repeat(60));

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅  اتصال MongoDB ناجح\n");

  // ── جلب كل المنتجات ──────────────────────────────────────────────────
  const allProducts = await Product.find({}).lean();
  console.log(`📦  إجمالي المنتجات في DB: ${allProducts.length}`);

  // ── تصفية المنتجات التي تحتاج تحويل ─────────────────────────────────
  const toProcess = allProducts.filter(
    (p) => !hasExistingCountryPrices(p.countryPrices)
  );
  const alreadyDone = allProducts.length - toProcess.length;

  console.log(`✔   مكتملة بالفعل (تُجطى): ${alreadyDone}`);
  console.log(`⚙️   تحتاج تحويل:            ${toProcess.length}\n`);

  if (toProcess.length === 0) {
    console.log("✅  لا يوجد شيء للمعالجة. كل المنتجات لديها أسعار.");
    await mongoose.disconnect();
    return;
  }

  // ── نسخة احتياطية (قبل الكتابة فقط) ─────────────────────────────────
  if (WRITE_MODE) {
    const backupPath = path.join(
      __dirname,
      `backup-products-before-migration-${Date.now()}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify(toProcess, null, 2), "utf8");
    console.log(`💾  نسخة احتياطية: ${backupPath}\n`);
  }

  // ── بناء التعديلات وعرض أمثلة ─────────────────────────────────────────
  const updates = []; // [{ id, name, $set }]
  const examples = []; // أول 3 منتجات للعرض

  for (const product of toProcess) {
    const $set = {};

    // ── أسعار المنتج الرئيسية ──────────────────────────────────────────
    const rootPrices = buildCountryPrices(product.originalPrice, product.salePrice ?? null);
    for (const [currency, entry] of Object.entries(rootPrices)) {
      $set[`countryPrices.${currency}`] = entry;
    }

    // ── أسعار storageOptions داخل variants ────────────────────────────
    if (Array.isArray(product.variants)) {
      product.variants.forEach((variant, vi) => {
        if (!Array.isArray(variant.storageOptions)) return;
        variant.storageOptions.forEach((opt, oi) => {
          // إذا الـ storageOption عنده سعر مستقل، نحوّله؛ وإلا نستخدم سعر المنتج
          const sarOriginal =
            typeof opt.originalPrice === "number" ? opt.originalPrice : product.originalPrice;
          const sarSale =
            typeof opt.salePrice === "number" ? opt.salePrice : (product.salePrice ?? null);

          const optPrices = buildCountryPrices(sarOriginal, sarSale);
          for (const [currency, entry] of Object.entries(optPrices)) {
            $set[`variants.${vi}.storageOptions.${oi}.countryPrices.${currency}`] = entry;
          }
        });
      });
    }

    updates.push({ id: product._id, name: product.name, $set });

    // جمع أمثلة للعرض
    if (examples.length < 3) {
      examples.push({ product, $set });
    }
  }

  // ── عرض أمثلة ─────────────────────────────────────────────────────────
  console.log("─".repeat(60));
  console.log("📋  أمثلة على التحويل (أول 3 منتجات):");
  console.log("─".repeat(60));

  for (const { product, $set } of examples) {
    console.log(`\n🏷️   ${product.name}`);
    console.log(
      `     SAR الأصلي: ${product.originalPrice}${product.salePrice != null ? ` (خصم: ${product.salePrice})` : ""}`
    );
    console.log("     أسعار الدول المولّدة:");
    for (const { currency } of RATES) {
      const entry = $set[`countryPrices.${currency}`];
      const salePart =
        entry.salePrice != null ? ` | خصم: ${entry.salePrice} ${currency}` : "";
      console.log(`       ${currency}: ${entry.originalPrice}${salePart}`);
    }

    // storageOptions
    const storageSets = Object.entries($set).filter(([k]) =>
      k.startsWith("variants.")
    );
    if (storageSets.length > 0) {
      // عرض أول storageOption فقط
      const firstKey = storageSets[0][0]; // e.g. variants.0.storageOptions.0.countryPrices.AED
      const parts = firstKey.split(".");
      const vi = parts[1];
      const oi = parts[3];
      const variant = product.variants[vi];
      const opt = variant?.storageOptions?.[oi];
      if (opt) {
        console.log(`\n     📁 storageOption مثال: ${opt.storage ?? "N/A"}${opt.ram ? " / " + opt.ram : ""}`);
        console.log(
          `        SAR الأصلي: ${opt.originalPrice ?? product.originalPrice}${(opt.salePrice ?? product.salePrice) != null ? ` (خصم: ${opt.salePrice ?? product.salePrice})` : ""}`
        );
        for (const { currency } of RATES) {
          const key = `variants.${vi}.storageOptions.${oi}.countryPrices.${currency}`;
          const e = $set[key];
          if (!e) continue;
          const sp = e.salePrice != null ? ` | خصم: ${e.salePrice} ${currency}` : "";
          console.log(`        ${currency}: ${e.originalPrice}${sp}`);
        }
      }
    }
  }

  // ── ملخص إجمالي ──────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("📊  ملخص:");
  console.log(`     منتجات ستُعالَج:  ${updates.length}`);
  console.log(`     منتجات ستُتجطى:   ${alreadyDone}`);

  // إحصاء storageOptions
  let totalStorageOpts = 0;
  for (const { $set } of updates) {
    const currencies = RATES.map((r) => r.currency);
    const storageKeys = Object.keys($set).filter(
      (k) => k.startsWith("variants.") && k.endsWith(`.countryPrices.${currencies[0]}`)
    );
    totalStorageOpts += storageKeys.length;
  }
  console.log(`     storageOptions ستُحوَّل: ${totalStorageOpts}`);
  console.log(`     عملات مضافة لكل سعر:    ${RATES.length} (${RATES.map((r) => r.currency).join(", ")})`);

  if (!WRITE_MODE) {
    console.log("\n" + "━".repeat(60));
    console.log("ℹ️   هذا Dry Run. لتنفيذ التعديل الفعلي شغّل:");
    console.log("     node migrate-country-prices-v2.js --write");
    console.log("━".repeat(60));
    await mongoose.disconnect();
    return;
  }

  // ── الكتابة الفعلية ───────────────────────────────────────────────────
  console.log("\n⏳  جاري الكتابة في قاعدة البيانات...");
  let successCount = 0;
  let errorCount = 0;

  // bulkWrite لأداء أفضل
  const bulkOps = updates.map(({ id, $set }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set },
    },
  }));

  const BATCH_SIZE = 50;
  for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
    const batch = bulkOps.slice(i, i + BATCH_SIZE);
    try {
      const result = await Product.bulkWrite(batch, { ordered: false });
      successCount += result.modifiedCount;
    } catch (err) {
      console.error(`❌  خطأ في الـ batch ${i}–${i + BATCH_SIZE}:`, err.message);
      errorCount += batch.length;
    }
  }

  console.log(`\n✅  اكتملت الكتابة:`);
  console.log(`     نجح:    ${successCount} منتج`);
  if (errorCount > 0) console.log(`     فشل:    ${errorCount} منتج`);

  // ── تحقق ختامي ────────────────────────────────────────────────────────
  const verifyCount = await Product.countDocuments({
    "countryPrices.AED": { $exists: true },
  });
  console.log(`\n🔍  تحقق: ${verifyCount} منتج لديه AED في DB الآن`);

  await mongoose.disconnect();
  console.log("\n✅  انتهى. قاعدة البيانات محدّثة.");
}

run().catch((err) => {
  console.error("💥  خطأ غير متوقع:", err);
  process.exit(1);
});
