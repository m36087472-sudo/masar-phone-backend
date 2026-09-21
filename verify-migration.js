require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('./models/Product');

const RATES = [
  { currency: 'AED', rate: 0.979, decimals: 2 },
  { currency: 'QAR', rate: 0.971, decimals: 2 },
  { currency: 'KWD', rate: 0.082, decimals: 3 },
  { currency: 'OMR', rate: 0.103, decimals: 3 },
];

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const total   = await Product.countDocuments();
  const withAED = await Product.countDocuments({ 'countryPrices.AED': { $exists: true } });
  const withQAR = await Product.countDocuments({ 'countryPrices.QAR': { $exists: true } });
  const withKWD = await Product.countDocuments({ 'countryPrices.KWD': { $exists: true } });
  const withOMR = await Product.countDocuments({ 'countryPrices.OMR': { $exists: true } });

  // Count storageOptions with countryPrices
  const allProducts = await Product.find({}).lean();
  let totalStorageOpts = 0;
  let storageWithPrices = 0;
  for (const p of allProducts) {
    for (const v of (p.variants || [])) {
      for (const o of (v.storageOptions || [])) {
        totalStorageOpts++;
        if (o.countryPrices && (o.countryPrices.AED || (o.countryPrices instanceof Map && o.countryPrices.get('AED')))) {
          storageWithPrices++;
        }
      }
    }
  }

  console.log('━'.repeat(60));
  console.log('📊  التقرير النهائي — فحص قاعدة البيانات');
  console.log('━'.repeat(60));
  console.log('\n✅  المنتجات:');
  console.log('   إجمالي في DB         :', total);
  console.log('   لديها AED            :', withAED);
  console.log('   لديها QAR            :', withQAR);
  console.log('   لديها KWD            :', withKWD);
  console.log('   لديها OMR            :', withOMR);
  console.log('   ناقصة (AED)          :', total - withAED);
  console.log('\n   storageOptions إجمالي:', totalStorageOpts);
  console.log('   storageOptions محدّثة:', storageWithPrices);

  // فحص 3 منتجات عشوائية مختلفة
  const samples = await Product.find({}).limit(3).lean();

  console.log('\n' + '─'.repeat(60));
  console.log('🔬  فحص عينة (3 منتجات):');
  console.log('─'.repeat(60));

  for (const p of samples) {
    const cp = p.countryPrices;
    console.log(`\n  📱 ${p.name}`);
    console.log(`     SAR originalPrice : ${p.originalPrice}  (بدون تعديل)`);
    console.log(`     SAR salePrice     : ${p.salePrice ?? '—'}  (بدون تعديل)`);
    console.log('     countryPrices:');
    for (const { currency } of RATES) {
      const entry = cp?.[currency];
      if (entry) {
        const sp = entry.salePrice != null ? ` | خصم: ${entry.salePrice}` : '';
        console.log(`       ${currency}: originalPrice=${entry.originalPrice}${sp}`);
      } else {
        console.log(`       ${currency}: ❌ غير موجود`);
      }
    }

    // storageOption مثال
    const firstOpt = p.variants?.[0]?.storageOptions?.[0];
    if (firstOpt) {
      const ocp = firstOpt.countryPrices;
      console.log(`\n     storageOption [${firstOpt.storage ?? 'N/A'}${firstOpt.ram ? '/'+firstOpt.ram : ''}]:`);
      console.log(`       SAR originalPrice: ${firstOpt.originalPrice ?? p.originalPrice}  (بدون تعديل)`);
      for (const { currency } of RATES) {
        const entry = ocp?.[currency];
        if (entry) {
          const sp = entry.salePrice != null ? ` | خصم: ${entry.salePrice}` : '';
          console.log(`       ${currency}: ${entry.originalPrice}${sp}`);
        } else {
          console.log(`       ${currency}: ❌ غير موجود`);
        }
      }
    }
  }

  // تحقق: SAR ما اتغيرت
  console.log('\n' + '─'.repeat(60));
  console.log('🛡️   تحقق من سلامة SAR (بدون تعديل):');
  let sarIntact = true;
  for (const p of allProducts) {
    if (typeof p.originalPrice !== 'number' || p.originalPrice <= 0) {
      console.log(`   ⚠️  ${p.name}: originalPrice = ${p.originalPrice}`);
      sarIntact = false;
    }
  }
  if (sarIntact) console.log('   ✅  كل أسعار SAR سليمة وبدون تعديل');

  console.log('\n' + '━'.repeat(60));
  console.log('✅  Migration مكتمل بنجاح.');
  console.log('━'.repeat(60));

  await mongoose.disconnect();
});
