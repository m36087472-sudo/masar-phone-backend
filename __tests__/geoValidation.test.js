/**
 * Geo-validation unit tests.
 *
 * Covers:
 * 1.  Complete flow with manual address (no coords)       → validateCoords skipped
 * 2.  Point inside Saudi Arabia                           → inside: true
 * 3.  Point outside Saudi Arabia (Iran)                   → inside: false
 * 4.  Point inside bbox of SA but outside polygon (Gulf)  → inside: false
 * 5.  Kuwait island / border area                         → inside: true
 * 6.  Oman Musandam exclave                               → inside: true
 * 7.  NaN coordinates                                     → valid: false
 * 8.  Infinity coordinates                                → valid: false
 * 9.  Out-of-range latitude > 90                          → valid: false
 * 10. Unsupported country code                            → inside: false
 * 11. Both lat/lon = 0 (Gulf of Guinea)                   → valid: false
 */

"use strict";

const {
  validateCoords,
  isPointInCountry,
} = require("../utils/geoValidation");

describe("validateCoords", () => {
  test("valid Saudi coordinates", () => {
    expect(validateCoords(24.7, 46.7)).toEqual({ valid: true });
  });

  test("rejects NaN latitude", () => {
    const r = validateCoords(NaN, 46.7);
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("rejects Infinity longitude", () => {
    const r = validateCoords(24.7, Infinity);
    expect(r.valid).toBe(false);
  });

  test("rejects latitude > 90", () => {
    const r = validateCoords(91, 46.7);
    expect(r.valid).toBe(false);
  });

  test("rejects latitude < -90", () => {
    const r = validateCoords(-91, 46.7);
    expect(r.valid).toBe(false);
  });

  test("rejects (0, 0) — Gulf of Guinea", () => {
    const r = validateCoords(0, 0);
    expect(r.valid).toBe(false);
  });

  test("rejects null values", () => {
    const r = validateCoords(null, null);
    expect(r.valid).toBe(false);
  });

  test("rejects undefined values", () => {
    const r = validateCoords(undefined, undefined);
    expect(r.valid).toBe(false);
  });
});

describe("isPointInCountry — Saudi Arabia", () => {
  test("Riyadh center is inside SA", () => {
    const r = isPointInCountry(24.69, 46.72, "SA");
    expect(r.inside).toBe(true);
  });

  test("Jeddah is inside SA", () => {
    const r = isPointInCountry(21.49, 39.19, "SA");
    expect(r.inside).toBe(true);
  });

  test("Tehran (Iran) is outside SA", () => {
    const r = isPointInCountry(35.69, 51.39, "SA");
    expect(r.inside).toBe(false);
    expect(r.error).toMatch(/خارج/);
  });

  test("Point in middle of Arabian Gulf (inside SA bbox) is outside SA polygon", () => {
    // ~26°N, 50°E — sea between Saudi and Bahrain, inside SA bounding box
    const r = isPointInCountry(26.5, 50.3, "SA");
    expect(r.inside).toBe(false);
  });
});

describe("isPointInCountry — UAE", () => {
  test("Dubai is inside AE", () => {
    const r = isPointInCountry(25.2, 55.27, "AE");
    expect(r.inside).toBe(true);
  });

  test("Muscat (Oman) is outside AE", () => {
    const r = isPointInCountry(23.61, 58.59, "AE");
    expect(r.inside).toBe(false);
  });
});

describe("isPointInCountry — Qatar", () => {
  test("Doha is inside QA", () => {
    const r = isPointInCountry(25.28, 51.53, "QA");
    expect(r.inside).toBe(true);
  });

  test("Bahrain is outside QA", () => {
    const r = isPointInCountry(26.22, 50.59, "QA");
    expect(r.inside).toBe(false);
  });
});

describe("isPointInCountry — Kuwait", () => {
  test("Kuwait City is inside KW", () => {
    const r = isPointInCountry(29.37, 47.98, "KW");
    expect(r.inside).toBe(true);
  });

  test("Basra (Iraq) is outside KW", () => {
    const r = isPointInCountry(30.51, 47.78, "KW");
    expect(r.inside).toBe(false);
  });
});

describe("isPointInCountry — Oman (MultiPolygon)", () => {
  test("Muscat main territory is inside OM", () => {
    const r = isPointInCountry(23.61, 58.59, "OM");
    expect(r.inside).toBe(true);
  });

  test("Musandam exclave (Khasab) is inside OM", () => {
    // Khasab: ~26.2°N, 56.25°E — part of Oman separated from main territory
    const r = isPointInCountry(26.18, 56.25, "OM");
    expect(r.inside).toBe(true);
  });

  test("Dubai is outside OM", () => {
    const r = isPointInCountry(25.2, 55.27, "OM");
    expect(r.inside).toBe(false);
  });
});

describe("isPointInCountry — edge cases", () => {
  test("unsupported country code returns error", () => {
    const r = isPointInCountry(24.7, 46.7, "XX");
    expect(r.inside).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("NaN coordinates returns error without throwing", () => {
    const r = isPointInCountry(NaN, NaN, "SA");
    expect(r.inside).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("coordinates inside bounding box but outside polygon", () => {
    // Red Sea: ~22°N, 38°E — inside SA bbox but sea, outside polygon
    const r = isPointInCountry(22.0, 37.5, "SA");
    expect(r.inside).toBe(false);
  });
});
