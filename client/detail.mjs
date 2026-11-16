/**
 * 详情视图（vanilla）：行情头部（行情时间/拉取时间区分）、图表（分时/日K/周K/月K + 均线 +
 * 成交量）、持仓编辑、目标价编辑、删除标的。快速切换标的时以 fetchKey 守卫异步响应
 * （12.2 无串数据）。
 * 渲染切片广播（Task 3）：骨架按标的一次构建（renderSkeleton），quotes-only tick 只走
 * 活区 patch（paintQuoteLine + paintLive）——输入框/图表节点身份由「tick 不重建」保证
 * （§12.17 契约），跳绘守卫与光标捕获/恢复随之退役。图表仅在数据引用变化（loadChart
 * 完成/失败）、周期切换、resize 时重画，tick 零改动。
 */

import { api } from "./api.mjs";
import { fmtPrice, fmtPct, fmtAmount, fmtChange, priceDigits, maskIf, trendClass, parsePositiveInput, fmtClock, fmtClockSec } from "./fmt.mjs";
import { buildMinuteChart, buildCandleChart, buildMaLegend } from "./charts.mjs";
import { iconEl } from "./icons.mjs";
import { t, tErr, getLang, detailSourceText } from "./i18n.mjs";
import { checkTargetRelation } from "../src/identity.mjs";
import { positionMetrics } from "../src/portfolio.mjs";
import { chartRefreshDue, isMarketOpen, targetBadgeKind } from "../src/sessions.mjs";

const PERIODS = [
  { key: "minute", label: () => t("detail.period.minute") },
  { key: "day", label: () => t("detail.period.day") },
  { key: "week", label: () => t("detail.period.week") },
  { key: "month", label: () => t("detail.period.month") },
];

/* 图表高度随视口收缩（第 10 轮，2026-11-10）：卡片 max-height = 100dvh − 24，图表取「视口 − 24 − 固定区高度」，
   夹在 [min, max] 内。固定区 = 卡片头尾 + 详情中除图表外的内容；按界面语言取值（英文文案更长，实测）。
   分时/K线统一钳位与固定区（第 12 轮，2026-11-10）：指标行四档周期常驻（分时档显示昨收图例，行高恒定），
   卡片总高与周期无关——切分时/日K/周K/月K 不再触发卡片变高与重新定位（弹跳根除）。
   第 13 轮（2026-11-15）：hero 改三行数据栈 zh 494→521（溢出差分实测）；同日两轮主人反馈迭代——
   双栏（新鲜度升右栏）zh 521→497（vh720 差分：svg=175、余量 24 实测）；单行终版（价格+变动+新鲜度
   同 baseline，hero lineH 54→32）zh 497→475（vh720 差分实测：svg=199、面板余量 22）；
   en 与 zh 同步同 Δ：511→538→514→492（解析链，未真机实测见 §12.55 遗留）。 */
const CHART_H = { max: 230, min: 140, fixed: { zh: 475, en: 492 } };
const chartHeight = (vh) => {
  const fixed = CHART_H.fixed[getLang()] ?? CHART_H.fixed.zh;
  return Math.round(Math.min(CHART_H.max, Math.max(CHART_H.min, vh - 24 - fixed)));
};

function textSpan(className, text) {
  const el = document.createElement("span");
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

export function createDetail({ store, win, resizeThrottleMs = 150 }) {
  // 视口来源优先取注入的 win（宿主传入）；DSH 运行时全局 window 可能不存在，此前会回退到 768 导致图表不收缩（第 11 轮）
  const winRef = () => win ?? globalThis.window ?? null;
  const viewportHeight = () => winRef()?.innerHeight ?? 768;
  let disposed = false;
  let snapshot = null;
  let period = "minute";
  let chart = { key: "", loading: false, data: null, error: null, errorDetail: null, adjust: null, prevClose: null, date: null };
  let chartKey = "";
  let loadedKey = ""; // 已发起加载的 fetchKey（同 key 的快照更新不重拉）
  let form = null;
  let overlapHint = false;
  let lastDetailId;
  let segment = "position"; // 分段：position（持仓）| targets（目标价）；会话态，切换标的保留（第六轮 2026-11-10，方案 B）
  let pending = null; // 区块内确认条：null | "clear" | "clear-targets" | "overlap" | "remove"（替代原生 confirm；第 13 轮增 remove）
  let busy = false; // 保存中：禁用保存钮，防重复提交
  let live = null; // 当前渲染的实时节点引用：输入时原位刷新，不重绘
  let skeleton = null; // 骨架节点引用（报价行/周期 Tab/指标行/图表框）；quotes tick 不重建
  let skeletonId = null; // 当前骨架的标的 id（null = 空态）

  /* resize 重画闸（§12.58）：(宽,高)二元组守卫 + rAF 同帧合并 + resizeThrottleMs 节流
   * （leading 下一帧即绘、窗内静默、trailing 必绘兜底终态）。终结每事件整棵图表 SVG 重建的
   * 节点构建放大器；守卫自身保留每事件一次 clientWidth 读（无样式失效时有布局缓存，量级远低于重建）。 */
  let lastBoxDims = { w: 0, h: 0 };
  let lastPaintAt = 0;
  let rafPending = false;
  let rafHandle = null; // rAF 句柄——clearPendingRepaint 撤句柄用（缺变量则撤句柄路径成死代码）
  let trailingTimer = null;

  const el = document.createElement("div");

  const symbolOf = () =>
    snapshot?.business?.symbols?.find((s) => s.id === snapshot?.ui?.detailId) ?? null;
  /** 已保存值的表单基准（非编辑态草稿） */
  const baseOf = (symbol) => ({
    quantity: symbol.quantity != null ? String(symbol.quantity) : "",
    avgCost: symbol.avgCost != null ? String(symbol.avgCost) : "",
    buyTarget: symbol.buyTarget != null ? String(symbol.buyTarget) : "",
    sellTarget: symbol.sellTarget != null ? String(symbol.sellTarget) : "",
  });
  const draftOf = (symbol) => form ?? baseOf(symbol);
  const hasSavedPosition = (symbol) => symbol.quantity != null || symbol.avgCost != null;
  const hasSavedTargets = (symbol) => symbol.buyTarget != null || symbol.sellTarget != null;
  const priceOf = (symbol) => {
    const q = snapshot?.quotes?.[symbol.id];
    return q?.status === "ok" && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
  };
  const privacyOf = () => snapshot?.business?.settings?.privacyMode === true;
  const numText = (n) => (n == null ? "" : String(n));
  /** 表单实时状态：解析、校验、脏标记（只读，不改 DOM）。null = 留空，undefined = 非法 */
  const stateOf = (symbol) => {
    const d = draftOf(symbol);
    const base = baseOf(symbol);
    const qty = parsePositiveInput(d.quantity);
    const cost = parsePositiveInput(d.avgCost);
    const buy = parsePositiveInput(d.buyTarget);
    const sell = parsePositiveInput(d.sellTarget);
    return {
      qty, cost, buy, sell,
      qtyInvalid: qty === undefined,
      costInvalid: cost === undefined,
      buyInvalid: buy === undefined,
      sellInvalid: sell === undefined,
      hValid: qty !== undefined && cost !== undefined,
      tValid: buy !== undefined && sell !== undefined,
      hDirty: form !== null && (d.quantity !== base.quantity || d.avgCost !== base.avgCost),
      tDirty: form !== null && (d.buyTarget !== base.buyTarget || d.sellTarget !== base.sellTarget),
    };
  };
  /** 保存成功后收敛草稿：与标的一致则丢弃草稿，避免残留 */
  const pruneForm = () => {
    const symbol = symbolOf();
    if (!form || !symbol) {
      form = null;
      return;
    }
    const base = baseOf(symbol);
    if (Object.keys(base).every((k) => form[k] === base[k])) form = null;
  };

  /** 盘中静默刷新（§12.33）：同一标的与周期，保留现有图表直到新数据到达；刷新失败保留旧数据，不切换为错误态 */
  const refreshChart = (symbol) => {
    const key = `${symbol.id}:${period}`;
    if (chart.loading || chart.key !== key) return;
    const load = period === "minute" ? api.minute(symbol.id) : api.kline(symbol.id, period);
    load.then((data) => {
      if (disposed || chartKey !== key) return;
      if (data.error) {
        chart = { ...chart, loadedAt: Date.now() };
        return;
      }
      chart = {
        ...chart,
        loadedAt: Date.now(),
        data: period === "minute" ? data : data.candles,
        error: null,
        errorDetail: null,
        adjust: data.adjust ?? null,
        prevClose: data.prevClose ?? null,
        date: data.date ?? null,
      };
      paintPeriodMeta();
      paintChartArea();
    }).catch(() => {
      if (disposed || chartKey !== key) return;
      chart = { ...chart, loadedAt: Date.now() };
    });
  };
  /** 图表加载（fetchKey 守卫：响应回来时若 key 已变则丢弃） */
  const loadChart = (symbol) => {
    const key = `${symbol.id}:${period}`;
    loadedKey = key;
    chartKey = key;
    chart = { ...chart, key, loading: true };
    const load = period === "minute" ? api.minute(symbol.id) : api.kline(symbol.id, period);
    load.then((data) => {
      if (disposed || chartKey !== key) return;
      chart = {
        key,
        loadedAt: Date.now(),
        loading: false,
        data: period === "minute" ? data : data.candles,
        error: data.error ?? null,
        errorDetail: data.errorDetail ?? null,
        adjust: data.adjust ?? null,
        prevClose: data.prevClose ?? null,
        date: data.date ?? null,
      };
      paintPeriodMeta();
      paintChartArea();
    }).catch((e) => {
      if (disposed || chartKey !== key) return;
      chart = { key, loadedAt: Date.now(), loading: false, data: null, error: "fetch-failed", errorDetail: String(e?.message ?? e), adjust: null };
      paintPeriodMeta();
      paintChartArea();
    });
  };

  // 原生 confirm 退役（第 13 轮 2026-11-15）：删除与清除/重叠一样走区块内确认条（pending="remove"）

  /** 区块内确认条（第六轮，替代原生 confirm）：清除持仓 / 目标价重叠共用；
   *  page=true = 详情页整幅条（删除），上缘与头排留 10px 呼吸（§12.58：零间距贴合观感重叠） */
  const confirmStrip = ({ text, ok, danger, onOk, page = false }) => {
    const box = document.createElement("div");
    box.className = page ? "skc-confirm skc-confirm--page" : "skc-confirm";
    const msg = document.createElement("div");
    msg.textContent = text;
    const row = document.createElement("div");
    row.className = "skc-confirm-actions";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = danger ? "skc-btn skc-btn-danger" : "skc-btn skc-btn-primary";
    yes.textContent = ok;
    yes.addEventListener("click", onOk);
    const no = document.createElement("button");
    no.type = "button";
    no.className = "skc-btn";
    no.textContent = t("detail.cancel");
    no.addEventListener("click", () => {
      pending = null;
      syncPendingStrip();
    });
    row.append(yes, no);
    box.append(msg, row);
    return box;
  };

  const saveHoldings = async (symbol) => {
    symbol = symbolOf() ?? symbol; // 用当前快照的标的做基准（编辑中轮询不重绘，闭包里的对象可能已旧）
    const st = stateOf(symbol);
    if (busy || st.qtyInvalid || st.costInvalid) {
      paintLive();
      return;
    }
    // 数量与成本都留空、且原本有持仓 = 清除：走区块内确认，不直接提交（防误触）
    if (st.qty === null && st.cost === null && hasSavedPosition(symbol)) {
      pending = "clear";
      syncPendingStrip();
      return;
    }
    busy = true;
    paintLive();
    const result = await store.updateSymbol(symbol.id, { quantity: st.qty, avgCost: st.cost });
    busy = false;
    if (disposed) return;
    if (result.ok) {
      if (form) form = { ...form, quantity: numText(st.qty), avgCost: numText(st.cost) };
      pending = null;
      pruneForm();
      syncFormValues();
      syncPendingStrip();
      store.setToast(t("toast.position-saved"));
      paintLive();
    } else {
      paintLive();
    }
  };

  const clearHoldings = async (symbol) => {
    symbol = symbolOf() ?? symbol;
    busy = true;
    paintLive();
    const result = await store.updateSymbol(symbol.id, { quantity: null, avgCost: null });
    busy = false;
    if (disposed) return;
    if (result.ok) {
      if (form) form = { ...form, quantity: "", avgCost: "" };
      pending = null;
      pruneForm();
      syncFormValues();
      syncPendingStrip();
      store.setToast(t("toast.position-cleared"));
      paintLive();
    } else {
      paintLive();
    }
  };

  const saveTargets = async (symbol, { acknowledged = false } = {}) => {
    symbol = symbolOf() ?? symbol;
    const st = stateOf(symbol);
    if (busy || st.buyInvalid || st.sellInvalid) {
      paintLive();
      return;
    }
    // 买卖两价都留空、且原本有目标价 = 清除：走区块内确认，不直接提交（与持仓一致）
    if (st.buy === null && st.sell === null && hasSavedTargets(symbol)) {
      pending = "clear-targets";
      syncPendingStrip();
      return;
    }
    const relation = checkTargetRelation(st.buy, st.sell);
    // 买入不低于卖出：两个标记可能同时显示——区块内确认，不弹原生窗口
    if (relation.overlap && !acknowledged) {
      pending = "overlap";
      syncPendingStrip();
      return;
    }
    busy = true;
    paintLive();
    const result = await store.updateSymbol(symbol.id, { buyTarget: st.buy, sellTarget: st.sell });
    busy = false;
    if (disposed) return;
    if (result.ok) {
      overlapHint = relation.overlap;
      if (form) form = { ...form, buyTarget: numText(st.buy), sellTarget: numText(st.sell) };
      pending = null;
      pruneForm();
      syncFormValues();
      syncPendingStrip();
      store.setToast(t("toast.targets-saved"));
      paintLive();
    } else {
      paintLive();
    }
  };

  /** 清除目标价（买入与卖出一并清空）：区块内确认后执行，与清除持仓同一套交互 */
  const clearTargets = async (symbol) => {
    symbol = symbolOf() ?? symbol;
    busy = true;
    paintLive();
    const result = await store.updateSymbol(symbol.id, { buyTarget: null, sellTarget: null });
    busy = false;
    if (disposed) return;
    if (result.ok) {
      overlapHint = false;
      if (form) form = { ...form, buyTarget: "", sellTarget: "" };
      pending = null;
      pruneForm();
      syncFormValues();
      syncPendingStrip();
      store.setToast(t("toast.targets-cleared"));
      paintLive();
    } else {
      paintLive();
    }
  };

  /** 确认后的删除动作（第 13 轮：入口改为删除 chip → pending="remove" 确认条） */
  const performRemove = async (symbol) => {
    const result = await store.removeSymbol(symbol.id);
    if (result.ok) store.backToList();
  };

  const setDraft = (field, value) => {
    const symbol = symbolOf();
    if (!symbol) return;
    form = { ...draftOf(symbol), [field]: value };
    // 编辑即撤销待确认（清除 / 重叠）：确认条原位移除，避免对着过期草稿点确认
    if (pending) {
      pending = null;
      if (live?.strip) live.strip.remove();
      if (live) live.strip = null;
    }
    paintLive(); // 输入原位反映（派生文字、校验、脏标记），不重绘，保持焦点与光标
  };

  /** 图表宽随详情内宽自适应：面板 420px（二级）时约 380px；列表宽 360 时约 320px；移动端 sheet 变宽时同步加宽（封顶 400）；隐藏态取回退 280 */
  const chartWidth = () => {
    const inner = el.clientWidth - 14; // 图表框 padding 6×2 + border 1×2
    return inner > 0 ? Math.min(400, Math.max(240, inner)) : 280;
  };

  /* ---- resize 重画闸内部（capsule.mjs scheduleFrame 同款 rAF 回退：无 rAF 环境立即同步执行，无 resize 风暴无实害） ---- */
  const dimsOf = () => ({ w: chartWidth(), h: chartHeight(viewportHeight()) });

  const clearPendingRepaint = () => {
    if (trailingTimer != null) {
      winRef()?.clearTimeout?.(trailingTimer);
      trailingTimer = null;
    }
    rafPending = false;
    if (rafHandle != null) {
      winRef()?.cancelAnimationFrame?.(rafHandle);
      rafHandle = null;
    }
  };

  const repaintIfDimsChanged = () => {
    if (disposed) return;
    const d = dimsOf();
    if (d.w === lastBoxDims.w && d.h === lastBoxDims.h) return; // trailing 触发时守卫复查：回到原值零绘
    paintChartArea();
  };

  const scheduleRepaint = () => {
    if (rafPending) return; // 同帧合并：一帧至多一次回调
    rafPending = true;
    const fire = () => {
      rafHandle = null;
      rafPending = false;
      if (disposed) return;
      if (Date.now() - lastPaintAt >= resizeThrottleMs) {
        repaintIfDimsChanged();
        return;
      }
      const delay = resizeThrottleMs - (Date.now() - lastPaintAt);
      winRef()?.clearTimeout?.(trailingTimer); // 先清旧 timer 再武装：同窗内第二次进该分支不得覆盖句柄泄漏旧 timer
      trailingTimer = winRef()?.setTimeout(() => {
        trailingTimer = null;
        if (disposed) return;
        repaintIfDimsChanged();
      }, delay) ?? null;
    };
    const w = winRef();
    if (typeof w?.requestAnimationFrame === "function") rafHandle = w.requestAnimationFrame.call(w, fire);
    else fire(); // 无 rAF 回退：立即同步执行（该环境无 resize 事件风暴）
  };

  const buildChartBox = (symbol, ui) => {
    const box = document.createElement("div");
    box.className = "skc-chartbox";
    // 三态同高（第 12 轮追补）：加载/错误占位与成图等高——骨架屏内容高 ~140px 低于图高（最高 230px），
    // 不钉高则切周期时卡片先塌后涨（「先变短再涨回去」的残余弹跳根因）
    box.style.height = `${chartHeight(viewportHeight())}px`;
    const chartErrorText = chart.error ? tErr(chart.error, chart.errorDetail) || chart.error : null;
    const closedMinute = period === "minute" && !isMarketOpen(symbol.market, Date.now()) && !(chart.data?.points?.length > 1);
    if (closedMinute) {
      // 休市分时（§12.35 用户反馈：提示出来慢）：立即给安静提示，不等上游；数据到达后本函数重画为图表
      const closed = document.createElement("div");
      closed.className = "skc-chart-empty";
      closed.textContent = t("detail.chart.closed");
      box.append(closed);
    } else if (chart.loading) {
      // 骨架态（operate.md：内容区用 skeleton，不用文字 spinner）+ 保留文案供读屏
      const loading = document.createElement("div");
      loading.className = "skc-chart-loading";
      const price = document.createElement("div");
      price.className = "skc-skeleton skc-skeleton-price";
      const vol = document.createElement("div");
      vol.className = "skc-skeleton skc-skeleton-vol";
      const caption = document.createElement("span");
      caption.className = "skc-skeleton-caption";
      caption.textContent = t("detail.chart.loading");
      loading.append(price, vol, caption);
      box.append(loading);
    } else if (chartErrorText) {
      const err = document.createElement("div");
      err.className = "skc-chart-empty skc-chart-error";
      err.textContent = t("detail.chart.error", { e: chartErrorText });
      box.append(err);
    } else if (period === "minute") {
      box.append(buildMinuteChart(
        { points: chart.data?.points ?? [], prevClose: chart.data?.prevClose ?? chart.prevClose ?? null },
        { dark: false, market: symbol.market, mode: snapshot?.business?.settings?.trendColorMode, width: chartWidth(), height: chartHeight(viewportHeight()) },
      ));
    } else {
      box.append(buildCandleChart(chart.data ?? [], { maVisible: ui.maVisible, dark: false, market: symbol.market, mode: snapshot?.business?.settings?.trendColorMode, width: chartWidth(), height: chartHeight(viewportHeight()) }));
    }
    lastBoxDims = dimsOf(); // 守卫记账唯一权威：每次盒构建记录 (宽,高)（含 renderSkeleton 直调路径）
    return box;
  };

  /** 表单字段：标签行（名称 + 右侧 meta，目标价的距现价放这里）+ 单位后缀输入框 + 辅助行（提示 / 错误）。输入框保留 data-field（编辑保活依赖它） */
  const buildField = ({ field, label, value, placeholder, suffix }) => {
    const labelEl = document.createElement("label");
    const head = document.createElement("span");
    head.className = "skc-field-head";
    head.append(textSpan("skc-field-name", label));
    const meta = textSpan("skc-field-meta", "");
    meta.hidden = true;
    head.append(meta);
    labelEl.append(head);
    const wrap = document.createElement("span");
    wrap.className = "skc-input-wrap";
    const input = document.createElement("input");
    input.className = "skc-input";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.value = value;
    input.dataset.field = field;
    input.addEventListener("input", () => setDraft(field, input.value));
    wrap.append(input);
    if (suffix) wrap.append(textSpan("skc-input-suffix", suffix));
    labelEl.append(wrap);
    const helper = document.createElement("span");
    helper.className = "skc-field-helper";
    labelEl.append(helper);
    return { label: labelEl, input, helper, meta };
  };

  /** 持仓摘要（实时）：按草稿数量与成本、当前价算市值 / 盈亏；隐私模式打码 */
  const holdingsMetaText = (symbol, st, price) => {
    if (privacyOf()) return `${maskIf(true, "")}${symbol.quoteCurrency}`;
    if (st.qtyInvalid || st.costInvalid) return "—";
    if (st.qty === null) return t("detail.holdings.empty");
    const pm = positionMetrics({ quantity: st.qty, avgCost: st.cost }, price);
    return t("detail.holdings.meta", {
      v: pm.marketValue != null ? fmtAmount(pm.marketValue) : "—",
      ccy: symbol.quoteCurrency,
      p: pm.pnl != null ? fmtAmount(pm.pnl) : (pm.flags.zeroCost ? t("detail.cost-unset") : t("detail.no-quote")),
      pct: pm.pnlPct != null ? fmtPct(pm.pnlPct) : "—",
    });
  };

  const paintFieldError = (f, invalid) => {
    f.input.classList.toggle("skc-input-invalid", invalid);
    f.input.setAttribute("aria-invalid", String(invalid));
    f.helper.classList.toggle("skc-field-helper--error", invalid);
    f.helper.textContent = invalid ? t("detail.err.positive") : "";
  };

  /** 目标价：提示放在输入框下方（≤ 此价显示 B）；距现价放在标签行右侧（第七轮）；非法值只显示错误 */
  const paintTargetField = (f, invalid, value, hint, price) => {
    f.input.classList.toggle("skc-input-invalid", invalid);
    f.input.setAttribute("aria-invalid", String(invalid));
    f.helper.classList.toggle("skc-field-helper--error", invalid);
    if (invalid) {
      f.helper.textContent = t("detail.err.positive");
      f.meta.hidden = true;
      return;
    }
    f.helper.textContent = hint;
    f.meta.hidden = value == null;
    f.meta.textContent = value == null
      ? ""
      : (price == null ? t("detail.no-quote") : t("detail.dist", { p: fmtPct(((value / price) - 1) * 100) }));
  };

  const paintDot = (dot, unsaved, data) => {
    dot.hidden = !(unsaved || data);
    dot.classList.toggle("skc-seg-dot--unsaved", unsaved);
  };

  /** 实时派生（不重建输入框）：持仓摘要、距现价、校验提示、脏标记、保存钮可用性、分段打点 */
  const paintLive = () => {
    if (!live || disposed) return;
    const symbol = symbolOf();
    if (!symbol) return;
    const st = stateOf(symbol);
    const price = priceOf(symbol);
    const h = live.holdings;
    if (h) {
      h.meta.textContent = holdingsMetaText(symbol, st, price);
      h.unsaved.hidden = !st.hDirty;
      h.save.disabled = busy || !st.hDirty || !st.hValid;
      h.clear.disabled = busy;
      paintFieldError(h.qty, st.qtyInvalid);
      paintFieldError(h.cost, st.costInvalid);
    }
    const g = live.targets;
    if (g) {
      g.unsaved.hidden = !st.tDirty;
      g.save.disabled = busy || !st.tDirty || !st.tValid;
      g.clear.disabled = busy;
      paintTargetField(g.buy, st.buyInvalid, st.buy, t("detail.buy-hint"), price);
      paintTargetField(g.sell, st.sellInvalid, st.sell, t("detail.sell-hint"), price);
    }
    if (live.segs?.position) paintDot(live.segs.position.dot, st.hDirty, hasSavedPosition(symbol));
    if (live.segs?.targets) paintDot(live.segs.targets.dot, st.tDirty, hasSavedTargets(symbol));
  };

  /** 持仓段：摘要 + 数量/成本 + 保存/清除/未保存 +（清除时的）确认条；返回 { form, strip, live } */
  const buildHoldingsPanel = (symbol, draft) => {
    const form = document.createElement("form");
    form.className = "skc-holdings";
    form.noValidate = true;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      saveHoldings(symbol);
    });
    const meta = textSpan("skc-holdings-meta", "");
    const grid = document.createElement("div");
    grid.className = "skc-form-grid";
    const coins = symbol.market === "crypto";
    const qty = buildField({
      field: "quantity",
      label: t("detail.quantity"),
      value: draft.quantity,
      placeholder: t(coins ? "detail.ph.qty.coins" : "detail.ph.qty"),
      suffix: t(coins ? "detail.unit.coins" : "detail.unit.shares"),
    });
    const cost = buildField({
      field: "avgCost",
      label: t("detail.avg-cost"),
      value: draft.avgCost,
      placeholder: t("detail.ph.cost"),
      suffix: symbol.quoteCurrency,
    });
    const actions = document.createElement("div");
    actions.className = "skc-form-actions";
    const save = document.createElement("button");
    save.className = "skc-btn skc-btn-primary";
    save.type = "submit";
    save.textContent = t("detail.save-position");
    const clear = document.createElement("button");
    clear.className = "skc-btn skc-btn-text";
    clear.type = "button";
    clear.textContent = t("detail.clear-position");
    clear.hidden = !hasSavedPosition(symbol);
    clear.addEventListener("click", () => {
      pending = "clear";
      syncPendingStrip();
    });
    const unsaved = textSpan("skc-unsaved", t("detail.unsaved"));
    actions.append(save, clear, unsaved);
    grid.append(qty.label, cost.label, actions);
    form.append(meta, grid);
    let strip = null;
    if (pending === "clear") {
      strip = confirmStrip({
        text: t("detail.confirm.clear"),
        ok: t("detail.confirm.clear-ok"),
        danger: true,
        onOk: () => clearHoldings(symbol),
      });
      form.append(strip);
    }
    return { form, strip, live: { meta, qty, cost, save, clear, unsaved } };
  };

  /** 目标价段：说明 + 两列提醒价（距现价在标签行右侧）+ 保存/清除/未保存 +（确认时的）确认条；返回 { form, strip, live } */
  const buildTargetsPanel = (symbol, draft) => {
    const form = document.createElement("form");
    form.className = "skc-targets";
    form.noValidate = true;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      saveTargets(symbol);
    });
    form.append(textSpan("skc-hint skc-targets-hint", t("detail.targets.hint")));
    if (overlapHint) form.append(textSpan("skc-badge skc-badge-stale", t("detail.overlap")));
    const grid = document.createElement("div");
    grid.className = "skc-form-grid";
    const buy = buildField({
      field: "buyTarget",
      label: t("detail.alert.buy"),
      value: draft.buyTarget,
      placeholder: t("detail.ph.target"),
      suffix: symbol.quoteCurrency,
    });
    const sell = buildField({
      field: "sellTarget",
      label: t("detail.alert.sell"),
      value: draft.sellTarget,
      placeholder: t("detail.ph.target"),
      suffix: symbol.quoteCurrency,
    });
    const actions = document.createElement("div");
    actions.className = "skc-form-actions";
    const save = document.createElement("button");
    save.className = "skc-btn skc-btn-primary";
    save.type = "submit";
    save.textContent = t("detail.save-targets");
    const clear = document.createElement("button");
    clear.className = "skc-btn skc-btn-text";
    clear.type = "button";
    clear.textContent = t("detail.clear-targets");
    clear.hidden = !hasSavedTargets(symbol);
    clear.addEventListener("click", () => {
      pending = "clear-targets";
      syncPendingStrip();
    });
    const unsaved = textSpan("skc-unsaved", t("detail.unsaved"));
    actions.append(save, clear, unsaved);
    grid.append(buy.label, sell.label, actions);
    form.append(grid);
    let strip = null;
    if (pending === "clear-targets") {
      strip = confirmStrip({
        text: t("detail.confirm.clear-targets"),
        ok: t("detail.confirm.clear-ok"),
        danger: true,
        onOk: () => clearTargets(symbol),
      });
      form.append(strip);
    } else if (pending === "overlap") {
      strip = confirmStrip({
        text: t("detail.confirm.overlap"),
        ok: t("detail.confirm.overlap-ok"),
        danger: false,
        onOk: () => saveTargets(symbol, { acknowledged: true }),
      });
      form.append(strip);
    }
    return { form, strip, live: { buy, sell, save, clear, unsaved } };
  };

  /** 报价行原位刷新（quotes tick 的主要落点）：价格/涨跌额/涨跌/新鲜度行/stale 徽标（第 13 轮结构） */
  const paintQuoteLine = () => {
    if (!skeleton) return;
    const symbol = symbolOf();
    if (!symbol) return;
    const q = snapshot?.quotes?.[symbol.id];
    const price = q?.status === "ok" ? q.price : null;
    const pct = q?.changePercent ?? null;
    const trendMode = snapshot?.business?.settings?.trendColorMode; // ADR-0009（undefined → 解析层默认 red-up）
    // 第 13 轮（2026-11-15）：涨跌额直用上游口径 changeAmount（六适配器全填、routes:322 透传），
    // 与涨跌幅同一 tick 自洽；缺失/非有限值时隐藏（退化回「价格+涨跌幅」双元组，不空窗）
    const chg = Number.isFinite(q?.changeAmount) ? q.changeAmount : null;
    const priceText = price != null ? fmtPrice(price) : q ? (q.status === "error" ? t("list.quote-failed") : "…") : "—";
    skeleton.quote.price.textContent = priceText;
    // 长价降档（第 13 轮·主人终版单行 + 极端档）：格式化 ≥9 字符（BTC 64,486.70 / 纳指 25,136.27）→ 24px；
    // ≥12 字符（十万点级 1,234,567.89）→ 22px——保证万点/极端长价也能与新鲜度同行
    skeleton.quote.price.className = `skc-quote-price ${trendClass(pct, symbol.market, trendMode)}${price != null && priceText.length >= 12 ? " skc-quote-price--xs" : price != null && priceText.length >= 9 ? " skc-quote-price--sm" : ""}`;
    skeleton.quote.chg.hidden = chg == null;
    if (chg != null) {
      // 混合规则（主人拍板）：档位 = max(自身量级档, 价格显示档位)，裁拖零——与同行价格小数位不打架
      skeleton.quote.chg.textContent = fmtChange(chg, price != null ? priceDigits(price) : 2); // 涨跌额不加方向符号（Q11）
      skeleton.quote.chg.className = `skc-quote-chg ${trendClass(pct, symbol.market, trendMode)}`;
    }
    skeleton.quote.pct.textContent = fmtPct(pct);
    skeleton.quote.pct.className = `skc-quote-pct ${trendClass(pct, symbol.market, trendMode)}`;
    const qTime = q?.quoteTime ?? null;
    const fTime = q?.fetchedAt ?? null;
    const badgeKind = symbol ? targetBadgeKind(q?.target, symbol.market, Date.now()) : null;
    // 新鲜度行收敛为单表达式「HH:mm · 来源全称」（第 13 轮·迭代四：徽章迁头部后恢复经典名，秒数走 tooltip）；
    // 双时间戳（行情/拉取含秒）降级为 tooltip
    const fresh = fTime != null ? fmtClock(fTime) : "—";
    const provider = q?.status === "ok" && q?.source ? t(`provider.${q.source}`) : null;
    const meta = skeleton.quote.meta;
    meta.replaceChildren(document.createTextNode(provider ? t("detail.freshness", { t: fresh, s: provider }) : fresh));
    // §12.48 数据源脚注（2026-11-16 目验反馈）：降级说明收进 tooltip——行内只留「时间 · 数据源」，
    // 降级串换行挤掉时间的观感问题根除；诊断信息悬停仍可得（诚实降级不丢面）
    const srcNote = detailSourceText(q);
    skeleton.quoteLine.title = (qTime != null
      ? t("detail.quote-tip", { q: fmtClock(qTime), f: fTime != null ? fmtClockSec(fTime) : "—" })
      : "") + (srcNote ? `\n${srcNote}` : "");
    // 状态徽章迁头部蓝框位（迭代四）：meta 行不再挂徽章
    if (badgeKind) {
      const text = badgeKind === "closed" ? t("detail.closed") : badgeKind === "stale" ? t("detail.stale") : t("detail.no-data");
      skeleton.headBadge.textContent = text;
      skeleton.headBadge.title = t(`badge.${badgeKind}.tip`);
      skeleton.headBadge.hidden = false;
    } else {
      skeleton.headBadge.hidden = true;
    }
  };

  const paintPeriodTabs = () => {
    if (!skeleton) return;
    for (const { key, btn } of skeleton.periodTabs) {
      btn.className = `skc-tab skc-period${period === key ? " skc-tab-active" : ""}`;
    }
  };

  /** 指标行（第 12 轮）：随周期与图表状态重画；只在周期切换/图表加载完成时调用，tick 不触 */
  const paintPeriodMeta = () => {
    if (!skeleton) return;
    const ui = snapshot?.ui ?? {};
    const meta = skeleton.periodMeta;
    meta.replaceChildren();
    if (period === "minute") {
      const prevClose = chart.data?.prevClose ?? chart.prevClose ?? null;
      meta.append(textSpan("skc-meta-note", t("detail.prev-close", { v: prevClose != null ? fmtPrice(prevClose) : "—" })));
    } else {
      meta.append(buildMaLegend(ui.maVisible, (p) =>
        store.setMaVisible({ ...ui.maVisible, [p]: ui.maVisible[p] === false })));
      if (chart.adjust) {
        meta.append(textSpan("skc-adjust", chart.adjust === "qfq" ? t("detail.adjust.fwd") : t("detail.adjust.none")));
      }
    }
  };

  /** 图表区重画：仅数据引用变化（loadChart 完成/失败）、周期切换、resize 时调用；quotes tick 不触。
   *  直调真绘后清 pending 尾绘（挂着的 trailing 冗余）并刷新节流钟（否则直调后窗内合法 resize 被误延迟）。 */
  const paintChartArea = () => {
    if (!skeleton || disposed) return;
    clearPendingRepaint();
    lastPaintAt = Date.now();
    const symbol = symbolOf();
    if (!symbol) return;
    const fresh = buildChartBox(symbol, snapshot?.ui ?? {});
    skeleton.chartBox.replaceWith(fresh);
    skeleton.chartBox = fresh;
  };

  const paintSegment = () => {
    if (!live) return;
    for (const key of ["position", "targets"]) {
      const on = segment === key;
      const seg = live.segs?.[key];
      if (seg?.btn) {
        seg.btn.className = `skc-tab skc-seg${on ? " skc-tab-active" : ""}`;
        seg.btn.setAttribute("aria-pressed", String(on));
      }
      const part = key === "position" ? live.holdings?.form : live.targets?.form;
      part?.classList.toggle("is-off", !on);
      part?.toggleAttribute("inert", !on);
      part?.setAttribute("aria-hidden", String(!on));
    }
  };

  /** 确认条同步：pending 变化时移除旧条、按需挂新条（区块内确认，第六轮交互语义不变） */
  const syncPendingStrip = () => {
    if (!live) return;
    if (live.strip) {
      live.strip.remove();
      live.strip = null;
    }
    const symbol = symbolOf();
    if (!symbol || !pending) return;
    let strip = null;
    if (pending === "clear") {
      strip = confirmStrip({ text: t("detail.confirm.clear"), ok: t("detail.confirm.clear-ok"), danger: true, onOk: () => clearHoldings(symbol) });
    } else if (pending === "clear-targets") {
      strip = confirmStrip({ text: t("detail.confirm.clear-targets"), ok: t("detail.confirm.clear-ok"), danger: true, onOk: () => clearTargets(symbol) });
    } else if (pending === "overlap") {
      strip = confirmStrip({ text: t("detail.confirm.overlap"), ok: t("detail.confirm.overlap-ok"), danger: false, onOk: () => saveTargets(symbol, { acknowledged: true }) });
    } else if (pending === "remove") {
      // 第 13 轮：删除确认条插在报价区之前；确认即删（6s 撤销已退役，§12.56）
      strip = confirmStrip({ text: t("detail.confirm.remove", { name: symbol.name }), ok: t("detail.confirm.remove-ok"), danger: true, page: true, onOk: () => { pending = null; performRemove(symbol); } });
    }
    if (!strip) return;
    if (pending === "remove") {
      el.insertBefore(strip, skeleton?.quoteLine ?? el.firstChild);
    } else {
      const host = pending === "clear" ? live.holdings?.form : live.targets?.form;
      host?.append(strip);
    }
    live.strip = strip;
  };

  /** 表单值与草稿同步：保存/清除成功后草稿收敛时调用；输入中绝不调用（防打断打字/光标） */
  const syncFormValues = () => {
    const symbol = symbolOf();
    if (!symbol || !live) return;
    const d = draftOf(symbol);
    for (const [name, field] of [
      ["quantity", live.holdings?.qty],
      ["avgCost", live.holdings?.cost],
      ["buyTarget", live.targets?.buy],
      ["sellTarget", live.targets?.sell],
    ]) {
      if (field) field.input.value = d[name] ?? "";
    }
  };

  /** 骨架重建（唯一结构路径）：quotes tick 永不走此路径——输入框/图表身份由「tick 不重建」保证 */
  const renderSkeleton = () => {
    if (disposed) return;
    const symbol = symbolOf();
    const ui = snapshot?.ui ?? {};
    el.replaceChildren();
    live = null;
    skeleton = null;
    skeletonId = symbol?.id ?? null;

    if (!symbol) {
      const empty = document.createElement("div");
      empty.className = "skc-empty";
      empty.textContent = t("detail.missing");
      el.append(empty);
      return;
    }

    const draft = draftOf(symbol);

    const head = document.createElement("div");
    head.className = "skc-detail-head";
    const back = document.createElement("button");
    back.className = "skc-btn skc-btn-ghost skc-detail-back";
    back.type = "button";
    back.append(iconEl(document, "back"), document.createTextNode(t("detail.back")));
    back.addEventListener("click", () => store.backToList());
    // 标题区两行：名称单行省略（完整名称走 tooltip），代码·市场·类型·币种另起一行——长名称不再把操作挤到换行（第五轮 2026-11-10）
    const titleCol = document.createElement("div");
    titleCol.className = "skc-detail-titlecol";
    const title = textSpan("skc-detail-title", symbol.name);
    title.title = symbol.name;
    // 第 13 轮·主人反馈迭代五（2026-11-15）：徽章与标的名同行（`恒生科技指数 [休市中]`）——
    // 语义直接贴合、头部横排不再占宽（代码行宽度全额归还）；长名时标题省略、徽章恒可见（flex:none）
    const titleRow = document.createElement("span");
    titleRow.className = "skc-detail-titlerow";
    const headBadge = textSpan("skc-badge skc-badge-stale", "");
    headBadge.hidden = true;
    titleRow.append(title, headBadge);
    titleCol.append(titleRow, textSpan("skc-detail-meta", `${symbol.code} · ${t(`market.${symbol.market}`)}${symbol.kind === "etf" ? " · ETF" : ""}${symbol.kind === "index" ? ` · ${t("kind.index")}` : ""} · ${symbol.quoteCurrency}`));
    // 删除：中性幽灵钮，悬停/聚焦时才转危险色（原红色实心钮在长名称换行后过于突兀）；整行不换行
    const del = document.createElement("button");
    del.className = "skc-btn skc-detail-delete";
    del.type = "button";
    del.append(iconEl(document, "trash", { strokeWidth: 1.4 }), document.createTextNode(t("detail.delete")));
    del.addEventListener("click", () => {
      pending = "remove";
      syncPendingStrip();
    });
    head.append(back, titleCol, del);

    const quoteLine = document.createElement("div");
    quoteLine.className = "skc-quote-line";
    const quotePrice = textSpan("skc-quote-price", "");
    const quoteChg = textSpan("skc-quote-chg", "");
    quoteChg.hidden = true;
    const quotePct = textSpan("skc-quote-pct", "");
    const quoteMove = document.createElement("span");
    quoteMove.className = "skc-quote-move";
    quoteMove.append(quoteChg, quotePct);
    const quoteMeta = document.createElement("span");
    quoteMeta.className = "skc-quote-meta";
    quoteLine.append(quotePrice, quoteMove, quoteMeta);

    // 周期切换：独立一行的分段控件（与列表 Tab 同族，四段等宽、文字居中），不与 K 线指标共用一行
    const periodTabs = document.createElement("div");
    periodTabs.className = "skc-period-tabs";
    const periodTabRefs = [];
    for (const p of PERIODS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `skc-tab skc-period${p.key === period ? " skc-tab-active" : ""}`;
      btn.textContent = p.label();
      btn.addEventListener("click", () => {
        if (period === p.key) return;
        period = p.key;
        const s = symbolOf();
        paintPeriodTabs();
        paintPeriodMeta();
        paintChartArea();
        if (s) loadChart(s);
      });
      periodTabs.append(btn);
      periodTabRefs.push({ key: p.key, btn });
    }
    // 指标行四档周期常驻（第 12 轮，2026-11-10）：行高恒定，卡片总高与周期无关。
    // K线档 = MA 图例 + 复权标注；分时档 = 昨收图例（标注图内的虚线参考线，非占位空行）。
    const periodMeta = document.createElement("div");
    periodMeta.className = "skc-period-meta";
    if (period === "minute") {
      const prevClose = chart.data?.prevClose ?? chart.prevClose ?? null;
      periodMeta.append(textSpan("skc-meta-note", t("detail.prev-close", { v: prevClose != null ? fmtPrice(prevClose) : "—" })));
    } else {
      periodMeta.append(buildMaLegend(ui.maVisible, (p) =>
        store.setMaVisible({ ...ui.maVisible, [p]: ui.maVisible[p] === false })));
      if (chart.adjust) {
        periodMeta.append(textSpan("skc-adjust", chart.adjust === "qfq" ? t("detail.adjust.fwd") : t("detail.adjust.none")));
      }
    }

    const chartBox = buildChartBox(symbol, ui);

    // 分段（第六轮，方案 B）：持仓 | 目标价 二选一显示；段上打点：有数据（灰）/ 未保存（橙）
    // 指数（2026-11-13）：无持仓/目标价语义——分段条与两段表单不构建，给一句占位说明
    const isIndex = symbol.kind === "index";
    const segTabs = document.createElement("div");
    const stack = document.createElement("div");
    const segs = {};
    if (isIndex) {
      stack.className = "skc-index-note";
      stack.append(textSpan("skc-hint", t("detail.index-note")));
      live = { segs, strip: null, holdings: null, targets: null };
    } else {
      segTabs.className = "skc-seg-tabs";
      for (const key of ["position", "targets"]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `skc-tab skc-seg${segment === key ? " skc-tab-active" : ""}`;
        btn.setAttribute("aria-pressed", String(segment === key));
        btn.append(document.createTextNode(t(key === "position" ? "detail.holdings" : "detail.targets")));
        const dot = textSpan("skc-seg-dot", "");
        dot.hidden = true;
        btn.append(dot);
        btn.addEventListener("click", () => {
          if (segment === key) return;
          segment = key;
          pending = null;
          paintSegment();
          syncPendingStrip();
        });
        segTabs.append(btn);
        segs[key] = { dot, btn };
      }
      // 两段同挂一个网格格子（grid-area 1/1）：非当前段 visibility:hidden 仍占位，容器高度取较高者，
      // 切换分段时页面高度不变、不跳动（第七轮 2026-11-10）；非当前段 inert，键盘与读屏都进不去
      const holdingsPart = buildHoldingsPanel(symbol, draft);
      const targetsPart = buildTargetsPanel(symbol, draft);
      stack.className = "skc-seg-stack";
      for (const [part, key] of [[holdingsPart, "position"], [targetsPart, "targets"]]) {
        const on = segment === key;
        part.form.classList.toggle("is-off", !on);
        part.form.toggleAttribute("inert", !on);
        part.form.setAttribute("aria-hidden", String(!on));
        stack.append(part.form);
      }
      live = {
        segs,
        strip: holdingsPart.strip ?? targetsPart.strip,
        holdings: { ...holdingsPart.live, form: holdingsPart.form },
        targets: { ...targetsPart.live, form: targetsPart.form },
      };
    }
    skeleton = {
      quote: { price: quotePrice, chg: quoteChg, pct: quotePct, meta: quoteMeta },
      quoteLine,
      headBadge,
      periodTabs: periodTabRefs,
      periodMeta,
      chartBox,
    };

    el.append(head, quoteLine, periodTabs, periodMeta, chartBox, ...(isIndex ? [] : [segTabs]), stack);
    // 第 13 轮：pending="remove" 的确认条不随骨架内联构建（holdings/targets 的 pending 条由
    // buildHoldingsPanel/buildTargetsPanel 内联，此处补挂会双挂），仅 remove 分支重建时补挂
    if (pending === "remove" && !isIndex) {
      const strip = confirmStrip({ text: t("detail.confirm.remove", { name: symbol.name }), ok: t("detail.confirm.remove-ok"), danger: true, page: true, onOk: () => { pending = null; performRemove(symbol); } });
      el.insertBefore(strip, quoteLine);
      live.strip = strip;
    }
    paintQuoteLine();
    paintLive();
  };

  /* 窗口高度变化：仅图表区随视口重算（paintChartArea，图表高度随视口收缩语义）。
     头部/表单/输入框一律不动——移动端软键盘弹出即触发 window resize（竖屏 sheet 尤甚，
     横屏键盘多走 pan 不触发），整段重建会当场销毁聚焦输入框 → 软键盘立跳（§12.17 契约；
     2026-11-11 主人实机复测：竖屏四个输入框必现）。行情与图表数据沿用会话内缓存，不重新拉取。 */
  const onWinResize = () => {
    if (disposed || !snapshot?.ui?.panelOpen || snapshot?.ui?.view !== "detail" || !symbolOf()) return;
    const d = dimsOf();
    if (d.w === lastBoxDims.w && d.h === lastBoxDims.h) return; // 二元组守卫：未变零调度（宽度 [240,400] 钳位量化顺带白赚）
    scheduleRepaint();
  };
  winRef()?.addEventListener?.("resize", onWinResize);

  const update = (next) => {
    if (disposed) return;
    snapshot = next;
    const ui = next?.ui ?? {};
    const changed = next?.changed; // undefined = 全量（订阅回放/语言切换/旧快照）
    const symbol = symbolOf();

    // detailId 变化：重置会话态（period 保留，语义与 React 版一致）
    const detailChanged = ui.detailId !== lastDetailId;
    if (detailChanged) {
      lastDetailId = ui.detailId;
      form = null;
      pending = null;
      busy = false;
      overlapHint = false;
      chartKey = "";
      loadedKey = ""; // §12.37：重新打开同一标的详情也立即重新取数（否则 loadedKey 残留会跳过 loadChart）
      chart = { key: "", loading: false, data: null, error: null, errorDetail: null, adjust: null, prevClose: null, date: null };
    }
    if (symbol) {
      const key = `${symbol.id}:${period}`;
      if (key !== loadedKey) loadChart(symbol);
      else if (chartRefreshDue(symbol.market, chart.loadedAt ?? 0, Date.now())) refreshChart(symbol); // §12.33 盘中静默刷新（休市不刷新）
      else if (chart.error && period === "minute" && !isMarketOpen(symbol.market, Date.now())) refreshChart(symbol); // §12.37 休市分时后台重试：拿到数据即静默换图（每拍至多一次）
    }
    // 切片门控（渲染切片广播 Task 3）：结构触发 → 骨架重建；quotes-only tick → 报价行 + 派生域
    // 原位写。输入框/图表身份由「tick 不重建」保证（§12.17 契约）——跳绘守卫与光标捕获/恢复退役。
    const structural = changed === undefined
      || changed.business === true
      || detailChanged
      || skeletonId !== (symbol?.id ?? null)
      || (Array.isArray(changed.ui) ? changed.ui.some((k) => k === "view" || k === "detailId") : true);
    if (!symbol) {
      if (structural) renderSkeleton(); // 空态：首次或结构变化才动 DOM，list 视图 tick 早退（不再白做空态重建）
      return;
    }
    if (structural) {
      renderSkeleton();
      return;
    }
    paintQuoteLine();
    paintLive();
    if (Array.isArray(changed && changed.ui) && changed.ui.includes("maVisible")) {
      paintPeriodMeta(); // MA 显隐即时生效（§12.36 修复：图例芯片态 + 图表区 MA 线原位重画）
      paintChartArea();
    }
  };

  const dispose = () => {
    disposed = true;
    clearPendingRepaint(); // 撤 pending rAF/trailing（回调另自带 disposed 早退）
    winRef()?.removeEventListener?.("resize", onWinResize);
    el.replaceChildren();
    el.remove();
  };

  return { el, update, dispose };
}
