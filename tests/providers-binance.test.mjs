import test from "node:test";
import assert from "node:assert/strict";
import { binanceSymbolOf, fetchQuote, fetchBatchSnapshots, fetchKline, fetchMinuteDetail } from "../src/markets/binance.mjs";

/* Binance 加密备源（2026-11-17 ③）：链位 OKX 之后。全 mock 网络，覆盖符号映射、
   批量（≤2 逐个 / >2 symbols 参数 / 坏码 400 逐标的退化 / 5xx 整批抛错退避）、K线、分时、错误形状。 */

function ticker(instId) {
  return {
    symbol: instId.replaceAll("-", ""),
    lastPrice: "64903.87",
    openPrice: "64567.22",
    highPrice: "65696.16",
    lowPrice: "63905.01",
    priceChange: "336.65",
    priceChangePercent: "0.521",
    volume: "21178.98313",
    quoteVolume: "1371416090.31",
    closeTime: 1794851216001,
  };
}

function kline(openTimeMs, o, h, l, c, v) {
  return [String(openTimeMs), String(o), String(h), String(l), String(c), String(v)];
}

function httpError(status) {
  const e = new Error("HTTP " + status);
  e.httpStatus = status;
  return e;
}

test("binanceSymbolOf：instId → binance 符号；非法码 null", () => {
  assert.equal(binanceSymbolOf("BTC-USDT"), "BTCUSDT");
  assert.equal(binanceSymbolOf("btc-usdt"), "BTCUSDT");
  assert.equal(binanceSymbolOf("BTC"), null);
  assert.equal(binanceSymbolOf(""), null);
  assert.equal(binanceSymbolOf(null), null);
});

test("fetchQuote：单标的 ticker/24hr → 快照行（24h 滚动口径，code 键＝instId）", async () => {
  const orig = globalThis.fetch;
  let seen = "";
  globalThis.fetch = async (url) => {
    seen = String(url);
    return { ok: true, json: async () => ticker("BTC-USDT") };
  };
  try {
    const q = await fetchQuote("BTC-USDT");
    assert.equal(q.code, "BTC-USDT");
    assert.equal(q.price, 64903.87);
    assert.equal(q.prevClose, 64567.22);
    assert.equal(q.high, 65696.16);
    assert.equal(q.low, 63905.01);
    assert.equal(q.volume, 21178.98313);
    assert.equal(q.amount, 1371416090.31);
    assert.equal(q.quoteTimeMs, 1794851216001);
    assert.ok(q.changePercent > 0 && q.changeAmount > 0);
    assert.ok(seen.includes("/ticker/24hr?symbol=BTCUSDT"), "符号应去掉连字符: " + seen);
  } finally {
    globalThis.fetch = orig;
  }
});

test("批量 ≤2：逐标的 ticker；>2：symbols 参数一次批量，坏码行缺席", async () => {
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const u = String(url);
    if (u.includes("symbols=")) {
      return { ok: true, json: async () => [ticker("BTC-USDT"), ticker("ETH-USDT")] }; // SOL 行缺失=坏码缺席
    }
    return { ok: true, json: async () => ticker("BTC-USDT") };
  };
  try {
    const small = await fetchBatchSnapshots(["BTC-USDT", "ETH-USDT"]);
    assert.equal(small.size, 2);
    assert.ok(urls.every((u) => u.includes("symbol=") && !u.includes("symbols=")), "≤2 应逐标的");

    const big = await fetchBatchSnapshots(["BTC-USDT", "ETH-USDT", "SOL-USDT"]);
    assert.equal(big.size, 2);
    assert.ok(urls.some((u) => u.includes("symbols=") && u.includes(encodeURIComponent(JSON.stringify(["BTCUSDT", "ETHUSDT", "SOLUSDT"])))), "应带 symbols 参数批量");
    assert.ok(big.has("BTC-USDT") && big.has("ETH-USDT") && !big.has("SOL-USDT"));
  } finally {
    globalThis.fetch = orig;
  }
});

test("批量坏码整批 400 → 逐标的退化：好码照回、坏码缺席；5xx/网络错误整批抛错（退避）", async () => {
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("symbols=")) throw httpError(400); // 坏码整批拒绝
    if (u.includes("BADUSDT")) throw httpError(400); // 逐标的时坏码单独 400
    return { ok: true, json: async () => ticker("BTC-USDT") };
  };
  try {
    const rows = await fetchBatchSnapshots(["BTC-USDT", "ETH-USDT", "BAD-USDT"]); // >2 → 批量路径
    assert.equal(rows.size, 2);
    assert.ok(rows.has("BTC-USDT") && rows.has("ETH-USDT"));
    assert.ok(urls.filter((u) => u.includes("symbol=") && !u.includes("symbols=")).length >= 3, "400 后应退化为逐标的");
  } finally {
    globalThis.fetch = orig;
  }

  globalThis.fetch = async () => { throw httpError(503); };
  try {
    await assert.rejects(() => fetchBatchSnapshots(["BTC-USDT", "ETH-USDT", "SOL-USDT"]), /503/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchKline：升序入参直接映射、+8h 日期标注、adjust none；分时 prevClose=首根开盘", async () => {
  const orig = globalThis.fetch;
  const T0 = Date.UTC(2026, 10, 14); // 2026-11-14T00:00:00Z
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("interval=1d")) {
      return { ok: true, json: async () => [kline(T0, 100, 110, 90, 105, 12.5), kline(T0 + 86400000, 105, 120, 100, 118, 9.5)] };
    }
    if (u.includes("interval=5m")) {
      return { ok: true, json: async () => [kline(T0, 100, 101, 99, 100.5, 3), kline(T0 + 300000, 100.5, 102, 100, 101.5, 4)] };
    }
    throw new Error("unexpected " + u);
  };
  try {
    const k = await fetchKline("BTC-USDT", "day");
    assert.equal(k.error, null);
    assert.equal(k.adjust, "none");
    assert.deepEqual(k.candles, [
      { time: "2026-11-14", open: 100, high: 110, low: 90, close: 105, volume: 12.5 },
      { time: "2026-11-15", open: 105, high: 120, low: 100, close: 118, volume: 9.5 },
    ]);
    assert.ok(urls.some((u) => u.includes("interval=1d") && u.includes("limit=180")), "day → 1d&180");

    const m = await fetchMinuteDetail("BTC-USDT");
    assert.ok(urls.some((u) => u.includes("interval=5m") && u.includes("limit=288")), "分时 5m×288");
    assert.equal(m.error, null);
    assert.equal(m.prevClose, 100, "基准线＝区间首根开盘");
    assert.equal(m.points.length, 2);
    assert.deepEqual(m.points[0], { t: T0 / 1000, p: 100.5, v: 3 });
    const wantDate = new Date((T0 + 300000) + 8 * 3600 * 1000).toISOString().slice(0, 10);
    assert.equal(m.date, wantDate, "date＝末点 +8 日期");
  } finally {
    globalThis.fetch = orig;
  }
});

test("错误形状：传输失败 fetch-failed；码形非法 invalid-code", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  try {
    const k = await fetchKline("BTC-USDT", "day");
    assert.equal(k.error, "fetch-failed");
    assert.match(k.errorDetail ?? "", /ECONNRESET/);
    const m = await fetchMinuteDetail("BTC-USDT");
    assert.equal(m.error, "fetch-failed");
    assert.equal((await fetchKline("NOTACODE", "day")).error, "invalid-code");
    assert.equal((await fetchMinuteDetail("NOTACODE")).error, "invalid-code");
    assert.equal(await fetchQuote("NOTACODE"), null);
  } finally {
    globalThis.fetch = orig;
  }
});
