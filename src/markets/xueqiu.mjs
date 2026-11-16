/**
 * 雪球分时适配器（美股分时备源 #2，2026-11-17 新增）：链位 EM trends2 之后、Yahoo 之前。
 *
 * 为什么要加（2026-11-16/17 实录，美股盘中美股分时整链不可用）：
 *   - 东方财富 push2/push2his 对本机房 IP 整体封锁（push2 https/http 均 502，push2his
 *     连接后空回应，编号镜像域 21/23/40.push2his 连 TCP 都建不起来；IPv4/IPv6 同型），
 *     resolveUSSecid 严格模式探测全传输失败 → SECID_TRANSPORT，EM 分时/K线腿全灭；
 *   - Yahoo query1/query2 对本机 IP 持续 429（偶发放行窗口不构成可用性；fc.yahoo.com
 *     cookie 引导实测无效——带 A3 cookie 照样 429，是 IP 级限速不是缺 cookie）；
 *   - 腾讯美股分时只有最新 1 个点（minute/query 实测），mkline 对美股 301，均不可用；
 *   - 雪球 guest 引导（fetch https://xueqiu.com/ 自动跟随 301 → www，最终响应
 *     getSetCookie() 暴露 xq_a_token 等）后 minute.json 实测 200，返回全量 1 分钟序列。
 *
 * 实测事实（2026-11-16 美股盘中）：
 *   - GET https://stock.xueqiu.com/v5/stock/chart/minute.json?symbol=AAPL&period=1d
 *     → data.items[]：current/volume/avg_price/timestamp(epoch ms)/high/low/…，
 *     data.last_close=昨收；items 自 09:30 ET 起 1 分钟一根；盘后另在 data.after[]（不采）；
 *   - 只带 xq_a_token 即可用（实测）；引导请求把最终响应全部 cookie 对都带上，贴近浏览器；
 *   - 指数符号 .DJI/.IXIC/.INX 同端点同形态可用（实测 170 根）；
 *   - token 过期/无效 → HTTP 400 + body error_code 400016：重新引导一次再试（自愈）。
 *
 * 错误口径与 eastmoney minute 同形：传输层失败 → fetch-failed；空数据 → no-data。
 * 失败不缓存、token 进程内复用；无常驻定时器，全部惰性触发。
 */

const HOME = "https://xueqiu.com/";
const MINUTE_URL = "https://stock.xueqiu.com/v5/stock/chart/minute.json";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 10000;

/** 美股指数代码 → 雪球符号（普通 ticker 原样） */
const INDEX_SYMBOL = { DJI: ".DJI", IXIC: ".IXIC", INX: ".INX" };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

let xqCookie = "";

/** 测试用：清空引导 cookie 与全部状态 */
export function resetXueqiuForTests() {
  xqCookie = "";
}

function symbolOf(code) {
  const t = String(code ?? "").toUpperCase().split(".")[0];
  return INDEX_SYMBOL[t] ?? t;
}

/** guest 引导：GET 首页（fetch 自动跟随 301→www），取最终响应全部 cookie 对 */
async function bootstrapCookie() {
  const res = await fetch(HOME, {
    headers: { "user-agent": UA, accept: "text/html,application/json,*/*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const pairs = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c.includes("="));
  if (!pairs.some((p) => p.startsWith("xq_a_token="))) {
    const e = new Error("xueqiu-no-cookie");
    e.code = "XUEQIU_NO_COOKIE";
    throw e;
  }
  xqCookie = pairs.join("; ");
}

/** minute.json 一次请求（带当前 cookie）；HTTP 400 交由调用方判 400016 重引导 */
async function requestMinute(symbol) {
  const url = MINUTE_URL + "?symbol=" + encodeURIComponent(symbol) + "&period=1d";
  return fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", referer: "https://xueqiu.com/", cookie: xqCookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/* 纽约日期（与 us-detail nyDate 同口径；独立小副本避免环 import） */
function nyDate(epochSec) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(epochSec * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

function itemsToMinute(items) {
  const points = [];
  for (const it of items ?? []) {
    const ts = num(it?.timestamp);
    const p = num(it?.current);
    if (ts == null || ts <= 0 || p == null || p <= 0) continue;
    const v = num(it?.volume);
    points.push({ t: Math.floor(ts / 1000), p, v: v != null && v >= 0 ? v : 0 });
  }
  return points;
}

/**
 * 美股分时（当日）。成功返回 { date, prevClose, points, error: null }；
 * 传输失败/引导失败 → fetch-failed；应答但无点位 → no-data。guest token 失效（400016）
 * 重新引导一次重试；再失败按传输失败处理。
 */
export async function fetchMinuteDetail(code) {
  if (!xqCookie) {
    try {
      await bootstrapCookie();
    } catch (e) {
      return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: String(e?.message ?? e).slice(0, 80) };
    }
  }
  let res;
  try {
    res = await requestMinute(symbolOf(code));
    if (res.status === 400) {
      // guest token 失效/无效：重引导一次再试；仍 400 按传输失败（链内让位 Yahoo）
      await bootstrapCookie();
      res = await requestMinute(symbolOf(code));
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (e) {
    return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: String(e?.message ?? e).slice(0, 80) };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { date: null, prevClose: null, points: [], error: "fetch-failed", errorDetail: String(e?.message ?? e).slice(0, 80) };
  }
  const points = itemsToMinute(json?.data?.items);
  if (points.length === 0) return { date: null, prevClose: null, points: [], error: "no-data" };
  const preClose = num(json?.data?.last_close);
  return {
    date: nyDate(points[0].t),
    prevClose: preClose != null && preClose > 0 ? preClose : null,
    points,
    error: null,
  };
}
