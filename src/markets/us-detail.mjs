/**
 * 美股详情图表（分时 / K 线）多源链（2026-11-13）。
 *
 *   K 线：东方财富 push2his（前复权 qfq，主源）-> 腾讯美股 K 线（备源，未复权，标 none；指数同样回落）
 *   分时：东方财富 trends2（主源）-> 雪球 minute.json（备源 #2，2026-11-17；guest cookie 引导见 xueqiu.mjs）
 *        -> Yahoo chart 1 分钟（备源 #3，昨收取 meta.chartPreviousClose；带 429 退避）
 *
 * 2026-11-17 补链缘由：EM 对机房 IP 整体封锁（push2 502、push2his 空回应，见 eastmoney.mjs 头注）
 * 且 Yahoo 对本机 IP 持续 429（实测 fc.yahoo.com cookie 引导无效，属 IP 级限速非缺 cookie），
 * 美股分时两源齐灭、整块 fetch-failed——雪球实测可用（盘中 170 根 1 分钟序列，指数同形态）插入链中。
 *
 * 为什么要备源：2026-11-13 东方财富 push2/push2his 在本机整体不通（push2his 连接后空回应，push2 返回 502），
 * 详情图表此前只有这一条路径，整块报 fetch-failed。
 *
 * 实测事实（2026-11-13）：
 *   - 腾讯美股 K 线必须带交易所后缀：usNVDA.OQ 返回 180 根、升序；无后缀 usNVDA 只返回 2 根，数据不完整。
 *     因此后缀按 .OQ -> .N -> .AM 逐个探测，成功后记住。返回键为 day/week/month，且未复权：
 *     跨拆股日的周 K、月 K 会出现断点，界面据 adjust='none' 如实标注「不复权」。
 *   - 腾讯美股分时实测无曲线级数据（2026-11-16 盘中复核定谳：minute/query 对 usAAPL 只回最新
 *     1 个点、带后缀 usAAPL.OQ 回垃圾；同端点对照 A股 267 行/港股 332 行全量曲线）——
 *     腾讯分时端点只服务 cn/hk，美股侧仅快照式单点，故不纳入分时备源。
 *   - Yahoo 1 分钟图表 2026-11-13 实测 HTTP 200 有收盘序列；但对本机连续请求会返回 429，
 *     因此 429、5xx 或网络错误后 120 秒内不再请求 Yahoo（提供方级退避）。
 *   - 指数（DJI/IXIC/INX）同样回落腾讯：fqkline 对指数只回 1 根（实测），须走裸 kline 端点 + 点号格式
 *     us.IXIC/us.DJI/us.INX，day/week/month 全周期 180/150/120 根实测可用（2026-11-13；此前指数 K 线
 *     只走 EM，push2his 间歇不可达时整块 fetch-failed，用户实录）。
 *
 * 缓存：成功结果 K 线 5 分钟、分时 30 秒，失败不缓存。无常驻定时器，全部惰性触发。
 * 熔断（2026-11-17）：EM/xueqiu 腿传输失败走自管链指数退避（30s→5min，成功清零），
 * 与快照链 chain gate 语义对齐；退避期跳过该源不再计数（防自增殖）。各腿终态失败经
 * opts.note 上报 diag（chart.<provider>.fail，errors 档自动收录），routes 层注入。
 */
import * as eastmoney from "./eastmoney.mjs";
import { fetchMinuteDetail as xueqiuMinute, resetXueqiuForTests } from "./xueqiu.mjs";
import { indexOfCode } from "../identity.mjs";

const TIMEOUT_MS = 10000;
const TENCENT_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=";
const TENCENT_KLINE_INDEX = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=";
const TENCENT_SUFFIXES = [".OQ", ".N", ".AM"];
const TENCENT_COUNT = { day: 180, week: 150, month: 120 };
const TENCENT_MIN_ROWS = 5;
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  referer: "https://finance.yahoo.com/",
};
const YAHOO_SYMBOL = { DJI: "^DJI", IXIC: "^IXIC", INX: "^GSPC" };
const YAHOO_BACKOFF_MS = 120000;
const CACHE_TTL = { kline: 5 * 60 * 1000, minute: 30 * 1000 };

const suffixByTicker = new Map();
const cache = new Map();
let yahooBackoffUntil = 0;

/* ---- 自管链 provider 熔断（2026-11-17）：快照链有 chain gate 指数退避，K线/分时自管链此前没有——
   EM 封锁期每次图表刷新都付全额探测税（本机实测 3s/次）。语义＝「暂时跳过该源」，不是「该码不存在」
   （与评审 R3-1「传输失败不得负缓存」不冲突：不产生任何 secid 负缓存结论）；仅传输失败（fetch-failed）
   计数，源应答但无数据不计数；成功/应答即清零。EM 与 xueqiu 共用记账（按 provider 名分桶）。 */
const BREAKER_BASE_MS = 30 * 1000;
const BREAKER_MAX_MS = 5 * 60 * 1000;
const breakerState = new Map(); // provider → { failures, backoffUntil }

function breakerOpen(name) {
  const s = breakerState.get(name);
  return s ? Date.now() < s.backoffUntil : false;
}

/** 退避期内跳过该源的合成形态（不得再计数，防退避自增殖） */
function breakerSkip(name) {
  return { date: null, prevClose: null, points: [], candles: [], adjust: null, error: "fetch-failed", errorDetail: name + "-backoff" };
}

/** 传输失败记账 + diag（④：*.fail 进 errors 档）；note 缺省（测试直调）只记账不外发 */
function breakerFail(name, detail, note) {
  const s = breakerState.get(name) ?? { failures: 0, backoffUntil: 0 };
  s.failures += 1;
  const backoff = Math.min(BREAKER_BASE_MS * 2 ** (s.failures - 1), BREAKER_MAX_MS);
  s.backoffUntil = Date.now() + backoff;
  breakerState.set(name, s);
  try {
    note?.({ ev: "chart." + name + ".fail", market: "us", error: String(detail ?? "fetch-failed").slice(0, 120), failures: s.failures, backoffMs: backoff });
  } catch {
    /* 诊断不得影响行情 */
  }
}

/** 源非传输终态（成功 / 应答但无数据）→ 传输层已证活，清零 */
function breakerReset(name) {
  breakerState.delete(name);
}

/** 测试用：清空后缀记忆、缓存与退避状态（含雪球引导 cookie 与自管链熔断） */
export function resetUsDetailForTests() {
  suffixByTicker.clear();
  cache.clear();
  yahooBackoffUntil = 0;
  breakerState.clear();
  resetXueqiuForTests();
}

function tickerOf(code) {
  return String(code ?? "").replace(/^us/i, "").toUpperCase().split(".")[0];
}

function cached(key, ttl) {
  const e = cache.get(key);
  return e && Date.now() - e.at < ttl ? e.value : null;
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** 腾讯美股 K 线：逐个后缀探测；有效行数不足 TENCENT_MIN_ROWS 视为该后缀无效 */
async function tencentKline(code, period) {
  const ticker = tickerOf(code);
  const count = TENCENT_COUNT[period] ?? 180;
  const remembered = suffixByTicker.get(ticker);
  // 指数：裸 kline 端点 + 点号格式 us.IXIC（fqkline 对指数只回 1 根，2026-11-13 实测）；
  // 个股：fqkline + 交易所后缀逐个探测（无后缀只回 2 根）
  const isIndex = indexOfCode("us", code) !== null;
  const candidates = isIndex ? [""] : remembered ? [remembered] : TENCENT_SUFFIXES;
  let lastError = "no-data";
  for (const suffix of candidates) {
    const sym = isIndex ? "us." + ticker : "us" + ticker + suffix;
    let json;
    try {
      const klineUrl = isIndex
        ? TENCENT_KLINE_INDEX + sym + "," + period + ",,," + count
        : TENCENT_KLINE + sym + "," + period + ",,," + count + ",qfq";
      const res = await fetch(klineUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = "fetch-failed";
        continue;
      }
      json = await res.json();
    } catch {
      lastError = "fetch-failed";
      continue;
    }
    const rows = json?.data?.[sym]?.[period];
    if (!Array.isArray(rows)) {
      lastError = "no-data";
      continue;
    }
    const candles = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const time = String(row[0]).slice(0, 10);
      const open = parseFloat(row[1]);
      const close = parseFloat(row[2]);
      const high = parseFloat(row[3]);
      const low = parseFloat(row[4]);
      const volume = parseFloat(row[5]) || 0;
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(time) || ![open, close, high, low].every(Number.isFinite)) continue;
      candles.push({ time, open, high, low, close, volume });
    }
    if (candles.length < TENCENT_MIN_ROWS) {
      lastError = "no-data";
      continue;
    }
    suffixByTicker.set(ticker, suffix);
    return { candles, adjust: "none", error: null };
  }
  return { candles: [], adjust: null, error: lastError };
}

function nyDate(epochSec) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSec * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

/** Yahoo 1 分钟图表（当日或最近交易日）。429、5xx 与网络错误进入退避；终态失败发 diag（④）。 */
async function yahooMinute(code, note) {
  if (Date.now() < yahooBackoffUntil) {
    return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: "yahoo-backoff" };
  }
  const sym = YAHOO_SYMBOL[tickerOf(code)] ?? tickerOf(code);
  let json;
  try {
    const res = await fetch(YAHOO_CHART + encodeURIComponent(sym) + "?interval=1m&range=1d&includePrePost=false", {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) yahooBackoffUntil = Date.now() + YAHOO_BACKOFF_MS;
      try {
        note?.({ ev: "chart.yahoo.fail", market: "us", error: "HTTP " + res.status, backoffMs: res.status === 429 || res.status >= 500 ? YAHOO_BACKOFF_MS : 0 });
      } catch { /* 诊断不得影响行情 */ }
      return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: "HTTP " + res.status };
    }
    json = await res.json();
  } catch (e) {
    yahooBackoffUntil = Date.now() + YAHOO_BACKOFF_MS;
    try {
      note?.({ ev: "chart.yahoo.fail", market: "us", error: String(e?.message ?? e).slice(0, 80), backoffMs: YAHOO_BACKOFF_MS });
    } catch { /* 诊断不得影响行情 */ }
    return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: String(e?.message ?? e).slice(0, 80) };
  }
  const r = json?.chart?.result?.[0];
  const ts = Array.isArray(r?.timestamp) ? r.timestamp : [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const p = q.close?.[i];
    if (typeof ts[i] !== "number" || typeof p !== "number" || !Number.isFinite(p) || p <= 0) continue;
    const v = q.volume?.[i];
    points.push({ t: ts[i], p, v: typeof v === "number" && Number.isFinite(v) ? v : 0 });
  }
  if (points.length === 0) return { date: null, prevClose: null, points: [], error: "no-data" };
  const pc = r?.meta?.chartPreviousClose;
  return {
    date: nyDate(points[0].t),
    prevClose: typeof pc === "number" && Number.isFinite(pc) ? pc : null,
    points,
    error: null,
  };
}

/** K 线：东方财富（前复权，带熔断）-> 腾讯美股（未复权）；指数同样回落腾讯（原始价，无复权概念） */
export async function fetchKline(code, period = "day", opts = {}) {
  const note = opts?.note ?? null;
  const per = ["day", "week", "month"].includes(period) ? period : "day";
  const key = "kl:" + code + ":" + per;
  const hit = cached(key, CACHE_TTL.kline);
  if (hit) return hit;
  let em;
  if (breakerOpen("eastmoney")) {
    em = breakerSkip("eastmoney"); // 退避期内跳过，不再计数
  } else {
    em = await eastmoney.fetchKline(code, per);
    if (em.error === "fetch-failed") breakerFail("eastmoney", em.errorDetail, note);
    else breakerReset("eastmoney");
  }
  if (em.candles?.length) {
    // EM fqt=1 对指数是无操作（指数无复权概念），但 EM 侧 kline 恒标 qfq 会误显「前复权」徽标；
    // README 口径：指数一律不复权（如实标注）——目录命中的美股指数覆写 none（2026-11-13 口径审计）
    return remember(key, indexOfCode("us", code) ? { ...em, adjust: "none" } : em);
  }
  // 指数不再排除腾讯（2026-11-13 用户实录：push2his 间歇不可达时美股指数 K 线整块 fetch-failed）——
  // 腾讯美股 K 线为原始价，指数无复权概念，标 none 与「不复权（如实标注）」口径一致
  const tx = await tencentKline(code, per);
  if (tx.error === "fetch-failed") {
    try {
      note?.({ ev: "chart.tencent.fail", market: "us", error: tx.error, code: String(code).toUpperCase() });
    } catch { /* 诊断不得影响行情 */ }
  }
  if (tx.candles.length) return remember(key, tx);
  const error = em.error === "fetch-failed" || tx.error === "fetch-failed" ? "fetch-failed" : (tx.error ?? em.error ?? "no-data");
  return { candles: [], adjust: null, error, errorDetail: em.errorDetail ?? null };
}

/** 分时：东方财富（trends2，带熔断）-> 雪球（guest 引导，带熔断）-> Yahoo 1 分钟（带退避） */
export async function fetchMinuteDetail(code, opts = {}) {
  const note = opts?.note ?? null;
  const key = "min:" + code;
  const hit = cached(key, CACHE_TTL.minute);
  if (hit) return hit;
  let em;
  if (breakerOpen("eastmoney")) {
    em = breakerSkip("eastmoney"); // 退避期内跳过，不再计数
  } else {
    em = await eastmoney.fetchMinuteDetail(code);
    if (em.error === "fetch-failed") breakerFail("eastmoney", em.errorDetail, note);
    else breakerReset("eastmoney");
  }
  if (em.points?.length) return remember(key, em);
  let xq;
  if (breakerOpen("xueqiu")) {
    xq = breakerSkip("xueqiu"); // 退避期内跳过，不再计数
  } else {
    xq = await xueqiuMinute(code);
    if (xq.error === "fetch-failed") breakerFail("xueqiu", xq.errorDetail, note);
    else breakerReset("xueqiu");
  }
  if (xq.points?.length) return remember(key, xq);
  const yh = await yahooMinute(code, note);
  if (yh.points.length) return remember(key, yh);
  const error = em.error === "fetch-failed" || yh.error === "fetch-failed" ? "fetch-failed" : (yh.error ?? em.error ?? "no-data");
  return { date: null, prevClose: null, points: [], error, errorDetail: yh.errorDetail ?? xq.errorDetail ?? em.errorDetail ?? null };
}
