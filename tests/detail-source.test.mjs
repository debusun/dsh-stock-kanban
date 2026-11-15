import test from "node:test";
import assert from "node:assert/strict";
import { detailSourceText, t, setLang } from "../client/i18n.mjs";

/* 脚注文案 helper 单测（§12.48 → 第 13 轮改契约）：正常态返回 null（来源名已并入 hero 新鲜度行
 * 「HH:mm:ss · 源」，脚注不重复常显）；降级态钉死——zh「数据源：{name}（降级自 {from}）」、
 * en "Source: {name} (fell back from {from})"；error/null 行返回 null。 */

test("detailSourceText：正常态返回 null（源名已并入新鲜度行）", () => {
  setLang("zh");
  assert.equal(detailSourceText({ status: "ok", source: "eastmoney", fallbackFrom: null }), null);
});

test("detailSourceText：降级态附加降级来源（zh）", () => {
  setLang("zh");
  assert.equal(detailSourceText({ status: "ok", source: "sina", fallbackFrom: "tencent" }), "数据源：新浪（降级自 腾讯）");
});

test("detailSourceText：error/null/缺 source → null（脚注隐藏）", () => {
  setLang("zh");
  assert.equal(detailSourceText({ status: "error", source: null, fallbackFrom: null }), null);
  assert.equal(detailSourceText(null), null);
  assert.equal(detailSourceText({ status: "ok", source: null, fallbackFrom: null }), null);
});

test("detailSourceText：英文降级态；正常态 null", () => {
  setLang("en");
  assert.equal(detailSourceText({ status: "ok", source: "eastmoney", fallbackFrom: null }), null);
  assert.equal(detailSourceText({ status: "ok", source: "sina", fallbackFrom: "tencent" }), "Source: Sina (fell back from Tencent)");
  setLang("zh");
});

test("detailSourceText：六个 provider token 双语键齐全（parity 直断 provider 键）", () => {
  for (const lang of ["zh", "en"]) {
    setLang(lang);
    for (const p of ["tencent", "eastmoney", "tencent-us", "yahoo", "okx", "sina"]) {
      const s = t(`provider.${p}`);
      assert.ok(s && !s.includes("provider.") && s.length > 0, `${lang}/${p} -> ${s}`);
    }
  }
  setLang("zh");
});
