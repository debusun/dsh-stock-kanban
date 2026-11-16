# 涨跌语义三档切换 实施计划

## 目标

- 落地 ADR-0009：涨跌配色三档可切换（红涨绿跌 / 红跌绿涨 / 原生语义），默认红涨绿跌，设置存 DSH 实例服务端 settings，设置对话框新增「涨跌配色」radio 组（每行内嵌真实预览），涨跌幅字段加 ▲▼ 方向符号。
- 全部语义色面（胶囊/列表行/持仓盈亏/详情 hero/B/S 标记徽章/分时/K 线）跟随档位即时换向，平盘恒中性灰，危险/警告/额度色不动。

## 架构快照

- **语义模型（单一权威）**：`trendColorMode ∈ "red-up" | "green-up" | "native"`，服务端 `src/model.mjs` 持有常量与规范化函数（客户端已习惯 import src/ 纯函数，如 portfolio/sessions，方向合法）。默认 `"red-up"` = 现状。
- **翻向机制（两层）**：
  1. red-up / green-up 两档：DOM 与 SVG 全部消费点不变，仅由 `main.mjs` 在渲染时把 `--skc-up/--skc-down` 两个自定义属性写到 float root 内联 style（`trendModeVars(mode)` 产值）——类名 `.skc-up/.skc-down/.skc-mark-*/.skc-badge-*` 与图表 `style="…:var(--skc-up)"` 自动跟随。
  2. native 档：同屏不同市场不同向，全局单值变量不够 → `trendClass(v, market, mode)` 按市场返回分支类（cn → `skc-up-cn/skc-down-cn`，非 cn → `skc-up-g/skc-down-g`，g = international）；物理色对 `--skc-red/--skc-green` 新增变量承载，B/S 用追加 side 类（`skc-side-cn/skc-side-g`）覆盖配色。
- **SVG 图表**：UP/DOWN 模块常量退役，stroke/fill 改走 style 属性 + `var()` 引用（仓内先例 AXIS_TEXT_STYLE，charts.mjs:19-22「SVG 表现属性吃不到 var()，走 style 属性」），量柱 rgba 字面量改 `color-mix(in srgb, var(…) N%, transparent)` 配方。
- **▲▼**：新纯函数 `fmtTrendPct(v)`（= 方向符号 + 既有 `fmtPct`），仅用于三处涨跌幅字段；`fmtPct` 原样保留给持仓盈亏幅（Q11 边界）。
- **设置写入**：客户端 `api.setSettings` 已存在（api.mjs:41）；settings 路由（routes.mjs:263-268）patch 白名单加 `trendColorMode`；rev 自增既有广播管道触发 structural 全量重渲染 + 图表重画，无需新增门控（list.mjs:462 的 business 变化分支已覆盖）。
- **原生档前提**：四市场 Tab 单市场过滤（list.mjs:445-446），同屏不混色（ADR-0009 决定 9）。

## 全局约束（继承自仓库 AGENTS.md，逐字执行）

- 改 `client/` 后必跑 `npm run build`（esbuild 产 `lib/client.js`；pre-push 产物新鲜度 build+diff 闸）。
- i18n 为 zh/en 双字典，parity 与键位对齐有守卫测试——新文案两字典同步加。
- build/test 前 `test -d node_modules`，缺失先恢复依赖：`npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban npm ci`；跑 npm test 前确认无 headless chrome：`pgrep -f '[c]hrome-cft'`（空输出即干净）。
- 渲染层改动后跑 `scripts/cdp-shot.mjs`（纪律见其头注：chrome 一律后台起跑、假活 `--down` 重启、重活前进程清零）。
- 类名缝教训：新类名必须与样式表逐字一致（前科 sk-up vs `.skc-up` 致功能静默失效）；产物核证探针优先 minify 免疫的 **ASCII 结构标记**（settings 对象键/路由成员访问，如 `trendColorMode`——`privacyMode` 同形态存活实证）；函数名会被 minify 掉（`trendClass` 产物计 0 实证）不可作判据；中文字面量在 lib 内为「反斜杠 + u + 四位**大写** hex」转义形态（评审 P4 探针：大写命中计 2、小写定串计 0；全文 CJK 原字符 0 处），如需字面量定串必须逐字复制产物实际字节，并注意 `grep -c` 计 0 即 exit 1、禁入 `&&` 链。
- **`--skc-danger` 的 fallback 与涨跌红同 hex `#e5484d`（styles.mjs:42）——全程禁止按色值全局替换，禁止改动 ：42 那一行。**
- 客户端单测勿钉随真实时钟漂移的状态值（badgeKind/isMarketOpen/休市判定）。
- 验证输出经管道时保留退出码（`set -o pipefail`）；`grep -c` 计 0 即 exit 1，禁入 `&&` 链。
- clone 后一次性：`git config core.hooksPath .githooks`。

## 输入工件

- 设计（已批准）：`docs/adr/0009-trend-color-semantics.md`（九条决定 + Considered Options + Consequences）
- 术语：`GLOSSARY.md`「涨跌语义」「原生语义」
- 共识台账：/grill-with-docs 会话 Q1–Q11（与 ADR 一致，以 ADR 为准）

## 文件结构与职责

**Create：**
- `client/colors.mjs` —— 物理色权威 + 模式→变量映射（`TREND_RED/TREND_GREEN/trendModeVars`）；import src/model.mjs 的模式常量。
- `tests/client-colorsem.test.mjs` —— 语义纯函数矩阵测试（trendClass/trendVarRef/fmtTrendPct/trendSideClass/trendModeVars）。
- `tests/client-settings-colorsem.test.mjs` —— 设置组 DOM 交互 + 根变量翻转测试（jsdom）。

**Modify：**
- `src/model.mjs` —— schema：`TREND_COLOR_MODES` 常量、`normalizeTrendColorMode`、normalizeGlobal/baseGlobal 携带 `trendColorMode`、parseImportPayload 往返（锚点 ：86、:89-96、:221-234）。
- `src/routes.mjs` —— state 载荷 settings 加 trendColorMode（:164）；settingsRoute patch 白名单（:263-268）。
- `src/store.mjs` —— importAll 的 settings 构建携带 mode（:349；setSettings 走 normalizeGlobal 合并，无需改）。
- `client/fmt.mjs` —— `trendClass(v, market, mode)` 三参化（默认参保旧调用）、新增 `trendVarRef/fmtTrendPct/trendSideClass`（锚点 ：31-35、:63-66）。
- `client/styles.mjs` —— :host 插值物理色变量（:44-45 改为引用 TREND_RED/GREEN 常量插值）；新增分支类、B/S side 类、预览类、radio 组样式。
- `client/capsule.mjs` —— 涨跌幅 glyph + trendClass 穿参（锚点 :427-429；B/S 标记 ：233-236 加 side 类）。
- `client/list.mjs` —— 行 build/patch 穿参 + glyph（锚点 ：331-336、:384-392）；B/S 徽章 side 类（:34、:38）。
- `client/detail.mjs` —— hero 穿参 + glyph（锚点 ：683-691）；图表调用点传 market/mode。
- `client/charts.mjs` —— UP/DOWN 常量退役（:14-15）、全部着色改 style 属性 var 引用（:107、:116、:144-154、:191-215）；minute opts 加 mode、candle opts 加 market+mode（窗先例 ：58）。
- `client/panel.mjs` —— 设置对话框「涨跌配色」radio 组（settingsBody 组装锚点 ：303-320）。
- `client/i18n.mjs` —— zh 字典（:38 区段）与 en 字典（:225 区段）各加 `colorsem.*` 键。
- `client/main.mjs` —— renderAll 内根变量翻转（订阅锚点 ：109-131；style 注入 ：40-42）。
- `docs/ui-redesign.md` —— A1（红涨绿跌）/A2（买红 B 卖绿 S）条款改「随涨跌语义档位」表述 + 分轮变更追记。
- `docs/verification.md` —— 最终验证后追记 §12.N+1（N 取文件头检索索引的最大编号）。

**Test（既有，扩展）：**
- `tests/model.test.mjs`、`tests/routes.test.mjs`、`tests/store.test.mjs`
- `tests/client-dom.test.mjs`（FLOAT_STYLE_TEXT 钉段 + 图表 builder 断言）、`tests/client-round3.test.mjs`（图表 builder）、`tests/client-ui.test.mjs`（trendClass 三态 ：55-60）、`tests/client-detail-hero.test.mjs`（hero 类名 ：129-132）、`tests/client-restyle.test.mjs`（令牌卫生回归）。

## 任务清单

### Task 1: 服务端 schema——trendColorMode 进 model

- 目标：settings 增加经校验的 `trendColorMode` 字段，非法值 fail-closed 回默认 `"red-up"`（与 privacyMode `=== true` 强转同风格）。
- 涉及文件：`src/model.mjs`（含 buildExportPayload :199-208）、`tests/model.test.mjs`
- 接口契约
  - Consumes：无（首个任务）。
  - Produces：`src/model.mjs` 导出 `TREND_COLOR_MODES = ["red-up","green-up","native"]` 与 `normalizeTrendColorMode(v)`（非法/缺失 → `"red-up"`）；`normalizeGlobal` 产出的 `settings` 形如 `{ privacyMode: boolean, trendColorMode: string }`；`parseImportPayload` 往返携带；`buildExportPayload`（:205）导出载荷同样携带（评审 P1）。
- 验证范围：normalizeGlobal 三态（green-up 保留 / 非法回默认 / 缺失回默认）；parseImportPayload 合法值往返、缺字段补默认；既有 privacyMode 断言不回归。

- [ ] Step 1: 在 `tests/model.test.mjs` 追加失败测试（describe「trendColorMode schema」）：① `normalizeGlobal({ rev:1, settings:{ privacyMode:false, trendColorMode:"green-up" }, updatedAt })` → `settings.trendColorMode === "green-up"`；② trendColorMode `"nope"` → `"red-up"`；③ settings 缺 trendColorMode → `"red-up"`；④ `parseImportPayload` 合法载荷往返保留 mode、载荷缺字段 → `"red-up"`；⑤ **导出→导入端到端往返**：`buildExportPayload`（settings 含 green-up）产物喂 `parseImportPayload` → `settings.trendColorMode === "green-up"`（评审 P1 回归钉）。
- Run: `node --test tests/model.test.mjs`
- Expected: 新断言红（当前 normalizeGlobal 只回 `{ privacyMode }`，trendColorMode 为 undefined）。
- [ ] Step 2: 确认失败信号与预期一致（是 undefined/缺字段，不是别的崩）。
- Run: `node --test tests/model.test.mjs 2>&1 | tail -20`（保留退出码时用 `set -o pipefail`）
- Expected: 4 处 failure 均指向 trendColorMode 断言。
- [ ] Step 3: 最小实现 `src/model.mjs`：新增导出 `TREND_COLOR_MODES`、`normalizeTrendColorMode`；baseGlobal（:86）settings 加 `trendColorMode: "red-up"`；normalizeGlobal（:94-95）改为 `settings: { privacyMode: raw.settings?.privacyMode === true, trendColorMode: normalizeTrendColorMode(raw.settings?.trendColorMode) }`；parseImportPayload（:221）同理；buildExportPayload（:205）改为 `settings: { privacyMode: … === true, trendColorMode: normalizeTrendColorMode(global.settings.trendColorMode) }`。
- [ ] Step 4: 全绿。
- Run: `node --test tests/model.test.mjs`
- Expected: pass，既有断言零回归。

### Task 2: 服务端往返——routes 载荷 + patch 白名单 + importAll

- 目标：state 载荷透出 mode；settings 路由可改 mode；备份导入保留 mode。
- 涉及文件：`src/routes.mjs`、`src/store.mjs`、`tests/routes.test.mjs`、`tests/store.test.mjs`
- 接口契约
  - Consumes：Task 1 的 `normalizeTrendColorMode`。
  - Produces：GET `/stock-kanban/state` 载荷 `settings.trendColorMode`（客户端 snapshot.business.settings 可读）；POST `/stock-kanban/settings` body `{ trendColorMode }` 生效（非法值静默回默认，不报错——与既有 coercion 风格一致）；`importAll` 保留 mode。
- 验证范围：routes.test（载荷字段、POST 生效 + rev 自增 + 非法回默认）、store.test（importAll 携带）。

- [ ] Step 1: `tests/routes.test.mjs` 追加失败测试：state 载荷 `settings.trendColorMode === "red-up"`（默认）；POST settings `{ trendColorMode: "native" }` → 200 且响应 `settings.trendColorMode === "native"`、`rev` 较前自增；随后 state 载荷同为 `"native"`；POST 非法值 → 200 且回落 `"red-up"`。`tests/store.test.mjs` 追加：`importAll(symbols, { privacyMode:false, trendColorMode:"green-up" })` 后 global.settings.trendColorMode === "green-up"。
- Run: `node --test tests/routes.test.mjs tests/store.test.mjs`
- Expected: 新断言红（载荷无字段、patch 被丢弃、importAll 丢字段）。
- [ ] Step 2: 实现三处：routes.mjs :164 settings 对象加 `trendColorMode: normalizeTrendColorMode(store.global.settings.trendColorMode)`（import 自 ./model.mjs）；settingsRoute（:263-268）patch 分支加 `if (typeof body.trendColorMode === "string") patch.trendColorMode = normalizeTrendColorMode(body.trendColorMode);`；store.mjs importAll（:349）settings 构建加 `trendColorMode: normalizeTrendColorMode(settings?.trendColorMode)`。
- [ ] Step 3: 全绿 + 既有路由/store 测试零回归。
- Run: `node --test tests/routes.test.mjs tests/store.test.mjs tests/model.test.mjs`
- Expected: pass。

### Task 3: 语义纯函数层——colors.mjs（新）+ fmt.mjs 三参化

- 目标：客户端单一权威的颜色常量与语义解析函数，矩阵测试钉死。
- 涉及文件：`client/colors.mjs`（Create）、`client/fmt.mjs`、`tests/client-colorsem.test.mjs`（Create）
- 接口契约
  - Consumes：Task 1 的 `TREND_COLOR_MODES`、`normalizeTrendColorMode`（client → src import 方向，仓内既有先例 portfolio/sessions）。
  - Produces（后续所有客户端任务消费）：
    - `colors.mjs`：`TREND_RED = "#e5484d"`、`TREND_GREEN = "#2bb596"`、`trendModeVars(mode)` → `{ "--skc-up": hex, "--skc-down": hex }`（red-up/native → up=RED,down=GREEN；green-up → up=GREEN,down=RED）。
    - `fmt.mjs`：`trendClass(v, market = null, mode = "red-up")`——null/NaN/0 → `"skc-flat"`；mode !== "native" → `v>0 ? "skc-up" : "skc-down"`（翻向由根变量承载）；native → market==="cn" ? (v>0?"skc-up-cn":"skc-down-cn") : (v>0?"skc-up-g":"skc-down-g")。`trendVarRef(v, market, mode)` 同判定树返回 CSS var 引用串：非 native → `"var(--skc-up)"/"var(--skc-down)"`（根变量已翻向）；native → cn 涨 `"var(--skc-red)"` 跌 `"var(--skc-green)"`、非 cn 涨 `"var(--skc-green)"` 跌 `"var(--skc-red)"`（SVG 无类名分支，物理 var 直出；flat → null）。`trendDirVar(up, market, mode)` = `trendVarRef(up ? 1 : -1, market, mode)`——图表布尔方向入口（charts.mjs:107/:192 只有布尔，无数值；评审 P2）。`fmtTrendPct(v)` = (v>0?"▲":v<0?"▼":"") + `fmtPct(v)`。`trendSideClass(market, mode)` = native ? (market==="cn"?"skc-side-cn":"skc-side-g") : ""。
  - 兼容性红线：旧一参调用 `trendClass(v)` 行为与现在逐字节一致（默认参 = red-up = 现状），迁移期不破现存测试。
- 验证范围：矩阵 = 3 modes × market ∈ {cn,hk,us,crypto,null} × v ∈ {2.35,-1.8,0,null,NaN}；fmtTrendPct 三态；trendVarRef 对应；trendDirVar 布尔入口与 trendVarRef 等价性（up=true/false × 三 mode × cn/us 两市场）；trendSideClass 两态；trendModeVars 三态。

- [ ] Step 1: 写 `tests/client-colorsem.test.mjs` 失败测试（import 上述导出，矩阵断言如上；含「旧签名 trendClass(v) 与现行行为一致」的兼容断言组）。
- Run: `node --test tests/client-colorsem.test.mjs`
- Expected: 红（导出不存在）。
- [ ] Step 2: 实现 `client/colors.mjs` 与 `client/fmt.mjs` 扩展（trendClass 改签名，:62 注释同步更新为三档口径）。
- [ ] Step 3: 绿 + 旧测试零回归（兼容断言组即守卫）。
- Run: `node --test tests/client-colorsem.test.mjs tests/client-ui.test.mjs`
- Expected: pass（client-ui 的三态断言 ：55-60 走旧签名，必须原样绿）。

### Task 4: CSS 层——物理变量 + 分支类 + 设置组样式

- 目标：styles.mjs 获得 native 档类、B/S side 类、预览类、radio 组样式；:host 变量改由颜色常量插值（单点权威）。
- 涉及文件：`client/styles.mjs`、`tests/client-dom.test.mjs`、`tests/client-restyle.test.mjs`
- 接口契约
  - Consumes：Task 3 的 `TREND_RED/TREND_GREEN`（styles.mjs 顶部 import 并在 FLOAT_STYLE_TEXT 模板串插值）。
  - Produces（DOM 任务与设置组消费）：
    - `:host` 新增 `--skc-red/--skc-green`（插值 TREND_RED/TREND_GREEN）；`--skc-up: ${TREND_RED}; --skc-down: ${TREND_GREEN};` 替换 ：44-45 的字面量（静态默认 = red-up）。
    - 文本分支类：`.skc-up-cn{color:var(--skc-red)} .skc-down-cn{color:var(--skc-green)} .skc-up-g{color:var(--skc-green)} .skc-down-g{color:var(--skc-red)}`。
    - B/S side 覆盖 ×8：`.skc-mark-buy.skc-side-cn`（red）/`.skc-mark-sell.skc-side-cn`（green）/`.skc-mark-buy.skc-side-g`（green）/`.skc-mark-sell.skc-side-g`（red）+ badge 四条，color/border-color/background 三元组逐一镜像既有 ：79-80、:154-155 的 color-mix 配方（14%/38%/10% 档位不变）。
    - 预览类：`.skc-csp-red{color:var(--skc-red)} .skc-csp-green{color:var(--skc-green)}`（tabular-nums）。
    - 设置组：`.skc-colorsem-title`（caption、text-2）、`.skc-colorsem`（role=radiogroup 容器，纵向）、`.skc-colorsem-row`（button 重置、min-height 44px、hover 用 `--skc-hover`、`aria-checked="true"` 态 radio 点 accent 着色 + 文本加重）、radio 点 ::before 圆点、`.skc-colorsem-label/.skc-colorsem-sub`（label 13px/sub 11px text-2）、`.skc-colorsem-preview`（右对齐、margin-left:auto、tabular-nums、12px）、`.skc-colorsem-tag`（11px text-3 药丸底）、`.skc-colorsem-divider`（hairline-soft，1px）。
  - 红线：不动 `--skc-danger`（:42）行；不动既有 `.skc-mark-buy` 等基础规则本体，side 类只做追加覆盖。
- 验证范围：client-dom 的 FLOAT_STYLE_TEXT 钉段纪律——为每条新增规则段落加整串 pin（先红后绿）；client-restyle 令牌卫生回归绿。

- [ ] Step 1: `tests/client-dom.test.mjs` 追加钉段失败测试（沿用该文件既有整串 pin 写法）：`--skc-red:` 声明行、`.skc-up-cn{color:var(--skc-red)}`、`.skc-mark-buy.skc-side-g` 整串、`.skc-colorsem-row` 含 `min-height:44px` 的整串、`.skc-csp-red` 行。
- Run: `node --test tests/client-dom.test.mjs tests/client-restyle.test.mjs`
- Expected: 新 pin 红（规则不存在），restyle 绿。
- [ ] Step 2: 实现 styles.mjs（import 常量 + 插值 + 追加规则块；注释标注「ADR-0009 三档语义」）。
- [ ] Step 3: 绿。
- Run: `node --test tests/client-dom.test.mjs tests/client-restyle.test.mjs`
- Expected: pass，既有钉段零回归。

### Task 5: SVG 图表改变量驱动（视觉恒等重构）

- 目标：charts.mjs 全部涨跌着色改 style 属性 var 引用，opts 增加 market/mode 通道；本任务收口时**视觉与现状逐像素等价**（默认 red-up）。
- 涉及文件：`client/charts.mjs`、`client/detail.mjs`（仅图表调用点传参）、`tests/client-round3.test.mjs`、`tests/client-dom.test.mjs`
- 接口契约
  - Consumes：Task 3 `trendDirVar`（布尔入口，含 native 物理 var 语义）。
  - Produces：`buildMinuteChart(opts)` opts 增加 `mode`（market 已有，charts.mjs:58）；`buildCandleChart(opts)` opts 增加 `market`、`mode`；UP/DOWN 常量（:14-15）与 rgba 字面量（:151、:213）删除；分时线（:116）、量柱（:144-154）、K 线影线/实体/量柱（:191-215）全部 `el.setAttribute("style", "stroke:…;fill:…")` 形式（配方：分时主线 ：116 `stroke:${trendDirVar(up, market, mode)}`；影线 stroke 同 ref；阳线空心 fill 保持 transparent、阴线实心 fill=对应方向 ref；量柱 `fill:color-mix(in srgb, ${方向 var} 40%/.35, transparent)`，档位对齐现状 .4/.35）。**方向布尔与回退语义维持现状（评审 P2）**：分时 ：107 prevClose 无效 → up=true（涨向 ref），K 线 ：192 `close >= open`。detail.mjs 图表调用点先传 `market: s.market, mode: "red-up"` 默认值。
- 验证范围：`tests/client-dom.test.mjs` **新增**图表着色断言（评审 P5：dom/round3 既有图表断言均不钉涨跌色，无「改」的对象；round3 图表断言不涉色、不动）；渲染结果默认档视觉恒等。

- [ ] Step 1: 在 `tests/client-dom.test.mjs` **新增**图表着色断言（minute 主线 polyline / candle 影线与阴线实体 / 量柱的 style 属性含 `var(--skc-…)` 方向引用），先跑红。
- Run: `node --test tests/client-dom.test.mjs`
- Expected: 红（新增断言读到的是 fill/stroke 表现属性 + hex 字面量，非 style 属性 var 引用）。
- [ ] Step 2: 实现 charts.mjs 改造 + detail.mjs 调用点默认传参。
- [ ] Step 3: 绿（round3 + dom + colorsem 全绿）。
- Run: `node --test tests/client-round3.test.mjs tests/client-dom.test.mjs tests/client-colorsem.test.mjs`
- Expected: pass。

### Task 6: DOM 消费点穿参 + ▲▼ + B/S side 类

- 目标：全部语义色消费点接入三参解析；三处涨跌幅加方向符号；B/S 标记/徽章 native 档带 side 类。
- 涉及文件：`client/capsule.mjs`、`client/list.mjs`、`client/detail.mjs`、`tests/client-ui.test.mjs`、`tests/client-detail-hero.test.mjs`
- 接口契约
  - Consumes：Task 3 `trendClass/fmtTrendPct/trendSideClass`；mode 取值 `snapshot.business.settings?.trendColorMode`（客户端读法先例 detail.mjs:95）；market 取各行作用域已有的 `s.market`（capsule/list/detail 均已持有）。
  - Produces：涨跌幅 DOM 文本 = `fmtTrendPct(pct)`（▲+2.35% 形态）；全部 `trendClass(...)` 调用三参化。**消费点清单以 `grep -n "trendClass" client/` 输出为准**（已知锚点：capsule.mjs:427-429、list.mjs:331-336 与 ：384-392 patch、detail.mjs:683-691；B/S：capsule.mjs:233-236、list.mjs:34,:38；**B/S side 类双写点（评审 P3）**：capsule 创建 ：233-236 **与** update 路径 ：421-422（现仅切 hidden——side 类须在此同步重写 className，market 取 `symbol?.market`，:424 已有同源取值先例）。fmtPct 在持仓盈亏幅（list.mjs:342-357、:398-404）保持原样不加符号。
- 验证范围：hero 类名断言扩展（hero 测试 :129-132 加 native×market 断言与 glyph 断言）；行级 glyph 断言落 `tests/client-round3.test.mjs`（该文件已有行级原位更新断言先例 ：309——断言 tick patch 后 pct 文本带 ▲/▼ 前缀、类名随 mode/market 解析）。

- [ ] Step 1: 失败测试：client-detail-hero.test.mjs 加「native 模式 cn 标的 hero pct 类 = skc-up-cn、us 标的 = skc-up-g」断言与 glyph 断言（▲ 前缀）；按 grep 定位的行级测试加同构断言。
- Run: `node --test tests/client-detail-hero.test.mjs`
- Expected: 红（现产出 skc-up 且无 glyph）。
- [ ] Step 2: 实现 capsule/list/detail 穿参 + glyph + side 类（capsule B/S 在创建 :233-236 与 update :421-422 两处同步写 side 类；list patch 路径 ：384-392 注意文本原位写纪律——列类型由全量重建保证）。
- [ ] Step 3: 绿。
- Run: `node --test tests/client-detail-hero.test.mjs tests/client-ui.test.mjs tests/client-round3.test.mjs`
- Expected: pass，零回归。

### Task 7: 设置对话框「涨跌配色」组 + i18n + api 接线

- 目标：设置对话框新增 radio 组（组标签 + 三行 + 每行内嵌真实预览），点选即写服务端，失败 toast 回滚。
- 涉及文件：`client/panel.mjs`、`client/i18n.mjs`、`tests/client-settings-colorsem.test.mjs`（Create）
- 接口契约
  - Consumes：Task 2 路由（api.setSettings 既有，api.mjs:41）、Task 4 样式类、`fmtTrendPct`、`normalizeTrendColorMode`。
  - Produces：i18n 键（zh/en 各 9 枚）：`colorsem.title`（涨跌配色 / Trend colors）、`colorsem.mode.redup`（红涨绿跌 / Red up · green down）、`colorsem.mode.greenup`（红跌绿涨 / Green up · red down）、`colorsem.mode.native`（原生语义 / Native per market）、`colorsem.sub.redup`（A股惯例 / Chinese market convention）、`colorsem.sub.greenup`（国际惯例 / International convention）、`colorsem.sub.native`（按各市场当地惯例 / Each market follows its own convention）、`colorsem.tag.cn`（沪 / CN）、`colorsem.tag.us`（美 / US）。
  - DOM 结构（ADR-0009 决定 8 定稿）：settingsBody 组装改为 `colorsem 标题 + .skc-colorsem + .skc-colorsem-divider + views.backup.el + notes`（现 ：319）。三行：行 = label + sub + preview；行1预览 `fmtTrendPct(2.35)`（skc-csp-red）+ `fmtTrendPct(-1.8)`（skc-csp-green）；行2同文本反色；行3 = tag(沪)+`fmtTrendPct(2.35)`（csp-red）+ tag(美)+`fmtTrendPct(2.35)`（csp-green）。容器 `role="radiogroup"` `aria-label=t("colorsem.title")`；行 button `role="radio"` `aria-checked`；选中态读 `snapshot.business.settings?.trendColorMode`（normalizeTrendColorMode 兜底）。
  - 写入路径：点击行 → `api.setSettings({ trendColorMode })` → 成功走既有 refreshState 管道（写法锚点 `client/backup.mjs` 导入成功路径的 mutate→refresh 模式）→ rev 广播全量重渲染；失败 → toast（锚点 backup.mjs 错误路径，**复用既有 `toast.op-failed` 键**——i18n.mjs:171 zh/en 均在案，不新增 toast 键，防 parity 计数预期漂移；评审建议 2）+ 以下一次 render 的 snapshot 为准回滚 aria-checked。**无乐观更新、无保存钮。**
- 验证范围：jsdom 交互测试（stub api/store）。

- [ ] Step 1: 写 `tests/client-settings-colorsem.test.mjs` 失败测试：① 渲染后 radiogroup 存在、恰 3 个 role=radio、当前模式行 aria-checked="true"、标签文案取自 zh 字典；② 点击「红跌绿涨」行 → api stub 收到 `{ trendColorMode: "green-up" }`；③ api stub reject → toast 可见且 aria-checked 未变；④ 行3预览含两个 `▲+2.35%` 且类名含 csp-red 与 csp-green 各一。
- Run: `node --test tests/client-settings-colorsem.test.mjs`
- Expected: 红（视图不存在）。
- [ ] Step 2: 实现 panel.mjs 视图 + i18n 双字典（两字典同步加，parity 守卫会拦单边）。
- [ ] Step 3: 绿 + parity 守卫绿。
- Run: `node --test tests/client-settings-colorsem.test.mjs tests/i18n.test.mjs`
- Expected: pass（`tests/i18n.test.mjs` = zh/en parity 与键位对齐守卫）。
- [ ] Step 4: checkpoint commit（`feat(client): color semantics radio group in settings`——不含版本号）。

### Task 8: 根变量翻转接线——main.mjs

- 目标：mode 变化把 `trendModeVars(mode)` 写到 float root 内联 style，全 DOM/SVG 消费点换向；写前比对缓存，tick 渲染零冗余写。
- 涉及文件：`client/main.mjs`、`tests/client-settings-colorsem.test.mjs`（追加）
- 接口契约
  - Consumes：Task 3 `trendModeVars/normalizeTrendColorMode`；renderAll 订阅点（main.mjs:109-131）与 float root 引用（style 注入处 main.mjs:40-42 同域）。
  - Produces：root `style` 上恒有 `--skc-up/--skc-down` 当前档位值；red-up/native → `#e5484d/#2bb596`，green-up → 反。
- 验证范围：jsdom 断言 root 内联变量随 snapshot 三态翻转。

- [ ] Step 1: 追加失败测试：三态 snapshot 依次 render → 断言 `root.style.getPropertyValue("--skc-up")` 分别为 TREND_RED/TREND_GREEN/TREND_RED（native 同 red-up 默认）。
- Run: `node --test tests/client-settings-colorsem.test.mjs`
- Expected: 红（属性为空）。
- [ ] Step 2: main.mjs renderAll 内实现（缓存上一次 mode+值串，未变不写）。
- [ ] Step 3: 绿。
- Run: `node --test tests/client-settings-colorsem.test.mjs tests/client-render-identity.test.mjs`
- Expected: pass（render identity 回归绿）。

### Task 9: 设计契约与文档修订

- 目标：ui-redesign.md 契约条款与实现对齐；README 核查结论留痕。
- 涉及文件：`docs/ui-redesign.md`、（视核查结果）`README.md`
- 接口契约
  - Consumes：ADR-0009 决定 3/4/8。
  - Produces：A1（红涨绿跌）改为「涨跌语义默认档 red-up，可切换」、A2（买红 B/卖绿 S）改为「B 恒取涨色、S 恒取跌色，随档位换向（ADR-0009）」；分轮变更节追记本轮（格式随文件头既有轮次体例）。
- 验证范围：README 已核查无「红涨绿跌」硬声明（:127 为泛化令牌描述）——若实现中发现新声明冲突再改，否则 no-op 并在验证记录注明。

- [ ] Step 1: 修订 ui-redesign.md 两条款 + 追记轮次（真实内容，无占位）。
- [ ] Step 2: `grep -n "红涨" README.md` 复核（预期仅间接描述或零命中；命中即评估是否需改，改则同步 en 文档如有）。
- Run: `grep -n "红涨\|绿跌" README.md docs/ui-redesign.md`
- Expected: ui-redesign 新表述在案；README 无失真声明残留。

### Task 10: 全量验证 + 产物 + 视觉 + 验证记录

- 目标：全套测试绿、产物新鲜、三档视觉实证、验证记录追记。
- 涉及文件：`lib/client.js`（build 产物）、`docs/verification.md`
- 接口契约
  - Consumes：全部前序任务。
  - Produces：verification.md §12.N+1（N 取文件头检索索引最大编号；含未验证项如实记——未验证不冒充已验证）。

- [ ] Step 1: 环境预检 `test -d node_modules`（缺则按全局约束恢复）；`pgrep -f '[c]hrome-cft'` 确认空输出。
- [ ] Step 2: 全套测试。
- Run: `npm test`
- Expected: 全绿（串行 runner，注意 15s 单测超时纪律）。
- [ ] Step 3: 产物重建 + 产物核证探针（字符串字面量判据）。
- Run: `npm run build` 后 `git status --short lib/client.js`（应见 M，随实现提交带上）；主判据 `grep -cF 'trendColorMode' lib/client.js`（ASCII 结构标记：settings 对象键 + 路由成员访问，minify 免疫；`privacyMode` 同形存活实证——评审 P4）；辅判据（可选）：zh 字面量为「反斜杠+u+四位大写 hex」转义形态，定串须逐字复制产物字节（小写定串实测计 0）
- Expected: 主判据计数 > 0（实证新代码进产物）；辅判据如采用，同样 > 0。
- [ ] Step 4: 视觉实证 `scripts/cdp-shot.mjs`（纪律按其头注：chrome 后台起跑、假活 `--down` 重启、重活前 `pgrep` 清零）；截设置对话框 + 默认档列表/详情，切换档位后复截——**green-up 档截图清单必须含详情 hero 行**（价格+涨跌额+涨跌幅，「红=跌」为三档中反直觉最强处，评审建议 1）（POST settings 或 jsdom 不可达时以脚本能力为准，能力不足项如实记入 verification「未验证项」）。
- [ ] Step 5: verification.md §12.N+1 追记：决策指针（ADR-0009）、测试与视觉证据命令指针（`gh`/脚本输出不留机读手抄）、未验证项。
- [ ] Step 6: 收尾提交（实现 + 产物 + 文档一笔或按既有粒度；**发版链（refresh-pools/bump/tag/publish/release-monitor）不在本计划范围**）。

## 执行纪律

- 开始实现前先批判性复查整份计划：发现缺项、矛盾、命名不一致或验证命令无效，先修计划再动手。
- 按任务顺序执行（T1→T10），不无声跳步、合并步或改变任务目标；每任务完成即跑该任务定义的验证。
- 开始前确认分支：`git status -sb`——若在 `main`/`master`，先征得主人同意再开实现分支。
- 遇阻塞、重复失败或计划与仓库现实不符（锚点行号漂移属正常，以符号锚点为准；结构不符即停），立即停下说明，不要猜。
- 单测不得钉随真实时钟漂移的状态值（badgeKind/休市判定）；新 DOM 断言只钉类名/文本/属性。
- 验证命令均在仓库根（`dsh-stock-kanban/`）执行；联网 npm 命令前按全局约束加 `npm_config_cache`。

## 最终验证

- `npm test` 全绿；`npm run build` 产物新鲜（`git status --short lib/client.js` 干净于提交后）；`node --test tests/client-colorsem.test.mjs tests/client-settings-colorsem.test.mjs` 绿；cdp-shot 视觉实证三档（或如实记未验证项）；`docs/verification.md` §12.N+1 在案；`docs/ui-redesign.md` 条款已修订。
