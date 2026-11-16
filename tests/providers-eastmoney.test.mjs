import test from "node:test";
import assert from "node:assert/strict";
import { directSecid, fetchBatchSnapshots, fetchKline, fetchMinuteDetail, fetchQuote, resolveUSSecid } from "../src/markets/eastmoney.mjs";

/* EM 多市场化（P0-1/P0-3，2026-11-13）：cn/hk 目录式 secid、美股指数预置、f124 时间戳。 */

test("directSecid：cn/hk/美股指数目录映射；美股个股 null；hkHSI undefined（不经 EM）", () => {
  assert.equal(directSecid("sh600519"), "1.600519");
  assert.equal(directSecid("sz000001"), "0.000001");
  assert.equal(directSecid("bj830799"), "0.830799");
  assert.equal(directSecid("hk00700"), "116.00700");
  assert.equal(directSecid("hkHSI"), undefined);
  assert.equal(directSecid("DJI"), "100.DJIA");
  assert.equal(directSecid("AAPL"), null);
});

test("resolveUSSecid：美股指数预置，不走交易所探测（105/106/107 探不到指数）", async () => {
  assert.equal(await resolveUSSecid("DJI"), "100.DJIA");
  assert.equal(await resolveUSSecid("INX"), "100.SPX");
});

test("fetchBatchSnapshots：多市场混合，按入参 code 回填键，f124 → quoteTimeMs", async () => {
  const diff = [
    { f2: 1453, f3: 0.07, f4: 1, f5: 42848, f6: 619953000, f12: "600519", f13: 1, f14: "贵州茅台", f15: 1457.72, f16: 1436, f17: 1450, f18: 1452, f124: 1762416840 },
    { f2: 344.7, f3: 0.16, f4: 0.55, f5: 1000, f6: 344700, f12: "AAPL", f13: 105, f14: "苹果", f15: 345, f16: 343, f17: 344, f18: 344.15, f124: 1762416840 },
  ];
  const originalFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes("fields=f57")) return { ok: true, json: async () => ({ data: { f57: "AAPL" } }) };
    return { ok: true, json: async () => ({ data: { diff } }) };
  };
  try {
    const rows = await fetchBatchSnapshots(["sh600519", "AAPL"]);
    assert.equal(rows.size, 2);
    const mt = rows.get("sh600519");
    assert.equal(mt.price, 1453);
    assert.equal(mt.prevClose, 1452);
    assert.equal(mt.high, 1457.72);
    assert.equal(mt.quoteTimeMs, 1762416840000);
    assert.equal(rows.get("AAPL").name, "苹果");
    assert.ok(seenUrls.some((u) => u.includes("ulist.np")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchQuote：完整快照含 f124 时间戳（cn/hk 备源与 us 主源同型）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { f43: 1453, f44: 1457.72, f45: 1436, f46: 1450, f47: 42848, f48: 619953000, f57: "600519", f58: "贵州茅台", f60: 1452, f124: 1762416840, f169: 1, f170: 0.07 } }) });
  try {
    const q = await fetchQuote("sh600519");
    assert.equal(q.price, 1453);
    assert.equal(q.quoteTimeMs, 1762416840000);
    assert.equal(q.name, "贵州茅台");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ---- K线/分时 directSecid 分支 + adjust 参数（ADR-0007 Task 4）---- */

test("fetchKline：cn 代码走 directSecid（secid=1.600519，fqt=1），不触发美股探测", async () => {
  const urls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new Error("stop"); };
  try {
    await fetchKline("sh600519", "day");
  } catch { /* 网络桩截停即可，断言 URL 形状 */ }
  finally { globalThis.fetch = orig; }
  assert.ok(urls.some((u) => u.includes("secid=1.600519") && u.includes("fqt=1")), urls.join("|"));
  assert.ok(!urls.some((u) => u.includes("fields=f57")), "不得走美股 secid 探测端点");
});

test("fetchKline：hk + adjust none → fqt=0；hkHSI 别名 → not-found 零网络", async () => {
  const urls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new Error("stop"); };
  try {
    await fetchKline("hk00700", "day", { adjust: "none" }); // 红相：走美股探测（URL 形状错）；绿相：directSecid 直映 116.00700 + fqt=0（URL 已记）
    const r = await fetchKline("hkHSI", "day", { adjust: "none" }); // 必须在 stub 区内：绿相 directSecid undefined → 零网络 not-found；红相探测被桩截停 → fetch-failed（断言红且离线）
    assert.ok(urls.some((u) => u.includes("secid=116.00700") && u.includes("fqt=0")), urls.join("|"));
    assert.equal(r.error, "not-found");
  } finally { globalThis.fetch = orig; }
});

test("fetchKline：美股 secid 探测传输失败 → fetch-failed 形态，不抛穿（§12.32 契约，回归守卫）", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("HTTP 502"); };
  try {
    const r = await fetchKline("NVDA", "day"); // directSecid=null → 走严格探测
    assert.equal(r.candles.length, 0);
    assert.equal(r.error, "fetch-failed");
    assert.match(r.errorDetail ?? "", /secid-transport/);
  } finally { globalThis.fetch = orig; }
});

test("fetchMinuteDetail：trends2 量纲列序=时间/价格/量（fields2=f51,f53,f56，2026-11-17 补 v）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("trends2"), "应打 trends2 端点");
    assert.ok(String(url).includes("fields2=f51,f53,f56"), "应请求 f56 量列");
    return { ok: true, json: async () => ({ data: {
      trends: [
        "2026-11-16 14:30,353.29,12345", // 全列：时间,价格,量
        "2026-11-16 14:31,353.50",       // 双列旧形态：量缺失退化 v=0，不劣化
        "2026-11-16 14:32,353.40,678",
      ],
      preClose: 356.27,
    } }) };
  };
  try {
    const r = await fetchMinuteDetail("sh600519"); // directSecid 直映，不走 secid 探测
    assert.equal(r.error, null);
    assert.equal(r.prevClose, 356.27);
    assert.deepEqual(r.points, [
      { t: Math.round(Date.parse("2026-11-16T14:30:00+08:00") / 1000), p: 353.29, v: 12345 },
      { t: Math.round(Date.parse("2026-11-16T14:31:00+08:00") / 1000), p: 353.5, v: 0 },
      { t: Math.round(Date.parse("2026-11-16T14:32:00+08:00") / 1000), p: 353.4, v: 678 },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
