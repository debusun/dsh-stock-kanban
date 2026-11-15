# 详情图表 resize 重画闸（ADR-0004 遗留收口）实施计划

## 目标

- 终结 `client/detail.mjs` 的 resize 节点构建放大器：现状 `onWinResize` 每事件直调 `paintChartArea()`，整棵图表 SVG 全量重建（日 K 180 根 ≈ 540+ 节点/次，ADR-0004 自家口径），窗口拖拽期间 resize 事件 30-60 次/秒 → 1.6 万-3.2 万节点构建/秒 + 每事件一次 `clientWidth` 布局读。闸门化后节点构建放大器终结；守卫自身保留每事件一次 `clientWidth` 读（无样式失效时有布局缓存，量级远低于整图重建——此保留项在 §12.58 如实登记）。ADR-0004 已将此项列为「已知遗留（另行安排）」，本战役兑付该欠票。
- 闸门形状（grill 三轮 13 决策定案，2026-11-16）：**二元组守卫**（`(chartWidth(), chartHeight(viewportHeight()))` 全等 → 零调度）+ **rAF 同帧合并** + **150ms 最小间隔节流**（leading 下一帧即绘、窗口内静默、trailing 必绘兜底终态）。
- 记账随权威走：守卫二元组在 `buildChartBox` 内统一记录（覆盖 `renderSkeleton` 直调路径）。
- 测试：`tests/client-detail-fit.test.mjs` 现有两测适配 + 四条新契约钉（同帧合并 ≤1 / 守卫 0 次 / 节流窗合并+终态 / dispose 静默）。
- 落档：`docs/verification.md` §12.58 追记 + ADR-0004 已知遗留行加一行修订注记。GLOSSARY 不动（闸门是实现细节非领域概念）；无新 ADR。
- 明确非目标：panel `placePanel`×2 双触发与 capsule `clampHostToViewport` 不动（登记 §12.58 观察项）；不抽共享 rAF 助手（capsule/detail 各自内联，第三个用户出现再抽）；不发版（fix 提交攒批，随下次 chore(release) 随行）；`detail.mjs:180` 注释对 §12.57 的「§12.58」误引不改（不在本 seam）。

## 架构快照

- 现状调用面（改前事实底账）：
  - `onWinResize`（detail.mjs `窗口高度变化` 注释块，现 L935-939）：守卫 `disposed/panelOpen/view==='detail'/symbolOf()` 后直调 `paintChartArea()`，无节流无合并。
  - `paintChartArea()`（现 L687-695）：`buildChartBox()` 新建盒 → `skeleton.chartBox.replaceWith(fresh)` → 换引用。调用方六处：`refreshChart` 数据到达（L141）、`loadChart` 成功/失败（L168/L173）、周期 Tab 点击（L837）、resize（L937）、`maVisible` 变化（L985）。
  - `buildChartBox()`（现 L343-384）：唯一图表盒构建 choke point，四种态（closed-minute 占位 / loading 骨架 / error / 分时或K线 SVG）；`renderSkeleton`（L858）直调它建骨架内首盒。盒高 `chartHeight(viewportHeight())` 恒定三态同高；SVG 宽 `chartWidth()` 钳位 [240,400]、读 `el.clientWidth - 14`。
  - `chartHeight(vh)`（L36 起）：clamp(视口 − 固定区, 140, 230) 阶梯。
  - `dispose()`（现 L989-994）：摘 resize 监听 + 清空 DOM。
- 本次改动后的形状：
  - `createDetail({ store, win, resizeThrottleMs = 150 })` 新增第三可选项（缺省 150；0 = 关节流只留 rAF 合并——测试注入面，生产行为由缺省值保证）。
  - `buildChartBox` 末尾记录 `lastBoxDims = { w: chartWidth(), h: chartHeight(viewportHeight()) }`（单一记账点）。
  - `paintChartArea` 首尾两件事：清 pending（`clearTimeout` trailing + 撤 rAF 标记）与刷新 `lastPaintAt = Date.now()`——直调路径（周期切换/数据到达/maVisible）真绘后，挂着的尾绘被取消（grill Q10-A），节流钟同步刷新（否则直调后 150ms 内的合法 resize 会被误延迟）。
  - resize 回调三级早退：既有四条件守卫 → 二元组全等守卫（不调度）→ `scheduleRepaint()`。调度：rAF 承载同帧合并（一帧至多一次回调），回调内 `Date.now() - lastPaintAt >= resizeThrottleMs` 即绘；否则武装 trailing `setTimeout(差值)`，触发时先复查守卫（回到原值零绘）再绘。rAF 缺席环境（宿主无 window）内联 capsule 同款回退（capsule.mjs L79-80 `scheduleFrame` 形态）：立即同步执行——该环境无 resize 风暴，回退无实害。
  - `dispose()` 增清 trailing 定时器与 rAF 句柄（有 `cancelAnimationFrame` 则撤）；pending 回调自带 `disposed` 早退。
- 为什么不改 SVG 形态（无 viewBox/CSS 缩放路线）：charts.mjs 用显式 px 宽高属性，CSS 缩放会让文字/刻度糊化，且改动面扩到 charts.mjs 两个构建器——超出本 seam，违背「一步动一处」。

## 全局约束

- 运行时零 npm 依赖不动；devDeps（esbuild、jsdom）不动。
- `npm test` 保持全离线：fit 夹具 fetch stub 既有，新钉不触网。
- 本战役 `lib/client.js` **必有 diff**（客户端改动——注意与行情链计划的零 diff 约束相反）；改 `client/` 后必跑 `npm run build`（esbuild 打包 + 版本注入断言自带）。
- 单测勿钉随真实时钟漂移的状态值：新钉全部在图表数据到达后测（夹具 MINUTE_POINTS 30 点 >1，`closedMinute` 分支自然短路，不受休市时钟影响）；节流值经 `resizeThrottleMs` 注入（0 / 40ms 小值），不真等 150ms 墙钟。
- 守卫二元组的宽度分量在 jsdom 不可测（`el.clientWidth` 恒 0 → `chartWidth()` 恒走 280 回退，评审探针实证）：四钉只覆盖高度分量；宽度分量覆盖缺口在 §12.58 登记为已知事实（`Object.defineProperty` 造宽度变化的增强默认不做，不为此扩测）。
- 文件编辑前必先 read 同一文件；文件读写走 ops 工具，构建/测试/git 走 bash；`grep -c` 计 0 即 exit 1，禁入 `&&` 链。
- build/test 前 `test -d node_modules`，缺失先 `npm ci`（联网 npm 命令加 `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban`）；确认无 headless chrome（chrome-cft）进程。
- 渲染层改动按仓规跑实页取证：chrome 一律后台起跑（`scripts/cdp-shot.mjs` 头注纪律）；headless 在默认沙箱起不来时按 §12.57 同款「未验证降级」如实登记，不冒充已验证。
- 发版纪律：本战役只提 fix 提交（信息不含版本号），**不 bump、不发版**（攒批）；仓库惯例 main 直推，开始实现前与主人确认一次。
- 验证记录新编号取 `docs/verification.md` 末尾 §12.57 的下一个：**§12.58**（已核，末尾为 §12.57 v0.3.8 追记）。
- Node ≥20；bash（Linux）；仓库 `/home/ubuntu/workspace/dsh-stock-kanban`。

## 输入工件

- grill-with-docs 三轮共识（2026-11-16）：R1 Q1-Q7（节流形态 B / 二元组守卫 / buildChartBox 记账 / 内联回退 / 契约迁移三钉 / 单 seam 范围 / §12.58+ADR 注记+攒批+实拍）；R2 Q8-Q11（leading 即绘 + 150ms / rAF+时间戳+setTimeout 载体与注入 / 直调清 pending / 探针计数验收口径）；R3 Q12-Q13（writing-plans 入库 / 测试并入 fit 文件）。
- 性能审计底账（2026-11-16 两路子代理 + 主代理复核）：resize 放大器为全客户端剩余最大 DOM 放大器（量化与裁决见对话；ADR-0004 L33 已列遗留）；panel `placePanel`×2 与 capsule 钳位为亚毫秒机制性摩擦，登记不动。
- 夹具事实：`tests/client-detail-fit.test.mjs` `setupDetail({ height, lang, injectWin })` 形态、`h.setViewport(w, 1100, h)`、`chartH()` 读 `.skc-chart` height 属性、`sleepMs(10)` 等数据到达；dom-harness `pretendToBeVisual: true` 提供真 rAF。
- capsule rAF 回退原文位置：capsule.mjs L79-80 `scheduleFrame`。

## 文件结构与职责

- Modify: `client/detail.mjs` —— 闸门全部实现（选项参数 / lastBoxDims 记账 / paintChartArea 清 pending + 刷节流钟 / onWinResize 守卫 + scheduleRepaint / dispose 清理）。单文件单 seam，其余文件零改动。
- Modify: `tests/client-detail-fit.test.mjs` —— 现有两测适配（Task 1）+ 四条新钉与 `rafFlush`/盒重建计数助手（Task 2）。
- Build 产物: `lib/client.js`（`npm run build` 生成，不手改）。
- Modify: `docs/verification.md` —— 末尾追记 §12.58（Task 6）。
- Modify: `docs/adr/0004-render-slice-broadcast-and-live-patch.md` —— 已知遗留行（L33）尾加一行修订注记（Task 6）。
- 不动：`client/panel.mjs`、`client/capsule.mjs`、`client/charts.mjs`、`GLOSSARY.md`、i18n 字典、`src/**`。

## 任务清单

### Task 1: fit 现有两测适配（frame flush + 节流 0 注入）

- 目标：闸门化前置条件——现有两条 resize 测试从「dispatch 后同步断言」改为「flush 一帧后断言」，语义断言不变。
- 涉及文件：`tests/client-detail-fit.test.mjs`。
- 接口契约：
  - 新增夹具参数：`setupDetail({ height, lang, injectWin, resizeThrottleMs = 0 })` 透传 `createDetail({ store, win, resizeThrottleMs })`（injectWin 分支同传）。
  - 新增助手 `rafFlush(h)`：`new Promise((r) => h.window.requestAnimationFrame(() => r()))`。
  - 「窗口高度变化」测：dispatch 后 `await rafFlush(s.h)` 再断言 `chartH() === 140`。
  - 「编辑中 resize」测：同上加 flush；输入框身份断言不变。
- 步骤：
  1. read `tests/client-detail-fit.test.mjs` 全文；改造 `setupDetail` 与两测。
  2. `node scripts/run-tests.mjs tests/client-detail-fit.test.mjs` —— 预期**全绿**（现状无闸，dispatch 同步已绘，flush 后 identity 稳定；本任务是适配不是红驱动）。
- 验证：同上命令全绿；`git diff` 仅该测试文件。

### Task 2: 四条新契约钉（红 ×3 + 回归钉 ×1）

- 目标：把闸门行为钉死——同帧合并、守卫零绘、节流窗合并+终态、dispose 静默。
- 涉及文件：`tests/client-detail-fit.test.mjs`。
- 接口契约：
  - 盒重建计数助手：`countBoxRebuilds(detail, h)` 必须用 **`h.window.MutationObserver`**（Node 全局无此构造器，评审实测 `undefined`，裸用必 ReferenceError）观察 `detail.el`（`childList + subtree`），只计 added 节点中 `classList.contains("skc-chartbox")` 的替换；返回 `flush()` 收数函数。收数在 microtask 边界即达（评审实测：同步读 0 → 宏任务边界即满），断言前 `await sleepMs(5)` 充分。
  - 钉 1（同帧合并，红）：`resizeThrottleMs: 0`、**setup height 680（成图 181 档）**；数据到达后 `setViewport(1100, 520)`（140 档）改高一次，随即连发 5 次 `dispatchEvent(resize)`（保持 520 高度）→ `await rafFlush` + `await sleepMs(5)` → 重建计数 **=== 1**、`chartH() === 140`。（现状：每事件同步重建 → 计数 5 → 红，评审探针复现。）**数值钉死**：setup 档与变更档必须互异——同档（如 520↔630 双 140）时正确实现的守卫全程零调度，计数 0≠1 钉永红。
  - 钉 2（守卫零绘，红）：`resizeThrottleMs: 0`；**计数器在图表数据到达后安装**（评审实测：装在 load 前会把骨架+数据到达共 2 次重建计入——现状即 7=2+5，闸门正确实现后恒 2≠0 永红）；装好后**不改** `setViewport`，连发 5 次 resize → flush → 计数 **=== 0** 且 `.skc-chartbox` 节点引用不变。（现状：计数 5 → 红。）
  - 钉 3（节流窗合并 + 终态 + leading，红）：`resizeThrottleMs: 40`、**setup height 720（成图 221 档）**；数据到达后 `setViewport(1100, 520)`（140 档）+ 连发 4 次 resize（**间隔 `sleepMs(2)`**——评审实测 5ms 间隔 burst ≈24ms、对 40ms 窗余量仅 ~16ms，慢机定时器拉伸会假红；2ms 间隔 burst ≈10ms、余量 ~30ms），第 4 次后 `setViewport(1100, 680)`（181 档）再发 1 次 → `await sleepMs(80)` → 计数 **=== 1** 且 `chartH() === 181`（680 档终值；窗口后补绘经 trailing 或后续 rAF，两路径终态同值，不作机制区分断言）；随后 `setViewport(1100, 600)`（140 档）+ 发 1 次 → `await sleepMs(40)` → 累计计数 **=== 2**（距上绘 >40ms，leading 即绘）。（现状：计数 5-6 → 红，评审按此数值序列探针复现 5→6。）**数值钉死**：221/140/181/140 在每个断言点互异，任何相邻两步都是真实尺寸变化。
  - 钉 4（dispose 静默，回归钉）：`resizeThrottleMs: 0`，`setViewport` 改高 + 发 1 次 resize 后**立即** `detail.dispose()` → `await sleepMs(50)` → 进程无异常、`document` 内无 `.skc-chartbox`。（现状同步实现下本钉即绿——回归防护，防闸门化后 pending 回调炸尸。）
- 步骤：
  1. read 该测试文件（Task 1 后版本）；加助手与四钉。
  2. `node scripts/run-tests.mjs tests/client-detail-fit.test.mjs` —— 预期钉 1/2/3 红、钉 4 绿、既有全绿。
- 验证：红绿形态与上逐条一致；`git diff` 仅测试文件。

### Task 3: detail.mjs 闸门实现（绿）

- 目标：实现「架构快照」所述闸门，令 Task 2 四钉全绿、既有套件不回归。
- 涉及文件：`client/detail.mjs`。
- 接口契约（模块内私有状态组）：
  - `createDetail({ store, win, resizeThrottleMs = 150 })`；`const w = () => winRef()`。
  - `let lastBoxDims = { w: 0, h: 0 }`——`buildChartBox` 返回前 `lastBoxDims = { w: chartWidth(), h: chartHeight(viewportHeight()) }`（唯一记账点）。
  - `let lastPaintAt = 0`、`let rafPending = false`、`let rafHandle = null`（rAF 句柄——撤句柄路径依赖它，缺变量则成死代码）、`let trailingTimer = null`。
  - `paintChartArea()` 首部：`clearPendingRepaint(); lastPaintAt = Date.now();`（`clearPendingRepaint` = 有 timer 则 `w()?.clearTimeout(trailingTimer)` 并置 null、`rafPending = false`；`rafHandle` 非 null 且 `w()?.cancelAnimationFrame` 存在则撤并置 null）。函数体其余不变。
  - `scheduleRepaint()`：`rafPending` 为真直接返回；置真后经 capsule 同款回退调度 `w()?.requestAnimationFrame`（缺 rAF 或缺 window 则同步执行回调）；回调：置 `rafPending = false`，`disposed` 早退；`Date.now() - lastPaintAt >= resizeThrottleMs` → `repaintIfDimsChanged()`；否则**先清旧 timer 再武装**（`w()?.clearTimeout(trailingTimer)`——同窗内第二次进该分支不得覆盖句柄泄漏旧 timer）：`trailingTimer = w().setTimeout(差值, () => { trailingTimer = null; if (disposed) return; repaintIfDimsChanged(); })`（回调 `disposed` 早退与 rAF 回调对齐）。
  - `repaintIfDimsChanged()`：重读二元组，与 `lastBoxDims` 全等返回；否则 `paintChartArea()`。
  - `onWinResize`：既有四条件守卫后重读二元组，与 `lastBoxDims` 全等返回；否则 `scheduleRepaint()`。
  - `dispose()`：既有两行后加 `clearPendingRepaint()`。
- 步骤：
  1. read `client/detail.mjs` 相关段（L36-60、L115-180、L337-384、L660-700、L826-870、L930-997）后落实现。
  2. `node scripts/run-tests.mjs tests/client-detail-fit.test.mjs` —— 全绿。
  3. `npm test` —— 全套绿（重点盯 client-render-identity / client-dom / client-restyle / client-detail-hero / client-detail-r6 无回归）。
- 验证：两条命令全绿；`git diff` 仅 detail.mjs 与（Task 1/2 已改的）测试文件。

### Task 4: 构建 + 产物核证

- 目标：`lib/client.js` 重建并核证闸门逻辑入包。
- 步骤：
  1. `test -d node_modules && npm run build`。
  2. 产物判据（minify 免疫口径，AGENTS 纪律）：先 read `scripts/build-client.mjs` 确认 minify 配置（是否 mangle-props），再定判据——对象键 `resizeThrottleMs` 在默认配置下应可 `grep -cF` 命中；若配置会混淆键名，则改用构建后产物中稳定存在的 ASCII 字面量（如节流默认值旁的字符串/数值形态）或 `git diff lib/client.js` 人工核证替代，**先查证再定判据，不硬凑**。
  3. `git diff --stat` 确认 `lib/client.js` 在变更列表。
- 验证：build 自带版本注入断言过；上述判据成立。

### Task 5: 实页基线取证 + 改造后降级登记（cdp，chrome 后台起跑）

- 目标：实页证据分两侧收口。**约束事实**（§12.57 主人指令）：本机插件已切 npm 远端安装、不再热部署覆盖产物；本战役攒批不发版 → 改造后产物在发版 + `dshm_upgrade` 前上不了实页。故本轮只做**基线侧**实页取证，改造后侧以 jsdom 四钉为准并如实登记降级，发版后补验。
- 步骤：
  1. `pgrep -f chrome-cft || true` 确认无残留；headless chrome 后台起跑（纪律见 `scripts/cdp-shot.mjs` 头注；§12.57 实录默认沙箱 /dev/shm 权限可能拒绝）。
  2. 探针脚本（scratch 放 `.dsh-research/`，不入库）。四个可达性前置（评审 R1-06 开题，全部采纳）：① **视图态**——实页须处于「面板开 + detail 视图 + 有选中标的」（onWinResize 四条件守卫，不满足则计数恒 0、误判闸门失效），导航编排复用 cdp-shot 既有契约（capsule Enter 开面板 → 行点击入 detail）；② **shadow DOM**——图表盒在浮动壳 shadow root 内，MutationObserver 挂 shadowRoot 内层节点而非 document；③ **盘中数据刷新加计**——refreshChart 60s 静默刷新会额外触发 paintChartArea（crypto 7×24 恒开市），30 次 dispatch 在 <1s 内完成、至多相遇一次，基线计数写容差 [29, 31]；④ **纯事件即可、不阶梯**——evaluate 派发 resize 改不了真实 innerHeight，而 v0.3.8 无守卫、每事件无条件重建，30 次纯 dispatch 即成立（原「视口高度阶梯」表述删除；实页测守卫语义须 CDP Emulation.setDeviceMetricsOverride，非本战役范围）。对已装 v0.3.8 实页挂 MutationObserver 计 `.skc-chartbox` 重建 → evaluate 连发 30 次 `resize` → 收计数，输出落盘 log。
  3. 基线口径：v0.3.8（无闸）计数应为 30、容差 [29, 31]（容差来源见前置③）——放大器存在的实页实证。评审已核 v0.3.8..HEAD 工作树对 client/ 零差异：已装实页行为即仓库 onWinResize 直调行为。
  4. **改造后计数（≤3）本轮不做**（产物不可达实页，不违规热部署）：§12.58 如实登记「未验证降级——待下次发版 `dshm_upgrade` 后补录追记」；jsdom 四钉（合并 ≤1 / 守卫 0 / 节流窗 1+leading / dispose 静默）为改造后行为判据。
  5. chrome 起不来：基线侧也降级登记（§12.57 同款），jsdom 钉为准，不冒充已验证。
- 验证：基线数字或其降级记录落 §12.58；改造后补验义务在 §12.58 白纸黑字；探针脚本留 scratch 不入库。

### Task 6: 文档落档

- 目标：§12.58 追记 + ADR-0004 修订注记。
- 涉及文件：`docs/verification.md`、`docs/adr/0004-render-slice-broadcast-and-live-patch.md`。
- 接口契约：
  - `docs/verification.md` 末尾新节 `## 12.58 详情图表 resize 重画闸（ADR-0004 遗留收口，未发版攒批）`：背景（放大器量化 + ADR-0004 L33 出处）、闸门形状（13 决策摘要）、实现与测试证据（四钉 + 全套绿 + build 判据）、实页探针结果或降级、**观察项登记**（panel `placePanel`×2 / capsule `clampHostToViewport` 亚毫秒摩擦；capsule/detail 两处 rAF 回退待第三个用户再抽）、**误引注记**（`detail.mjs:180` 代码注释「§12.58」实指 §12.57 的确认条内容——本战役不改该注释，但 §12.58 落档后此误引会新增指向歧义，注记一句、留待发版后顺手修正）。
  - ADR-0004 L33 已知遗留行尾追加：`（修订追记 2026-11-16：resize 闸已收口——rAF 合并 + 150ms 节流 + 二元组守卫，见 §12.58）`——单行注记，不改其余正文（ADR-0003「第 N 条修订」同款先例）。
- 步骤：read 两文件尾部/目标行 → 落笔。
- 验证：`git diff` 仅两文档；§编号与末尾+1 规则一致。

### Task 7: 全套回归 + fix 提交

- 目标：收口。
- 步骤：
  1. `npm test` 全绿。
  2. `git add client/detail.mjs tests/client-detail-fit.test.mjs lib/client.js docs/verification.md docs/adr/0004-render-slice-broadcast-and-live-patch.md docs/plans/2026-11-16-detail-resize-repaint-gate-implementation-plan.md`。
  3. fix 提交，信息形态对齐仓例：`fix(client): 详情图表 resize 重画闸——rAF 合并 + 150ms 节流 + (宽,高)二元组守卫，终结每事件整图 SVG 重建（ADR-0004 遗留收口/§12.58）`（正文可附量化：540+ 节点 × 30-60 事件/秒 → ≤ 节流窗率；四钉与实拍/降级见 §12.58）。
  4. **不 bump、不发版**（攒批）；是否推送 main 与主人确认。
- 验证：`git status` 净、`git log -1` 形态对齐；全套测试最终态绿。

## 执行纪律

- 开始实现前，先批判性复查整份计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划再动。
- 按任务顺序执行，不无声跳步、合并步或改变任务目标。
- 每完成一个任务，运行该任务定义的验证；红绿形态与计划不符时停下说明，不猜。
- 文件编辑前必先 read 同一文件（bash 改动过、跨轮次后续轮一律重读）。
- 遇阻塞、重复失败或计划与仓库现实不符，立即停下说明。
- 当前在 main：开始实现前与主人确认一次（仓库惯例 main 直推）。

## 最终验证

1. `node scripts/run-tests.mjs tests/client-detail-fit.test.mjs` 全绿（含四新钉）。
2. `npm test` 全套绿（零回归）。
3. `npm run build` 成功且 `lib/client.js` 含闸门判据标记、在 `git diff --stat` 内。
4. `docs/verification.md` §12.58 在末尾、ADR-0004 L33 带修订注记。
5. 实页基线计数 30（容差 [29,31]）落 §12.58（或 chrome 不可用的降级记录）；改造后实页计数登记为发版后补验（不冒充已验证）。
6. fix 提交在库、工作区净、未发版。
