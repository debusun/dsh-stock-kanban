import test from "node:test";
import assert from "node:assert/strict";
import { createDomHarness } from "./helpers/dom-harness.mjs";
import { createPanel } from "../client/panel.mjs";
import { getLang, setLang, t } from "../client/i18n.mjs";
import { fmtTrendPct } from "../client/fmt.mjs";

/* 设置对话框「涨跌配色」组（ADR-0009，实施计划 T7）——radio 三行 + 真实预览 + 快照驱动 aria */

function setupSettingsPanel() {
  const h = createDomHarness();
  h.setViewport(h.window, 1024, 768);
  const host = h.document.createElement("div");
  h.document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const actions = [];
  const store = {
    closePanel: () => {},
    setCapsuleSymbol: () => {},
    setPrivacy: () => {},
    setShowAdd: () => {},
    setShowSettings: () => {},
    pollQuotes: () => {},
    setQuotaMerge: () => {},
    setTrendColorMode: (m) => actions.push(["setTrendColorMode", m]),
  };
  const stubView = () => ({ el: h.document.createElement("div"), update() {}, dispose() {} });
  const views = { list: stubView(), detail: stubView(), add: stubView(), backup: stubView() };
  const panel = createPanel({ doc: h.document, win: h.window, store, views });
  shadow.append(panel.el);
  const snap = (mode = "red-up") => ({
    business: { rev: 1, settings: { privacyMode: false, trendColorMode: mode }, symbols: [], driverKind: null, loaded: true },
    quotes: {},
    quoteMeta: { fetchedAt: 1, error: null },
    ui: {
      panelOpen: true, view: "list", detailId: null, showAdd: false, showSettings: true,
      lastMarket: "cn", holdingsOnly: false, maVisible: { 5: true, 10: true, 20: true, 60: true },
      capsuleSymbolId: null, quotaCapable: false, quotaMerge: true,
    },
    toast: null,
    providers: null,
  });
  return { h, panel, actions, snap, restore() { panel.dispose(); h.cleanup(); } };
}

test("设置组 · 涨跌配色 radio 三行 + aria + 预览 + 点击写档（ADR-0009 T7）", () => {
  const prevLang = getLang();
  const s = setupSettingsPanel();
  try {
    setLang("zh");
    s.panel.update(s.snap("red-up"));
    const group = s.panel.el.querySelector('.skc-colorsem[role="radiogroup"]');
    assert.ok(group, "radiogroup 在位");
    assert.equal(group.getAttribute("aria-label"), t("colorsem.title"), "组 aria-label = 组标签");

    const rows = [...group.querySelectorAll('button[role="radio"]')];
    assert.equal(rows.length, 3, "竖排三行 radio");
    const checked = rows.filter((r) => r.getAttribute("aria-checked") === "true");
    assert.equal(checked.length, 1, "恰好一行选中");
    assert.equal(checked[0].dataset.mode, "red-up", "默认档 red-up 选中");
    assert.equal(rows[0].querySelector(".skc-colorsem-label").textContent, t("colorsem.mode.redup"), "zh 标签取自字典");
    assert.equal(rows[2].querySelector(".skc-colorsem-sub").textContent, t("colorsem.sub.native"), "副标取自字典");

    // 预览：行1 涨红/跌绿；行3 同涨不同色（沪红/美绿）+ 市场小标签
    const p1 = [...rows[0].querySelectorAll(".skc-csp-red,.skc-csp-green")];
    assert.deepEqual(p1.map((x) => x.className), ["skc-csp-red", "skc-csp-green"], "行1 预览=涨红/跌绿");
    assert.equal(p1[0].textContent, fmtTrendPct(2.35), "预览=真实渲染（▲+2.35%）");
    const p3 = [...rows[2].querySelectorAll(".skc-csp-red,.skc-csp-green")];
    assert.deepEqual(p3.map((x) => x.className), ["skc-csp-red", "skc-csp-green"], "行3 同涨不同色：沪红/美绿");
    const tags = [...rows[2].querySelectorAll(".skc-colorsem-tag")];
    assert.deepEqual(tags.map((x) => x.textContent), [t("colorsem.tag.cn"), t("colorsem.tag.us")], "行3 市场小标签");

    // 点击行2 → store.setTrendColorMode（mutate 包装：失败 toast 由 store 层承担，另见 store.test）
    rows[1].click();
    assert.deepEqual(s.actions, [["setTrendColorMode", "green-up"]], "点击走 store.setTrendColorMode，无乐观更新");

    // 下一次快照带到 green-up → aria-checked 跟随（写入失败 = 快照仍旧档自然回滚）
    s.panel.update(s.snap("green-up"));
    const checked2 = [...group.querySelectorAll('[aria-checked="true"]')];
    assert.equal(checked2.length, 1, "仍恰一行选中");
    assert.equal(checked2[0].dataset.mode, "green-up", "选中态随快照");
  } finally {
    setLang(prevLang);
    s.restore();
  }
});

test("设置组 · zh/en 文案切换实时跟随（骨架静态文案重套 t()）", () => {
  const prevLang = getLang();
  const s = setupSettingsPanel();
  try {
    setLang("zh");
    s.panel.update(s.snap("native"));
    const group = s.panel.el.querySelector('[role="radiogroup"]');
    setLang("en");
    s.panel.update(s.snap("native"));
    const labels = [...group.querySelectorAll(".skc-colorsem-label")].map((x) => x.textContent);
    assert.deepEqual(labels, [t("colorsem.mode.redup"), t("colorsem.mode.greenup"), t("colorsem.mode.native")], "en 标签实时套用");
    const tags = [...group.querySelectorAll(".skc-colorsem-tag")].map((x) => x.textContent);
    assert.deepEqual(tags, ["CN", "US"], "en 市场小标签实时套用");
  } finally {
    setLang(prevLang);
    s.restore();
  }
});
