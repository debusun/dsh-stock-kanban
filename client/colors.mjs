/**
 * 涨跌语义物理色权威（ADR-0009）：红/绿 hex 全插件单点定义于此。
 * styles.mjs 将其插值进 :host 令牌（--skc-up/--skc-down/--skc-red/--skc-green），
 * main.mjs 经 trendModeVars 把语义对写到 float root 内联 style（red-up/green-up 两档翻向）。
 * 档位规范化沿用服务端 schema（client → src import 方向，仓内既有先例 store.mjs:16）。
 */

import { normalizeTrendColorMode } from "../src/model.mjs";

/** 涨跌红（与 --skc-danger 的 fallback 同 hex 但语义无关——全程禁按色值全局替换） */
export const TREND_RED = "#e5484d";
/** 涨跌绿 */
export const TREND_GREEN = "#2bb596";

/** 模式 → 根级语义变量值。native 档同 red-up 默认：同屏分支在类名层（trendClass/trendSideClass）与 SVG 直取层（trendDirVar），全局对保持无害默认。 */
export function trendModeVars(mode) {
  const m = normalizeTrendColorMode(mode);
  return m === "green-up"
    ? { "--skc-up": TREND_GREEN, "--skc-down": TREND_RED }
    : { "--skc-up": TREND_RED, "--skc-down": TREND_GREEN };
}
