import test from "node:test";
import assert from "node:assert/strict";
import { TREND_RED, TREND_GREEN, trendModeVars } from "../client/colors.mjs";
import { trendClass, trendVarRef, trendDirVar, trendSideClass, fmtPct } from "../client/fmt.mjs";

/* 涨跌语义纯函数矩阵（ADR-0009，实施计划 T3）——3 modes × 4 markets × 方向/平盘/无数据 */

const MARKETS = ["cn", "hk", "us", "crypto"];

test("colors.mjs：物理色常量与根变量映射", () => {
  assert.equal(TREND_RED, "#e5484d");
  assert.equal(TREND_GREEN, "#2bb596");
  assert.deepEqual(trendModeVars("red-up"), { "--skc-up": TREND_RED, "--skc-down": TREND_GREEN });
  assert.deepEqual(trendModeVars("green-up"), { "--skc-up": TREND_GREEN, "--skc-down": TREND_RED });
  assert.deepEqual(trendModeVars("native"), { "--skc-up": TREND_RED, "--skc-down": TREND_GREEN }); // native 同 red-up 默认，分支在类名/直取层
  assert.deepEqual(trendModeVars("bogus"), { "--skc-up": TREND_RED, "--skc-down": TREND_GREEN }); // 未知模式回默认
});

test("trendClass：三档 × 市场矩阵", () => {
  for (const m of MARKETS) {
    for (const mode of ["red-up", "green-up"]) {
      assert.equal(trendClass(2.35, m, mode), "skc-up"); // 非原生档恒全局对，翻向由根变量承载
      assert.equal(trendClass(-1.8, m, mode), "skc-down");
    }
    assert.equal(trendClass(2.35, m, "native"), m === "cn" ? "skc-up-cn" : "skc-up-g");
    assert.equal(trendClass(-1.8, m, "native"), m === "cn" ? "skc-down-cn" : "skc-down-g");
  }
  for (const v of [0, null, NaN, undefined]) {
    assert.equal(trendClass(v, "cn", "native"), "skc-flat"); // 平盘/无数据恒中性灰，不参与换向
    assert.equal(trendClass(v, "us"), "skc-flat");
  }
  assert.equal(trendClass(1, null, "native"), "skc-up-g"); // native + 市场缺失 → 国际分支兜底
});

test("trendClass：旧单参签名兼容（现状行为逐字不变）", () => {
  assert.equal(trendClass(2.35), "skc-up");
  assert.equal(trendClass(-1.8), "skc-down");
  assert.equal(trendClass(0), "skc-flat");
  assert.equal(trendClass(null), "skc-flat");
});

test("trendVarRef：语义 var 引用（SVG style 属性用；flat → null）", () => {
  assert.equal(trendVarRef(2.35, "us", "red-up"), "var(--skc-up)");
  assert.equal(trendVarRef(-1.8, "us", "red-up"), "var(--skc-down)");
  assert.equal(trendVarRef(2.35, "us", "green-up"), "var(--skc-up)"); // 根变量翻向承载
  assert.equal(trendVarRef(2.35, "cn", "native"), "var(--skc-red)");
  assert.equal(trendVarRef(-1.8, "cn", "native"), "var(--skc-green)");
  assert.equal(trendVarRef(2.35, "us", "native"), "var(--skc-green)");
  assert.equal(trendVarRef(-1.8, "hk", "native"), "var(--skc-red)");
  assert.equal(trendVarRef(0, "cn", "native"), null);
  assert.equal(trendVarRef(null, "us", "red-up"), null);
});

test("trendDirVar：布尔方向入口与 trendVarRef 等价（评审 P2）", () => {
  for (const mode of ["red-up", "green-up", "native"]) {
    for (const m of ["cn", "us"]) {
      assert.equal(trendDirVar(true, m, mode), trendVarRef(1, m, mode));
      assert.equal(trendDirVar(false, m, mode), trendVarRef(-1, m, mode));
    }
  }
});

test("trendSideClass：native 分支 side 追加类；非 native 恒空", () => {
  assert.equal(trendSideClass("cn", "native"), "skc-side-cn");
  assert.equal(trendSideClass("us", "native"), "skc-side-g");
  assert.equal(trendSideClass("crypto", "native"), "skc-side-g");
  assert.equal(trendSideClass("hk", "red-up"), "");
  assert.equal(trendSideClass("cn", "green-up"), "");
  assert.equal(trendSideClass(null, "native"), "skc-side-g");
});
