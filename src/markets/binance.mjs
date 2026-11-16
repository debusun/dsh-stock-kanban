/**
 * Binance 现货适配器（加密货币备源，2026-11-17）—— 链位 OKX 之后（CHAINS.crypto = ["okx","binance"]）。
 *
 * 为什么加（③ 钢人评审定案）：crypto 快照/K线/分时此前全为 OKX 单源，OKX 区域封锁/维护＝加密全灭。
 * binance 公共 REST 零鉴权、本机实测全通（2026-11-17：ping 76ms、klines/ticker 200）。注意
 * dsh-stock-view 2026-11-06 曾实测 api.binance.com HTTP 451（地域限制）——可用性与部署地强相关，
 * 恰是备源价值：OKX 与 binance 的封禁/风控域不对称，同灭概率低于单源。
 *
 * 协议事实（2026-11-17 本机实测钉死）：
 *   - GET /api/v3/ticker/24hr?symbols=["BTCUSDT",…]（URL 编码 JSON 数组）一次批量；单坏代码整批
 *     HTTP 400（{"code":-1121,"msg":"Invalid symbol."}）→ 退化为逐标的循环，坏码缺席、好码照回；
 *   - ticker 字段：lastPrice / openPrice(=24h 滚动开盘，prevClosePrice 同值) / highPrice / lowPrice /
 *     priceChange / priceChangePercent / volume(基础币 24h) / quoteVolume(计价币 24h) / closeTime；
 *   - GET /api/v3/klines 升序返回（旧→新），[openTime,open,high,low,close,volume,…]；
 *     interval 1d/1w/1M 对 day/week/month；
 *   - 分时＝最近 24h 5m×288（升序），与 OKX bar=5m&limit=288 同窗。
 *
 * 与 OKX 主源口径对齐（okx.mjs 为准）：
 *   - 快照 prevClose＝24h 滚动开盘（openPrice，语义同 OKX open24h）；涨跌额/% 同 24h 滚动口径；
 *   - K线 adjust 恒 "none"；limit 同表（180/150/120）；行 time +8h 对齐东八区日期习惯
 *     （切分差异如实记录：OKX 按 UTC+8 切分、binance 按 UTC 切分，桶边界有分歧——备源形态可接受）；
 *   - 分时 prevClose＝区间首根开盘；date＝末点 +8 日期；
 *   - 错误形状同 OKX：图表传输失败 fetch-failed / 应答无数据 no-data / 码形非法 invalid-code；
 *     批量快照传输失败整批抛错（触发提供方级退避）。
 */

import { parseInstId } from "./okx.mjs";

const BASE = "https://api.binance.com/api/v3";
const UA = "dsh-stock-kanban/0.1 (DeepSeek Harness plugin)";
const TIMEOUT_MS = 12000;
const TZ_OFFSET_MS = 8 * 3600 * 1000;
const BATCH_MAX = 100; // binance symbols 参数单请求上限
const CHUNK_FALLBACK = 400; // 批量 400（坏码整批拒绝）→ 退化为逐标的

export function handles(market) {
  return market === "crypto";
}

/** "BTC-USDT" → "BTCUSDT"；非法码 null */
export function binanceSymbolOf(code) {
  const parsed = parseInstId(code);
  return parsed ? parsed.base + parsed.quote : null;
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function binanceJson(path, timeout = TIMEOUT_MS) {
  const res = await fetch(BASE + path, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.httpStatus = res.status;
    throw e;
  }
  return res.json();
}

/** ticker/24hr 行 → 快照行（行形状与 OKX tickerToQuote 同构；code 键＝入参 instId 形态） */
function tickerToQuote(instId, t) {
  if (!t || t.lastPrice === undefined) return null;
  const price = num(t.lastPrice);
  if (price == null || price <= 0) return null;
  const open24h = num(t.openPrice);
  return {
    code: String(instId ?? "").toUpperCase(),
    name: "",
    price,
    prevClose: open24h, // 24h 口径的基准价（与 OKX open24h 同语义）
    open: null,
    high: num(t.highPrice),
    low: num(t.lowPrice),
    changeAmount: open24h != null ? price - open24h : null,
    changePercent: open24h != null && open24h > 0 ? ((price - open24h) / open24h) * 100 : null,
    volume: num(t.volume), // 基础币量（如 BTC）
    amount: num(t.quoteVolume), // 计价币额（如 USDT）
    quoteTimeMs: num(t.closeTime),
  };
}

/** 单标的快照 */
export async function fetchQuote(code) {
  const instId = parseInstId(code)?.instId;
  const symbol = binanceSymbolOf(code);
  if (!instId || !symbol) return null;
  const t = await binanceJson(`/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
  return tickerToQuote(instId, t);
}

/**
 * 批量快照：≤2 个逐个 ticker；>2 个用 symbols 参数一次批量（>100 分片）。
 * 批量被坏码整批拒绝（HTTP 400）时退化为逐标的循环：坏码缺席、好码照回。
 * 传输失败（网络/5xx）整体抛错（调用方触发提供方级退避）。
 */
export async function fetchBatchSnapshots(codes) {
  const pairs = [...new Set((codes ?? []).map((c) => {
    const instId = parseInstId(c)?.instId;
    const symbol = binanceSymbolOf(c);
    return instId && symbol ? { instId, symbol } : null;
  }).filter(Boolean).map((p) => JSON.stringify(p)))].map((s) => JSON.parse(s));
  const out = new Map();
  if (pairs.length === 0) return out;
  const put = (instId, t) => {
    const quote = tickerToQuote(instId, t);
    if (quote) out.set(quote.code, quote);
  };
  if (pairs.length <= 2) {
    for (const p of pairs) put(p.instId, await binanceJson(`/ticker/24hr?symbol=${encodeURIComponent(p.symbol)}`)); // 失败上抛 → provider 级退避
    return out;
  }
  for (let i = 0; i < pairs.length; i += BATCH_MAX) {
    const chunk = pairs.slice(i, i + BATCH_MAX);
    const symbolsParam = encodeURIComponent(JSON.stringify(chunk.map((p) => p.symbol)));
    try {
      const rows = await binanceJson(`/ticker/24hr?symbols=${symbolsParam}`, 20000);
      const bySymbol = new Map((Array.isArray(rows) ? rows : []).map((t) => [String(t.symbol ?? ""), t]));
      for (const p of chunk) put(p.instId, bySymbol.get(p.symbol));
    } catch (e) {
      if (e?.httpStatus !== CHUNK_FALLBACK) throw e; // 网络与 5xx 整批抛错退避；400 才逐标的退化
      for (const p of chunk) {
        try {
          put(p.instId, await binanceJson(`/ticker/24hr?symbol=${encodeURIComponent(p.symbol)}`)); // 坏码缺席
        } catch {
          /* 单标的失败缺席（不整批失败） */
        }
      }
    }
  }
  return out;
}

const INTERVAL_OF_PERIOD = { day: "1d", week: "1w", month: "1M" };
const LIMIT_OF_PERIOD = { day: 180, week: 150, month: 120 };

/** K线（无复权概念，adjust "none"；升序入参直接映射，time +8h 对齐东八区日期习惯） */
export async function fetchKline(code, period = "day") {
  const symbol = binanceSymbolOf(code);
  if (!symbol) return { candles: [], adjust: null, error: "invalid-code" };
  const interval = INTERVAL_OF_PERIOD[period] ?? "1d";
  const limit = LIMIT_OF_PERIOD[period] ?? 180;
  let rows;
  try {
    rows = await binanceJson(`/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`);
  } catch (e) {
    return { candles: [], adjust: null, error: "fetch-failed", errorDetail: String(e.message ?? e).slice(0, 80) };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { candles: [], adjust: null, error: "no-data" };
  const candles = rows
    .map((r) => ({
      time: new Date(num(r[0]) + TZ_OFFSET_MS).toISOString().slice(0, 10),
      open: num(r[1]),
      high: num(r[2]),
      low: num(r[3]),
      close: num(r[4]),
      volume: num(r[5]) ?? 0,
    }))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.time) && c.open != null && c.close != null)
    .sort((a, b) => a.time.localeCompare(b.time));
  if (candles.length === 0) return { candles: [], adjust: null, error: "no-data" };
  return { candles, adjust: "none", error: null };
}

/** 分时 = 最近 24h（5m×288，升序）；基准线取区间首根开盘价（与 OKX 同口径） */
export async function fetchMinuteDetail(code) {
  const symbol = binanceSymbolOf(code);
  if (!symbol) return { date: null, prevClose: null, points: [], error: "invalid-code" };
  let rows;
  try {
    rows = await binanceJson(`/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`);
  } catch (e) {
    return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: String(e.message ?? e).slice(0, 80) };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { date: null, prevClose: null, points: [], error: "no-data" };
  const asc = [...rows].sort((a, b) => num(a[0]) - num(b[0]));
  const points = asc
    .map((r) => ({ t: Math.round(num(r[0]) / 1000), p: num(r[4]), v: num(r[5]) ?? 0 }))
    .filter((p) => p.t > 0 && p.p != null && p.p > 0);
  if (points.length === 0) return { date: null, prevClose: null, points: [], error: "no-data" };
  const firstOpen = num(asc[0][1]);
  return {
    date: new Date(points[points.length - 1].t * 1000 + TZ_OFFSET_MS).toISOString().slice(0, 10),
    prevClose: firstOpen != null && firstOpen > 0 ? firstOpen : points[0].p,
    points,
    error: null,
  };
}
