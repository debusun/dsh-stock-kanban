/**
 * 第 13 轮详情 hero 单测：fmtChange 纯函数（Task 1）+ hero 三行结构/降级/新鲜度（Task 3）。
 * 夹具形态沿用 tests/client-detail-fit.test.mjs 的 setupDetail（createDomHarness + createDetail + fetch stub）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fmtChange, priceDigits } from "../client/fmt.mjs";

test("fmtChange：正负号 + 千分位 + 边界", () => {
  assert.equal(fmtChange(2885.4), "+2,885.40");
  assert.equal(fmtChange(-2885.4), "-2,885.40");
  assert.equal(fmtChange(0), "0.00");
  assert.equal(fmtChange(null), "—");
  assert.equal(fmtChange(Number.NaN), "—");
  assert.equal(fmtChange(0.1), "+0.10"); // 自身档 4 位、min 2 保底 → 0.10
  assert.equal(fmtChange(-0.001), "-0.001"); // <0.01 档 6 位 → 永不 -0.00
});

test("fmtChange：浮点尾差经档位消音 + 混合规则（参考价格档位 + 裁拖零）", () => {
  assert.equal(fmtChange(64486.7 - 67372.1), "-2,885.40");
  assert.equal(fmtChange(-0.082, priceDigits(2.44)), "-0.082"); // 创业板例：自身档 4 → -0.082（裁拖零）
  assert.equal(fmtChange(-0.004, priceDigits(0.945)), "-0.004"); // 富国例：自身档 6 → -0.004（不出 -0.004000）
  assert.equal(fmtChange(-21.48, priceDigits(3634.35)), "-21.48"); // 指数例：2 位不变
  assert.equal(fmtChange(-0.004, 2), "-0.004"); // 无参考价时自身档兜底，同样不出 -0.00
});

/* ---------------- Task 3：hero 三行数据栈 ---------------- */

import { createDomHarness } from "./helpers/dom-harness.mjs";
import { createDetail } from "../client/detail.mjs";
import { FLOAT_STYLE_TEXT } from "../client/styles.mjs";
import { getLang, setLang, t } from "../client/i18n.mjs";
import { fmtClock, fmtClockSec } from "../client/fmt.mjs";

const SYMBOL = {
  id: "cn:sz159206",
  market: "cn",
  code: "sz159206",
  name: "卫星ETF永赢",
  quoteCurrency: "CNY",
  kind: "etf",
  quantity: 100,
  avgCost: 10,
  buyTarget: null,
  sellTarget: null,
};

const QUOTE_ROW = {
  status: "ok",
  price: 8.5,
  changePercent: 0.3,
  changeAmount: 0.1,
  quoteTime: 1,
  fetchedAt: 1,
  source: "okx",
  fallbackFrom: null,
  target: { status: "fresh" },
};

function setupHero({ lang = "zh" } = {}) {
  const h = createDomHarness();
  const prevLang = getLang();
  setLang(lang);
  h.setViewport(h.window, 1100, 680);
  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
  };
  globalThis.document = h.document;
  globalThis.window = h.window;
  globalThis.localStorage = h.localStorage;
  globalThis.fetch = async (url) => {
    const body = String(url).includes("/kline")
      ? { candles: [], adjust: "qfq" }
      : { points: [], prevClose: 8.4 };
    return { ok: true, status: 200, json: async () => body };
  };
  const store = {
    backToList() {},
    updateSymbol: async () => ({ ok: true }),
    removeSymbol: async () => ({ ok: true }),
    setToast() {},
    setMaVisible() {},
  };
  const detail = createDetail({ store, win: h.window });
  h.document.body.append(detail.el);
  const snap = (row = QUOTE_ROW) => ({
    business: { rev: 1, settings: { privacyMode: false }, symbols: [SYMBOL], driverKind: null, loaded: true },
    quotes: { [SYMBOL.id]: row },
    quoteMeta: { fetchedAt: 1, error: null },
    ui: {
      panelOpen: true, view: "detail", detailId: SYMBOL.id, showAdd: false, showSettings: false,
      lastMarket: "cn", holdingsOnly: false, maVisible: { 5: true, 10: true, 20: true, 60: true }, capsuleSymbolId: null,
    },
    toast: null,
    providers: null,
  });
  return {
    h,
    detail,
    snap,
    restore() {
      detail.dispose();
      setLang(prevLang);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
      h.cleanup?.();
    },
  };
}

test("hero 三行结构：价格行 / 变动行（chg+pct 同色）/ 新鲜度行；chg 缺 changeAmount 时隐藏", () => {
  const s = setupHero();
  try {
    s.detail.update(s.snap());
    const line = s.detail.el.querySelector(".skc-quote-line");
    assert.ok(line, "quote-line 在位");
    const price = line.querySelector(".skc-quote-price");
    const move = line.querySelector(".skc-quote-move");
    const chg = line.querySelector(".skc-quote-chg");
    const pct = line.querySelector(".skc-quote-pct");
    assert.ok(move && chg && pct, "变动行容器与两 span 在位");
    assert.equal(price.textContent, "8.50");
    assert.equal(price.className.includes("skc-up"), true, "价格着色跟涨跌向");
    assert.equal(chg.hidden, false);
    assert.equal(chg.textContent, fmtChange(0.1)); // "+0.1000"（abs≥0.01 四位档）
    assert.equal(chg.className.includes("skc-up"), true, "涨跌额与涨跌幅同色");
    assert.equal(pct.textContent, "+0.30%");
    const metaText = line.querySelector(".skc-quote-meta").textContent;
    assert.equal(metaText.includes(t("detail.freshness", { t: fmtClock(1), s: t("provider.okx") })), true, "新鲜度单表达式（HH:mm · 经典全称源）");
    assert.equal(metaText.includes(t("providerShort.okx")), false, "缩写源已退役");
    assert.equal(line.querySelector(".skc-badge"), null, "徽章已迁头部（hero 行不再有徽章）");
    const headBadge = s.detail.el.querySelector(".skc-detail-titlerow .skc-badge");
    assert.ok(headBadge, "头部徽章槽在位（与标的名同行）");
    assert.equal(line.querySelector(".skc-badge"), null, "徽章只存在于头部（hero 行/元数据行不再有徽章）");
    // 显隐值随真实时钟（休市/过期判定）漂移，不在单测钉死——badgeKind 逻辑由既有用例覆盖
    assert.equal(line.title, t("detail.quote-tip", { q: fmtClock(1), f: fmtClockSec(1) }), "双时间戳（含秒）降级为 tooltip");
    // 退化分支：去掉 changeAmount 再喂快照
    const row = { ...QUOTE_ROW };
    delete row.changeAmount;
    s.detail.update(s.snap(row));
    const line2 = s.detail.el.querySelector(".skc-quote-line");
    assert.equal(line2.querySelector(".skc-quote-chg").hidden, true, "无 changeAmount → chg 隐藏");
    assert.equal(line2.querySelector(".skc-quote-pct").textContent, "+0.30%", "pct 仍在（退化不空窗）");
  } finally {
    s.restore();
  }
});

test("hero 单行：价格+变动+新鲜度同 baseline（主人 2026-11-15 终版拍板）；溢出落右对齐第二行兜底", () => {
  const st = FLOAT_STYLE_TEXT;
  assert.ok(
    st.includes(".skc-quote-line{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;text-align:left;margin:10px 0 12px}"),
    "单行 flex baseline；放不下 → meta 整簇落第二行（右对齐）",
  );
  assert.ok(st.includes(".skc-quote-price{flex:none;"), "价格不参与换行");
  assert.ok(st.includes(".skc-quote-price--sm{font-size:24px}"), "长价（格式化 ≥9 字符）降 24px 保单行");
  assert.ok(st.includes(".skc-quote-price--xs{font-size:22px}"), "极端价（≥12 字符）降 22px 保单行");
  assert.ok(st.includes(".skc-quote-move{flex:none;"), "变动组不参与换行");
  assert.ok(st.includes(".skc-quote-meta{flex:1 1 auto;"), "元数据集群弹性占尾、右对齐");
  assert.equal(st.includes(".skc-quote-line{display:block;text-align:center;margin:10px 0 12px}"), false, "§12.54 居中串退役");
});

test("hero 退役：detail.quote-time 键删除（缺键回退键名）", () => {
  setLang("zh");
  assert.equal(t("detail.quote-time"), "detail.quote-time");
  setLang("en");
  assert.equal(t("detail.quote-time"), "detail.quote-time");
  setLang("zh");
});
