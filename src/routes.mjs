/**
 * HTTP 路由：业务状态 / 标的 CRUD / 行情 / K线 / 分时 / 搜索 / 导入导出。
 * 全部 exact 路由先过官方信任检查（trust 壳），POST 再强制同源 + JSON + 体积上限；响应 no-store。
 * 日志不输出持仓数值与备份内容（只记 id 与动作）。
 */

import { isSameOriginRequest } from "./access.mjs";
import { identityConsistent, MARKETS } from "./identity.mjs";
import { buildExportPayload, parseImportPayload, normalizeTrendColorMode } from "./model.mjs";
import { targetState, validateTargets } from "./targets.mjs";
import { positionMetrics } from "./portfolio.mjs";

export const PREFIX = "/stock-kanban";

const MUTATION_BODY_MAX = 64 * 1024;
const IMPORT_BODY_MAX = 512 * 1024;

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(body.length),
  });
  res.end(body);
}

function queryOf(req) {
  return new URL(req.url ?? "/", "http://local").searchParams;
}

async function readJsonBody(req, maxBytes) {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw Object.assign(new Error("content-type must be application/json"), { status: 400 });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > maxBytes) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(part);
  }
  if (chunks.length === 0) throw Object.assign(new Error("empty body"), { status: 400 });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid json"), { status: 400 });
  }
}

/** 变更路由公共壳：同源校验 + rev CAS + 错误映射（默认 64KiB；import 用 512KiB；label 供诊断） */
function mutation(handler, maxBytes = MUTATION_BODY_MAX, label = "(mutation)") {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { error: "origin-rejected" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, maxBytes);
    } catch (e) {
      sendJson(res, e.status ?? 400, { error: String(e.message ?? e) });
      return;
    }
    const rev = deps.store.rev;
    if (body.ifRev != null && Number(body.ifRev) !== rev) {
      note({ ev: "store.conflict", path: label, have: rev, got: Number(body.ifRev) });
      sendJson(res, 409, { error: "rev-conflict", rev, state: statePayload() });
      return;
    }
    try {
      await handler(body, res);
    } catch (e) {
      const status = e.status ?? (e.code === "invalid-patch" ? 400 : 500);
      sendJson(res, status, { error: String(e.message ?? e), rev: deps.store.rev });
    }
  };
}

/** 依赖注入（host.mjs 装配） */
let deps = null;

/** 诊断出口（deps.diag 可选，P1-6）：等级过滤在 diag 侧；诊断异常不得影响业务 */
function note(row) {
  try {
    deps?.diag?.append?.(row);
  } catch {
    /* 诊断失败静默 */
  }
}

export function createRoutes({ store, quotes, chain, logger, trust, diag }) {
  if (!chain) throw new Error("chain-required: createRoutes({ ..., chain })——添加校验与 K线/分时备源已收拢 chain.mjs（ADR-0007）");
  deps = { store, quotes, chain, logger: logger ?? console, diag: diag ?? null };
  /**
   * route.status 日志门（P1-6，2026-11-13）：同 path+status 两分钟内最多一行，重复只计 dropped——
   * 死上游不再刷屏（纪律参考 dsh-market-lens 的 route.status gate，MIT，见 NOTICE）。
   * 按最终 res.statusCode 记账（处理器结束后 finally 读取）；不包 res 代理——
   * Node response 的内部槽位不跨代理对象（Object.create 包装曾致 /state 挂起，实测教训）。
   */
  const statusLogAt = new Map();
  const STATUS_LOG_WINDOW_MS = 120000;
  const noteStatus = (path, status) => {
    try {
      if (!(status >= 400)) return;
      const key = path + "|" + String(status);
      const at = Date.now();
      const last = statusLogAt.get(key);
      if (last === undefined || at - last.at >= STATUS_LOG_WINDOW_MS) {
        note({ ev: "route.status", path, status, dropped: last === undefined ? 0 : last.dropped });
        statusLogAt.set(key, { at, dropped: 0 });
      } else {
        last.dropped += 1;
      }
    } catch {
      /* 门自身异常不影响响应 */
    }
  };
  /**
   * 官方信任检查壳 + 状态日志门：rejection 非 undefined → 以该状态码直接拒绝（401/403），读路由不豁免。
   * peer 存在 = DSH 框架层已完成准入（webserver 把 admission.peer 作为第三参传入），此时守卫不再重复判定：
   * 0.2.2-rc.2 起框架默认 auth='required'，自带 Host/Origin/凭据全链检查，插件的二次守卫只会误拒。
   */
  const withTrust = (path, handler) => async (req, res, peer) => {
    const rejection = peer !== undefined ? undefined : (typeof trust === "function" ? trust(req) : undefined);
    if (rejection !== undefined) {
      note({ ev: "route.reject", path, status: rejection });
      sendJson(res, rejection, { error: "untrusted" });
      noteStatus(path, rejection);
      return;
    }
    try {
      await handler(req, res);
    } finally {
      noteStatus(path, res.statusCode);
    }
  };
  const route = (path, handler) => ({ path, handler: withTrust(path, handler) });
  return [
    route(`${PREFIX}/state`, stateRoute),
    route(`${PREFIX}/symbols/add`, mutation(addSymbolRoute, MUTATION_BODY_MAX, "symbols/add")),
    route(`${PREFIX}/symbols/update`, mutation(updateSymbolRoute, MUTATION_BODY_MAX, "symbols/update")),
    route(`${PREFIX}/symbols/reorder`, mutation(reorderSymbolRoute, MUTATION_BODY_MAX, "symbols/reorder")),
    route(`${PREFIX}/symbols/remove`, mutation(removeSymbolRoute, MUTATION_BODY_MAX, "symbols/remove")),
    route(`${PREFIX}/settings`, mutation(settingsRoute, MUTATION_BODY_MAX, "settings")),
    route(`${PREFIX}/search`, searchRoute),
    route(`${PREFIX}/quotes`, quotesRoute),
    route(`${PREFIX}/kline`, klineRoute),
    route(`${PREFIX}/minute`, minuteRoute),
    route(`${PREFIX}/export`, exportRoute),
    route(`${PREFIX}/import`, mutation(importRoute, IMPORT_BODY_MAX, "import")),
    route(`${PREFIX}/health`, healthRoute),
    route(`${PREFIX}/diag`, diagRoute),
  ];
}

/** 导出业务状态（GET /state）。持仓数值原样下发——脱敏是客户端展示行为（4.6 界面遮挡）。 */
function statePayload() {
  const store = deps.store;
  return {
    rev: store.rev,
    settings: { privacyMode: store.global.settings.privacyMode === true, trendColorMode: normalizeTrendColorMode(store.global.settings.trendColorMode) },
    updatedAt: store.global.updatedAt,
    symbols: store.symbols,
    driverKind: store.driverKind,
  };
}

function stateRoute(_req, res) {
  sendJson(res, 200, statePayload());
}

async function addSymbolRoute(body, res) {
  const market = String(body.market ?? "");
  const code = String(body.code ?? "");
  const { resolveDirect } = await import("./markets/search.mjs");
  const resolved = await resolveDirect(market, code, { chain: deps.chain });
  if (!resolved.ok) {
    sendJson(res, 422, { error: resolved.error === "invalid-format" ? "invalid-identity" : resolved.error });
    return;
  }
  const { newSymbolRecord, patchSymbolRecord } = await import("./model.mjs");
  const built = newSymbolRecord(market, code, resolved.name, { kind: resolved.kind });
  if (!built.ok) {
    sendJson(res, 422, { error: built.error });
    return;
  }
  // 直连添加可带初始持仓/目标价（可选）
  let record = built.record;
  const patchKeys = ["quantity", "avgCost", "buyTarget", "sellTarget"];
  const patch = {};
  for (const key of patchKeys) if (key in (body.patch ?? {})) patch[key] = body.patch[key];
  if (Object.keys(patch).length > 0) {
    const applied = patchSymbolRecord(record, patch);
    if (!applied.ok) {
      sendJson(res, 422, { error: applied.errors.join(",") });
      return;
    }
    record = applied.record;
  }
  const targets = validateTargets(record.buyTarget, record.sellTarget);
  if (!targets.ok) {
    sendJson(res, 422, { error: targets.errors.join(",") });
    return;
  }
  try {
    const result = await deps.store.addSymbol(record);
    deps.logger?.info?.(`stock-kanban: symbol added ${record.id}`);
    sendJson(res, 200, { rev: result.global.rev, symbol: result.symbol, overlapHint: targets.overlap ? "overlap" : null });
  } catch (e) {
    if (String(e.message) === "duplicate") sendJson(res, 409, { error: "duplicate" });
    else sendJson(res, 500, { error: "save-failed" });
  }
}

async function updateSymbolRoute(body, res) {
  const id = String(body.id ?? "");
  const patch = body.patch ?? {};
  const current = deps.store.getSymbol(id);
  if (!current) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  const next = {
    buyTarget: "buyTarget" in patch ? patch.buyTarget : current.buyTarget,
    sellTarget: "sellTarget" in patch ? patch.sellTarget : current.sellTarget,
  };
  const targets = validateTargets(next.buyTarget, next.sellTarget);
  if (!targets.ok) {
    sendJson(res, 422, { error: targets.errors.join(",") });
    return;
  }
  const result = await deps.store.updateSymbol(id, patch);
  sendJson(res, 200, { rev: result.global.rev, symbol: result.symbol, overlapHint: targets.overlap ? "overlap" : null });
}

async function removeSymbolRoute(body, res) {
  const result = await deps.store.removeSymbol(String(body.id ?? ""));
  deps.logger?.info?.(`stock-kanban: symbol removed ${body.id}`);
  sendJson(res, 200, { rev: result.global.rev });
}

/** 拖拽排序持久化：market 分组内全量 id 排列 → 组内 sort 重编号（单次 rev 推进） */
async function reorderSymbolRoute(body, res) {
  const market = String(body.market ?? "");
  const orderedIds = body.orderedIds;
  if (!MARKETS.includes(market) || !Array.isArray(orderedIds)) {
    sendJson(res, 422, { error: "invalid-order" });
    return;
  }
  try {
    const result = await deps.store.reorderSymbols(market, orderedIds);
    if (result.changed) deps.logger?.info?.(`stock-kanban: symbols reordered ${market} n=${result.count}`);
    sendJson(res, 200, { rev: result.global.rev, changed: result.changed });
  } catch (e) {
    if (e.code === "invalid-order") sendJson(res, 422, { error: "invalid-order" });
    else sendJson(res, 500, { error: "save-failed" });
  }
}

async function settingsRoute(body, res) {
  const patch = {};
  if (typeof body.privacyMode === "boolean") patch.privacyMode = body.privacyMode;
  if (typeof body.trendColorMode === "string") patch.trendColorMode = normalizeTrendColorMode(body.trendColorMode); // ADR-0009：非法值 normalize 回默认，不报错（与 privacyMode 强转同风格）
  const result = await deps.store.setSettings(patch);
  sendJson(res, 200, { rev: result.global.rev, settings: result.global.settings });
}

async function searchRoute(req, res) {
  const q = queryOf(req);
  const market = q.get("market") ?? "";
  const needle = q.get("q") ?? "";
  const { search } = await import("./markets/search.mjs");
  try {
    const result = await search(market, needle, { chain: deps.chain }); // ADR-0008：名称覆写走行情链同 gate
    sendJson(res, 200, { rows: result.rows, error: result.error });
  } catch (e) {
    // 搜索源故障：明确报错，绝不给虚构结果
    sendJson(res, 200, { rows: [], error: `search-unavailable: ${String(e?.message ?? e).slice(0, 80)}` });
  }
}

/** GET /quotes?ids=a:sh600519,crypto:BTC-USDT[&full=1] */
async function quotesRoute(req, res) {
  const ids = (queryOf(req).get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 80);
  const full = queryOf(req).get("full") === "1";
  const identities = [];
  for (const id of ids) {
    const symbol = deps.store.getSymbol(id);
    if (symbol && identityConsistent(symbol)) identities.push(symbol);
  }
  const rowsById = {};
  if (identities.length > 0) {
    let rows;
    if (full) {
      rows = await deps.quotes.getQuoteFull(identities);
    } else {
      rows = await deps.quotes.getQuotes(identities);
    }
    const now = Date.now();
    for (const [id, row] of rows) {
      const symbol = deps.store.getSymbol(id);
      const metrics = positionMetrics(symbol, row.status === "ok" ? row.quote.price : null);
      const target = targetState({
        price: row.status === "ok" ? row.quote.price : null,
        quoteTime: row.quoteTime,
        fetchedAt: row.fetchedAt,
        now,
        buyTarget: symbol?.buyTarget ?? null,
        sellTarget: symbol?.sellTarget ?? null,
      });
      rowsById[id] = {
        id,
        status: row.status,
        name: row.quote?.name || symbol?.name || null,
        price: row.quote?.price ?? null,
        prevClose: row.quote?.prevClose ?? null,
        open: row.quote?.open ?? null,
        high: row.quote?.high ?? null,
        low: row.quote?.low ?? null,
        changeAmount: row.quote?.changeAmount ?? null,
        changePercent: row.quote?.changePercent ?? null,
        volume: row.quote?.volume ?? null,
        amount: row.quote?.amount ?? null,
        fetchedAt: row.fetchedAt,
        quoteTime: row.quoteTime,
        source: row.source ?? null, // §12.46：实际供数方 token；error 行为 null
        fallbackFrom: row.fallbackFrom ?? null, // §12.46：首个失败/丢弃该标的的源 token；链首直接供数为 null
        target,
        metrics: metrics.hasPosition ? metrics : null,
      };
    }
  }
  sendJson(res, 200, { rev: deps.store.rev, rows: rowsById, providers: deps.quotes.health() });
}

/**
 * 快照锚定量纲自适应（§12.53，评审 F2 收口）：腾讯 fqkline 上游在 手↔股 间跨窗口翻转
 * （§12.52 F2：HEAD 窗口 sh600519/bj920000 原生股、前缀启发式 ×100 过缩放 100×；sh688111 1×），
 * 前缀启发式（klineVolumeToShares）无法自证。快照量（f36，§12.47 口径=股）为稳定锚：
 * 日 K 末根量 / 快照量 ≈100 → ÷100 回正；≈0.01 → ×100；其余（≈1/快照缺/量 0）不动。
 * 仅 cn/hk 的 tencent/eastmoney 腿 + 日 K 生效（us/crypto 量纲另系）；锚定失败静默保持原响应
 * （前缀启发式兜底），每次纠偏发 diag kline.volume.anchor 供审计。
 */
async function anchorKlineVolume(symbol, period, packed) {
  const { result, source } = packed;
  if (result?.error || !Array.isArray(result?.candles) || result.candles.length === 0) return result;
  if (period !== "day" || (symbol.market !== "cn" && symbol.market !== "hk")) return result;
  if (source !== "tencent" && source !== "eastmoney") return result;
  try {
    const rows = await deps.quotes.getQuotes([symbol]);
    const snapVol = [...rows.values()][0]?.quote?.volume ?? null;
    const last = result.candles[result.candles.length - 1];
    if (!snapVol || !last?.volume) return result;
    const ratio = last.volume / snapVol;
    const scale = ratio >= 50 && ratio <= 200 ? 0.01 : ratio >= 0.005 && ratio <= 0.02 ? 100 : 1;
    if (scale === 1) return result;
    note({ ev: "kline.volume.anchor", market: symbol.market, code: symbol.code, source, ratio: Number(ratio.toFixed(3)), scale });
    return { ...result, candles: result.candles.map((c) => ({ ...c, volume: Math.round(c.volume * scale) })) };
  } catch {
    return result;
  }
}

async function klineRoute(req, res) {
  const q = queryOf(req);
  const symbol = deps.store.getSymbol(q.get("id") ?? "");
  const period = ["day", "week", "month"].includes(q.get("period") ?? "") ? q.get("period") : "day";
  if (!symbol) {
    sendJson(res, 404, { error: "symbol-not-found" });
    return;
  }
  let packed;
  if (symbol.market === "us") {
    const adapter = await adapterFor(symbol.market);
    packed = { result: await adapter.fetchKline(symbol.code, period, { note }), source: "us-detail" }; // us 自管链（ADR-0007；note → 各腿 diag）
  } else {
    packed = await chartResult("kline", symbol, period); // cn/hk/crypto 查链表（ADR-0007）
  }
  const result = await anchorKlineVolume(symbol, period, packed); // 快照锚定量纲自适应（§12.53）
  sendJson(res, 200, {
    id: symbol.id,
    period,
    candles: result.candles,
    adjust: result.adjust,
    error: result.error,
    errorDetail: result.errorDetail ?? null,
    updatedAt: Date.now(),
  });
}

async function minuteRoute(req, res) {
  const symbol = deps.store.getSymbol(queryOf(req).get("id") ?? "");
  if (!symbol) {
    sendJson(res, 404, { error: "symbol-not-found" });
    return;
  }
  let packed;
  if (symbol.market === "us") {
    const adapter = await adapterFor(symbol.market);
    packed = { result: await adapter.fetchMinuteDetail(symbol.code, { note }), source: "us-detail" }; // us 自管链（ADR-0007；note → 各腿 diag）
  } else {
    packed = await chartResult("minute", symbol); // cn/hk/crypto 查链表（ADR-0007）
  }
  const result = packed.result;
  // 空分时不得伪装成功（§12.35 用户反馈：上证指数间歇性空白）：点位不足 2 个按 no-data 上报，客户端据此走休市/错误提示并可重试
  if (!result.error && (!Array.isArray(result.points) || result.points.length < 2)) result = { ...result, points: Array.isArray(result.points) ? result.points : [], error: "no-data" };
  sendJson(res, 200, {
    id: symbol.id,
    date: result.date,
    prevClose: result.prevClose,
    points: result.points,
    error: result.error,
    errorDetail: result.errorDetail ?? null,
    updatedAt: Date.now(),
  });
}

/** us 详情自管链（ADR-0007：us-detail 内部 EM→腾讯/Yahoo 维持原样）；cn/hk/crypto 走 chain.runChain（chartResult） */
async function adapterFor(market) {
  return import("./markets/us-detail.mjs");
}

/* ---- K线/分时入链（ADR-0007 Task 6）：cn/hk/crypto 查链表逐源补位，EM 腿按市场给复权口径 ---- */

/** K线 attempt 表：EM hk 腿 fqt=0（对齐腾讯实际输出 day/none）、cn 腿 fqt=1（与腾讯 qfqday 同口径） */
async function klineAttemptTable(market) {
  const tencent = await import("./markets/tencent.mjs");
  const eastmoney = await import("./markets/eastmoney.mjs");
  const table = {
    tencent: async (code, period) => tencent.fetchKline(code, period),
    eastmoney: async (code, period) => eastmoney.fetchKline(code, period, { adjust: market === "hk" ? "none" : "qfq" }),
  };
  if (market === "crypto") {
    const okx = await import("./markets/okx.mjs");
    table.okx = async (code, period) => okx.fetchKline(code, period);
    const binance = await import("./markets/binance.mjs"); // 2026-11-17 ③：crypto K线备源
    table.binance = async (code, period) => binance.fetchKline(code, period);
  }
  return table;
}

/** 分时 attempt 表（trends2/腾讯 minute/okx 分时） */
async function minuteAttemptTable(market) {
  const tencent = await import("./markets/tencent.mjs");
  const eastmoney = await import("./markets/eastmoney.mjs");
  const table = {
    tencent: async (code) => tencent.fetchMinuteDetail(code),
    eastmoney: async (code) => eastmoney.fetchMinuteDetail(code),
  };
  if (market === "crypto") {
    const okx = await import("./markets/okx.mjs");
    table.okx = async (code) => okx.fetchMinuteDetail(code);
    const binance = await import("./markets/binance.mjs"); // 2026-11-17 ③：crypto 分时备源
    table.binance = async (code) => binance.fetchMinuteDetail(code);
  }
  return table;
}

/**
 * cn/hk/crypto 图表经链取数：attempt 抛错=传输失败（fetch-failed 形态抛出，gate 记账/退避/补位），
 * validate 不过=无数据（交下源）；全链失败按 errorKind 映射回既有响应字段（形状逐字段不变）。
 */
async function chartResult(kind, symbol, period = "day") {
  const table = kind === "kline" ? await klineAttemptTable(symbol.market) : await minuteAttemptTable(symbol.market);
  const attempt = async (provider, codes) => {
    const fn = table[provider.name];
    const out = new Map();
    for (const code of codes) {
      const r = await fn(code, period);
      if (r?.error === "fetch-failed") throw new Error(r.errorDetail ?? "fetch-failed");
      out.set(code, r);
    }
    return out;
  };
  const validate = (r) => r && !r.error && (kind === "kline"
    ? (Array.isArray(r.candles) && r.candles.length > 0)
    : (Array.isArray(r.points) && r.points.length >= 2));
  const cells = await deps.chain.runChain(symbol.market, kind === "kline" ? "kline:" + period : "minute", [symbol.code], attempt, {
    validate,
    supports: (p) => p.name in table,
    cache: false, // 图表旧行为零缓存（§12.35：退化答案不得冻住下一拍轮询）；退避/在途合并仍生效
  });
  const cell = cells.get(symbol.code);
  if (cell?.ok) return { result: cell.value, source: cell.source };
  const error = cell?.errorKind === "transport" ? "fetch-failed" : (cell?.value?.error ?? "no-data"); // 保留末源错误码（api-error/invalid-code 不吞）
  const errorDetail = cell?.errorKind === "transport" ? (cell.error ?? null) : (cell?.value?.errorDetail ?? null);
  const result = kind === "kline"
    ? { candles: [], adjust: cell?.value?.adjust ?? null, error, errorDetail }
    : { date: cell?.value?.date ?? null, prevClose: cell?.value?.prevClose ?? null, points: [], error, errorDetail };
  return { result, source: null };
}

function exportRoute(_req, res) {
  const payload = buildExportPayload(deps.store.global, Object.fromEntries(deps.store.symbols.map((s) => [s.id, s])));
  const body = Buffer.from(JSON.stringify(payload, null, 1));
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="stock-kanban-backup-${stamp}.json"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(body.length),
  });
  res.end(body);
}

async function importRoute(body, res) {
  const parsed = parseImportPayload(body.payload);
  if (!parsed.ok) {
    sendJson(res, 422, { error: parsed.error });
    return;
  }
  const result = await deps.store.importAll(parsed.symbols, parsed.settings);
  deps.logger?.info?.(`stock-kanban: import applied imported=${result.imported} removed=${result.removed} rejected=${parsed.rejected}`);
  sendJson(res, 200, {
    rev: result.global.rev,
    imported: result.imported,
    removed: result.removed,
    rejected: parsed.rejected,
  });
}

function healthRoute(_req, res) {
  sendJson(res, 200, {
    driver: deps.store.driverKind,
    symbolCount: deps.store.symbols.length,
    providers: deps.quotes.health(),
  });
}

/** GET /diag?tail=50 回读尾部；POST 批量收客户端诊断行（同源 + JSON + 64KiB + ≤200 行）。P1-6。 */
async function diagRoute(req, res) {
  if (req.method === "POST") {
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { error: "origin-rejected" });
      return;
    }
    try {
      const body = await readJsonBody(req, MUTATION_BODY_MAX);
      const rawRows = Array.isArray(body?.rows)
        ? body.rows.slice(0, 200).filter((r) => r && typeof r === "object" && typeof r.ev === "string" && String(r.ev).trim() !== "")
        : [];
      // 客户端行二次过滤（2026-11-13 评审轮2 P3）：ev 强制归入 client. 命名空间——服务端
      // 保留事件族（provider./route./store./host.）不可被客户端伪造注入诊断日志、绕不过
      // route.status 门；时间戳权威在宿主侧（diag.append 展开序），src 恒覆写 client。
      const reserved = /^(provider\.|route\.|store\.|host\.)/;
      const rows = [];
      let rejectedReserved = 0;
      for (const raw of rawRows) {
        const ev = String(raw.ev).trim().replace(/^client\./, "");
        if (reserved.test(ev)) { rejectedReserved += 1; continue; }
        rows.push({ ...raw, ev: "client." + ev, src: "client" });
      }
      for (const row of rows) note(row);
      sendJson(res, 200, { ok: true, stored: rows.length, rejected: rejectedReserved });
    } catch (e) {
      sendJson(res, e.status ?? 400, { error: String(e?.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    if (!deps.diag) {
      sendJson(res, 200, { file: null, rows: [] });
      return;
    }
    const n = Number(queryOf(req).get("tail") ?? "50");
    const { file, rows } = await deps.diag.tail(Number.isFinite(n) ? n : 50);
    sendJson(res, 200, { file, rows });
    return;
  }
  res.setHeader("Allow", "GET, POST");
  sendJson(res, 405, { error: "method-not-allowed" });
}
