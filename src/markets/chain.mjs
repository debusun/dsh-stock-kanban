/**
 * 行情链单一权威（ADR-0007）：数据化链表 + 提供方注册 + per-(provider, market) 记账 + attempt 注入 runner。
 *
 * - 链知识唯一载体：批量快照、详情单码、直连添加校验、K线/分时备源全部经 runChain（四处消费，另见
 *   docs/plans/2026-11-15-quote-chain-single-authority-implementation-plan.md）；
 * - attempt(provider, codes) → Map<code, value>：抛错 = 传输失败；validate(value) → boolean（必填）：
 *   不过 = 无数据（该码交下源）；supports(provider) → boolean（缺省 handles(market)）；
 * - cell 三态（值语义钉死）：ok（value=供数源原值、error=null）/ no-data（value=末源对该码返回原值、
 *   error=null）/ transport（value=null、error=末次 attempt 错误消息）；补位行 fallbackFrom=首个失败/丢弃源；
 * - 链序解析：内置 providers 表按 CHAINS[market] 数据化链序；注入自定义 providers 表（测试形态）时
 *   按表内排列顺序为链序——链序随提供方集合走，CHAINS 仍为内置链的唯一权威；
 * - 时钟唯一：now 注入单点，消费方经 chain.now() 取时。
 */

import { handles as tencentHandles, fetchBatchSnapshots as tencentBatch, quoteTimeOf as tencentQuoteTime } from "./tencent.mjs";
import { handles as emHandles, fetchBatchSnapshots as emBatch } from "./eastmoney.mjs";
import { handles as yahooHandles, fetchBatchSnapshots as yahooBatch } from "./yahoo.mjs";
import { handles as tencentUsHandles, fetchBatchSnapshots as tencentUsBatch, quoteTimeOf as tencentUsQuoteTime } from "./tencent-us.mjs";
import { handles as okxHandles, fetchBatchSnapshots as okxBatch } from "./okx.mjs";
import { handles as sinaHandles, fetchBatchSnapshots as sinaBatch } from "./sina.mjs";

/** 快照链序（顺序即优先级） */
export const CHAINS = {
  cn: ["tencent", "eastmoney", "sina"],
  hk: ["tencent", "eastmoney"],
  us: ["eastmoney", "tencent-us", "yahoo"],
  crypto: ["okx"],
};

const BUILT_IN_PROVIDERS = [
  { name: "tencent", handles: tencentHandles, fetch: tencentBatch, quoteTime: tencentQuoteTime },
  { name: "eastmoney", handles: emHandles, fetch: emBatch, quoteTime: null },
  { name: "tencent-us", handles: tencentUsHandles, fetch: tencentUsBatch, quoteTime: tencentUsQuoteTime },
  { name: "yahoo", handles: yahooHandles, fetch: yahooBatch, quoteTime: null },
  { name: "okx", handles: okxHandles, fetch: okxBatch, quoteTime: null },
  { name: "sina", handles: sinaHandles, fetch: sinaBatch, quoteTime: null }, // quoteTimeMs 已在 parser 内按东八区解析
];

export function createChain({ now = () => Date.now(), diag, ttlMs = 10 * 1000, backoffBaseMs = 30 * 1000, backoffMaxMs = 5 * 60 * 1000, providers = BUILT_IN_PROVIDERS } = {}) {
  const byName = new Map(providers.map((p) => [p.name, p]));

  /** (提供方, 市场) → 记账三件套：TTL 缓存 + 在途合并 + 失败计数/指数退避（成功即清零）。 */
  const state = new Map();
  function stateOf(name, market) {
    const key = name + "|" + market;
    let s = state.get(key);
    if (!s) {
      s = { cache: new Map(), inFlight: new Map(), failures: 0, backoffUntil: 0, lastOkAt: null, lastErrorAt: null, lastError: null };
      state.set(key, s);
    }
    return s;
  }
  function backoffMs(s) {
    return s.failures === 0 ? 0 : Math.min(backoffBaseMs * 2 ** (s.failures - 1), backoffMaxMs);
  }

  /**
   * 单提供方取数闸：TTL 缓存 + 在途合并 + 指数退避。
   * 退避窗口内：有缓存回陈旧行（行内 quoteTime 保持旧值，消费方按其判 stale），无缓存抛 backoff-<name>——
   * 快速失败不计 failures、不发 diag（与旧 fetchProvider 语义逐字对齐，2026-11-13 P0-1）。
   */
  async function gate(provider, market, ns, codes, attempt) {
    const s = stateOf(provider.name, market);
    const key = ns + "|" + [...codes].sort().join(",");
    const t = now();
    const cached = s.cache.get(key);
    if (cached && t - cached.at < ttlMs) return cached.rows;
    if (t < s.backoffUntil) {
      if (cached) return cached.rows;
      throw new Error("backoff-" + provider.name);
    }
    const inflight = s.inFlight.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const rows = await attempt(provider, codes);
        s.failures = 0;
        s.backoffUntil = 0;
        s.lastOkAt = now();
        s.cache.set(key, { at: now(), rows });
        return rows;
      } catch (e) {
        s.failures += 1;
        const b = backoffMs(s);
        s.backoffUntil = now() + b;
        s.lastErrorAt = now();
        s.lastError = String(e?.message ?? e).slice(0, 120);
        try {
          diag?.({ ev: "provider.fail", provider: provider.name, market, error: s.lastError, failures: s.failures, backoffMs: b });
        } catch {
          /* 诊断不得影响行情 */
        }
        throw e;
      } finally {
        s.inFlight.delete(key);
      }
    })();
    s.inFlight.set(key, p);
    return p;
  }

  async function runChain(market, ns, codes, attempt, { validate, supports } = {}) {
    if (typeof validate !== "function") throw new Error("validate-required");
    const sup = supports ?? ((p) => p.handles(market));
    const order = (providers === BUILT_IN_PROVIDERS
      ? (CHAINS[market] ?? []).map((n) => byName.get(n)).filter(Boolean)
      : providers.filter((p) => sup(p)));

    const out = new Map();
    const firstFail = new Map(); // code → 首个失败/丢弃源（ADR-0007 §fallbackFrom，镜像旧 §12.46 口径）
    const lastDisposition = new Map(); // code → 'transport' | 'no-data'（末源处置）
    const lastValue = new Map(); // code → 末源返回原值（no-data cell 携带）
    const lastErr = new Map(); // code → 末次传输错误消息
    let pending = [...codes];
    for (const code of codes) out.set(code, { ok: false, value: null, quoteTime: null, source: null, fallbackFrom: null, error: null, errorKind: "no-data" });

    for (const provider of order) {
      if (!sup(provider)) continue;
      if (pending.length === 0) break;
      let rows = null;
      try {
        rows = await gate(provider, market, ns, pending, attempt);
      } catch (e) {
        const msg = String(e?.message ?? e);
        for (const code of pending) {
          if (!firstFail.has(code)) firstFail.set(code, provider.name);
          lastDisposition.set(code, "transport");
          lastErr.set(code, msg);
          lastValue.set(code, null);
        }
        continue; // 整源失败 → 剩余码交下源
      }
      const still = [];
      for (const code of pending) {
        const v = rows.get(code) ?? rows.get(String(code).toUpperCase()) ?? null;
        if (v && validate(v)) {
          out.set(code, {
            ok: true,
            value: v,
            quoteTime: provider.quoteTime ? provider.quoteTime(v) : (v?.quoteTimeMs ?? null),
            source: provider.name,
            fallbackFrom: firstFail.get(code) ?? null,
            error: null,
            errorKind: null,
          });
        } else {
          if (!firstFail.has(code)) firstFail.set(code, provider.name);
          lastDisposition.set(code, "no-data");
          lastValue.set(code, v ?? null);
          still.push(code);
        }
      }
      pending = still;
    }

    for (const code of pending) {
      const kind = lastDisposition.get(code) ?? "no-data";
      out.set(code, {
        ok: false,
        value: kind === "transport" ? null : (lastValue.get(code) ?? null),
        quoteTime: null,
        source: null,
        fallbackFrom: firstFail.get(code) ?? null,
        error: kind === "transport" ? (lastErr.get(code) ?? null) : null,
        errorKind: kind,
      });
    }
    return out;
  }

  /** 两层契约（§12.49 镜像）：顶层 provider 键恒在（未触达=空对象占位）；market 子键仅触达时出现。 */
  function health() {
    const out = {};
    for (const p of providers) out[p.name] = {};
    for (const [key, s] of state) {
      const sep = key.indexOf("|");
      const name = key.slice(0, sep);
      const market = key.slice(sep + 1);
      if (!out[name]) continue;
      out[name][market] = { failures: s.failures, backoffRemainMs: Math.max(0, s.backoffUntil - now()), lastOkAt: s.lastOkAt, lastErrorAt: s.lastErrorAt, lastError: s.lastError };
    }
    return out;
  }

  return { runChain, health, now };
}
