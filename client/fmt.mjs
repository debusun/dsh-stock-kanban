/**
 * 展示格式化与隐私遮挡 —— 纯函数（可在 node 测试）。
 * 隐私遮挡只是界面遮挡（4.6）：所有敏感金额类展示值统一走 maskIf，遮挡为 '••••'；
 * 行情与图表不受影响。比例字段同样遮挡（保守默认，记录于文档）。
 */

export const MASK = "••••";

/** 隐私模式下遮挡任意值 */
export function maskIf(privacy, value) {
  return privacy ? MASK : value;
}

/** 价格显示档位（小数位数）：≥1 → 2 位；0.01~1 → 4 位；<0.01 → 6 位（fmtPrice 与 fmtChange 参考档共用） */
export function priceDigits(p) {
  if (p == null || !Number.isFinite(p)) return 2;
  const abs = Math.abs(p);
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

/** 价格：按量级自适应精度（千分位） */
export function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  const digits = priceDigits(p);
  return p.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 百分比（已乘 100 的值） */
export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** 涨跌额（带符号；0 无号；非法 → —）。
 *  精度 = max(自身量级档, 参考价格档位)，min 2 保底、超档裁拖零
 *  （第 13 轮·主人拍板混合规则：-0.004000 → -0.004、-0.0820 → -0.082、-21.48 不变——
 *  不出 -0.00、不拖零、与同行价格小数位不打架）。 */
export function fmtChange(v, refDigits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0.00";
  const digits = Math.max(priceDigits(v), refDigits);
  const sign = v > 0 ? "+" : "-";
  return sign + Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

/** 金额（千分位，2 位小数；null → —） */
export function fmtAmount(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 数量：小数（加密货币可 8 位）去尾零 */
export function fmtQty(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return s.length === 0 ? "0" : s;
}

/** 涨跌颜色类名（ADR-0009 三档语义）：flat 恒中性灰；red-up/green-up 恒全局对（翻向由 float root 的 --skc-up/--skc-down 内联变量承载，见 client/colors.mjs）；native 按标的所在市场分支类——A股红涨绿跌，港/美/币绿涨红跌，指数随所属市场 */
export function trendClass(v, market = null, mode = "red-up") {
  if (v == null || !Number.isFinite(v) || v === 0) return "skc-flat";
  if (mode !== "native") return v > 0 ? "skc-up" : "skc-down";
  return market === "cn" ? (v > 0 ? "skc-up-cn" : "skc-down-cn") : (v > 0 ? "skc-up-g" : "skc-down-g");
}

/** SVG style 属性用的 var 引用（与 trendClass 同判定树；flat → null）。native 直出物理色 var——SVG 无类名分支。 */
export function trendVarRef(v, market = null, mode = "red-up") {
  if (v == null || !Number.isFinite(v) || v === 0) return null;
  if (mode !== "native") return v > 0 ? "var(--skc-up)" : "var(--skc-down)";
  return market === "cn"
    ? (v > 0 ? "var(--skc-red)" : "var(--skc-green)")
    : (v > 0 ? "var(--skc-green)" : "var(--skc-red)");
}

/** 图表布尔方向入口：charts.mjs 的方向判定输出布尔（分时 last.p>=prevClose、K线 close>=open），无数值 */
export function trendDirVar(up, market = null, mode = "red-up") {
  return trendVarRef(up ? 1 : -1, market, mode);
}

/** 涨跌幅专用：▲/▼ 方向前缀 + fmtPct（颜色+符号双编码，色弱冗余）。平盘/无数据不加符号。持仓盈亏幅仍走 fmtPct（豁免符号）。 */
export function fmtTrendPct(v) {
  if (v == null || !Number.isFinite(v)) return fmtPct(v);
  const glyph = v > 0 ? "▲" : v < 0 ? "▼" : "";
  return `${glyph}${fmtPct(v)}`;
}

/** B/S 标记/徽章的 native 档 side 追加类；非 native 恒 ""（全局变量翻向已覆盖） */
export function trendSideClass(market = null, mode = "red-up") {
  return mode === "native" ? (market === "cn" ? "skc-side-cn" : "skc-side-g") : "";
}

/** epoch ms → 当地 HH:mm（行情时间展示） */
export function fmtClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtClockSec(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function fmtDate(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 数值输入解析：空 → null（清除）；非法 → undefined（错误）；合法 → 正数。
 */
export function parsePositiveInput(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

