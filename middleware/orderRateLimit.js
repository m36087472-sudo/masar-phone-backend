/**
 * Order Rate Limit Middleware
 *
 * Pattern (configurable via env):
 *   4 requests → BLOCK 5 min
 *   2 requests → BLOCK 10 min
 *   2 requests → BLOCK 20 min
 *   ... capped at MAX_BLOCK_SECONDS
 *
 * Identity : signed HttpOnly cookie (clientId) + IP history
 * Storage  : MongoDB atomic findOneAndUpdate
 * Fail-closed: DB unavailable → reject order, never open the gate
 */

const crypto = require("crypto");
const OrderRateLimit = require("../models/OrderRateLimit");

// ── Config ─────────────────────────────────────────────────────────────────
const CFG = {
  INITIAL_REQUESTS:    parseInt(process.env.ORDER_RATE_LIMIT_INITIAL_REQUESTS    || "4"),
  POST_BLOCK_REQUESTS: parseInt(process.env.ORDER_RATE_LIMIT_POST_BLOCK_REQUESTS || "2"),
  INITIAL_BLOCK_SEC:   parseInt(process.env.ORDER_RATE_LIMIT_INITIAL_BLOCK_SECONDS || "300"),
  MULTIPLIER:          parseFloat(process.env.ORDER_RATE_LIMIT_MULTIPLIER         || "2"),
  MAX_BLOCK_SEC:       parseInt(process.env.ORDER_RATE_LIMIT_MAX_BLOCK_SECONDS    || "86400"),
  COOKIE_NAME:         "rl_cid",
  get COOKIE_SECRET() {
    return process.env.RATE_LIMIT_COOKIE_SECRET || process.env.JWT_SECRET || "fallback-change-me";
  },
};

// ── Signed cookie helpers ──────────────────────────────────────────────────
function signValue(value) {
  const sig = crypto
    .createHmac("sha256", CFG.COOKIE_SECRET)
    .update(value)
    .digest("hex")
    .slice(0, 16);
  return `${value}.${sig}`;
}

function verifyAndExtract(signed) {
  if (!signed || typeof signed !== "string") return null;
  const lastDot = signed.lastIndexOf(".");
  if (lastDot === -1) return null;
  const value = signed.slice(0, lastDot);
  const sig   = signed.slice(lastDot + 1);
  const expected = crypto
    .createHmac("sha256", CFG.COOKIE_SECRET)
    .update(value)
    .digest("hex")
    .slice(0, 16);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return value;
}

function setClientCookie(res, clientId) {
  res.cookie(CFG.COOKIE_NAME, signValue(clientId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 365 * 24 * 3600 * 1000,
    path: "/",
  });
}

// ── Identity ───────────────────────────────────────────────────────────────
function resolveClientId(req, res) {
  const raw = req.cookies?.[CFG.COOKIE_NAME];
  const extracted = verifyAndExtract(raw);
  if (extracted) return extracted;
  const newId = crypto.randomUUID();
  setClientCookie(res, newId);
  return newId;
}

function getIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// ── Helpers ────────────────────────────────────────────────────────────────
function calcBlockDuration(level) {
  const raw = CFG.INITIAL_BLOCK_SEC * Math.pow(CFG.MULTIPLIER, level);
  return Math.min(Math.round(raw), CFG.MAX_BLOCK_SEC);
}

function windowLimit(level) {
  return level === 0 ? CFG.INITIAL_REQUESTS : CFG.POST_BLOCK_REQUESTS;
}

// ── Middleware ─────────────────────────────────────────────────────────────
async function orderRateLimitMiddleware(req, res, next) {
  let clientId;
  try {
    clientId = resolveClientId(req, res);
  } catch {
    return res.status(500).json({ ok: false, code: "INTERNAL_ERROR", error: "خطأ في الخادم" });
  }

  const ip  = getIP(req);
  const key = `anon:${clientId}`;
  const now = new Date();

  // ── Upsert record ────────────────────────────────────────────────────────
  let record;
  try {
    record = await OrderRateLimit.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key, clientId,
          level: 0, windowRequests: 0, requestCount: 0,
          totalBlocks: 0, blockDuration: 0,
        },
        $addToSet: { ipHistory: ip },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // Trim ipHistory
    if (record.ipHistory.length > 20) {
      await OrderRateLimit.updateOne({ key }, { $push: { ipHistory: { $each: [], $slice: -20 } } });
    }
  } catch (err) {
    console.error("[RATE_LIMIT] DB unavailable — fail closed:", err.message);
    return res.status(503).json({
      ok: false,
      code: "RATE_LIMITER_UNAVAILABLE",
      error: "خدمة الطلبات غير متاحة مؤقتاً، يرجى المحاولة لاحقاً",
    });
  }

  // ── Currently blocked? ───────────────────────────────────────────────────
  if (record.blockedUntil && record.blockedUntil > now) {
    const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
    console.log(`[ORDER_RATE_LIMIT_BLOCKED] key=${key} ip=${ip} retryAfter=${retryAfter}s`);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      ok: false,
      code: "RATE_LIMITED",
      error: "لقد تجاوزت الحد المسموح للطلبات. يرجى الانتظار ثم المحاولة مرة أخرى.",
      retryAfter,
      blockedUntil: record.blockedUntil.toISOString(),
    });
  }

  // ── Atomic increment ─────────────────────────────────────────────────────
  let updated;
  try {
    updated = await OrderRateLimit.findOneAndUpdate(
      { key },
      { $inc: { windowRequests: 1, requestCount: 1 }, $set: { lastRequestAt: now } },
      { new: true }
    );
  } catch (err) {
    console.error("[RATE_LIMIT] DB error on increment — fail closed:", err.message);
    return res.status(503).json({
      ok: false,
      code: "RATE_LIMITER_UNAVAILABLE",
      error: "خدمة الطلبات غير متاحة مؤقتاً، يرجى المحاولة لاحقاً",
    });
  }

  const currentLevel = updated.level;
  const limit        = windowLimit(currentLevel);

  // ── Over limit → block ───────────────────────────────────────────────────
  if (updated.windowRequests > limit) {
    const blockDuration = calcBlockDuration(currentLevel);
    const blockedUntil  = new Date(now.getTime() + blockDuration * 1000);

    try {
      await OrderRateLimit.updateOne(
        { key },
        {
          $set: { blockedUntil, blockDuration, level: currentLevel + 1, windowRequests: 0 },
          $inc: { totalBlocks: 1 },
        }
      );
    } catch (err) {
      console.error("[RATE_LIMIT] DB error setting block:", err.message);
    }

    console.log(`[ORDER_RATE_LIMIT_BLOCKED] key=${key} ip=${ip} level=${currentLevel} blockDuration=${blockDuration}s`);
    res.set("Retry-After", String(blockDuration));
    return res.status(429).json({
      ok: false,
      code: "RATE_LIMITED",
      error: "لقد تجاوزت الحد المسموح للطلبات. يرجى الانتظار ثم المحاولة مرة أخرى.",
      retryAfter: blockDuration,
      blockedUntil: blockedUntil.toISOString(),
    });
  }

  console.log(`[ORDER_RATE_LIMIT_ACCEPTED] key=${key} ip=${ip} level=${currentLevel} window=${updated.windowRequests}/${limit}`);
  req.rlClientId = clientId;
  next();
}

// ── Status query (used by frontend status endpoint) ────────────────────────
async function getRateLimitStatus(clientId) {
  const key    = `anon:${clientId}`;
  const record = await OrderRateLimit.findOne({ key }).lean();
  if (!record) return { blocked: false };
  const now = new Date();
  if (record.blockedUntil && record.blockedUntil > now) {
    return {
      blocked: true,
      retryAfter: Math.ceil((record.blockedUntil - now) / 1000),
      blockedUntil: record.blockedUntil.toISOString(),
    };
  }
  return { blocked: false };
}

module.exports = { orderRateLimitMiddleware, getRateLimitStatus, resolveClientId, verifyAndExtract, CFG };
