/**
 * phone.js — Country-aware phone number utility (backend / Node.js)
 *
 * Mirror of frontend/app/lib/phone.ts — same logic, CommonJS.
 * Supports: SA | AE | KW | QA | OM
 *
 * Usage:
 *   const { validatePhone, toE164, normalizePhone } = require("./utils/phone");
 *   const result = validatePhone("0551234567", "SA");
 *   // { valid: true, e164: "+966551234567", local: "0551234567" }
 */

"use strict";

// ── Per-country configuration ─────────────────────────────────────────────

const PHONE_CONFIG = {
  SA: {
    code: "SA",
    callingCode: "966",
    callingCodeDisplay: "+966",
    localLength: 10,
    localRegex: /^05[0-9]{8}$/,
    example: "05XXXXXXXX",
    errorMsg: "يرجى إدخال رقم جوال سعودي صحيح مثل 05XXXXXXXX",
    placeholder: "05XXXXXXXX",
    inputMaxLength: 10,
  },
  AE: {
    code: "AE",
    callingCode: "971",
    callingCodeDisplay: "+971",
    localLength: 10,
    localRegex: /^0(50|52|54|55|56|58)[0-9]{7}$/,
    example: "05XXXXXXXX",
    errorMsg: "يرجى إدخال رقم جوال إماراتي صحيح مثل 05XXXXXXXX",
    placeholder: "05XXXXXXXX",
    inputMaxLength: 10,
  },
  KW: {
    code: "KW",
    callingCode: "965",
    callingCodeDisplay: "+965",
    localLength: 8,
    localRegex: /^[456789][0-9]{7}$/,
    example: "5XXXXXXX",
    errorMsg: "يرجى إدخال رقم جوال كويتي صحيح مكون من 8 أرقام",
    placeholder: "5XXXXXXX",
    inputMaxLength: 8,
  },
  QA: {
    code: "QA",
    callingCode: "974",
    callingCodeDisplay: "+974",
    localLength: 8,
    localRegex: /^[3567][0-9]{7}$/,
    example: "5XXXXXXX",
    errorMsg: "يرجى إدخال رقم جوال قطري صحيح مكون من 8 أرقام",
    placeholder: "5XXXXXXX",
    inputMaxLength: 8,
  },
  OM: {
    code: "OM",
    callingCode: "968",
    callingCodeDisplay: "+968",
    localLength: 8,
    localRegex: /^[79][0-9]{7}$/,
    example: "9XXXXXXX",
    errorMsg: "يرجى إدخال رقم جوال عماني صحيح مكون من 8 أرقام",
    placeholder: "9XXXXXXX",
    inputMaxLength: 8,
  },
};

// ── Arabic → ASCII digit map ──────────────────────────────────────────────

const AR_DIGITS = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

// ── Step 1: normalize ─────────────────────────────────────────────────────

/**
 * Strip whitespace, dashes, parens; convert Arabic digits; unify 00xxx → +xxx.
 * Returns a string containing only digits and an optional leading '+'.
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw);

  // Convert Arabic-Indic digits
  s = s.replace(/[٠-٩]/g, (d) => AR_DIGITS[d] ?? d);

  // Remove all whitespace, dashes, dots, parens
  s = s.replace(/[\s\-().]/g, "");

  // Unify 00 prefix → +
  if (s.startsWith("00")) s = "+" + s.slice(2);

  // Remove any remaining non-digit chars except leading +
  s = s.replace(/(?!^\+)[^\d]/g, "");

  return s;
}

// ── Step 2: strip country code → local digits ─────────────────────────────

function toLocal(normalized, cfg) {
  const cc = cfg.callingCode;

  // +966XXXXXXXXX
  if (normalized.startsWith("+" + cc)) {
    const candidate = normalized.slice(1 + cc.length);
    // Already full local length
    if (candidate.length === cfg.localLength) return candidate;
    // Short form (no leading 0) — SA/AE: add 0
    if (cfg.localRegex.source.startsWith("^0") && candidate.length === cfg.localLength - 1) {
      return "0" + candidate;
    }
    return candidate;
  }

  // 966XXXXXXXXX (no + prefix, but starts with calling code)
  if (normalized.startsWith(cc) && !normalized.startsWith("+")) {
    const candidate = normalized.slice(cc.length);
    if (candidate.length === cfg.localLength) return candidate;
    if (cfg.localRegex.source.startsWith("^0") && candidate.length === cfg.localLength - 1) {
      return "0" + candidate;
    }
  }

  // Already local length
  if (normalized.length === cfg.localLength) return normalized;

  // Short form: SA/AE "5XXXXXXXX" (9 digits) → prepend "0"
  if (
    cfg.localRegex.source.startsWith("^0") &&
    normalized.length === cfg.localLength - 1 &&
    !normalized.startsWith("0")
  ) {
    return "0" + normalized;
  }

  return normalized;
}

// ── Step 3: validate ──────────────────────────────────────────────────────

/**
 * Validate a phone number for a given country code.
 *
 * @param {string|null|undefined} raw
 * @param {string} country  — "SA" | "AE" | "KW" | "QA" | "OM"
 * @returns {{ valid: boolean, e164?: string, local?: string, error?: string }}
 */
function validatePhone(raw, country) {
  const cfg = PHONE_CONFIG[country];

  // Unknown / unsupported country — permissive fallback
  if (!cfg) {
    const digits = normalizePhone(raw).replace(/\D/g, "");
    if (!digits || digits.length < 7) {
      return { valid: false, error: "رقم الجوال غير صحيح" };
    }
    return { valid: true, e164: digits, local: digits };
  }

  const normalized = normalizePhone(raw);

  if (!normalized) {
    return { valid: false, error: "رقم الجوال مطلوب" };
  }

  const local = toLocal(normalized, cfg);

  if (!cfg.localRegex.test(local)) {
    return { valid: false, error: cfg.errorMsg, local };
  }

  return {
    valid: true,
    e164: toE164(local, cfg),
    local,
  };
}

// ── Step 4: toE164 ────────────────────────────────────────────────────────

/**
 * Convert local digits to E.164.
 * "0551234567" (SA) → "+966551234567"
 * "51234567"   (KW) → "+96551234567"
 *
 * @param {string} local
 * @param {object} cfg
 * @returns {string}
 */
function toE164(local, cfg) {
  const digits = local.startsWith("0") ? local.slice(1) : local;
  return `+${cfg.callingCode}${digits}`;
}

/**
 * Resolve a country config, returning null for unsupported countries.
 * @param {string} country
 * @returns {object|null}
 */
function getPhoneConfig(country) {
  return PHONE_CONFIG[country] ?? null;
}

// ── exports ───────────────────────────────────────────────────────────────

module.exports = {
  PHONE_CONFIG,
  normalizePhone,
  validatePhone,
  toE164,
  getPhoneConfig,
};
