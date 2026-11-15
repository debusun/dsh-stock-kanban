/**
 * §12.56 删除 toast 退役契约（取代 client-undo.test.mjs：6s 撤销链于 2026-11-15 主人拍板退役——
 * 确认条已是真防线，短窗口+有损复原无实际受益人）。
 * 桩法沿袭原 undo 套路：globalThis.fetch 按前缀路由 + storage stub + node:test mock.timers 停表。
 * mutate 是异步串行链——所有断言前 await。
 *
 * 契约：
 *   - removeSymbol 成功（result.ok === true）→ 纯文本 toast「已删除 {name}」，无 action 字段；
 *   - store 不再暴露 undoRemoveSymbol（接口面退役钉）；
 *   - setToast 默认窗口不变（3800ms 守卫 / 4000ms 定时）；
 *   - panel toast 纯文本渲染，永不出现 .skc-toast-action 撤销钮。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createDomHarness } from "./helpers/dom-harness.mjs";
import { createStore } from "../client/store.mjs";
import { createPanel } from "../client/panel.mjs";
import { setLang, t } from "../client/i18n.mjs";

function createStorageStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** fetch stub：按前缀路由；handler 返回 payload（默认 ok:true）或 { ok:false, status, body } 模拟失败。返回恢复函数。 */
function stubFetch(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (path) => {
    const hit = routes.find(([prefix]) => String(path).startsWith(prefix));
    if (!hit) throw new Error(`stub-fetch: no route for ${String(path)}`);
    const payload = await hit[1](String(path));
    if (payload && payload.ok === false) {
      return { ok: false, status: payload.status ?? 500, json: async () => payload.body ?? { error: "stub-error" } };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  return () => {
    globalThis.fetch = real;
  };
}

const SYMBOLS = [
  { id: "s1", market: "cn", code: "600519", name: "贵州茅台", sort: 0, quantity: 2, avgCost: 100, buyTarget: 90, sellTarget: 110 },
  { id: "s2", market: "hk", code: "00700", name: "腾讯控股", sort: 1 },
];
const STATE_PAYLOAD = { rev: 5, settings: { privacyMode: false }, symbols: SYMBOLS, driverKind: "stub" };

async function seedStore(store, routes = []) {
  // seeding 只挂 /state；完成后即恢复，测试路由以持久 stub 重新挂载（返回其 restore）
  const restoreSeed = stubFetch([
    ["/stock-kanban/state", async () => ({ ...STATE_PAYLOAD })],
  ]);
  try {
    await store.refreshState();
  } finally {
    restoreSeed();
  }
  return stubFetch(routes);
}

test("① removeSymbol 成功 → 纯文本 toast（无 action）；undoRemoveSymbol 已退役", async () => {
  setLang("zh");
  const store = createStore(createStorageStub());
  let removeCalled = 0;
  const restore = await seedStore(store, [
    ["/stock-kanban/symbols/remove", async () => {
      removeCalled += 1;
      return { ok: true };
    }],
    ["/stock-kanban/state", async () => ({ ...STATE_PAYLOAD })],
  ]);
  try {
    const r = await store.removeSymbol("s1");
    assert.equal(r.ok, true, "前置：删除成功");
    assert.equal(removeCalled, 1);
    const toast = store.getState().toast;
    assert.equal(toast.text, t("toast.removed", { name: "贵州茅台" }), "removed 文案");
    assert.equal(toast.action, undefined, "无 action 字段（撤销已退役）");
    assert.equal(store.undoRemoveSymbol, undefined, "接口面退役钉");
  } finally {
    restore();
    store.dispose();
  }
});

test("② setToast 默认窗口不变（3800 守卫 / 4000 定时，mock.timers 停表）", (t) => {
  setLang("zh");
  const store = createStore(createStorageStub());
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    store.setToast("plain");
    t.mock.timers.tick(3800);
    assert.notEqual(store.getState().toast, null, "3800ms 定时器未触发（4000 才触发）");
    t.mock.timers.tick(200);
    assert.equal(store.getState().toast, null, "4000ms 触发 → 3800 守卫 → 清除");
  } finally {
    t.mock.timers.reset();
    store.dispose();
  }
});

test("③ panel patchToast 纯文本：永不出现撤销钮（.skc-toast-action 退役钉）", async () => {
  setLang("zh");
  const h = createDomHarness();
  const store = {
    closePanel() {}, setCapsuleSymbol() {}, setPrivacy() {}, setShowAdd() {}, setShowSettings() {}, pollQuotes() {}, setQuotaMerge() {},
  };
  const stubView = () => ({ el: h.document.createElement("div"), update() {}, dispose() {} });
  const panel = createPanel({
    doc: h.document,
    win: h.window,
    store,
    views: { list: stubView(), detail: stubView(), add: stubView(), backup: stubView() },
  });
  h.document.body.append(panel.el);
  try {
    const base = {
      ui: { panelOpen: true, view: "list", showAdd: false, showSettings: false, lastMarket: "cn", holdingsOnly: false, capsuleSymbolId: null, quotaCapable: false, quotaMerge: true, maVisible: { 5: true, 10: true, 20: true, 60: true }, detailId: null },
      business: { rev: 1, settings: {}, symbols: [], loaded: true },
      quoteMeta: { fetchedAt: 1, error: null },
      providers: null,
    };
    panel.update({ ...base, toast: { text: "已删除 贵州茅台", at: 1 } });
    const toastEl = panel.el.querySelector(".skc-toast");
    assert.equal(toastEl.textContent, "已删除 贵州茅台", "纯文本渲染");
    assert.equal(panel.el.querySelector(".skc-toast-action"), null, "撤销钮退役钉");
  } finally {
    panel.dispose();
    h.cleanup();
  }
});
