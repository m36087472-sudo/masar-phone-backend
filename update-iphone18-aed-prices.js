/**
 * update-iphone18-aed-prices.js
 *
 * يحدّث أسعار AED لكل documents آيفون 18 برو وآيفون 18 برو ماكس في DB.
 * كل document هو لون/سعة مستقل — السكريبت يحدّث:
 *   • countryPrices.AED على مستوى المنتج
 *   • countryPrices.AED لكل storageOption داخل كل variant
 *
 * الأسعار الجديدة (درهم إماراتي):
 *
 *   iPhone 18 Pro:     256GB=5099 | 512GB=5949 | 1TB=7649 | 2TB=9349
 *   iPhone 18 Pro Max: 256GB=5499 | 512GB=6349 | 1TB=8049 | 2TB=9749
 *
 * Usage:
 *   node update-iphone18-aed-prices.js           ← تحديث فعلي
 *   node update-iphone18-aed-prices.js --dry-run  ← معاينة بدون حفظ
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("./models/Product");

const DRY_RUN = process.argv.includes("--dry-run");

// ── خريطة الأسعار ────────────────────────────────────────────────
const PRICE_MAP = {
  PRO: {
    "256GB": 5099,
    "512GB": 5949,
    "1TB":   7649,
    "2TB":   9349,
  },
  PROMAX: {
    "256GB": 5499,
    "512GB": 6349,
    "1TB":   8049,
    "2TB":   9749,
  },
};

// ── استخراج السعة من اسم المنتج (fallback لو storageOptions فاضية) ──
function extractStorageFromName(name) {
  if (/256/i.test(name))       return "256GB";
  if (/512/i.test(name))       return "512GB";
  if (/1 تيرابايت|1TB/i.test(name)) return "1TB";
  if (/2 تيرابايت|2TB/i.test(name)) return "2TB";
  return null;
}

// ── تحديث document واحد ──────────────────────────────────────────
async function updateProduct(product, priceMap) {
  const storageName = extractStorageFromName(product.name);
  const rootPrice   = storageName ? priceMap[storageName] : null;

  console.log(`\n  📄 ${product.name.substring(0, 70)}`);
  console.log(`     ID: ${product._id}`);

  // ── Root countryPrices ──
  if (rootPrice != null) {
    const cur = product.countryPrices?.get?.("AED");
    console.log(`     Root AED: ${cur ? cur.originalPrice : "—"} → ${rootPrice}`);
    if (!DRY_RUN) {
      product.countryPrices.set("AED", {
        currency: "AED",
        originalPrice: rootPrice,
        salePrice: null,
      });
    }
  } else {
    console.log(`     ⚠️  لم يُحدَّد Root price (لم تُعرَف السعة من الاسم)`);
  }

  // ── storageOptions داخل كل variant ──
  let updatedOpts = 0;
  product.variants.forEach((variant, vi) => {
    variant.storageOptions.forEach((opt, si) => {
      const newPrice = priceMap[opt.storage];
      if (newPrice == null) {
        console.log(`     ⚠️  Variant[${vi}] opt[${si}] storage="${opt.storage}" — لا يوجد سعر، تخطي`);
        return;
      }
      const cur = opt.countryPrices?.get?.("AED");
      console.log(`     Variant[${vi}] ${opt.storage}: ${cur ? cur.originalPrice : "—"} → ${newPrice}`);
      if (!DRY_RUN) {
        opt.countryPrices.set("AED", {
          currency: "AED",
          originalPrice: newPrice,
          salePrice: null,
        });
      }
      updatedOpts++;
    });
  });

  if (!DRY_RUN) {
    product.markModified("countryPrices");
    product.markModified("variants");
    await product.save();
    console.log(`     ✅ محفوظ (${updatedOpts} storage option(s))`);
  } else {
    console.log(`     🔍 [DRY RUN] (${updatedOpts} storage option(s) سيتم تحديثها)`);
  }
}

// ── main ─────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60));
  console.log(DRY_RUN
    ? "🔍  DRY RUN — معاينة فقط، لن يتم الحفظ"
    : "✏️   تشغيل فعلي — سيتم الحفظ في DB");
  console.log("═".repeat(60));

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ متصل بقاعدة البيانات\n");

  // iPhone 18 Pro  (category = "ابل ايفون 18 برو ")
  const proProducts = await Product.find({ category: /^ابل ايفون 18 برو\s*$/ });
  console.log(`\n📱 iPhone 18 Pro — ${proProducts.length} document(s)`);
  for (const p of proProducts) {
    await updateProduct(p, PRICE_MAP.PRO);
  }

  // iPhone 18 Pro Max  (category = "ابل ايفون 18 برو ماكس")
  const proMaxProducts = await Product.find({ category: /ابل ايفون 18 برو ماكس/ });
  console.log(`\n\n📱 iPhone 18 Pro Max — ${proMaxProducts.length} document(s)`);
  for (const p of proMaxProducts) {
    await updateProduct(p, PRICE_MAP.PROMAX);
  }

  await mongoose.disconnect();
  console.log("\n" + "═".repeat(60));
  console.log(`🔌 انتهى. Pro: ${proProducts.length} | Pro Max: ${proMaxProducts.length}`);
  console.log(DRY_RUN ? "✔  DRY RUN — لا تغييرات محفوظة" : "✔  تم تحديث جميع الأسعار بنجاح");
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("💥 خطأ:", err);
  process.exit(1);
});
