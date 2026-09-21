/**
 * Central config for supported countries and currencies.
 * Single source of truth shared across models, routes, and migration scripts.
 *
 * Decimal places:
 *   SAR, QAR, AED  → 2 decimal places
 *   KWD, OMR       → 3 decimal places
 */

const COUNTRIES = {
  SA: { code: "SA", currency: "SAR", nameAr: "السعودية",  flag: "🇸🇦", decimals: 2 },
  AE: { code: "AE", currency: "AED", nameAr: "الإمارات",  flag: "🇦🇪", decimals: 2 },
  QA: { code: "QA", currency: "QAR", nameAr: "قطر",       flag: "🇶🇦", decimals: 2 },
  KW: { code: "KW", currency: "KWD", nameAr: "الكويت",    flag: "🇰🇼", decimals: 3 },
  OM: { code: "OM", currency: "OMR", nameAr: "عُمان",     flag: "🇴🇲", decimals: 3 },
};

/** Ordered list for UI display */
const COUNTRY_LIST = [
  COUNTRIES.SA,
  COUNTRIES.AE,
  COUNTRIES.QA,
  COUNTRIES.KW,
  COUNTRIES.OM,
];

/** All supported country codes */
const SUPPORTED_COUNTRY_CODES = COUNTRY_LIST.map((c) => c.code);

/** All supported currency codes */
const SUPPORTED_CURRENCIES = COUNTRY_LIST.map((c) => c.currency);

/** Map from currency code → country config */
const CURRENCY_MAP = {};
for (const c of COUNTRY_LIST) CURRENCY_MAP[c.currency] = c;

/** Default/fallback country */
const DEFAULT_COUNTRY = COUNTRIES.SA;

/**
 * Resolve country config from a country code string.
 * Falls back to SA if unrecognised.
 * @param {string} code
 */
function resolveCountry(code) {
  return COUNTRIES[code] || DEFAULT_COUNTRY;
}

/**
 * Validate that a price value is a safe non-negative finite number.
 * @param {*} val
 */
function isValidPrice(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Round a number to the correct decimal places for the given currency.
 * Uses "round half away from zero" to avoid floating-point drift.
 * @param {number} amount
 * @param {string} currency  e.g. "SAR"
 */
function roundPrice(amount, currency) {
  const decimals = (CURRENCY_MAP[currency] || DEFAULT_COUNTRY).decimals;
  const factor = Math.pow(10, decimals);
  return Math.round(amount * factor) / factor;
}

module.exports = {
  COUNTRIES,
  COUNTRY_LIST,
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_CURRENCIES,
  CURRENCY_MAP,
  DEFAULT_COUNTRY,
  resolveCountry,
  isValidPrice,
  roundPrice,
};
