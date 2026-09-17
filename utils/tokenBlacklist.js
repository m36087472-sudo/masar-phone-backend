const jwt = require("jsonwebtoken");
const TokenBlacklist = require("../models/TokenBlacklist");

// In-memory cache: token → { blacklisted: bool, expiresAt: ms }
// Avoids a DB round-trip on every authenticated request
const cache = new Map();
const CACHE_TTL = 30_000; // 30 seconds — safe for logout propagation
const MAX_CACHE = 500;

function pruneCache() {
  if (cache.size < MAX_CACHE) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now > v.expiresAt) cache.delete(k);
    if (cache.size < MAX_CACHE * 0.8) break;
  }
}

async function addToBlacklist(token) {
  try {
    const decoded = jwt.decode(token);
    if (!decoded?.exp) return false;
    const expiresAt = new Date(decoded.exp * 1000);
    if (expiresAt <= new Date()) return true;
    await TokenBlacklist.updateOne({ token }, { token, expiresAt }, { upsert: true });
    // Immediately mark in cache
    cache.set(token, { blacklisted: true, expiresAt: expiresAt.getTime() });
    return true;
  } catch (err) {
    console.error(`خطأ في إضافة token للقائمة السوداء: ${err.message}`);
    return false;
  }
}

async function isBlacklisted(token) {
  try {
    const now = Date.now();
    const cached = cache.get(token);
    if (cached) {
      if (now > cached.expiresAt) { cache.delete(token); return false; }
      return cached.blacklisted;
    }
    const doc = await TokenBlacklist.findOne({ token }, "_id expiresAt").lean();
    const blacklisted = !!doc;
    pruneCache();
    const ttlEnd = doc ? doc.expiresAt.getTime() : now + CACHE_TTL;
    cache.set(token, { blacklisted, expiresAt: Math.min(ttlEnd, now + CACHE_TTL) });
    return blacklisted;
  } catch {
    return false;
  }
}

module.exports = { addToBlacklist, isBlacklisted };
