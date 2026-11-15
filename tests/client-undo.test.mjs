/**
 * 第 13 轮删除撤销链单测（client/store.mjs 捕获 + toast action + client/panel.mjs 撤销钮）。
 * 桩法 Consumes tests/client-store-slices.test.mjs：globalThis.fetch 按前缀路由 + storage stub +
 * node:test mock.timers 停表（setToast 定时器）。mutate 是异步串行链——所有断言前 await。
 *
 * 契约（Task 9）：
 *   - removeSymbol 成功（result.ok === true）→ 捕获被删记录 + toast { text, action: { kind: "undo-remove", label, ms: 6000 } }；
 *   - undoRemoveSymbol() → 以相同 market+code 调 symbols/add（patch 带回 quantity/avgCost/buyTarget/sellTarget），
 *     成功清捕获 + restored toast；无捕获 → { ok: false }；失败不清捕获（op-failed 由 mutate quiet:false 分支承担）；
 *   - setToast(text, action?)：默认定时语义不变（4000ms 定时/3800ms 守卫），带 action 时窗口 action.ms。
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

test("① removeSymbol 成功 → toast 带 undo-remove action（6s）+ 捕获记录", async () => {
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
    assert.deepEqual(toast.action, { kind: "undo-remove", label: t("toast.undo"), ms: 6000 }, "action 形状");
  } finally {
    restore();
    store.dispose();
  }
});

test("② undoRemoveSymbol → 成功清捕获 + restored toast；二次 undo 空转", async () => {
  setLang("zh");
  const store = createStore(createStorageStub());
  let addCalled = 0;
  const restore = await seedStore(store, [
    ["/stock-kanban/symbols/remove", async () => ({ ok: true })],
    ["/stock-kanban/symbols/add", async () => {
      addCalled += 1;
      return { ok: true };
    }],
    ["/stock-kanban/state", async () => ({ ...STATE_PAYLOAD })],
  ]);
  try {
    await store.removeSymbol("s1");
    const r1 = await store.undoRemoveSymbol();
    assert.equal(r1.ok, true, "undo 成功");
    const toast = store.getState().toast;
    assert.equal(toast.text, t("toast.restored", { name: "贵州茅台" }), "restored 文案");
    const r2 = await store.undoRemoveSymbol();
    assert.equal(r2.ok, false, "捕获已清 → 二次 undo 空转");
    assert.equal(addCalled, 1, "add 只被调一次");
  } finally {
    restore();
    store.dispose();
  }
});

test("②b undo 的 add 请求体：同 market+code、patch 带回四字段（api.add 直桩）", async () => {
  setLang("zh");
  const store = createStore(createStorageStub());
  const bodies = [];
  const restore = await seedStore(store);
  try {
    // 直桩 fetch：先挂（remove/mutate 内部 /state 都要走桩），拦截 add 请求体
    globalThis.fetch = async (path, init) => {
      const p = String(path);
      if (p.startsWith("/stock-kanban/symbols/remove")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (p.startsWith("/stock-kanban/symbols/add")) {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (p.startsWith("/stock-kanban/state")) return { ok: true, status: 200, json: async () => ({ ...STATE_PAYLOAD }) };
      throw new Error(`stub-fetch: no route for ${p}`);
    };
    await store.removeSymbol("s1");
    const r = await store.undoRemoveSymbol();
    assert.equal(r.ok, true, "undo 成功");
    assert.deepEqual(bodies, [{
      market: "cn",
      code: "600519",
      patch: { quantity: 2, avgCost: 100, buyTarget: 90, sellTarget: 110 },
      ifRev: 5,
    }], "同 market+code 复原、patch 四字段带回");
  } finally {
    restore();
    store.dispose();
  }
});

test("③ undo 失败 → op-failed toast 且无 action，捕获保留可再撤", async () => {
  setLang("zh");
  const store = createStore(createStorageStub());
  let addFails = true;
  const restore = await seedStore(store, [
    ["/stock-kanban/symbols/remove", async () => ({ ok: true })],
    ["/stock-kanban/symbols/add", async () => (addFails ? { ok: false, status: 500, body: { error: "boom" } } : { ok: true })],
    ["/stock-kanban/state", async () => ({ ...STATE_PAYLOAD })],
  ]);
  try {
    await store.removeSymbol("s1");
    const r = await store.undoRemoveSymbol();
    assert.equal(r.ok, false, "undo 失败");
    const toast = store.getState().toast;
    assert.ok(toast.text.startsWith(t("toast.op-failed", { e: "" }).split("：")[0]), "op-failed toast");
    assert.equal(toast.action ?? null, null, "失败 toast 无 action");
    // 捕获保留：add 恢复成功后再撤仍可用
    addFails = false;
    const r2 = await store.undoRemoveSymbol();
    assert.equal(r2.ok, true, "捕获保留 → 恢复成功");
    assert.equal(store.getState().toast.text, t("toast.restored", { name: "贵州茅台" }));
  } finally {
    restore();
    store.dispose();
  }
});

test("④b setToast 默认/动作窗口（mock.timers 停表）", (t) => {
  setLang("zh");
  const store = createStore(createStorageStub());
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    store.setToast("plain");
    t.mock.timers.tick(3800);
    assert.notEqual(store.getState().toast, null, "3800ms 定时器未触发（4000 才触发）");
    t.mock.timers.tick(200);
    assert.equal(store.getState().toast, null, "4000ms 触发 → 3800 守卫 → 清除");

    store.setToast("with-action", { kind: "undo-remove", label: "撤销", ms: 6000 });
    t.mock.timers.tick(6000);
    assert.notEqual(store.getState().toast, null, "6200 定时器未触发（现累计 10000 < 10200）");
    t.mock.timers.tick(300);
    assert.equal(store.getState().toast, null, "累计 10300 ≥ 触发点 10200 → 清除（守卫 6000）");
  } finally {
    t.mock.timers.reset();
    store.dispose();
  }
});

test("⑤ panel patchToast：action toast 渲染撤销钮；点击调 undoRemoveSymbol；无 action 无钮", async () => {
  setLang("zh");
  const h = createDomHarness();
  const undoCalls = [];
  const store = {
    undoRemoveSymbol: () => undoCalls.push(1),
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
    panel.update({ ...base, toast: { text: "已删除 贵州茅台", at: 1, action: { kind: "undo-remove", label: "撤销", ms: 6000 } } });
    const btn = panel.el.querySelector(".skc-toast-action");
    assert.ok(btn, "撤销钮在位");
    assert.equal(btn.textContent, "撤销");
    btn.click();
    assert.equal(undoCalls.length, 1, "点击 → undoRemoveSymbol");
    // 非 undo-remove kind 不触发
    panel.update({ ...base, toast: { text: "x", at: 2, action: { kind: "other", label: "x" } } });
    panel.el.querySelector(".skc-toast-action").click();
    assert.equal(undoCalls.length, 1, "其他 kind 不调 undo");
    // 无 action → 无钮
    panel.update({ ...base, toast: { text: "y", at: 3, action: null } });
    assert.equal(panel.el.querySelector(".skc-toast-action"), null, "无 action → 无钮");
  } finally {
    panel.dispose();
    h.cleanup();
  }
});
