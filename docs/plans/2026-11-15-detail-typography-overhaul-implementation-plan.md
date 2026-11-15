# 详情页排版与交互修正实施计划（第 13 轮：hero 左对齐数据栈 + 底部空白 + 触控 + 删除撤销）

## 目标

- 落地 2026-11-15 impeccable 评审（22/40）经主人拍板的全部改动：
  1. **P0-2 / 方向 A「左对齐数据栈」**：详情 hero 区从居中三段混排改为左对齐三行数据栈——行1 价格（28px 独占行）、行2 变动（涨跌额 + 涨跌幅同色成列）、行3 新鲜度（拉取时刻 · 数据源），推翻 §12.54 居中轴钦定；
  2. **P0-1 底部幽灵空白**：≤520px 视口下隐藏的分段表单改 `display:none`，消除移动端半屏死白；
  3. **P1-4 删除流程**：删除弃用 `window.confirm` 原生弹窗，改用区块内 danger 确认条；删除后 toast 提供 6 秒「撤销」（同 id 经 `symbols/add` 复原）；
  4. **P2-5 触控与 footer**：26px 图标钮热区外扩至 ≥40px；移除与自动轮询冗余的「刷新」钮；
  5. 文档与验证记录按仓库惯例归档（ui-redesign 第 13 轮 + verification §12.55）。
- **明确不做**（主人 2026-11-15 拍板）：涨跌色保持全局红涨（评审 P1-3 不做，`trendClass` 与 `--skc-up/down` 不动）；不 bump、不发版。

## 架构快照

- hero 结构（方向 A 三行数据栈）：`skc-quote-line` 改 block + `text-align:left`——行 1 价格（24px→28px，tabular-nums、700、-0.01em，块级独占行）；行 2 变动（新增 `skc-quote-move` flex 行：`skc-quote-chg` 涨跌额 + 既有 `skc-quote-pct`，14px/600，`trendClass` 同色成列）；行 3 新鲜度（`skc-quote-meta` 改 `justify-content:flex-start`，内容从「行情 HH:mm · 拉取 HH:mm:ss + 徽章 + 数据源：X」收敛为「HH:mm:ss · X + 徽章」，完整双时间戳降级为 `quoteLine.title` tooltip）。
- 涨跌额数据源：行情快照行已携带上游口径 `changeAmount`（六适配器全填——eastmoney 165/234、okx 57、sina 71、tencent-us 66、tencent 73、yahoo 66/69；`src/routes.mjs:322` 透传；client 全目录现零消费），hero **直用 `q.changeAmount`**，与涨跌幅同一上游 tick 自洽；缺失或非有限值时隐藏涨跌额 span、退化为现行为（价格+涨跌幅），不新增取数路径。
- 图表高度契约不变：`chartHeight = clamp(vh − 24 − CHART_H.fixed[lang], 140, 230)`。hero 由两行变三行使固定区显著增高（解析估算 +26px），Task 4 实测校准 `CHART_H.fixed` 与 `tests/client-detail-fit.test.mjs` 的硬编码期望值（680 视口将落入 140 下限，需补 760 视口断言上限档）。
- 删除撤销链：`client/store.mjs` 在 `removeSymbol` 成功后于内存捕获被删记录（`state.business.symbols` 中的对象），toast 携带可序列化 `action = { kind: "undo-remove", label, ms }`；`panel.mjs` 渲染「撤销」按钮，点击调新增的 `store.undoRemoveSymbol()` —— 经既有 `api.add(market, code, patch, rev)` 以**相同 market+code** 复原（服务端 id 由 market+code 派生，恢复同 id；sort 位不恢复、落到组尾，已接受并在验证记录注明）。撤销失败走既有 `quiet:false` 的 `toast.op-failed` 路径，捕获保留。
- 其余（seg-stack、footer、toast）均为纯 CSS/DOM 微改，不触渲染切片契约（`patchToast` 引用比对语义保持）。

## 全局约束（逐字继承）

- 运行时零 npm 依赖；devDeps 仅 esbuild、jsdom；node ≥ 20。
- 颜色一律取 `--dsw-alias-*` → `:host` `--skc-*` 局部别名，每处带 fallback；不得引入硬编码色值。
- 字号阶梯：正文/控件 13px、辅助说明 12px、徽章 11px，不出现 10px；辅助文案用 label-secondary（≥4.5:1）。hero 价格 28px 为既有 24px 特例的延续放大，不破阶梯（它是页面唯一 hero 层）。
- 动效只做 chrome（面板/对话框/toast 入场），数据行不做动画；新改动不新增任何动画。
- i18n zh/en 双字典同步增删改，parity 有守卫测试；**用户可见文案 zh/en 逐字入本计划**（见各任务）。
- 判据命令写入前按最终形态复跑；`grep -c` 计 0 即 exit 1，禁入 `&&` 链；lib 内中文是 `\uXXXX` 转义形态，产物判据用 `grep -cF` 转义定串。
- 改 `client/` 后必跑 `npm run build`（最终验证统一跑）；渲染层改动跑 `scripts/cdp-shot.mjs`（头注纪律：chrome 后台起跑、重活前 headless chrome 进程清零）。
- build/test 前 `test -d node_modules`，缺失先 `npm ci`；确认无 headless chrome 进程残留。
- 联网 npm 命令前加 `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban`。
- 默认**不提交**：各轮改动留工作区待主人验核（仓库惯例）；主人明示时才按任务边界提交。
- 首次改 UI 文件前必读 impeccable craft-floor：`/home/ubuntu/.dsh/profiles/web/node_modules/@iasiv5/dsh-skills/skills/impeccable/reference/craft-floor.md`。

## 输入工件

- 评审快照：`docs/../.impeccable/critique/2026-11-15T06-35-10Z__client-detail-mjs.md`（22/40，5 个优先问题 + 方向 A/B/C）
- 主人拍板（2026-11-15 对话）：方向 A 左对齐数据栈；范围 = 全部 5 个优先问题；涨跌色保持全局红涨
- 既有裁决（本轮推翻，需同步改记录）：`docs/verification.md` §12.54（hero 居中轴）

## 文件结构与职责

- Create: `tests/client-detail-hero.test.mjs` —— hero 结构/降级/新鲜度 + `fmtChange` 单测
- Create: `tests/client-undo.test.mjs` —— 删除撤销 store 契约 + toast action 面板渲染
- Modify: `client/fmt.mjs` —— 新增纯函数 `fmtChange(v)`
- Modify: `client/i18n.mjs` —— zh/en 双字典新键、`detail.confirm.remove`/`detail.source` 文案改写、退役键删除
- Modify: `client/detail.mjs` —— `renderSkeleton`/`paintQuoteLine` hero 重构；`confirmBox` 退役与 `pending:"remove"` 确认条；`CHART_H.fixed` 校准
- Modify: `client/styles.mjs` —— 报价区/图标钮热区/toast 按钮样式；≤520 媒体查询 seg-stack 规则
- Modify: `client/panel.mjs` —— 移除刷新钮；`patchToast` 渲染 action 按钮
- Modify: `client/store.mjs` —— `removeSymbol` 捕获、`undoRemoveSymbol`、`setToast(text, action?)`
- Modify: `tests/client-detail-fit.test.mjs` —— 图表高度期望值随固定区校准
- Modify: `tests/client-detail-r6.test.mjs` —— 删除确认条用例
- Modify: `tests/detail-source.test.mjs` —— detailSourceText 新契约（正常态 null）逐用例改钉，计数不变
- Modify: `tests/client-dom.test.mjs` —— 新样式串钉住 + footer 无刷新钮用例
- Modify: `tests/client-restyle.test.mjs` —— footer action 枚举去 `refresh`（第 65 行循环）
- Modify: `tests/i18n.test.mjs` —— 新键 zh/en 值逐字断言
- Modify: `docs/ui-redesign.md`、`docs/verification.md` —— 第 13 轮 + §12.55 归档
- Build 产物（不改手）：`lib/client.js`（`npm run build`）

测试计数账（基线 N₀ 执行时实跑记录；§12.53 记录为 441）：T1 +2、T2 +1、T3 +3、T5 +1、T6 +1、T7 +1、T8 +2、T9 +5 → 最终 **N₀ + 16**；T4 改值不加数；无删 case。

## 任务清单

### Task 1: client/fmt.mjs + 纯函数 fmtChange

- 目标：新增涨跌额格式化纯函数，node 可测。
- 涉及文件：Modify `client/fmt.mjs`；Create `tests/client-detail-hero.test.mjs`
- 接口契约
  - Consumes: `client/fmt.mjs` 现有 `fmtPrice`（保持不动）
  - Produces: `export function fmtChange(v)` —— `v == null || !Number.isFinite(v)` → `"—"`；`v === 0` → `"0.00"`；`v > 0` → `"+" + fmtPrice(v)`；`v < 0` → `"-" + fmtPrice(Math.abs(v))`（ASCII 连字符，与 `fmtPct` 负号一致）。后续 Task 3 的 hero 测试与 `paintQuoteLine` 按此签名消费。
- 验证范围：`node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs"`

- [ ] Step 1: 写失败测试。新建 `tests/client-detail-hero.test.mjs`，先只含 fmt 用例（import `fmtChange` 自 `../client/fmt.mjs`，此刻该导出不存在）：

```js
test("fmtChange：正负号 + 千分位 + 边界", () => {
  assert.equal(fmtChange(2885.4), "+2,885.40");
  assert.equal(fmtChange(-2885.4), "-2,885.40");
  assert.equal(fmtChange(0), "0.00");
  assert.equal(fmtChange(null), "—");
  assert.equal(fmtChange(Number.NaN), "—");
  assert.equal(fmtChange(0.1), "+0.1000"); // <1 走 fmtPrice 4 位档：fmtPrice(0.1)="0.1000"（精度沿用 fmtPrice，不另造档）
});
```

  注意：`fmtPrice(0.1)` 走 `abs >= 0.01 → digits=4` 分支返回 `"0.1000"`，故 `fmtChange(0.1)` 期望为 `"+0.1000"`（精度档沿用 fmtPrice 是本任务契约）。
- Run: `node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs"`
- Expected: 红 —— `SyntaxError: The requested module '../client/fmt.mjs' does not provide an export named 'fmtChange'`（红落在 import 行，即目标断言前置依赖；属预期模块级红）
- [ ] Step 2: 运行并确认失败
- Run: `node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs"`
- Expected: 上述模块级红
- [ ] Step 3: 写最小实现。`client/fmt.mjs` 在 `fmtPct` 之后追加：

```js
/** 涨跌额（带符号；0 无号；非法 → —）。精度沿用 fmtPrice 量级档。 */
export function fmtChange(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0.00";
  return v > 0 ? `+${fmtPrice(v)}` : `-${fmtPrice(Math.abs(v))}`;
}
```

  并在 `tests/client-detail-hero.test.mjs` 补第二条用例：`fmtChange(64486.7 - 67372.1)` === `"-2,885.40"`（浮点尾差经 fmtPrice 消音的自证）。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs"`
- Expected: 2 tests 全绿（基线计数 +2）

### Task 2: client/i18n.mjs + 第 13 轮新键（只增不改不删）

- 目标：新增 hero/撤销所需全部文案键（zh/en 同步），并在 i18n 测试钉住逐字值。
- 涉及文件：Modify `client/i18n.mjs`（zh 块 `detail.*` 区约 61-124 行、`toast.*` 区约 162-170 行；en 块对应区）；Modify `tests/i18n.test.mjs`
- 接口契约
  - Consumes: 无
  - Produces: 以下键（Task 3/8/9 消费，逐字）：
    - `"detail.freshness"`: zh `"{t} · {s}"`；en `"{t} · {s}"`
    - `"detail.quote-tip"`: zh `"行情 {q} · 拉取 {f}"`；en `"Quote {q} · Fetched {f}"`
    - `"detail.confirm.remove-ok"`: zh `"确认删除"`；en `"Delete"`
    - `"toast.removed"`: zh `"已删除 {name}"`；en `"Removed {name}"`
    - `"toast.undo"`: zh `"撤销"`；en `"Undo"`
    - `"toast.restored"`: zh `"已恢复 {name}"`；en `"Restored {name}"`
  - 本任务**不改** `"detail.confirm.remove"`（其新文案属 Task 9）、**不删**任何键（`detail.quote-time` 退役属 Task 3、`list.refresh` 属 Task 7）。
- 验证范围：`node scripts/run-tests.mjs "tests/i18n.test.mjs"`

- [ ] Step 1: 写失败测试。`tests/i18n.test.mjs` 末尾追加：

```js
test("第 13 轮新键：hero 新鲜度 + 撤销文案（zh/en 逐字）", () => {
  setLang("zh");
  assert.equal(t("detail.freshness"), "{t} · {s}");
  assert.equal(t("detail.quote-tip"), "行情 {q} · 拉取 {f}");
  assert.equal(t("detail.confirm.remove-ok"), "确认删除");
  assert.equal(t("toast.removed"), "已删除 {name}");
  assert.equal(t("toast.undo"), "撤销");
  assert.equal(t("toast.restored"), "已恢复 {name}");
  setLang("en");
  assert.equal(t("detail.freshness"), "{t} · {s}");
  assert.equal(t("detail.quote-tip"), "Quote {q} · Fetched {f}");
  assert.equal(t("detail.confirm.remove-ok"), "Delete");
  assert.equal(t("toast.removed"), "Removed {name}");
  assert.equal(t("toast.undo"), "Undo");
  assert.equal(t("toast.restored"), "Restored {name}");
});
```

  （沿用文件内既有的 `setLang`/`t` import；若文件头未导入 `setLang` 则补 import。）
- Run: `node scripts/run-tests.mjs "tests/i18n.test.mjs"`
- Expected: 红 —— 首个断言 `t("detail.freshness")` 返回键名本身（i18n 缺键回退键名），`assert.equal` 失败信息含 `"detail.freshness"`
- [ ] Step 2: 运行并确认失败
- Run: `node scripts/run-tests.mjs "tests/i18n.test.mjs"`
- Expected: 上述红
- [ ] Step 3: 写最小实现。zh 块在 `"detail.confirm.remove"` 附近与 `"toast.op-failed"` 附近、en 块对应位置，按上方契约逐字加入 6 键。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/i18n.test.mjs"`
- Expected: 全绿（+1 test）；parity 守卫不红（双字典已同步）

### Task 3: client/detail.mjs hero 左对齐数据栈 + 报价区样式

- 目标：hero 改两行左对齐结构；涨跌额接入；新鲜度行收敛；居中轴退役。
- 涉及文件：Modify `client/detail.mjs`（`renderSkeleton` 773-779 行 quoteLine 构建段、`paintQuoteLine` 613-640 行）、Modify `client/styles.mjs`（185-188 行报价区规则）、Modify `client/i18n.mjs`（退役 `detail.quote-time`、`detail.source` 值改写）、Modify `tests/client-detail-hero.test.mjs`
- 接口契约
  - Consumes: Task 1 `fmtChange`；Task 2 `detail.freshness`/`detail.quote-tip`；既有 `trendClass`/`fmtPct`/`fmtClock`/`fmtClockSec`/`detailSourceText`/`t("provider.*")`
  - Produces: DOM 结构 `.skc-quote-line > .skc-quote-price（块级行）+ .skc-quote-move（flex 行：.skc-quote-chg[hidden] + .skc-quote-pct）+ .skc-quote-meta`；`skeleton.quoteLine`（quoteLine 容器引用，Task 8 的确认条插入锚点）与 `skeleton.quote.chg`；样式类 `.skc-quote-move`、`.skc-quote-chg`
- 验证范围：`node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs" && node scripts/run-tests.mjs "tests/client-render-identity.test.mjs" && node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs" && node scripts/run-tests.mjs "tests/detail-source.test.mjs"`

- [ ] Step 1: 前置复核（判据已按最终形态基线复跑，评审 R3 落盘 log 佐证）：
  - `grep -cF "detail.quote-time" client/detail.mjs client/i18n.mjs` → `1` 与 `2`（zh+en 各一）；`grep -rn "quote-time" tests/` → 0 命中（无测试钉住）
  - `grep -rn "detailSourceText" client/ tests/` → 消费面仅 `client/detail.mjs:638` 一处 + `tests/detail-source.test.mjs`（5 用例，8-43 行：正常态 zh:8-13 / 降级态 zh:15-18 / error-null 20-25 / en 两态 27-32 / provider parity 循环 34-42）——**键名 grep 查不出输出串钉**（R3 教训），故本文件列入 Modify 清单并逐用例改钉（见 Step 3）
  - `grep -cF "changeAmount" src/routes.mjs` ≥ 1（已核 322 行透传；六适配器供数点：eastmoney.mjs:165/234、okx.mjs:57、sina.mjs:71、tencent-us.mjs:66、tencent.mjs:73、yahoo.mjs:66/69）；`grep -rn "changeAmount" client/` → 0 命中（现状零消费，exit 1 属预期）
- [ ] Step 2: 写失败测试。`tests/client-detail-hero.test.mjs` 新增详情夹具（照 `tests/client-detail-fit.test.mjs` 的 `setupDetail` 形态：`createDomHarness` + `createDetail` + fetch stub + 快照，其中 quotes 行加 `changeAmount: 0.1, source: "okx", fallbackFrom: null`），三个用例：

```js
test("hero 三行结构：价格行 / 变动行（chg+pct 同色）/ 新鲜度行；chg 缺 changeAmount 时隐藏", async () => {
  const s = setupDetail({ height: 680 }); // 夹具 quotes 行带 changeAmount: 0.1, source: "okx"
  try {
    await s.load();
    const line = s.detail.el.querySelector(".skc-quote-line");
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
    assert.equal(metaText.includes(t("detail.freshness", { t: fmtClockSec(1), s: "OKX" })), true, "新鲜度单表达式");
    assert.equal(line.title, t("detail.quote-tip", { q: fmtClock(1), f: fmtClockSec(1) }), "双时间戳降级为 tooltip");
    // 退化分支：去掉 changeAmount 再喂快照
    // （构造 changeAmount 缺失的 quotes 行 detail.update → chg.hidden === true，price/pct 仍在）
  } finally { s.restore(); }
});

test("hero 左对齐：报价区样式串断言（新串在、旧居中串退役）", () => {
  const st = FLOAT_STYLE_TEXT;
  assert.ok(st.includes(".skc-quote-line{display:block;text-align:left;margin:10px 0 12px}"), "左对齐块级");
  assert.ok(st.includes(".skc-quote-move{"), "变动行容器样式在位");
  assert.equal(st.includes(".skc-quote-line{display:block;text-align:center;margin:10px 0 12px}"), false, "§12.54 居中串已退役");
});

test("hero 退役：detail.quote-time 键删除（缺键回退键名）", () => {
  setLang("zh");
  assert.equal(t("detail.quote-time"), "detail.quote-time");
  setLang("en");
  assert.equal(t("detail.quote-time"), "detail.quote-time");
});
```

  （夹具构造照 `tests/client-detail-fit.test.mjs` 的 `setupDetail`：`createDomHarness` + `createDetail` + fetch stub + 快照，quotes 行加 `changeAmount: 0.1, source: "okx", fallbackFrom: null`；退化分支在同用例内构造第二份快照。文件头按需补 import：`createDomHarness`（`./helpers/dom-harness.mjs`）、`createDetail`、`FLOAT_STYLE_TEXT`（`../client/styles.mjs`）、`t`/`setLang`（`../client/i18n.mjs`）、`fmtChange`/`fmtClock`/`fmtClockSec`（`../client/fmt.mjs`），路径全部与 fit 测试同源。断言红前提复查（判据纪律）：三块红均建立在「当前 HEAD 无 move/chg span、样式串仍居中、键仍在」之上，Task 1/2 完成后依然成立。）
- Run: `node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs"`
- Expected: 三个新用例红（结构缺席 / 旧串在 / 键在），既有 2 个 fmt 用例保持绿
- [ ] Step 3: 写最小实现：
  - `styles.mjs` 185-188 行改为：

```css
.skc-quote-line{display:block;text-align:left;margin:10px 0 12px} /* 第 13 轮（2026-11-15）：方向 A 三行数据栈，§12.54 居中轴退役（主人拍板；styles.mjs 旧注释 §12.53 为历史笔误随本轮更正） */
.skc-quote-price{display:block;font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.15;letter-spacing:-.01em}
.skc-quote-move{display:flex;gap:8px;align-items:baseline;margin-top:2px}
.skc-quote-chg{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.skc-quote-pct{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums} /* 原 margin-left:10px 退役：行内间距归 .skc-quote-move gap */
.skc-quote-meta{color:var(--skc-text-2);font-size:12px;line-height:16px;display:flex;justify-content:flex-start;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px;font-variant-numeric:tabular-nums}
```

  - `detail.mjs` `renderSkeleton` quoteLine 段（773-779 行）：构建 `const quoteMove = document.createElement("span"); quoteMove.className = "skc-quote-move"; const quoteChg = textSpan("skc-quote-chg", ""); quoteChg.hidden = true; quoteMove.append(quoteChg, quotePct);`，`quoteLine.append(quotePrice, quoteMove, quoteMeta)`；`skeleton.quote = { price: quotePrice, chg: quoteChg, pct: quotePct, meta: quoteMeta }`，并挂 `skeleton.quoteLine = quoteLine`。
  - `paintQuoteLine` 重写（保留徽章/targetBadgeKind 分支与 stale 语义）：

```js
const q = snapshot?.quotes?.[symbol.id];
const price = q?.status === "ok" ? q.price : null;
const pct = q?.changePercent ?? null;
const chg = Number.isFinite(q?.changeAmount) ? q.changeAmount : null; // 上游口径直用（R2 成链：六适配器全填、routes:322 透传）
skeleton.quote.price.textContent = /* 原逻辑不变：price / q 错误文案 / … / — */;
skeleton.quote.price.className = `skc-quote-price ${trendClass(pct)}`;
skeleton.quote.chg.hidden = chg == null;
if (chg != null) {
  skeleton.quote.chg.textContent = fmtChange(chg);
  skeleton.quote.chg.className = `skc-quote-chg ${trendClass(pct)}`; // 着色跟 pct 同向
}
skeleton.quote.pct.textContent = fmtPct(pct);
skeleton.quote.pct.className = `skc-quote-pct ${trendClass(pct)}`;
const fTime = q?.fetchedAt ?? null;
const qTime = q?.quoteTime ?? null;
const provider = q?.status === "ok" && q?.source ? t(`provider.${q.source}`) : null;
const fresh = fTime != null ? fmtClockSec(fTime) : "—";
skeleton.quote.meta.replaceChildren(document.createTextNode(
  provider ? t("detail.freshness", { t: fresh, s: provider }) : fresh));
skeleton.quoteLine.title = qTime != null
  ? t("detail.quote-tip", { q: fmtClock(qTime), f: fTime != null ? fmtClockSec(fTime) : "—" })
  : "";
// badge 追加分支不动；降级源注仅在有 fallbackFrom 时追加（见下一条）
```

  - `i18n.mjs` `detailSourceText`（419-424 行）改契约为「仅降级时出注」：无 fallbackFrom 返回 `null`（paintQuoteLine 637-639 行 `if (srcNote)` 结构原样保留——正常态 provider 名已在新鲜度行内联，源注只在降级时出现，与 B2 单表达式收敛自洽）：

```js
export function detailSourceText(row) {
  if (!row || row.status !== "ok" || !row.source || !row.fallbackFrom) return null;
  const name = t(`provider.${row.source}`);
  const from = t(`provider.${row.fallbackFrom}`);
  return t("detail.source.fallback", { name, from });
}
```

  - `i18n.mjs` 键处理（定死）：删除 zh/en 两处 `"detail.quote-time"`；删除 zh/en 两处 `"detail.source"`（65/250 行——detailSourceText 改契约后全仓零消费）；`"detail.source.fallback"`（66/251 行）保留不动。
  - Modify `tests/detail-source.test.mjs`（逐用例改钉，计数不变：5 用例原地改）——:8-13 正常态 zh 改 `assert.equal(s, null)`（删 :12 的 includes 断言），用例名改「detailSourceText：正常态返回 null（源名已并入新鲜度行）」；:15-18 降级态与 :20-25 error-null **不动**；:27-32 en 的 :29 改 `assert.equal(..., null)`、:30 不动；:34-42 parity 循环改直断 provider 键（循环体内改 `const s = t(`provider.${p}`);`，断言非空且不含 "provider."）；文件头 5-6 行注释同步新契约（正常态 null / 降级态 数据源：{name}（降级自 {from}））。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-detail-hero.test.mjs" && node scripts/run-tests.mjs "tests/client-render-identity.test.mjs" && node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs" && node scripts/run-tests.mjs "tests/detail-source.test.mjs"`
- Expected: hero 文件全绿（+3）；render-identity 的「报价行原位更新」（145 行 `/121\.00/`）与 r6 全套保持绿（paintQuoteLine 仍是原位写、tick 不重建）；detail-source 5 用例改钉后全绿

### Task 4: 图表固定区高度校准（CHART_H.fixed + fit 测试期望值）

- 目标：hero 增高后图表钳位算术保持「卡片总高不越视口」契约。
- 涉及文件：Modify `client/detail.mjs`（31 行 `CHART_H` 与头注 27-31 行）、Modify `tests/client-detail-fit.test.mjs`（102-157 行的 `162` 期望值）
- 接口契约
  - Consumes: Task 3 完成后的 hero 实际高度；fit 夹具语言为 zh（证据：680 − 24 − 494 = 162 与现测试吻合）
  - Produces: 校准后的 `CHART_H.fixed = { zh: <实测>, en: <实测> }`（解析估算 zh 520 / en 537，与 Step 1 落码值一致，Step 3 实测裁决）
- 验证范围：`node scripts/run-tests.mjs "tests/client-detail-fit.test.mjs"` + `scripts/cdp-shot.mjs` 实拍

- [ ] Step 1: 解析估算落码。`CHART_H.fixed` 改 `{ zh: 520, en: 537 }`（Δ≈+26：价格行 27.6→32.2 ≈ +4.6，新增变动行 14px×1.45+2px margin ≈ +22，meta 行与边距不变）；fit 测试改组（680 在三行 hero 后落入 140 下限，上限档分辨力由 760 视口承担）：
  - 102-110 行用例（分时 680）：期望 `162` → `140`，用例名改「分时：视口 680 → 图表 140（三行 hero 后落入下限钳位，上限档由 760 承担）」；
  - 146-157 行 resize 用例：`680 → 162` 改 `680 → 140`（146 行用例名同步）；
  - 132-144 行日K 用例元组 `[[680, 162], [630, 140]]` → `[[760, 216], [630, 140]]`（760−24−520=216 ∈ (140,230)，保留上限档验证）。
- Run: `node scripts/run-tests.mjs "tests/client-detail-fit.test.mjs"`
- Expected: 全绿（测试期望与常量同源同改）
- [ ] Step 2: 实测校准。按 `scripts/cdp-shot.mjs` 头注纪律起 chrome（后台、进程清零），对 zh/en 详情夹具各实拍一张，读固定区实际高度（视口 680 下「卡片总高 − 图表高 − 24」）。若与估算差 ≤2px 保留估算值；否则以实测值同改 `CHART_H.fixed` 与 fit 期望值（单次同改，不留中间红）。
- Run: `node scripts/cdp-shot.mjs`（按其头注参数；产物落 `/tmp/skc-preview/out/r13-*`）
- Expected: 两图内图表完整显示、卡片不越 680 视口、底部 footer 可见；固定区读数回填 `CHART_H.fixed` 注释（格式沿用现注释「实测」口径）
- [ ] Step 3: 复跑确认
- Run: `node scripts/run-tests.mjs "tests/client-detail-fit.test.mjs"`
- Expected: 全绿；`detail.mjs` 头注第 31 行附近注释已更新为新实测值与日期

### Task 5: ≤520px 视口消除 seg-stack 幽灵占位（P0-1）

- 目标：移动端单列布局下隐藏段不再占位，消除表单区下方约半屏死白。
- 涉及文件：Modify `client/styles.mjs`（329-334 行 `@media (max-width:520px)` 块）；Modify `tests/client-dom.test.mjs`
- 接口契约
  - Consumes: 既有 `.skc-seg-stack > form.is-off{visibility:hidden}`（styles 214-216 行，桌面保留不动）；r6 对 seg-stack 的 DOM 断言（两段都在 DOM、inert 互换——媒体查询不触 DOM，r6 天然保持绿）
  - Produces: 样式串 `.skc-seg-stack > form.is-off{display:none}`（仅存在于 ≤520 媒体块内）
- 验证范围：`node scripts/run-tests.mjs "tests/client-dom.test.mjs" && node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs"`

- [ ] Step 1: 写失败测试。`tests/client-dom.test.mjs` 追加样式串断言（沿用其 `FLOAT_STYLE_TEXT` 断言风格）：

```js
test("第 13 轮 · ≤520 媒体块内 is-off 段 display:none（移动端幽灵占位消除）", () => {
  const s = FLOAT_STYLE_TEXT;
  const media = s.slice(s.indexOf("@media (max-width:520px)"));
  assert.ok(media.includes(".skc-seg-stack > form.is-off{display:none}"), "移动端隐藏段不再占位");
  assert.ok(!media.includes("transition"), "数据区不引入过渡动画（纪律）");
});
```

- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs"`
- Expected: 红 —— `media.includes(...)` 为 false
- [ ] Step 2: 运行并确认失败
- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs"`
- Expected: 上述红
- [ ] Step 3: 写最小实现。`@media (max-width:520px)` 块内追加一行：`.skc-seg-stack > form.is-off{display:none}`（桌面等高占位语义不变，块内不改其他规则）。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs" && node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs"`
- Expected: 两文件全绿（r6 的 stack.children === 2、inert 互换不受影响）；计数 +1

### Task 6: 图标钮热区外扩至 40px（P2-5 前半）

- 目标：26×26 图标钮的命中区经 `::before` 外扩到 40×40（复用胶囊 `-9px` 外扩技法）。
- 涉及文件：Modify `client/styles.mjs`（255 行 `.skc-icon-btn` 规则）；Modify `tests/client-dom.test.mjs`
- 接口契约
  - Consumes: 既有 `.skc-capsule::before{content:"";position:absolute;inset:-9px}` 技法（66 行）
  - Produces: `.skc-icon-btn` 获 `position:relative` 与 `::before{inset:-7px}`（26+14=40）
- 验证范围：`node scripts/run-tests.mjs "tests/client-dom.test.mjs"`

- [ ] Step 1: 写失败测试：

```js
test("第 13 轮 · 图标钮热区外扩 40px（::before inset -7）", () => {
  const s = FLOAT_STYLE_TEXT;
  assert.ok(s.includes(".skc-icon-btn{position:relative;"), "图标钮建立定位上下文");
  assert.ok(s.includes('.skc-icon-btn::before{content:"";position:absolute;inset:-7px}'), "热区外扩至 40px");
});
```

- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs"`
- Expected: 红（两断言均不成立）
- [ ] Step 2: 运行并确认失败
- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs"`
- Expected: 上述红
- [ ] Step 3: 写最小实现。255 行规则 `display:inline-flex` 前插 `position:relative;`；其后新增规则 `.skc-icon-btn::before{content:"";position:absolute;inset:-7px}`。相邻钮 gap 6px 与外扩 7px 会交叠 1px，命中边界落在两钮中线，可接受（与胶囊命中区外扩同哲理）；header 关闭钮同享 40px 热区。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs"`
- Expected: 全绿；计数 +1

### Task 7: 移除 footer 刷新钮（P2-5 后半）

- 目标：删掉与 15 秒自动轮询冗余的手动刷新；`list.refresh` 键退役。
- 涉及文件：Modify `client/panel.mjs`（273 行 refreshBtn、275 行 append 列表、350 行 render 循环键组）、Modify `client/i18n.mjs`（删 zh/en `"list.refresh"`）、Modify `tests/client-dom.test.mjs`、Modify `tests/client-restyle.test.mjs`（65 行 action 枚举）
- 接口契约
  - Consumes: client-dom 内现成 createPanel 夹具（`grep -n "createPanel" tests/client-dom.test.mjs` 定位，沿用其桩法）
  - Produces: footer 仅剩 holdings/add/settings 三钮 + header close；`icons.mjs` 的 `refresh` 图标保留不删（不在本计划范围）
- 验证范围：`node scripts/run-tests.mjs "tests/client-dom.test.mjs" && node scripts/run-tests.mjs "tests/client-restyle.test.mjs"`

- [ ] Step 1: 写失败测试。client-dom 追加（用既有 panel 夹具）：

```js
test("第 13 轮 · footer 无刷新钮（手动刷新与自动轮询冗余，2026-11-15 拍板移除）", () => {
  assert.equal(fx.panel.el.querySelector('[data-action="refresh"]'), null, "refresh 钮已移除");
  for (const action of ["holdings", "add", "settings"]) {
    assert.ok(fx.panel.el.querySelector(`[data-action="${action}"]`), `${action} 钮仍在`);
  }
});
```

  同时改 `tests/client-restyle.test.mjs` 65 行枚举 `["holdings", "add", "settings", "refresh"]` → `["holdings", "add", "settings"]`（该循环断言的是钮存在性，先行改枚举会让「refresh 钮存在」断言失败——把它并入本 Step 的红灯面）。两处改动都落在「当前 HEAD refresh 钮在」的前提上，红成立。
- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs" && node scripts/run-tests.mjs "tests/client-restyle.test.mjs"`
- Expected: 红 —— dom 新用例 `refresh 钮已移除` 失败；restyle 枚举循环失败
- [ ] Step 2: 运行并确认失败
- Run: 同上
- Expected: 上述两红
- [ ] Step 3: 写最小实现。`panel.mjs` 删 273 行 refreshBtn 构建与 275 行 append 中的 `refreshBtn`、350 行循环数组中的 `[refreshBtn, "list.refresh"]`；`i18n.mjs` 删 zh/en `"list.refresh"` 两行。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-dom.test.mjs" && node scripts/run-tests.mjs "tests/client-restyle.test.mjs" && node scripts/run-tests.mjs "tests/i18n.test.mjs"`
- Expected: 三文件全绿；`grep -cF "list.refresh" client/` → 0（注意：计数 0 即 exit 1，单独跑、不入 && 链）；计数 +1

### Task 8: 删除改区块内确认条（P1-4 前半，去原生 confirm）

- 目标：删除标的走与清除持仓同款的 danger 确认条；`confirmBox`/`window.confirm` 退役。
- 涉及文件：Modify `client/detail.mjs`（`confirmBox` 173-179 行、`removeSymbol` 319-323 行、`renderSkeleton` 869-879 行、`syncPendingStrip` 694-714 行）；Modify `tests/client-detail-r6.test.mjs`
- 接口契约
  - Consumes: Task 2 `detail.confirm.remove-ok`；Task 3 `skeleton.quoteLine`（插入锚点）；既有 `confirmStrip`（182-205 行）与 `pending` 会话态
  - Produces: `pending === "remove"` 分支；`removeSymbol(symbol)` 改名为语义明确的确认后动作（对 store 的调用签名不变：`store.removeSymbol(id)` → `{ok:true}` 后 `store.backToList()`）
- 验证范围：`node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs"`

- [ ] Step 1: 前置复核（评审 R3 实跑修正后的预期）：`grep -rn "window.confirm\|confirmBox" client/ tests/` 命中三类——① `client/detail.mjs` 两处（confirmBox 定义 173-179 + removeSymbol 调用 320，退役面）；② `client/backup.mjs:119-142`：设置页备份确认条的本地 DOM 变量名 `confirmBox`、className "skc-confirm"，与原生 confirm 无关，不在退役面；③ `tests/client-detail-r6.test.mjs` 的 confirm 桩（233-238，覆盖 overlap 流程，不动）。r6 测试在 `s.detail.el` 范围内查 `.skc-confirm`，与 backup 同名类不同容器，无碰撞。
- [ ] Step 2: 写失败测试。r6 追加（沿用其 `setup()`/`s.calls` 桩）：

```js
test("删除标的：区块内 danger 确认条，不弹原生窗口；确认才调 removeSymbol + backToList；取消不动", async () => {
  const s = setup();
  let nativeCalled = false;
  s.h.window.confirm = () => { nativeCalled = true; return true; };
  try {
    s.detail.update(snapshot());
    const del = s.detail.el.querySelector(".skc-detail-delete");
    del.click();
    await sleepMs(5);
    assert.equal(nativeCalled, false, "点删除不弹原生 confirm");
    assert.equal(s.calls.filter((c) => c[0] === "removeSymbol").length, 0, "确认前不提交");
    const strip = s.detail.el.querySelector(".skc-confirm");
    assert.ok(strip, "删除确认条在位（插在报价区之前）");
    const ok = [...strip.querySelectorAll("button")].find((b) => b.textContent === t("detail.confirm.remove-ok"));
    ok.click();
    await sleepMs(5);
    assert.deepEqual(s.calls.find((c) => c[0] === "removeSymbol"), ["removeSymbol", SYMBOL.id]);
    assert.deepEqual(s.calls.find((c) => c[0] === "backToList"), ["backToList"]);
  } finally { s.restore(); }
});

test("删除标的：取消即撤条，不调 removeSymbol", async () => {
  const s = setup();
  try {
    s.detail.update(snapshot());
    s.detail.el.querySelector(".skc-detail-delete").click();
    await sleepMs(5);
    const strip = s.detail.el.querySelector(".skc-confirm");
    const cancel = [...strip.querySelectorAll("button")].find((b) => b.textContent === t("detail.cancel"));
    cancel.click();
    await sleepMs(5);
    assert.equal(s.detail.el.querySelector(".skc-confirm"), null, "取消后确认条撤除");
    assert.equal(s.calls.filter((c) => c[0] === "removeSymbol").length, 0, "取消不提交");
  } finally { s.restore(); }
});
```

  （`t("detail.cancel")` 键已在位——zh「取消」/en「Cancel」，i18n.mjs 106/291 行。）

- Run: `node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs"`
- Expected: 两用例红（现实现点删除直接弹原生 confirm 并提交：`nativeCalled` 为 true、`removeSymbol` 已被调，红落在第一断言目标行）
- [ ] Step 3: 写最小实现：
  - 删 `confirmBox`（173-179 行）；`removeSymbol` 改造：改名 `performRemove(symbol)`（体内去掉 confirm 守卫，保留 `store.removeSymbol` + `backToList`）；删除钮 click 改为 `pending = "remove"; syncPendingStrip();`。
  - `syncPendingStrip` 增分支：`pending === "remove"` → `confirmStrip({ text: t("detail.confirm.remove", { name: symbol.name }), ok: t("detail.confirm.remove-ok"), danger: true, onOk: () => { pending = null; performRemove(symbol); } })`，宿主不是 form 而是 `el.insertBefore(strip, skeleton.quoteLine)`（`skeleton.quoteLine` 由 Task 3 提供；`live.strip = strip` 照旧）。
  - `renderSkeleton` 末尾（877 行 `paintQuoteLine()` 前）补：`if (pending === "remove" && !isIndex) { /* 复用 syncPendingStrip 的 remove 分支挂条 */ }` —— 注意**不可**在重建末尾无条件调 `syncPendingStrip()`（holdings/targets 的 pending 条由 `buildHoldingsPanel`/`buildTargetsPanel` 在构建时内联，会双挂）；只处理 remove 分支（remove 分段无关表单重建，重建场景仅语言切换/结构变化，保留 pending 重挂条）。
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-detail-r6.test.mjs" && node scripts/run-tests.mjs "tests/client-detail-fit.test.mjs"`
- Expected: r6 全绿（+2，含既有 overlap「不使用原生 confirm」用例不受扰）；fit 全绿；计数 +2

### Task 9: 删除撤销链（P1-4 后半：store 捕获 + toast action + 撤销钮）

- 目标：删除成功后 toast 带「撤销」6 秒；撤销经 `symbols/add` 同 id 复原。
- 涉及文件：Modify `client/store.mjs`（`removeSymbol` 174 行、`setToast` 263-270 行、return 表 296-304 行）、Modify `client/panel.mjs`（`patchToast` 333-339 行）、Modify `client/styles.mjs`（toast 区 325 行附近）、Modify `client/i18n.mjs`（`detail.confirm.remove` 文案改写）、Create `tests/client-undo.test.mjs`
- 接口契约
  - Consumes: Task 2 `toast.removed/undo/restored`；Task 7 已移除刷新钮（panel 文件无冲突）；既有 `mutate`/`api.add/remove`（client/store.mjs 171-174 行）与 slices 测试的 `stubFetch`/`createStorageStub`/`STATE_PAYLOAD` 桩法（`tests/client-store-slices.test.mjs` 16-55 行）；client-dom 的 panel 夹具
  - Produces:
    - `setToast(text, action?)`：`action = { kind: "undo-remove", label: string, ms?: number }`（可序列化，进快照）；默认定时语义不变（4000ms 定时 / 3800ms 守卫），带 action 时窗口取 `action.ms ?? 3800`（撤销用 6000）
    - `store.undoRemoveSymbol()`：无捕获 → 返回 `{ ok: false }`；有捕获 → `mutate((rev) => api.add(rec.market, rec.code, { quantity, avgCost, buyTarget, sellTarget }（null 兜底）, rev), { quiet: false })`，仅 `result?.ok === true` 时清捕获并 `setToast(t("toast.restored", { name }))`；失败（`{ok:false}`，mutate 从不抛错）不清捕获，捕获保留（op-failed/conflict toast 由 mutate 的 quiet:false 分支承担）
    - toast DOM：`.skc-toast` 内文本节点 + 可选 `button.skc-btn.skc-btn-text.skc-toast-action`（label = `toast.action.label`，click 仅响应 `kind === "undo-remove"` → `store.undoRemoveSymbol()`）
- 验证范围：`node scripts/run-tests.mjs "tests/client-undo.test.mjs"`

- [ ] Step 1: 写失败测试。新建 `tests/client-undo.test.mjs`（头部注释写明桩法来源）：

```js
// 桩法 Consumes tests/client-store-slices.test.mjs：globalThis.fetch 按前缀路由 + storage stub +
// node:test mock.timers 停表（setToast 定时器）。mutate 是异步串行链——所有断言前 await。
test("removeSymbol 成功 → toast 带 undo-remove action（6s）+ 捕获记录", async () => {
  // stub /stock-kanban/symbols/remove → { ok: true }（其余路由照 slices STATE_PAYLOAD）
  // store.removeSymbol("s1") 后：getState().toast.text === t("toast.removed", { name: "贵州茅台" })
  // 对照分支：remove 路由返回错误（fetch 非 ok）→ result.ok=false，不置捕获、toast 为 op-failed 且 action 为空
  //   toast.action 深等 { kind: "undo-remove", label: t("toast.undo"), ms: 6000 }
});

test("undoRemoveSymbol → 以相同 market+code 调 symbols/add（patch 带回四字段），成功清捕获 + restored toast", async () => {
  // remove 前 state 里 s1 带 quantity/avgCost/buyTarget/sellTarget
  // undo 后断言 fetch 收到的 add body：market/code/patch 四字段与原值一致
  // getState().toast.text === t("toast.restored", { name: ... })；再次 undoRemoveSymbol() → { ok: false }
});

test("undo 失败（add 返回错误）→ op-failed toast，捕获保留可重试（再删再撤仍可用）", async () => {
  // add 路由返回 { error: "x" } 或 fetch 非 ok（照 slices 对失败路径的既有桩法）
});

test("setToast 默认窗口仍 3800/4000（例⑦语义不回归）；action.ms=6000 时窗口 6000", () => {
  // mock.timers 推进断言两段
});

test("panel patchToast：action toast 渲染撤销钮；点击调 store.undoRemoveSymbol；无 action 无钮", () => {
  // createPanel 桩 views（client-dom 夹具形态）；store 桩记录 undoRemoveSymbol 调用
  // panel.update({ ...snapshot, toast: { text: "x", at: 1, action: { kind: "undo-remove", label: "撤销" } } })
  // 断言 .skc-toast-action 文本 "撤销"；click 后桩被调；再 update toast:null → 钮不在
});
```

- Run: `node scripts/run-tests.mjs "tests/client-undo.test.mjs"`
- Expected: 红 —— `store.undoRemoveSymbol` 不存在（TypeError）/ toast 无 action 字段，红落目标断言
- [ ] Step 2: 运行并确认失败
- Run: `node scripts/run-tests.mjs "tests/client-undo.test.mjs"`
- Expected: 上述红
- [ ] Step 3: 写最小实现：
  - `store.mjs`：闭包 `let lastRemoved = null;`；`removeSymbol` 改为先查 `const rec = state.business?.symbols?.find((s) => s.id === id) ?? null;` 再走原 mutate；成功（`result?.ok === true`——mutate 从不抛错，内部 try/catch 返回 `{ok:false,…}`）后 `lastRemoved = rec; setToast(t("toast.removed", { name: rec.name }), { kind: "undo-remove", label: t("toast.undo"), ms: 6000 });`（rec 为 null 时仅原 toast 语义不附加 action——实际不会发生，防御分支）。注意原 `removeSymbol` 的 mutate 未传 `{quiet}`（默认非 quiet），保持。
  - `undoRemoveSymbol` 与 `setToast` 签名按上方契约实现；return 表加 `undoRemoveSymbol`。
  - `panel.mjs` `patchToast`：`t` 变化时 `toast.replaceChildren(doc.createTextNode(t.text))` + action 钮构建（契约见 Produces）；`t` 为 null 时 `toast.replaceChildren()`。引用比对（`prevToast`）语义不变。
  - `styles.mjs` toast 区追加：`.skc-toast-action{min-height:24px;margin-left:8px}`（基类 `.skc-btn .skc-btn-text` 提供边框/字重）。
  - `i18n.mjs`：`"detail.confirm.remove"` zh 改 `"删除「{name}」？持仓与目标价一并移除，删除后可短暂撤销。"`；en 改 `"Remove “{name}”? Position and targets go with it — you can undo briefly afterwards."`
- [ ] Step 4: 运行并确认通过
- Run: `node scripts/run-tests.mjs "tests/client-undo.test.mjs" && node scripts/run-tests.mjs "tests/client-store-slices.test.mjs" && node scripts/run-tests.mjs "tests/i18n.test.mjs"`
- Expected: undo 文件 5 用例全绿（+5）；slices 全绿（toast 引用切片语义未变）；i18n 全绿（copy 改写未破 pins）；计数 +5

### Task 10: 文档归档 + 构建 + 全量验证

- 目标：第 13 轮记录入库、产物重建、实拍复核、全量绿。
- 涉及文件：Modify `docs/ui-redesign.md`、`docs/verification.md`；Build `lib/client.js`
- 接口契约
  - Consumes: Task 1-9 全部产出；`scripts/cdp-shot.mjs` 头注纪律
  - Produces: 无（收尾）
- 验证范围：见最终验证

- [ ] Step 1: `docs/ui-redesign.md` 末尾追加 `### 8.17 第 13 轮：详情 hero 左对齐数据栈 + 底部空白/触控/删除撤销（2026-11-15）`：改动清单（方向 A 结构、chg 涨跌额、新鲜度收敛、tooltip 降级、≤520 is-off display:none、40px 热区、刷新钮退役、删除确认条 + 6 秒撤销、CHART_H 实测值）、居中轴退役说明（§12.54 裁决被主人 2026-11-15 拍板推翻；styles.mjs:185 旧注释节号笔误 §12.53 随本轮重写一并更正）、验证小节（数字执行时回填真实值）。
- [ ] Step 2: `docs/verification.md` 末尾追加 `## 12.55 详情排版第 13 轮（hero 左对齐 / 底部空白 / 触控 / 删除撤销）`，字段：改动清单、CHART_H 实测值（zh/en）、测试计数 N₀ → N₁、实拍产物路径（`/tmp/skc-preview/out/r13-*`）、遗留项（quote error 长文案在 28px hero 的形态未改；恢复标的 sort 落组尾；涨跌色保持全局红涨为主人 2026-11-15 拍板、评审 P1-3 不做；刷新钮移除后手动刷新 = 切市场/重开面板触发 restartPolling）。
- [ ] Step 3: 构建 + 全量：
- Run: `test -d node_modules && npm run build && npm test`
- Expected: build 成功（`lib/client.js` 更新、构建脚本注入断言过）；全量 N₀ + 16 全绿
- [ ] Step 4: 实拍复核（cdp-shot，zh/en + 390 视口 sheet 各一张，`/tmp/skc-preview/out/r13-*`）：
  - hero 左对齐：价格行「64,486.70 −2,885.40 −4.27%」左轴共线；meta 行「14:23:15 · OKX」单行
  - 390 sheet：目标价段切走后无死白；持仓段与 footer 间无半屏空白
  - 删除流：点删除出现红边确认条（无原生弹窗）；撤销钮在 toast 内
- Expected: 三图符合上述描述；异常即停，回改对应任务后重跑

## 执行纪律

- 开始实现前批判性复查整份计划；发现缺项/矛盾/失效锚点先修计划再动手。
- 首次改 UI 文件前读 craft-floor（路径见全局约束）。
- 按任务顺序执行，不无声跳步/合并/换目标；每任务跑完其定义的验证再前进。
- **红前提逐任务重查**：每合并一步，后续任务的红灯断言必须仍对「当前 HEAD」成立；不可能红时改为「新标记的字符串/位置断言」，不硬凑红（agent-ops 判据纪律）。
- 遇阻（锚点漂移、测试计数对不上、夹具假绿）立即停下说明，不猜。
- 判据命令按最终形态跑；`grep -c` 为 0 时 exit 1，单独跑不串 &&。
- 默认不提交，工作区留给主人验核；主人明示后才按任务边界 commit。
- 不 bump、不发版、不动 `docs/plans` 之外的归档结构。

## 最终验证

- 前置：`test -d node_modules`（缺则 `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban npm ci`）；无 headless chrome 进程残留。
- Run: `npm run build && npm test`
- Expected: build 成功；全量 **N₀ + 16** 全绿（N₀ 为执行起点实跑基线，预期 441，则 457；以实跑为准，逐任务计数账见「文件结构与职责」末）。
- 判据抽查（逐条单独跑，失败即停）：
  - `grep -cF "skc-quote-move" client/styles.mjs client/detail.mjs` → 两文件各 ≥1
  - `grep -cF "skc-quote-chg" client/styles.mjs client/detail.mjs` → 各 ≥1
  - `grep -cF "changeAmount" client/detail.mjs` → ≥1（hero 直用上游口径，评审 F-2 双保险判据）
  - `grep -cF "text-align:center;margin:10px 0 12px" client/styles.mjs` → 0（旧居中串已退役；exit 1 属预期，不视为命令失败）
  - `grep -cF "detail.quote-time" client/` 递归 → 0；`grep -cF "list.refresh" client/` → 0
  - `grep -cF "undoRemoveSymbol" client/store.mjs client/panel.mjs` → 各 ≥1
  - `grep -cF "确认删除" client/i18n.mjs` → ≥1（zh 键在；lib 内转义形态判据不适用——此步查源码）
- 实拍：`scripts/cdp-shot.mjs` 产物 `r13-*` 三张符合 Task 10 Step 4 描述。

## 审阅 Checkpoint

- 计划正文到此结束。请主人审阅；通过后交普通编码 agent 或人工按任务序执行。审阅通过前不进入实现。
