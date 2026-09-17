/**
 * ADMIN PRODUCTS — PERFORMANCE & LOAD AUDIT
 * ==========================================
 * يقيس: response time, CPU, memory, DB queries, concurrent load
 * تشغيل: npm test -- audit-products.test.js
 *
 * المتطلبات: backend شغال على localhost:5000 + admin_token صحيح
 */

require("dotenv").config();
const http = require("http");
const https = require("https");
const { performance } = require("perf_hooks");
const os = require("os");

// ─── Config ───────────────────────────────────────────────
const BASE = process.env.AUDIT_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.AUDIT_ADMIN_EMAIL || "admin@masar.com";
const ADMIN_PASS = process.env.AUDIT_ADMIN_PASS || "Masar@2024";
// ⚠️  إذا فشل الـ login، غيّر AUDIT_ADMIN_PASS في .env أو مرره كـ env variable:
//    AUDIT_ADMIN_PASS="yourpassword" npx jest audit-products.test.js
const REPEAT = 5; // كم مرة نكرر كل request لحساب average
const CONCURRENT = [1, 5, 10, 20]; // مستويات الـ concurrent load

// ─── State ────────────────────────────────────────────────
let adminCookie = "";
let testProductId = "";
const results = [];

// ─── Helpers ──────────────────────────────────────────────
function request(method, path, { body, cookie, isForm } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    let bodyBuf = null;
    const headers = { Cookie: cookie || adminCookie };

    if (body && !isForm) {
      bodyBuf = Buffer.from(JSON.stringify(body));
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = bodyBuf.length;
    }

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    const start = performance.now();
    const cpuBefore = process.cpuUsage();
    const memBefore = process.memoryUsage().heapUsed;

    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const elapsed = performance.now() - start;
        const cpuDelta = process.cpuUsage(cpuBefore);
        const memDelta = process.memoryUsage().heapUsed - memBefore;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({
          status: res.status || res.statusCode,
          time: Math.round(elapsed),
          size: Buffer.byteLength(data, "utf8"),
          cpu: Math.round((cpuDelta.user + cpuDelta.system) / 1000), // ms
          memDelta: Math.round(memDelta / 1024), // KB
          body: parsed,
          raw: data,
        });
      });
    });

    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function repeat(fn, n = REPEAT) {
  const times = [];
  const cpus = [];
  const mems = [];
  let last;
  for (let i = 0; i < n; i++) {
    last = await fn();
    times.push(last.time);
    cpus.push(last.cpu);
    mems.push(last.memDelta);
  }
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const min = (arr) => Math.min(...arr);
  const max = (arr) => Math.max(...arr);
  return {
    ...last,
    avg_time: avg(times),
    min_time: min(times),
    max_time: max(times),
    avg_cpu: avg(cpus),
    avg_mem_kb: avg(mems),
    samples: times,
  };
}

async function concurrent(fn, n) {
  const start = performance.now();
  const cpuBefore = process.cpuUsage();
  const all = await Promise.all(Array.from({ length: n }, () => fn()));
  const elapsed = performance.now() - start;
  const cpuDelta = process.cpuUsage(cpuBefore);
  const times = all.map((r) => r.time);
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  return {
    concurrency: n,
    wall_time: Math.round(elapsed),
    avg_time: avg(times),
    min_time: Math.min(...times),
    max_time: Math.max(...times),
    errors: all.filter((r) => r.status >= 400).length,
    cpu_ms: Math.round((cpuDelta.user + cpuDelta.system) / 1000),
  };
}

function record(label, data) {
  results.push({ label, ...data });
}

function printTable(rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length))
  );
  const line = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const header = keys.map((k, i) => k.padEnd(widths[i])).join(" │ ");
  console.log("┌" + line.replace(/┼/g, "┬") + "┐");
  console.log("│ " + header + " │");
  console.log("├" + line + "┤");
  for (const row of rows) {
    const cells = keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join(" │ ");
    console.log("│ " + cells + " │");
  }
  console.log("└" + line.replace(/┼/g, "┴") + "┘");
}

// ─── Setup ────────────────────────────────────────────────
beforeAll(async () => {
  const url = new URL(BASE + "/api/admin/login");
  const lib = url.protocol === "https:" ? https : http;
  const bodyStr = JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS });

  adminCookie = await new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: "/api/admin/login",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const setCookie = res.headers["set-cookie"] || [];
        const tokenCookie = setCookie.find((c) => c.startsWith("admin_token="));
        if (tokenCookie) {
          resolve(tokenCookie.split(";")[0]);
        } else {
          // fallback: حاول تولد token مباشرة
          try {
            const parsed = JSON.parse(data);
            if (parsed.success === false || res.statusCode !== 200) {
              reject(new Error(`Login failed: ${data}`));
            } else {
              reject(new Error(`No Set-Cookie header. Response: ${data}`));
            }
          } catch {
            reject(new Error(`Login failed. Status: ${res.statusCode}, Body: ${data}`));
          }
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });

  if (!adminCookie) throw new Error("Failed to get admin cookie");
  console.log(`  ✅ Login OK — cookie: ${adminCookie.substring(0, 30)}...`);
}, 20000);

afterAll(() => {
  console.log("\n");
  console.log("═".repeat(70));
  console.log("  ADMIN PRODUCTS — PERFORMANCE AUDIT REPORT");
  console.log("═".repeat(70));

  // Response Time Table
  const timeRows = results
    .filter((r) => r.avg_time !== undefined)
    .map((r) => ({
      Endpoint: r.label,
      Status: r.status,
      "Avg(ms)": r.avg_time,
      "Min(ms)": r.min_time,
      "Max(ms)": r.max_time,
      "Size(KB)": r.size ? Math.round(r.size / 1024) : 0,
      "CPU(ms)": r.avg_cpu,
      "Mem(KB)": r.avg_mem_kb,
    }));

  if (timeRows.length) {
    console.log("\n📊 RESPONSE TIME & RESOURCE USAGE\n");
    printTable(timeRows);
  }

  // Concurrent Load Table
  const loadRows = results
    .filter((r) => r.concurrency !== undefined)
    .map((r) => ({
      Endpoint: r.label,
      Concurrency: r.concurrency,
      "Wall(ms)": r.wall_time,
      "Avg(ms)": r.avg_time,
      "Min(ms)": r.min_time,
      "Max(ms)": r.max_time,
      Errors: r.errors,
      "CPU(ms)": r.cpu_ms,
    }));

  if (loadRows.length) {
    console.log("\n⚡ CONCURRENT LOAD TEST\n");
    printTable(loadRows);
  }

  // Summary
  const slowest = timeRows.sort((a, b) => b["Avg(ms)"] - a["Avg(ms)"])[0];
  const heaviest = timeRows.sort((a, b) => b["CPU(ms)"] - a["CPU(ms)"])[0];
  const largest = timeRows.sort((a, b) => b["Size(KB)"] - a["Size(KB)"])[0];

  console.log("\n🔴 HOTSPOTS");
  if (slowest) console.log(`  Slowest:  ${slowest.Endpoint} — ${slowest["Avg(ms)"]}ms avg`);
  if (heaviest) console.log(`  CPU:      ${heaviest.Endpoint} — ${heaviest["CPU(ms)"]}ms cpu`);
  if (largest) console.log(`  Largest:  ${largest.Endpoint} — ${largest["Size(KB)"]}KB`);

  console.log("\n  System Info:");
  console.log(`  Node:     ${process.version}`);
  console.log(`  CPUs:     ${os.cpus().length}x ${os.cpus()[0]?.model}`);
  console.log(`  RAM:      ${Math.round(os.totalmem() / 1024 / 1024)}MB total`);
  console.log(`  Free RAM: ${Math.round(os.freemem() / 1024 / 1024)}MB`);
  console.log("═".repeat(70) + "\n");
});

// ─── Tests ────────────────────────────────────────────────

describe("1. AUTH — Login & Token", () => {
  test("POST /api/admin/login — valid credentials (already done in beforeAll)", async () => {
    expect(adminCookie).toMatch(/^admin_token=/);
    console.log(`  Cookie acquired: ${adminCookie.substring(0, 40)}...`);
  });

  test("POST /api/admin/login — wrong password", async () => {
    const r = await request("POST", "/api/admin/login", {
      body: { email: ADMIN_EMAIL, password: "wrongpassword" },
      cookie: "",
    });
    expect([401, 423]).toContain(r.status);
    console.log(`  Wrong login: ${r.time}ms, status: ${r.status}`);
  }, 10000);
});

describe("2. PRODUCTS LIST — GET /api/admin/products", () => {
  test(`repeated ${REPEAT}x — avg response time`, async () => {
    const r = await repeat(() => request("GET", "/api/admin/products"));
    record("GET /admin/products", r);
    expect(r.status).toBe(200);
    const count = Array.isArray(r.body) ? r.body.length : "?";
    console.log(`  Products count: ${count}`);
    console.log(`  Avg: ${r.avg_time}ms | Min: ${r.min_time}ms | Max: ${r.max_time}ms`);
    console.log(`  Size: ${Math.round(r.size / 1024)}KB | CPU: ${r.avg_cpu}ms`);
    if (Array.isArray(r.body) && r.body.length > 0) {
      testProductId = r.body[0]._id;
    }
  }, 60000);

  test("response shape — only required fields", async () => {
    const r = await request("GET", "/api/admin/products");
    expect(r.status).toBe(200);
    if (Array.isArray(r.body) && r.body.length > 0) {
      const p = r.body[0];
      const fields = Object.keys(p);
      console.log(`  Fields returned: ${fields.join(", ")}`);
      // يجب ألا يرجع description أو sections أو specGroups
      expect(fields).not.toContain("description");
      expect(fields).not.toContain("sections");
      expect(fields).not.toContain("specGroups");
    }
  }, 10000);

  test("payload size per product", async () => {
    const r = await request("GET", "/api/admin/products");
    if (Array.isArray(r.body) && r.body.length > 0) {
      const perProduct = Math.round(r.size / r.body.length);
      console.log(`  Per-product size: ~${perProduct} bytes`);
      console.log(`  Total payload: ${Math.round(r.size / 1024)}KB for ${r.body.length} products`);
    }
  }, 10000);
});

describe("3. PRODUCT FORM DATA — GET /api/admin/product-form-data", () => {
  test(`repeated ${REPEAT}x — unified endpoint`, async () => {
    const r = await repeat(() => request("GET", "/api/admin/product-form-data"));
    record("GET /product-form-data", r);
    expect(r.status).toBe(200);
    console.log(`  Categories: ${r.body?.categories?.length ?? 0}`);
    console.log(`  SubCategories: ${r.body?.subCategories?.length ?? 0}`);
    console.log(`  Avg: ${r.avg_time}ms | CPU: ${r.avg_cpu}ms`);
  }, 60000);
});

describe("4. PRODUCT DETAIL — GET /api/admin/products/:id", () => {
  test(`repeated ${REPEAT}x — single product`, async () => {
    if (!testProductId) return console.log("  Skipped — no product ID");
    const r = await repeat(() =>
      request("GET", `/api/admin/products/${testProductId}`)
    );
    record(`GET /admin/products/:id`, r);
    expect(r.status).toBe(200);
    console.log(`  Avg: ${r.avg_time}ms | Size: ${Math.round(r.size / 1024)}KB | CPU: ${r.avg_cpu}ms`);
  }, 60000);

  test("invalid ID — 404 response time", async () => {
    const r = await request("GET", "/api/admin/products/000000000000000000000000");
    expect(r.status).toBe(404);
    console.log(`  404 response: ${r.time}ms`);
  }, 10000);
});

describe("5. SUB-CATEGORIES — GET /api/admin/sub-categories", () => {
  test(`repeated ${REPEAT}x — aggregation cost`, async () => {
    const r = await repeat(() => request("GET", "/api/admin/sub-categories"));
    record("GET /sub-categories", r);
    expect(r.status).toBe(200);
    console.log(`  Avg: ${r.avg_time}ms | CPU: ${r.avg_cpu}ms`);
    console.log(`  Count: ${Array.isArray(r.body) ? r.body.length : "?"}`);
  }, 60000);
});

describe("6. ORDERS COUNT — GET /api/admin/orders/count", () => {
  test(`repeated ${REPEAT}x — navbar polling endpoint`, async () => {
    const r = await repeat(() => request("GET", "/api/admin/orders/count"));
    record("GET /orders/count", r);
    expect(r.status).toBe(200);
    console.log(`  Count: ${r.body?.count}`);
    console.log(`  Avg: ${r.avg_time}ms | CPU: ${r.avg_cpu}ms`);
  }, 30000);
});

describe("7. COMPANY — GET /api/admin/company", () => {
  test(`repeated ${REPEAT}x — navbar logo fetch`, async () => {
    const r = await repeat(() => request("GET", "/api/admin/company"));
    record("GET /company", r);
    expect(r.status).toBe(200);
    console.log(`  Avg: ${r.avg_time}ms | Size: ${Math.round(r.size / 1024)}KB`);
  }, 30000);
});

describe("8. BLACKLIST CACHE — isBlacklisted performance", () => {
  test("repeated auth requests — cache should reduce DB hits", async () => {
    // أول request يضرب DB، الباقي من الـ cache
    const times = [];
    for (let i = 0; i < 10; i++) {
      const r = await request("GET", "/api/admin/orders/count");
      times.push(r.time);
    }
    const first = times[0];
    const rest = times.slice(1);
    const avgRest = Math.round(rest.reduce((a, b) => a + b, 0) / rest.length);
    console.log(`  First request: ${first}ms`);
    console.log(`  Avg subsequent (cached): ${avgRest}ms`);
    console.log(`  Cache speedup: ${first > avgRest ? `~${Math.round(first / avgRest)}x faster` : "similar"}`);
    record("Auth cache (10 requests)", {
      status: 200,
      avg_time: avgRest,
      min_time: Math.min(...rest),
      max_time: Math.max(...rest),
      size: 0,
      avg_cpu: 0,
      avg_mem_kb: 0,
      samples: rest,
    });
  }, 30000);
});

describe("9. CONCURRENT LOAD TEST", () => {
  for (const n of CONCURRENT) {
    test(`GET /api/admin/products — ${n} concurrent requests`, async () => {
      const r = await concurrent(() => request("GET", "/api/admin/products"), n);
      record(`GET /products (x${n})`, r);
      console.log(`  [x${n}] wall: ${r.wall_time}ms | avg: ${r.avg_time}ms | errors: ${r.errors} | cpu: ${r.cpu_ms}ms`);
      expect(r.errors).toBe(0);
    }, 60000);
  }

  for (const n of CONCURRENT) {
    test(`GET /api/admin/product-form-data — ${n} concurrent`, async () => {
      const r = await concurrent(() => request("GET", "/api/admin/product-form-data"), n);
      record(`GET /product-form-data (x${n})`, r);
      console.log(`  [x${n}] wall: ${r.wall_time}ms | avg: ${r.avg_time}ms | errors: ${r.errors}`);
      expect(r.errors).toBe(0);
    }, 60000);
  }

  test("GET /api/admin/orders/count — 20 concurrent (polling simulation)", async () => {
    const r = await concurrent(() => request("GET", "/api/admin/orders/count"), 20);
    record("GET /orders/count (x20)", r);
    console.log(`  [x20] wall: ${r.wall_time}ms | avg: ${r.avg_time}ms | errors: ${r.errors}`);
    expect(r.errors).toBe(0);
  }, 30000);
});

describe("10. PRODUCT CREATE — POST /api/admin/products", () => {
  let createdId = "";

  test("create product — response time", async () => {
    const start = performance.now();
    const cpuBefore = process.cpuUsage();

    const r = await request("POST", "/api/admin/products", {
      body: {
        name: `[AUDIT TEST] ${Date.now()}`,
        originalPrice: 999,
        category: "audit-test",
        inStock: true,
      },
    });

    const elapsed = Math.round(performance.now() - start);
    const cpuDelta = process.cpuUsage(cpuBefore);
    const cpuMs = Math.round((cpuDelta.user + cpuDelta.system) / 1000);

    record("POST /admin/products", {
      status: r.status,
      avg_time: elapsed,
      min_time: elapsed,
      max_time: elapsed,
      size: r.size,
      avg_cpu: cpuMs,
      avg_mem_kb: 0,
      samples: [elapsed],
    });

    expect(r.status).toBe(201);
    createdId = r.body?._id;
    console.log(`  Create: ${elapsed}ms | CPU: ${cpuMs}ms | ID: ${createdId}`);
  }, 30000);

  test("update product — findByIdAndUpdate cost", async () => {
    if (!createdId) return console.log("  Skipped — no created ID");
    const r = await repeat(() =>
      request("PUT", `/api/admin/products/${createdId}`, {
        body: { name: `[AUDIT TEST UPDATED] ${Date.now()}`, originalPrice: 1099 },
      })
    );
    record("PUT /admin/products/:id", r);
    expect(r.status).toBe(200);
    console.log(`  Update avg: ${r.avg_time}ms | CPU: ${r.avg_cpu}ms`);
  }, 60000);

  test("delete product — cleanup", async () => {
    if (!createdId) return console.log("  Skipped — no created ID");
    const r = await request("DELETE", `/api/admin/products/${createdId}`);
    expect(r.status).toBe(200);
    console.log(`  Delete: ${r.time}ms`);
    record("DELETE /admin/products/:id", {
      status: r.status,
      avg_time: r.time,
      min_time: r.time,
      max_time: r.time,
      size: r.size,
      avg_cpu: r.cpu,
      avg_mem_kb: r.memDelta,
      samples: [r.time],
    });
  }, 15000);
});

describe("11. SEARCH — GET /api/products?q=", () => {
  const queries = ["i", "ip", "iph", "ipho", "iphone"];

  test("search per character — request count & time", async () => {
    const rows = [];
    for (const q of queries) {
      const r = await request("GET", `/api/products?q=${encodeURIComponent(q)}`);
      rows.push({
        query: `"${q}"`,
        status: r.status,
        time_ms: r.time,
        results: Array.isArray(r.body) ? r.body.length : "?",
        size_kb: Math.round(r.size / 1024),
      });
    }
    console.log("\n  Search per character:");
    printTable(rows);
    // كل حرف = request منفصل — يجب أن يكون هناك debounce
    console.log(`\n  ⚠️  ${queries.length} requests for typing "iphone" — debounce needed`);
  }, 30000);

  test("search with no results", async () => {
    const r = await request("GET", "/api/products?q=xyznotexist999");
    expect(r.status).toBe(200);
    console.log(`  Empty search: ${r.time}ms | results: ${Array.isArray(r.body) ? r.body.length : "?"}`);
  }, 10000);
});

describe("12. MEMORY & PAYLOAD ANALYSIS", () => {
  test("products list — memory footprint", async () => {
    const before = process.memoryUsage();
    const r = await request("GET", "/api/admin/products");
    const after = process.memoryUsage();

    console.log(`  Heap before: ${Math.round(before.heapUsed / 1024 / 1024)}MB`);
    console.log(`  Heap after:  ${Math.round(after.heapUsed / 1024 / 1024)}MB`);
    console.log(`  Delta:       ${Math.round((after.heapUsed - before.heapUsed) / 1024)}KB`);
    console.log(`  RSS:         ${Math.round(after.rss / 1024 / 1024)}MB`);
    console.log(`  Payload:     ${Math.round(r.size / 1024)}KB`);
  }, 15000);

  test("system CPU load during burst", async () => {
    const loadBefore = os.loadavg();
    await concurrent(() => request("GET", "/api/admin/products"), 10);
    const loadAfter = os.loadavg();
    console.log(`  Load avg before: [${loadBefore.map((l) => l.toFixed(2)).join(", ")}]`);
    console.log(`  Load avg after:  [${loadAfter.map((l) => l.toFixed(2)).join(", ")}]`);
  }, 30000);
});

describe("13. ERROR HANDLING — edge cases", () => {
  test("GET /api/admin/products/:id — malformed ID", async () => {
    const r = await request("GET", "/api/admin/products/not-a-valid-id");
    expect([400, 404, 500]).toContain(r.status);
    console.log(`  Malformed ID: status=${r.status}, time=${r.time}ms, size=${r.size}B`);
  }, 10000);

  test("GET /api/admin/products — no auth cookie", async () => {
    const r = await request("GET", "/api/admin/products", { cookie: "" });
    expect(r.status).toBe(401);
    console.log(`  No auth: status=${r.status}, time=${r.time}ms`);
  }, 10000);

  test("DELETE /api/admin/products/:id — non-existent product", async () => {
    const r = await request("DELETE", "/api/admin/products/000000000000000000000000");
    expect([404, 400]).toContain(r.status);
    console.log(`  Delete non-existent: status=${r.status}, time=${r.time}ms`);
  }, 10000);

  test("PUT /api/admin/products/:id — missing required fields", async () => {
    if (!testProductId) return;
    const r = await request("PUT", `/api/admin/products/${testProductId}`, {
      body: { originalPrice: "" },
    });
    console.log(`  PUT empty price: status=${r.status}, time=${r.time}ms`);
  }, 10000);
});

describe("14. WATERFALL vs PARALLEL — timing comparison", () => {
  test("sequential fetches (old pattern)", async () => {
    const start = performance.now();
    await request("GET", "/api/admin/products");
    await request("GET", "/api/admin/sub-categories");
    const elapsed = Math.round(performance.now() - start);
    console.log(`  Sequential (products + sub-cats): ${elapsed}ms`);
  }, 20000);

  test("parallel fetches (new pattern)", async () => {
    const start = performance.now();
    await Promise.all([
      request("GET", "/api/admin/products"),
      request("GET", "/api/admin/sub-categories"),
    ]);
    const elapsed = Math.round(performance.now() - start);
    console.log(`  Parallel   (products + sub-cats): ${elapsed}ms`);
  }, 20000);

  test("old: 3 separate category requests", async () => {
    const start = performance.now();
    await request("GET", "/api/admin/main-categories/extra");
    await request("GET", "/api/admin/sub-categories");
    await request("GET", "/api/admin/sub-categories/extra");
    const elapsed = Math.round(performance.now() - start);
    console.log(`  Old (3 sequential category requests): ${elapsed}ms`);
  }, 30000);

  test("new: 1 unified product-form-data request", async () => {
    const start = performance.now();
    await request("GET", "/api/admin/product-form-data");
    const elapsed = Math.round(performance.now() - start);
    console.log(`  New (1 unified request):             ${elapsed}ms`);
  }, 15000);
});
