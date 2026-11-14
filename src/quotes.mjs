/**
 * 行情服务：市场分组 + 行整形（ADR-0007 后）。
 *
 * - 链编排与提供方记账（TTL 缓存/在途合并/指数退避/失败诊断/health 记账）全在 chain.mjs（单一权威），
 *   本模块只做行情域语义：按市场分组、行整形、`price > 0` 有效判、health 薄转发（两层契约不变：
 *   顶层 provider 键恒在空对象占位、market 子键仅触达时出现）；
 * - 行语义（§12.46 口径保留）：每标的独立判错——未被任何源服务到才标 error；ok 行带 source（实际供数方）
 *   与 fallbackFrom（首个失败/丢弃源，链首直接供数为 null）；error 行 quoteTime/source/fallbackFrom 恒 null，
 *   error 字符串 = 末次传输错误消息（含退避快速失败的 backoff-<name>）或 "no-data"；
 * - getQuotes 与 getQuoteFull 同一实现（ADR-0007）：单码 = 长度 1 的 code-set，经同一 gate 享缓存与退避；
 *   旧 fullCache/guardedFull/fullAdapter 已删除——缺行随成功响应进 TTL 缓存，下一轮询自愈；
 * - 无任何常驻定时器：全部惰性触发，宿主空闲时零后台活动（需求 8.2 不变）。
 */

import { CHAINS } from "./markets/chain.mjs";

export function createQuoteService({ chain } = {}) {
  if (!chain) throw new Error("chain-required: createQuoteService({ chain })——链编排已收拢 chain.mjs（ADR-0007）");

  const validateQuote = (v) => v && v.price > 0;

  /** 快照/详情共路：按市场分组过链 → 行整形。返回 Map(id → row)。 */
  async function getQuotes(identities) {
    const byMarket = new Map();
    for (const identity of identities) {
      if (!CHAINS[identity.market]) continue;
      const group = byMarket.get(identity.market) ?? [];
      group.push(identity);
      byMarket.set(identity.market, group);
    }
    const out = new Map();
    await Promise.all([...byMarket.entries()].map(async ([market, list]) => {
      const cells = await chain.runChain(market, "snap", list.map((i) => i.code), (p, codes) => p.fetch(codes), { validate: validateQuote });
      const fetchedAt = chain.now();
      for (const identity of list) {
        const cell = cells.get(identity.code);
        if (cell?.ok) {
          out.set(identity.id, {
            id: identity.id,
            identity,
            status: "ok",
            quote: cell.value,
            fetchedAt,
            quoteTime: cell.quoteTime,
            source: cell.source,
            fallbackFrom: cell.fallbackFrom,
          });
        } else {
          out.set(identity.id, {
            id: identity.id,
            identity,
            status: "error",
            quote: null,
            fetchedAt,
            quoteTime: null,
            source: null,
            fallbackFrom: null,
            error: cell?.error ?? "no-data",
          });
        }
      }
    }));
    return out;
  }

  /** 详情页完整快照（高低开收全字段）：与快照同路，单码形态天然享 gate 的缓存与退避（Yahoo 429 防护不变）。 */
  async function getQuoteFull(identities) {
    return getQuotes(identities);
  }

  /** 诊断载荷薄转发（/quotes、/health 的 providers 载荷）。 */
  function health() {
    return chain.health();
  }

  return { getQuotes, getQuoteFull, health };
}
