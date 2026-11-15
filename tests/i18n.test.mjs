import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { t, tErr, resolveLang, setLang, DICT_KEYS } from "../client/i18n.mjs";

test("字典键位：zh 与 en 完全对齐（无缺失/多余）", () => {
  assert.deepEqual(DICT_KEYS.zh, DICT_KEYS.en);
  assert.ok(DICT_KEYS.zh.length >= 80, `keys=${DICT_KEYS.zh.length}`);
});

test("resolveLang：跟随系统语言", () => {
  assert.equal(resolveLang("zh-CN"), "zh");
  assert.equal(resolveLang("zh_TW"), "zh");
  assert.equal(resolveLang("en-US"), "en");
  assert.equal(resolveLang("ja-JP"), "en");
  assert.equal(resolveLang(undefined), "en");
});

test("t：zh 文案与参数插值", () => {
  setLang("zh");
  assert.equal(t("badge.stale"), "旧");
  assert.equal(t("badge.closed"), "休");
  assert.ok(t("toast.added", { name: "贵州茅台" }).includes("贵州茅台"));
  assert.ok(t("app.note.delay").includes("免费"));
});

test("t：en 文案", () => {
  setLang("en");
  assert.equal(t("badge.stale"), "Stale");
  assert.equal(t("badge.closed"), "Closed");
  assert.ok(t("toast.added", { name: "AAPL" }).startsWith("Added"));
});

test("tErr：已知代码本地化、未知代码原样透出、detail 附加、逗号多码逐段本地化", () => {
  setLang("zh");
  assert.equal(tErr("duplicate"), "该标的已在自选中");
  assert.equal(tErr("totally-unknown-code"), "totally-unknown-code");
  assert.ok(tErr("fetch-failed", "HTTP 503").includes("HTTP 503"));
  assert.equal(tErr("invalid-buy-target"), "买入目标价必须是正数");
  assert.ok(tErr("invalid-buy-target,invalid-sell-target").includes("买入目标价必须是正数"));
  assert.ok(tErr("invalid-buy-target,invalid-sell-target").includes("卖出目标价必须是正数"));
  setLang("en");
  assert.equal(tErr("duplicate"), "Already in watchlist");
});

test("quota.* 文案（合并开关 / 过期）：zh 与 en 双侧均有译文，非键名回退", () => {
  const keys = ["quota.merge.on", "quota.merge.off", "quota.stale", "quota.outcome"];
  for (const key of keys) {
    assert.ok(DICT_KEYS.zh.includes(key), `zh 字典含 ${key}`);
    assert.ok(DICT_KEYS.en.includes(key), `en 字典含 ${key}`);
  }
  setLang("zh");
  for (const key of keys) assert.notEqual(t(key), key, `zh 非键名回退：${key}`);
  setLang("en");
  for (const key of keys) assert.notEqual(t(key), key, `en 非键名回退：${key}`);
  setLang("zh");
});

test("字形：详情目标价文案为拉丁 B/S，zh/en 双侧（B26）", () => {
  setLang("zh");
  assert.equal(t("detail.buy-target"), "买入目标价（≤ 触发 B，{ccy}）", "zh 买入目标价");
  assert.equal(t("detail.sell-target"), "卖出目标价（≥ 触发 S，{ccy}）", "zh 卖出目标价");
  setLang("en");
  assert.equal(t("detail.buy-target"), "Buy target (≤ fires B, {ccy})", "en 买入目标价");
  assert.equal(t("detail.sell-target"), "Sell target (≥ fires S, {ccy})", "en 卖出目标价");
  setLang("zh");
});

test("文案：合并开关的 quota.merge.on/off 使用「合并胶囊」，zh/en 双侧一致（B37）", () => {
  try {
    setLang("zh");
    assert.equal(t("quota.merge.on"), "quota 已并入合并胶囊（点击拆分）", "zh 合并开");
    assert.equal(t("quota.merge.off"), "quota 独立显示（点击并入合并胶囊）", "zh 合并关");
    setLang("en");
    assert.equal(t("quota.merge.on"), "quota merged into the capsule (click to split)", "en 合并开");
    assert.ok(!t("quota.merge.off").includes("capsule group"), "en 合并关不再使用 capsule group");
    assert.equal(t("quota.merge.off"), "quota shown separately (click to merge into the capsule)", "en 合并关（精确）");
  } finally {
    setLang("zh");
  }
});

test("语言缝守卫：client 源码（除 i18n.mjs）字符串字面量零 CJK——面向用户的文案必须全部经 i18n 字典", () => {
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const violations = [];
  for (const f of readdirSync(new URL("../client/", import.meta.url)).filter((n) => n.endsWith(".mjs"))) {
    if (f === "i18n.mjs") continue;
    const lines = readFileSync(new URL(`../client/${f}`, import.meta.url), "utf8").split("\n");
    let inBlock = false;
    lines.forEach((line, i) => {
      let l = line;
      if (inBlock) {
        if (l.includes("*/")) { inBlock = false; l = l.split("*/").pop(); } else return;
      }
      if (l.includes("/*")) {
        const parts = l.split("/*");
        inBlock = !parts[parts.length - 1].includes("*/");
        l = parts[0] + (parts[parts.length - 1].split("*/").pop() ?? "");
      }
      for (const m of l.split("//")[0].matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
        const raw = m[1] ?? m[2] ?? m[3];
        if (raw && CJK.test(raw)) violations.push(`${f}:${i + 1} "${raw.slice(0, 24)}"`);
      }
    });
  }
  assert.deepEqual(violations, [], `硬编码文案（应走 i18n 字典）：${violations.join("、")}`);
});

test("第 13 轮新键：hero 新鲜度 + 撤销文案（zh/en 逐字）", () => {
  setLang("zh");
  assert.equal(t("detail.freshness"), "{t} · {s}", "zh 新鲜度");
  assert.equal(t("detail.quote-tip"), "行情 {q} · 拉取 {f}", "zh 双时间戳 tooltip");
  assert.equal(t("detail.confirm.remove-ok"), "确认删除", "zh 删除确认钮");
  assert.equal(t("toast.removed"), "已删除 {name}", "zh 已删除");
  assert.equal(t("toast.undo"), "撤销", "zh 撤销");
  assert.equal(t("toast.restored"), "已恢复 {name}", "zh 已恢复");
  setLang("en");
  assert.equal(t("detail.freshness"), "{t} · {s}", "en 新鲜度");
  assert.equal(t("detail.quote-tip"), "Quote {q} · Fetched {f}", "en 双时间戳 tooltip");
  assert.equal(t("detail.confirm.remove-ok"), "Delete", "en 删除确认钮");
  assert.equal(t("toast.removed"), "Removed {name}", "en 已删除");
  assert.equal(t("toast.undo"), "Undo", "en 撤销");
  assert.equal(t("toast.restored"), "Restored {name}", "en 已恢复");
  setLang("zh");
});
