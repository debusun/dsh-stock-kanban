import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { createQuoteService } from "../src/quotes.mjs";
import { createChain } from "../src/markets/chain.mjs";
import { createRoutes } from "../src/routes.mjs";
import { createTrustGuard } from "../src/access.mjs";

/* 路由层测试：真实 HTTP 服务器 + mock 上游（不依赖网络） */

const SYM = {
  id: "cn:sh600519", market: "cn", code: "sh600519", quoteCurrency: "CNY", kind: "stock",
  name: "贵州茅台", addedAt: "2026-01-01T00:00:00.000Z", sort: 1,
};

async function startServer({ trust, logger, diag, chain } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sk-routes-"));
  process.env.DSH_STOCK_KANBAN_FILE = join(dir, "data.json");
  const store = new Store({}, { info() {}, warn() {} });
  await store.init();
  await store.addSymbol(SYM);
  const quotes = createQuoteService({ chain: createChain({}) });
  const routes = createRoutes({ store, quotes, chain: chain ?? createChain({}), logger: logger ?? { info() {}, warn() {} }, trust, diag });
  const server = http.createServer((req, res) => {
    const route = routes.find((r) => r.path === (req.url ?? "").split("?")[0]);
    if (!route) { res.writeHead(404); res.end("not found"); return; }
    try {
      const r = route.handler(req, res);
      if (r?.catch) r.catch(() => {});
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (path, opts) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { store, base, j, server, close: () => server.close() };
}

const H = (origin) => ({ "content-type": "application/json", origin, "sec-fetch-site": "same-origin" });

async function mockUpstream() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("127.0.0.1")) return originalFetch(url, init);
    if (u.includes("qt.gtimg.cn")) {
      const text = 'v_sh600519="1~贵州茅台~600519~1453.00~1452.00~1450.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~202611061614~1.00~0.07~1457.72~1436.00~x~42848~619953~0.34~22.11";';
      return { ok: true, arrayBuffer: async () => Buffer.from(text, "utf8"), json: async () => ({}) };
    }
    if (u.includes("push2")) {
      return { ok: true, json: async () => ({ data: { diff: [] } }) };
    }
    if (u.includes("okx.com")) {
      return { ok: true, json: async () => ({ code: "0", data: [] }) };
    }
    return { ok: false, status: 404 };
  };
  return () => { globalThis.fetch = originalFetch; };
}

test("路由：/state 返回实例业务数据", async () => {
  const t = await startServer();
  try {
    const res = await t.j("/stock-kanban/state");
    assert.equal(res.status, 200);
    assert.equal(res.body.rev, 1);
    assert.equal(res.body.symbols[0].id, SYM.id);
    assert.equal(res.body.driverKind, "file");
  } finally { t.close(); }
});

test("路由：行情行包含持仓指标与目标状态", async () => {
  const restore = await mockUpstream();
  const t = await startServer();
  try {
    await t.store.updateSymbol(SYM.id, { quantity: 100, avgCost: 1500, buyTarget: 1400 });
    const res = await t.j(`/stock-kanban/quotes?ids=${SYM.id}`);
    const row = res.body.rows[SYM.id];
    assert.equal(row.status, "ok");
    assert.equal(row.source, "tencent"); // §12.46：行情行携带来源标注（透传）
    assert.equal(row.fallbackFrom, null);
    assert.equal(row.price, 1453);
    assert.equal(row.metrics.cost, 150000);
    assert.equal(row.metrics.marketValue, 145300);
    assert.ok(row.metrics.pnl < 0); // 1453 < 1500 → 亏损，不得显示虚假盈利
    assert.equal(row.target.status, "stale"); // 行情时间已过 30 分钟窗 → 不伪装有效触价
    await t.store.updateSymbol(SYM.id, { buyTarget: null, sellTarget: null });
    const res2 = await t.j(`/stock-kanban/quotes?ids=${SYM.id}`);
    assert.equal(res2.body.rows[SYM.id].target.status, "no-targets");
  } finally { t.close(); restore(); }
});

test("路由：分时点位不足 2 个按 no-data 上报（不得伪装成功，§12.35）", async () => {
  const originalFetch = globalThis.fetch;
  let lines = ["0930 1453.00 100"];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("127.0.0.1")) return originalFetch(url, init);
    if (u.includes("ifzqgtimg") || u.includes("ifzq.gtimg.cn")) {
      const code = decodeURIComponent((u.match(/code=([^&]+)/) || [])[1] || "sh600519");
      return { ok: true, json: async () => ({ data: { [code]: { data: { date: "20261113", data: lines }, qt: { [code]: [] } } } }) };
    }
    return { ok: false, status: 404 };
  };
  const t = await startServer();
  try {
    const bad = await t.j(`/stock-kanban/minute?id=${SYM.id}`);
    assert.equal(bad.status, 200);
    assert.equal(bad.body.error, "no-data", "单点分时不得伪装成功");
    lines = ["0930 1453.00 100", "0931 1453.10 200", "0932 1453.20 300"];
    const good = await t.j(`/stock-kanban/minute?id=${SYM.id}`);
    assert.equal(good.body.error, null);
    assert.equal(good.body.points.length, 3);
  } finally { t.close(); globalThis.fetch = originalFetch; }
});

test("路由：同源校验 + CAS 冲突 409 + 重复添加 409", async () => {
  const restore = await mockUpstream();
  const t = await startServer();
  const base = t.base;
  try {
    const cross = await t.j("/stock-kanban/settings", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ ifRev: t.store.rev, privacyMode: true }) });
    assert.equal(cross.status, 403);

    const conflict = await t.j("/stock-kanban/symbols/update", { method: "POST", headers: H(base), body: JSON.stringify({ ifRev: 0, id: SYM.id, patch: { quantity: 1 } }) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "rev-conflict");
    assert.ok(conflict.body.state.symbols.length >= 1); // 冲突响应携带最新状态

    const dup = await t.j("/stock-kanban/symbols/add", { method: "POST", headers: H(base), body: JSON.stringify({ ifRev: t.store.rev, market: "cn", code: "600519" }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "duplicate");

    const badType = await t.j("/stock-kanban/settings", { method: "GET", headers: H(base) });
    assert.equal(badType.status, 405);
  } finally { t.close(); restore(); }
});

test("路由：添加走真实行情校验（无效代码 422）", async () => {
  const restore = await mockUpstream();
  const t = await startServer();
  try {
    const bad = await t.j("/stock-kanban/symbols/add", { method: "POST", headers: H(t.base), body: JSON.stringify({ ifRev: t.store.rev, market: "cn", code: "999999" }) });
    assert.equal(bad.status, 422); // 格式合法但行情校验不过 → 不加入
    assert.equal(t.store.symbols.length, 1);
  } finally { t.close(); restore(); }
});

test("路由：搜索失败明确报错，不返回虚构结果（12.2）", async () => {
  const originalFetch = globalThis.fetch;
  const downstream = originalFetch;
  globalThis.fetch = async (url) => (String(url).includes("127.0.0.1") ? downstream(url) : (() => { throw new Error("down"); })());
  const t = await startServer();
  try {
    const res = await t.j("/stock-kanban/search?market=us&q=aapl"); // us 只依赖 smartbox → 必失败
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, []);
    assert.match(res.body.error, /unavailable/);
  } finally { t.close(); globalThis.fetch = originalFetch; }
});

test("路由：searchRoute 把 chain 接进 search（ADR-0008 名称覆写接线，重接路由不得静默丢失）", async () => {
  const originalFetch = globalThis.fetch;
  const downstream = originalFetch;
  // smartbox 空 ASCII 夹具（编码守卫纪律）；池行 600519 应被行情链覆写
  globalThis.fetch = async (url) => (String(url).includes("127.0.0.1") ? downstream(url)
    : { ok: true, arrayBuffer: async () => Buffer.from('v_hint=""', "utf8") });
  const seen = [];
  const chain = {
    runChain: async (market, ns, codes) => {
      seen.push([market, ns, [...codes]]);
      return new Map(codes.map((c) => [c, { ok: true, value: { name: "行情名" + c, price: 1 } }]));
    },
  };
  const t = await startServer({ chain });
  try {
    const res = await t.j("/stock-kanban/search?market=cn&q=600519");
    assert.equal(res.status, 200);
    const row = res.body.rows.find((r) => r.id === "cn:sh600519");
    assert.ok(row, JSON.stringify(res.body));
    assert.equal(row.name, "行情名sh600519"); // 池名被行情名覆盖 = chain 确实被传入 search
    assert.ok(seen.some(([m, ns, codes]) => m === "cn" && ns === "snap" && codes.includes("sh600519")),
      `覆写应过行情链同 gate，实际 seen=${JSON.stringify(seen)}`);
  } finally { t.close(); globalThis.fetch = originalFetch; }
});

test("路由：导出→导入往返（12.3 备份可恢复业务数据）", async () => {
  const restore = await mockUpstream();
  const t = await startServer();
  try {
    await t.store.updateSymbol(SYM.id, { quantity: 100, avgCost: 1500, buyTarget: 1400, sellTarget: 1800 });
    const ex = await fetch(t.base + "/stock-kanban/export");
    const backup = await ex.json();
    assert.equal(ex.headers.get("content-disposition")?.startsWith("attachment"), true);

    // 清空后导入恢复
    await t.store.removeSymbol(SYM.id);
    assert.equal(t.store.symbols.length, 0);
    const imp = await t.j("/stock-kanban/import", { method: "POST", headers: H(t.base), body: JSON.stringify({ ifRev: t.store.rev, payload: backup }) });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.imported, 1);
    const restored = t.store.getSymbol(SYM.id);
    assert.equal(restored.quantity, 100);
    assert.equal(restored.buyTarget, 1400);
    assert.equal(t.store.global.settings.privacyMode, backup.settings.privacyMode);
  } finally { t.close(); restore(); }
});

test("路由：/health 不含业务数据", async () => {
  const t = await startServer();
  try {
    const res = await t.j("/stock-kanban/health");
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("sh600519"));
    assert.ok(!text.includes("贵州茅台"));
    assert.ok(res.body.providers.tencent !== undefined); // §12.45：health 按 (提供方,市场) 嵌套、仅含已触达键——未触达时 provider 键存在但为空对象；触达后为 providers.tencent.cn
  } finally { t.close(); }
});

/* ---------------- 涨跌语义档位（ADR-0009，实施计划 T2） ---------------- */

test("路由：state 载荷携带 trendColorMode；settings POST 生效 rev 自增；非法值回默认", async () => {
  const t = await startServer();
  try {
    const s0 = await t.j("/stock-kanban/state");
    assert.equal(s0.status, 200);
    assert.equal(s0.body.settings.trendColorMode, "red-up"); // 默认档随载荷透出

    const revBefore = s0.body.rev;
    const set = await t.j("/stock-kanban/settings", { method: "POST", headers: H(t.base), body: JSON.stringify({ ifRev: revBefore, trendColorMode: "native" }) });
    assert.equal(set.status, 200);
    assert.equal(set.body.settings.trendColorMode, "native");
    assert.equal(set.body.rev, revBefore + 1);

    const s1 = await t.j("/stock-kanban/state");
    assert.equal(s1.body.settings.trendColorMode, "native");

    const invalid = await t.j("/stock-kanban/settings", { method: "POST", headers: H(t.base), body: JSON.stringify({ trendColorMode: "rainbow" }) });
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.settings.trendColorMode, "red-up"); // 非法 fail-closed 回默认
  } finally { t.close(); }
});

/* ---------------- 拖拽排序路由（symbols/reorder，2026-11-10） ---------------- */

test("路由：reorder 200 重编号 / 422 非排列与非法市场 / ifRev 冲突 409", async () => {
  const t = await startServer();
  try {
    await t.store.addSymbol({ ...SYM, id: "cn:sz000001", code: "sz000001", sort: 200 });
    const ok = await t.j("/stock-kanban/symbols/reorder", {
      method: "POST",
      headers: H(t.base),
      body: JSON.stringify({ market: "cn", orderedIds: ["cn:sz000001", "cn:sh600519"], ifRev: t.store.rev }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.changed, true);
    assert.ok(Number.isInteger(ok.body.rev));
    assert.equal(t.store.getSymbol("cn:sz000001").sort, 0);

    const bad = await t.j("/stock-kanban/symbols/reorder", {
      method: "POST",
      headers: H(t.base),
      body: JSON.stringify({ market: "cn", orderedIds: ["cn:sh600519"] }), // 缺员
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, "invalid-order");

    const badMarket = await t.j("/stock-kanban/symbols/reorder", {
      method: "POST",
      headers: H(t.base),
      body: JSON.stringify({ market: "nope", orderedIds: [] }),
    });
    assert.equal(badMarket.status, 422);

    const conflict = await t.j("/stock-kanban/symbols/reorder", {
      method: "POST",
      headers: H(t.base),
      body: JSON.stringify({ market: "cn", orderedIds: ["cn:sh600519", "cn:sz000001"], ifRev: 999999 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "rev-conflict");
  } finally { t.close(); }
});

/* ---------------- 官方信任检查（守卫式委派：admit 优先，requestRejection 回落） ---------------- */

/** 挂上指定 connection mock 的信任围栏后启动同一套路由 */
function trustServer(conn, logger) {
  return startServer({ trust: createTrustGuard({ get: () => conn }, logger) });
}

test("路由：admit 拒绝 → 401/403/503 原样下发（error=untrusted）", async () => {
  for (const status of [401, 403, 503]) {
    const t = await trustServer({ admit: () => ({ rejection: status }) });
    try {
      const res = await t.j("/stock-kanban/state");
      assert.equal(res.status, status);
      assert.equal(res.body.error, "untrusted");
    } finally { t.close(); }
  }
});

test("路由：admit 放行（{ peer }）→ 业务照常；写路由仍受同源校验", async () => {
  const restore = await mockUpstream();
  const t = await trustServer({ admit: () => ({ peer: { id: "p1" } }) });
  try {
    const res = await t.j("/stock-kanban/state");
    assert.equal(res.status, 200);
    assert.equal(res.body.rev, 1);
    const cross = await t.j("/stock-kanban/settings", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ ifRev: t.store.rev, privacyMode: true }) });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error, "origin-rejected");
  } finally { t.close(); restore(); }
});

test("路由：admit 收到完整 trust request（headers/method/url）", async () => {
  const seen = [];
  const t = await trustServer({ admit: (request) => { seen.push(request); return { peer: {} }; } });
  try {
    await t.j("/stock-kanban/health");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "GET");
    assert.equal(typeof seen[0].headers.host, "string");
    assert.match(seen[0].url, /^http:\/\//);
    assert.match(seen[0].url, /\/stock-kanban\/health$/);
  } finally { t.close(); }
});

test("路由：旧版回落 —— 只有 requestRejection 时仍按其判定（401/403 原样、undefined 放行）", async () => {
  for (const [status, expected] of [[401, 401], [403, 403], [undefined, 200]]) {
    const t = await trustServer({ requestRejection: () => status });
    try {
      const res = await t.j("/stock-kanban/state");
      assert.equal(res.status, expected);
      if (expected !== 200) assert.equal(res.body.error, "untrusted");
    } finally { t.close(); }
  }
});

test("路由：admit 优先于 requestRejection（两者都在时用 admit）", async () => {
  const t = await trustServer({ admit: () => ({ peer: {} }), requestRejection: () => 403 });
  try {
    assert.equal((await t.j("/stock-kanban/state")).status, 200);
  } finally { t.close(); }
});

test("路由：connection 服务缺席 → fail-closed 403，warn 只发一次", async () => {
  const warns = [];
  const t = await trustServer(undefined, { warn: (m) => warns.push(String(m)) });
  try {
    const r1 = await t.j("/stock-kanban/state");
    const r2 = await t.j("/stock-kanban/health");
    assert.equal(r1.status, 403);
    assert.equal(r2.status, 403);
    assert.equal(r1.body.error, "untrusted");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /fail-closed/);
  } finally { t.close(); }
});

test("路由：connection 无任何信任 API → fail-closed 403", async () => {
  const t = await trustServer({});
  try {
    const res = await t.j("/stock-kanban/state");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "untrusted");
  } finally { t.close(); }
});

test("路由：admit 抛错 → fail-closed 403", async () => {
  const t = await trustServer({ admit: () => { throw new Error("boom"); } });
  try {
    const res = await t.j("/stock-kanban/state");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "untrusted");
  } finally { t.close(); }
});

test("路由：requestRejection 抛错 → fail-closed 403", async () => {
  const t = await trustServer({ requestRejection: () => { throw new Error("boom"); } });
  try {
    const res = await t.j("/stock-kanban/state");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "untrusted");
  } finally { t.close(); }
});

test("路由：admit 返回非数值 rejection → 保守 403", async () => {
  const t = await trustServer({ admit: () => ({ rejection: "weird" }) });
  try {
    assert.equal((await t.j("/stock-kanban/state")).status, 403);
  } finally { t.close(); }
});

test("路由：DSH 已准入（handler 收到 peer）→ 守卫不再二次判定，业务直达", async () => {
  // 0.2.2-rc.2 起 webserver 默认 auth='required'，准入后把 admission.peer 作为第三参传给 handler。
  // 此时插件守卫必须让路，否则会对已认证请求误判（2026-11-27 实录：search 恒 403）。
  const restore = await mockUpstream();
  const seen = [];
  const dir = mkdtempSync(join(tmpdir(), "sk-peer-"));
  process.env.DSH_STOCK_KANBAN_FILE = join(dir, "data.json");
  const store = new Store({}, { info() {}, warn() {} });
  await store.init();
  await store.addSymbol(SYM);
  const chain = createChain({});
  const routes = createRoutes({
    store,
    quotes: createQuoteService({ chain }),
    chain,
    logger: { info() {}, warn() {} },
    // 守卫若被调用就会记录并返回 403；正确实现下它根本不该被调用
    trust: () => { seen.push("called"); return 403; },
  });
  const route = routes.find((r) => r.path === "/stock-kanban/state");
  const res = {
    statusCode: 0, headers: {}, body: "",
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; if (h) Object.assign(this.headers, h); },
    end(b) { this.body = String(b ?? ""); },
  };
  // 传 peer = DSH 已准入
  await route.handler({ method: "GET", url: "/stock-kanban/state", headers: { host: "127.0.0.1:3080" } }, res, { id: "peer-1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, [], "peer 存在时不得调用插件守卫");
  // 不传 peer = 老版本 DSH 未准入 → 守卫照常生效
  const res2 = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.statusCode = s; if (h) Object.assign(this.headers, h); }, end(b) { this.body = String(b ?? ""); } };
  await route.handler({ method: "GET", url: "/stock-kanban/state", headers: { host: "127.0.0.1:3080" } }, res2);
  assert.equal(res2.statusCode, 403);
  assert.equal(seen.length, 1, "无 peer 时守卫必须生效");
  restore();
});

test("路由：读路由不豁免（export/health/quotes 同样过信任检查）", async () => {
  const t = await trustServer({ admit: () => ({ rejection: 403 }) });
  try {
    assert.equal((await t.j("/stock-kanban/export")).status, 403);
    assert.equal((await t.j("/stock-kanban/health")).status, 403);
    assert.equal((await t.j("/stock-kanban/quotes?ids=cn:sh600519")).status, 403);
  } finally { t.close(); }
});

test("路由：非 import 变更默认 64KiB 体积上限（413）", async () => {
  const restore = await mockUpstream();
  const t = await trustServer({ admit: () => ({ peer: {} }) });
  try {
    const big = JSON.stringify({ ifRev: t.store.rev, privacyMode: true, pad: "x".repeat(70 * 1024) });
    const res = await t.j("/stock-kanban/settings", { method: "POST", headers: { "content-type": "application/json", origin: t.base, "sec-fetch-site": "same-origin" }, body: big });
    assert.equal(res.status, 413);
  } finally { t.close(); restore(); }
});

/* ---------------- 诊断闭环（P1-6，2026-11-13） ---------------- */

test("诊断：POST /diag 同源收批量行；跨源 403；GET tail 回读", async () => {
  const { createDiagLogger } = await import("../src/diag.mjs");
  const diag = createDiagLogger({ dir: mkdtempSync(join(tmpdir(), "sk-diag-")), level: "full" });
  const restore = await mockUpstream();
  const t = await startServer({ diag });
  try {
    const cross = await t.j("/stock-kanban/diag", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ rows: [{ ev: "panel.mount" }] }) });
    assert.equal(cross.status, 403);

    const ok = await t.j("/stock-kanban/diag", { method: "POST", headers: H(t.base), body: JSON.stringify({ rows: [{ ev: "panel.quotes.fail", message: "HTTP 502" }] }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.stored, 1);
    await diag.flush();

    const tail = await t.j("/stock-kanban/diag?tail=20");
    assert.equal(tail.status, 200);
    assert.ok(tail.body.rows.some((r) => r.ev === "client.panel.quotes.fail" && r.src === "client")); // 评审轮2：客户端行归 client. 命名空间
  } finally {
    t.close();
    restore();
  }
});

test("诊断：route.status 门——同 path+status 两分钟一行 + dropped 计数", async () => {
  const { createDiagLogger } = await import("../src/diag.mjs");
  const diag = createDiagLogger({ dir: mkdtempSync(join(tmpdir(), "sk-diag-")), level: "full" });
  const t = await startServer({ diag });
  try {
    const a = await t.j("/stock-kanban/kline?id=cn:missing&period=day");
    const b = await t.j("/stock-kanban/kline?id=cn:missing2&period=day");
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    await diag.flush();
    const { rows } = await diag.tail(10);
    const status = rows.filter((r) => r.ev === "route.status" && r.path === "/stock-kanban/kline" && r.status === 404);
    assert.equal(status.length, 1); // 第二次被门拦下（窗口内不重复落行）
    // dropped 计数在窗口内只累加在门的状态里，随下一次落行补记（有界日志语义，对齐 lens route.status gate）
    assert.equal(status[0].dropped, 0);
  } finally {
    t.close();
  }
});

test("诊断：客户端行 ev 命名空间化——服务端保留事件不可伪造（评审轮2 P3）", async () => {
  const { createDiagLogger } = await import("../src/diag.mjs");
  const diag = createDiagLogger({ dir: mkdtempSync(join(tmpdir(), "sk-diag-")), level: "full" });
  const restore = await mockUpstream();
  const t = await startServer({ diag });
  try {
    const ok = await t.j("/stock-kanban/diag", { method: "POST", headers: H(t.base), body: JSON.stringify({ rows: [
      { ev: "route.status", path: "/x", status: 502 },
      { ev: "provider.fail", provider: "tencent" },
      { ev: "client.panel.crash", message: "boom" },
      { ev: "panel.quotes.fail", message: "HTTP 502" },
    ] }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.stored, 2);
    assert.equal(ok.body.rejected, 2);
    await diag.flush();
    const { rows } = await diag.tail(20);
    const evs = rows.filter((r) => r.src === "client").map((r) => r.ev).sort();
    assert.deepEqual(evs, ["client.panel.crash", "client.panel.quotes.fail"]); // 自带 client. 前缀被归一化为单层（幂等）
    assert.ok(rows.every((r) => r.src !== "client" || !/^(provider.|route.|store.|host.)/.test(String(r.ev).replace(/^client./, ""))));
  } finally {
    t.close();
    restore();
  }
});

/* ---- K线/分时备源入链（ADR-0007 Task 6）---- */

test("K线：cn 腾讯腿挂 → EM 腿补位（fqt=1），响应形状不变（ADR-0007）", async () => {
  const t = await startServer();
  const orig = globalThis.fetch;
  const jsonOk = (body) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(body), "utf8"), json: async () => body });
  globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (s.includes("127.0.0.1")) return orig(u, opts); // 测试服务器回环放行（同 mockUpstream 惯例）
    if (s.includes("secid=1.600519") && s.includes("kline")) return jsonOk({ data: { klines: ["2026-11-14,10,11,12,9,1000", "2026-11-15,11,12,13,10,2000"] } });
    throw new Error("down"); // 其余上游一律失败（含腾讯 K线）
  };
  try {
    const res = await t.j("/stock-kanban/kline?id=cn:sh600519&period=day");
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null);
    assert.equal(res.body.candles.length, 2);
    assert.equal(res.body.adjust, "qfq");
    assert.equal(res.body.errorDetail, null);
  } finally {
    globalThis.fetch = orig;
    t.close();
  }
});

/* ---- K线量纲快照锚定（§12.53，评审 F2 收口）：腾讯 fqkline 上游 手↔股 跨窗口翻转 ---- */

/* 腾讯 fqkline 夹具：raw volume 逐字入行（fetchKline 内部 klineVolumeToShares 会 sh/sz/bj ×100）；
   快照夹具：qtimg 行 idx36 = 股口径量（§12.47 稳定锚）。 */
function txKlineStub(volumes) {
  const rows = volumes.map((v, i) => [`2026-11-${13 + i}`, "1404.00", "1435.26", "1437.69", "1394.00", String(v)]);
  return json0({ code: 0, data: { sh600519: { qfqday: rows } } });
}
function json0(body) {
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(body), "utf8"), json: async () => body };
}
const json0text = (text) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(text, "utf8"), json: async () => ({}) });
function qtRow(vol) {
  return 'v_sh600519="1~贵州茅台~600519~1453.00~1452.00~1450.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~202611141500~1.00~0.07~1457.72~1436.00~x~' + vol + '~619953~0.34~22.11";';
}

test("K线量纲锚定：上游原生股（启发式 ×100 过缩放 100×）→ ÷100 回正对齐快照", async () => {
  const t = await startServer();
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (s.includes("127.0.0.1")) return orig(u, opts);
    if (s.includes("ifzq.gtimg.cn")) return txKlineStub([4284800, 4284800]); // 上游翻转：原生股（股=4284800）
    if (s.includes("qt.gtimg.cn")) return json0text(qtRow(4284800));          // 快照锚：4284800 股 → 比值 100 → ÷100
    throw new Error("down");
  };
  try {
    const res = await t.j("/stock-kanban/kline?id=cn:sh600519&period=day");
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null);
    assert.equal(res.body.candles.at(-1).volume, 4284800, "过缩放 100× 应被快照锚回正");
  } finally {
    globalThis.fetch = orig;
    t.close();
  }
});

test("K线量纲锚定：口径一致（比值 1）→ 原样不动", async () => {
  const t = await startServer();
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (s.includes("127.0.0.1")) return orig(u, opts);
    if (s.includes("ifzq.gtimg.cn")) return txKlineStub([41780, 41780]); // raw 手 → ×100 = 4178000
    if (s.includes("qt.gtimg.cn")) return json0text(qtRow(4178000));     // 快照 4178000 → 比值 1 → 不动
    throw new Error("down");
  };
  try {
    const res = await t.j("/stock-kanban/kline?id=cn:sh600519&period=day");
    assert.equal(res.body.candles.at(-1).volume, 4178000, "口径一致不得误缩放");
  } finally {
    globalThis.fetch = orig;
    t.close();
  }
});

test("K线量纲锚定：快照不可用 → 启发式原值兜底（锚失败静默）", async () => {
  const t = await startServer();
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (s.includes("127.0.0.1")) return orig(u, opts);
    if (s.includes("ifzq.gtimg.cn")) return txKlineStub([41780, 41780]);
    throw new Error("down"); // 快照链（qtimg/EM）全灭 → snapVol null → 不动
  };
  try {
    const res = await t.j("/stock-kanban/kline?id=cn:sh600519&period=day");
    assert.equal(res.status, 200);
    assert.equal(res.body.candles.at(-1).volume, 4178000, "锚不可用 → 启发式 ×100 原值兜底");
  } finally {
    globalThis.fetch = orig;
    t.close();
  }
});
