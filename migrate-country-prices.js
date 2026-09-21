/**
 * migrate-country-prices.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Safe one-time migration that converts existing SAR prices to AED, QAR,
 * KWD, and OMR using fixed exchange rates, then stores results as independent
 * static prices in each product's `countryPrices` map.
 *
 * Safety guarantees:
 *  • Dry-run mode (--dry-run): shows what would change, saves nothing.
 *  • Idempotent: skips products that already have ALL target currencies.
 *  • Batch processing: updates in batches of BATCH_SIZE to avoid DB pressure.
 *  • Per-document error isolation: one failure doesn't abort the whole run.
 *  • Logs updated / skipped / failed counts at end.
 *
 * Usage:
 *   node migrate-country-prices.js --dry-run        # preview only
 *   node migrate-country-prices.js                   # live run
 *   node migrate-country-prices.js --batch-size=50  # custom batch size
 *
 * Exchange rates used (SAR → target currency).
 * Edit the RATES object below before running to use up-to-date values.
 * These rates are used ONLY during migration; the website never reads them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("./models/Product");
const { COUNTRIES, roundPrice } = require("./config/countries");

// ── Exchange rates (SAR → each currency) ─────────────────────────────────────
// Adjust these values before running the migration.
const RATES = {
  SAR: 1.0,       // base currency
  AED: 0.9806,    // 1 SAR ≈ 0.9806 AED
  QAR: 1.0254,    // 1 SAR ≈ 1.0254 QAR
  KWD: 0.0818,    // 1 SAR ≈ 0.0818 KWD
  OMR: 0.1028,    // 1 SAR ≈ 0.1028 OMR
};

// Currencies that the migration will populate (excluding SAR which is kept as-is)
const TARGET_CURRENCIES = ["AED", "QAR", "KWD", "OMR"];

// ── CLI argument parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BATCH_SIZE_ARG = args.find((a) => a.startsWith("--batch-size="));
const BATCH_SIZE = BATCH_SIZE_ARG ? parseInt(BATCH_SIZE_ARG.split("=")[1], 10) : 30;

if (isNaN(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error("Invalid --batch-size value");
  process.exit(1);
}

// ── Conversion helpers ────────────────────────────────────────────────────────
/**
 * Convert a SAR price to the target currency using RATES, then round
 * to the correct number of decimal places for that currency.
 * @param {number} sarPrice
 * @param {string} currency
 * @returns {number}
 */
function convert(sarPrice, currency) {
  const rate = RATES[currency];
  if (!rate) throw new Error(`No rate defined for currency: ${currency}`);
  return roundPrice(sarPrice * rate, currency);
}

/**
 * Build countryPrices map for a top-level product or a storage option.
 * Only fills missing currencies — does not overwrite existing entries.
 * @param {Map|object} existingMap  Current countryPrices (Mongoose Map or plain obj)
 * @param {number}     sarOriginal  SAR originalPrice
 * @param {number|null} sarSale     SAR salePrice (null if none)
 * @returns {{ map: object, changed: boolean }}
 */
function buildPricesMap(existingMap, sarOriginal, sarSale) {
  // Convert Mongoose Map to plain object for easy manipulation
  const current = existingMap instanceof Map
    ? Object.fromEntries(existingMap)
    : (existingMap || {});

  const updated = { ...current };
  let changed = false;

  // Always ensure SAR entry mirrors the main price fields
  if (!current.SAR) {
    updated.SAR = {
      currency: "SAR",
      originalPrice: sarOriginal,
      salePrice: sarSale ?? null,
    };
    changed = true;
  }

  for (const currency of TARGET_CURRENCIES) {
    if (current[currency]) continue; // already set — skip

    const orig = convert(sarOriginal, currency);
    const sale = sarSale != null ? convert(sarSale, currency) : null;

    updated[currency] = {
      currency,
      originalPrice: orig,
      salePrice: sale,
    };
    changed = true;
  }

  return { map: updated, changed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();

  console.log("═══════════════════════════════════════════════════");
  console.log("  migrate-country-prices.js");
  console.log(`  Mode:       ${DRY_RUN ? "DRY RUN (no changes saved)" : "LIVE"}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log("  Exchange rates (SAR → target):");
  for (const [cur, rate] of Object.entries(RATES)) {
    console.log(`    SAR 1.00 → ${cur} ${rate.toFixed(6)}`);
  }
  console.log("═══════════════════════════════════════════════════\n");

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB\n");

  const total = await Product.countDocuments();
  console.log(`📦 Total products in DB: ${total}\n`);

  let cursor = Product.find({}).lean().cursor();

  const stats = { updated: 0, skipped: 0, failed: 0 };
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;

    const bulkOps = [];

    for (const item of batch) {
      // Re-check: if ALL currencies already present, skip
      const allPresent = TARGET_CURRENCIES.every(
        (c) => item.updatedPrices[c] !== undefined
      );
      if (allPresent && item.updatedPrices.SAR !== undefined && !item.anyChanged) {
        stats.skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would update: "${item.name}" (${item._id})`);
        for (const [cur, price] of Object.entries(item.updatedPrices)) {
          if (!item.hadCurrency[cur]) {
            console.log(
              `    + ${cur}: originalPrice=${price.originalPrice}` +
              (price.salePrice != null ? `, salePrice=${price.salePrice}` : "")
            );
          }
        }
        stats.updated++;
        continue;
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: item.setPayload },
        },
      });
      stats.updated++;
    }

    if (bulkOps.length > 0) {
      await Product.bulkWrite(bulkOps, { ordered: false });
    }

    batch = [];
  }

  for await (const doc of cursor) {
    try {
      const sarOriginal = doc.originalPrice;
      const sarSale     = doc.salePrice ?? null;

      if (typeof sarOriginal !== "number" || isNaN(sarOriginal)) {
        console.warn(`⚠  Skipping "${doc.name}" — invalid originalPrice`);
        stats.skipped++;
        continue;
      }

      // ── Top-level countryPrices ──────────────────────────────────────────
      const { map: topMap, changed: topChanged } = buildPricesMap(
        doc.countryPrices, sarOriginal, sarSale
      );

      const setPayload = {};
      let anyChanged = topChanged;

      // Store top-level map as dot-notation keys for $set
      for (const [cur, price] of Object.entries(topMap)) {
        setPayload[`countryPrices.${cur}`] = price;
      }

      // ── Variant storageOptions countryPrices ─────────────────────────────
      if (Array.isArray(doc.variants)) {
        for (let vi = 0; vi < doc.variants.length; vi++) {
          const variant = doc.variants[vi];
          if (!Array.isArray(variant.storageOptions)) continue;

          for (let si = 0; si < variant.storageOptions.length; si++) {
            const opt = variant.storageOptions[si];
            const optOrig = opt.originalPrice ?? sarOriginal;
            const optSale = opt.salePrice ?? null;

            if (typeof optOrig !== "number" || isNaN(optOrig)) continue;

            const { map: optMap, changed: optChanged } = buildPricesMap(
              opt.countryPrices, optOrig, optSale
            );

            if (optChanged) {
              anyChanged = true;
              for (const [cur, price] of Object.entries(optMap)) {
                setPayload[
                  `variants.${vi}.storageOptions.${si}.countryPrices.${cur}`
                ] = price;
              }
            }
          }
        }
      }

      if (!anyChanged) {
        stats.skipped++;
        continue;
      }

      // Track which currencies the doc already had (for dry-run logging)
      const hadCurrency = {};
      if (doc.countryPrices) {
        const existing = doc.countryPrices instanceof Map
          ? Object.fromEntries(doc.countryPrices)
          : doc.countryPrices;
        for (const k of Object.keys(existing)) hadCurrency[k] = true;
      }

      batch.push({
        _id:            doc._id,
        name:           doc.name,
        updatedPrices:  topMap,
        hadCurrency,
        anyChanged,
        setPayload,
      });

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
        process.stdout.write(
          `\r  Progress: updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`
        );
      }
    } catch (err) {
      console.error(`\n✗ Failed to process "${doc.name}" (${doc._id}): ${err.message}`);
      stats.failed++;
    }
  }

  // Flush remaining
  await flushBatch();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("  Migration complete");
  console.log(`  Mode:    ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Updated: ${stats.updated}`);
  console.log(`  Skipped: ${stats.skipped} (already had prices or no change needed)`);
  console.log(`  Failed:  ${stats.failed}`);
  console.log(`  Time:    ${elapsed}s`);
  console.log("═══════════════════════════════════════════════════\n");

  await mongoose.disconnect();
  process.exit(stats.failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
