import test from "node:test";
import assert from "node:assert/strict";
import { fetchMinuteDetail, resetXueqiuForTests } from "../src/markets/xueqiu.mjs";

/* 雪球美股分时备源（2026-11-17）：guest 引导（首页跟随 301 → 最终响应 getSetCookie 暴露
   xq_a_token）→ minute.json。全 mock 网络，覆盖引导/复用/400016 自愈/指数符号/错误口径。 */

const T0 = 1794839400000; // 2026-11-16 09:30 ET（14:30Z）

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function cookieJar(cookies) {
  return { getSetCookie: () => cookies };
}

function items(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ current: 355 + i * 0.1, volume: 1000 + i, avg_price: 355.5, timestamp: T0 + i * 60000 });
  }
  return out;
}

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, cookie: opts.headers?.cookie ?? null });
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, opts);
    }
    throw new Error("fetch failed");
  };
  return calls;
}

test("首次调用引导 cookie，minute.json 带 cookie；解析 items/last_close/纽约日期", async () => {
  const orig = globalThis.fetch;
  resetXueqiuForTests();
  try {
    const calls = installFetch([
      ["minute.json", () => jsonResponse({ data: { items: items(3), last_close: 356.27 } })],
      ["https://xueqiu.com/", () => ({ ok: true, status: 200, headers: cookieJar(["xq_a_token=abc123; Path=/", "u=1; Path=/"]) })],
    ]);
    const r = await fetchMinuteDetail("AAPL");
    assert.equal(r.error, null);
    assert.equal(r.date, "2026-11-16");
    assert.equal(r.prevClose, 356.27);
    assert.equal(r.points.length, 3);
    assert.deepEqual(r.points[0], { t: T0 / 1000, p: 355, v: 1000 });
    assert.equal(calls.length, 2, "首页引导 + minute.json 各一次");
    assert.ok(calls[0].u.startsWith("https://xueqiu.com/"), "先引导首页");
    assert.equal(calls[1].cookie, "xq_a_token=abc123; u=1", "minute.json 应带引导 cookie");
  } finally {
    globalThis.fetch = orig;
  }
});

test("cookie 进程内复用：第二次调用不再打首页", async () => {
  const orig = globalThis.fetch;
  resetXueqiuForTests();
  try {
    const calls = installFetch([
      ["minute.json", () => jsonResponse({ data: { items: items(2), last_close: 356.27 } })],
      ["https://xueqiu.com/", () => ({ ok: true, status: 200, headers: cookieJar(["xq_a_token=abc123; Path=/"]) })],
    ]);
    await fetchMinuteDetail("AAPL");
    await fetchMinuteDetail("AAPL");
    assert.equal(calls.filter((c) => c.u.startsWith("https://xueqiu.com/")).length, 1, "首页只引导一次");
    assert.equal(calls.filter((c) => c.u.includes("minute.json")).length, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test("guest token 失效（HTTP 400）重引导一次自愈", async () => {
  const orig = globalThis.fetch;
  resetXueqiuForTests();
  try {
    let bootstraps = 0;
    const calls = installFetch([
      ["minute.json", () => jsonResponse({ error_description: "请重新登录", error_code: 400016 }, 400)],
      ["https://xueqiu.com/", () => {
        bootstraps += 1;
        return { ok: true, status: 200, headers: cookieJar(["xq_a_token=fresh" + bootstraps + "; Path=/"]) };
      }],
    ]);
    const r = await fetchMinuteDetail("AAPL");
    assert.equal(r.error, "fetch-failed", "两轮都 400 按传输失败，链内让位");
    assert.equal(bootstraps, 2, "400 触发一次重引导（首次引导 + 重引导）");
    assert.equal(calls.filter((c) => c.u.includes("minute.json")).length, 2, "400 后应重试一次 minute.json");
    assert.equal(calls.find((c) => c.u.includes("minute.json") && c.cookie === "xq_a_token=fresh2") !== undefined, true, "重试应带新 cookie（属性剥离后成对串）");
  } finally {
    globalThis.fetch = orig;
  }
});

test("指数符号映射：DJI → .DJI", async () => {
  const orig = globalThis.fetch;
  resetXueqiuForTests();
  try {
    let seen = "";
    const calls = installFetch([
      ["minute.json", (u) => { seen = u; return jsonResponse({ data: { items: items(1), last_close: 1 } }); }],
      ["https://xueqiu.com/", () => ({ ok: true, status: 200, headers: cookieJar(["xq_a_token=abc; Path=/"]) })],
    ]);
    await fetchMinuteDetail("DJI");
    assert.ok(seen.includes("symbol=.DJI"), "指数应映射点号符号: " + seen);
  } finally {
    globalThis.fetch = orig;
  }
});

test("引导失败/网络错误 → fetch-failed；应答但无点位 → no-data；畸形点位剔除", async () => {
  const orig = globalThis.fetch;
  resetXueqiuForTests();
  try {
    installFetch([
      ["minute.json", () => jsonResponse({ data: { items: [{ current: -1, timestamp: T0 }, { current: 355, timestamp: T0 + 60000 }], last_close: 356 } })],
      ["https://xueqiu.com/", () => { throw new Error("ECONNRESET"); }],
    ]);
    const bad = await fetchMinuteDetail("AAPL");
    assert.equal(bad.error, "fetch-failed");
    assert.equal(bad.errorDetail, "ECONNRESET");

    resetXueqiuForTests();
    installFetch([
      ["minute.json", () => jsonResponse({ data: { items: [], last_close: 356 } })],
      ["https://xueqiu.com/", () => ({ ok: true, status: 200, headers: cookieJar(["xq_a_token=abc; Path=/"]) })],
    ]);
    const empty = await fetchMinuteDetail("AAPL");
    assert.equal(empty.error, "no-data");

    resetXueqiuForTests();
    installFetch([
      ["minute.json", () => jsonResponse({ data: { items: [{ current: -1, timestamp: T0 }, { current: 355, timestamp: T0 + 60000 }], last_close: 356 } })],
      ["https://xueqiu.com/", () => ({ ok: true, status: 200, headers: cookieJar(["xq_a_token=abc; Path=/"]) })],
    ]);
    const shaped = await fetchMinuteDetail("AAPL");
    assert.equal(shaped.error, null);
    assert.equal(shaped.points.length, 1, "非正价格点位剔除");
    assert.deepEqual(shaped.points[0], { t: (T0 + 60000) / 1000, p: 355, v: 0 });
    assert.equal(shaped.prevClose, 356);
  } finally {
    globalThis.fetch = orig;
  }
});
