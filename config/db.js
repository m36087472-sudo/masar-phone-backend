const mongoose = require("mongoose");

async function ensureIndexes() {
  try {
    const db = mongoose.connection.db;

    // products: category و brand الأكثر استخداماً في queries الـ homepage
    await db.collection("products").createIndex({ category: 1 });
    await db.collection("products").createIndex({ brand: 1 });
    await db.collection("products").createIndex({ inStock: 1 });

    // subcategorysettings: compound index للـ home-settings query
    await db.collection("subcategorysettings").createIndex({ category: 1, subCategory: 1 }, { unique: true });
    await db.collection("subcategorysettings").createIndex({ order: 1 });

    // categorybanners: index على category للـ bulk query
    await db.collection("categorybanners").createIndex({ category: 1 }, { unique: true });

    // reviews: approved + createdAt للـ homepage reviews query
    await db.collection("reviews").createIndex({ approved: 1, createdAt: -1 });

    // checkouts: indexes للـ server-side search + pagination
    await db.collection("checkouts").createIndex({ createdAt: -1 });
    await db.collection("checkouts").createIndex({ status: 1, createdAt: -1 });
    await db.collection("checkouts").createIndex({ customer: 1 });
    await db.collection("checkouts").createIndex({ whatsapp: 1 });
    await db.collection("checkouts").createIndex({ nationalId: 1 });
    await db.collection("checkouts").createIndex({ orderId: 1 }, { unique: true });

    console.log("MongoDB indexes ensured");
  } catch (err) {
    // non-blocking — indexes are optional optimizations
    console.warn("Index creation warning:", err.message);
  }
}

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
    await ensureIndexes();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
