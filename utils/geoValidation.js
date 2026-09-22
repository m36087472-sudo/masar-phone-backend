/**
 * geoValidation.js
 *
 * Server-side geographic validation utilities.
 * Uses @turf/boolean-point-in-polygon for accurate polygon containment testing,
 * including MultiPolygon support (islands, enclaves like Musandam).
 *
 * The country boundary data is loaded ONCE at module level (cached in memory).
 * This avoids per-request parsing overhead and is safe in Serverless environments
 * since the data is a static JS module (not a large parsed GeoJSON file).
 *
 * Coordinate convention: GeoJSON → [longitude, latitude].
 * The @turf API follows this order; we validate inputs to avoid common lon/lat swap bugs.
 *
 * Dependencies: @turf/boolean-point-in-polygon, @turf/helpers
 */

"use strict";

const booleanPointInPolygon = require("@turf/boolean-point-in-polygon").default
  || require("@turf/boolean-point-in-polygon");
const { point: turfPoint } = require("@turf/helpers");
const { isInBoundingBox, getCountryFeature } = require("../data/country-boundaries");
const { SUPPORTED_COUNTRY_CODES } = require("../config/countries");

// ── Coordinate validation ────────────────────────────────────────────────────

/**
 * Validate that latitude and longitude values are well-formed.
 * Rejects NaN, Infinity, strings, out-of-range values.
 *
 * @param {*} lat  Latitude  (must be -90..90)
 * @param {*} lon  Longitude (must be -180..180)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCoords(lat, lon) {
  if (lat === undefined || lat === null || lon === undefined || lon === null) {
    return { valid: false, error: "الإحداثيات مطلوبة (خط العرض وخط الطول)" };
  }

  const latNum = Number(lat);
  const lonNum = Number(lon);

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return { valid: false, error: "الإحداثيات يجب أن تكون أرقامًا صالحة" };
  }

  if (latNum < -90 || latNum > 90) {
    return { valid: false, error: "خط العرض يجب أن يكون بين -90 و90" };
  }

  if (lonNum < -180 || lonNum > 180) {
    return { valid: false, error: "خط الطول يجب أن يكون بين -180 و180" };
  }

  // Sanity check: coordinates of (0,0) are the Gulf of Guinea — obviously wrong
  // for Gulf countries. Log but don't reject (could be future expansion).
  if (latNum === 0 && lonNum === 0) {
    return { valid: false, error: "الإحداثيات غير صالحة (0, 0)" };
  }

  return { valid: true };
}

// ── Point-in-country check ───────────────────────────────────────────────────

/**
 * Check whether a geographic point is inside a supported country.
 *
 * Strategy:
 *  1. Validate coordinate range.
 *  2. Fast bounding-box pre-check (O(1)) to reject obvious out-of-country points.
 *  3. Accurate polygon containment test via @turf/boolean-point-in-polygon
 *     (handles Polygon AND MultiPolygon — required for Oman's Musandam exclave).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} countryCode  e.g. "SA", "KW"
 * @returns {{ inside: boolean, error?: string }}
 */
function isPointInCountry(lat, lon, countryCode) {
  // 1. Coordinate validation
  const coordCheck = validateCoords(lat, lon);
  if (!coordCheck.valid) return { inside: false, error: coordCheck.error };

  // 2. Supported country check
  if (!SUPPORTED_COUNTRY_CODES.includes(countryCode)) {
    return { inside: false, error: `الدولة ${countryCode} غير مدعومة` };
  }

  const latNum = Number(lat);
  const lonNum = Number(lon);

  // 3. Fast bbox pre-check
  if (!isInBoundingBox(lonNum, latNum, countryCode)) {
    return { inside: false, error: buildOutsideError(countryCode) };
  }

  // 4. Accurate polygon check
  const feature = getCountryFeature(countryCode);
  if (!feature) {
    // Should never happen for supported countries; fail safe
    return { inside: false, error: "بيانات الحدود غير متوفرة، يرجى إدخال العنوان يدويًا" };
  }

  try {
    const pt = turfPoint([lonNum, latNum]); // [lon, lat] — GeoJSON standard
    const inside = booleanPointInPolygon(pt, feature);
    if (!inside) {
      return { inside: false, error: buildOutsideError(countryCode) };
    }
    return { inside: true };
  } catch (err) {
    // Defensive: if @turf throws, don't block the order — just skip geo-validation
    console.error("[GEO_VALIDATION_ERROR]", err?.message);
    return { inside: false, error: "فشل التحقق من الموقع، يرجى المحاولة أو إدخال العنوان يدويًا" };
  }
}

// ── Error messages ────────────────────────────────────────────────────────────

const COUNTRY_NAME_AR = {
  SA: "المملكة العربية السعودية",
  AE: "الإمارات العربية المتحدة",
  QA: "قطر",
  KW: "الكويت",
  OM: "سلطنة عُمان",
};

function buildOutsideError(countryCode) {
  const name = COUNTRY_NAME_AR[countryCode] || countryCode;
  return `الموقع المختار خارج ${name}. اختر موقعًا داخل ${name} للمتابعة.`;
}

// ── Exported helpers ──────────────────────────────────────────────────────────

module.exports = { validateCoords, isPointInCountry, buildOutsideError, COUNTRY_NAME_AR };
