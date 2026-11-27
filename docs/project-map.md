# 项目导览（记忆文件）

> 用途：后续对 dsh-stock-kanban 做修改 / 定制时的入口地图。**结构事实以本文件与两张图为索引，具体行为以源码与 `docs/` 下的权威文档为准。**
> 锚点：`v0.3.14` @ HEAD `824aa0f73b41b50b565da438caa598a124972dc5`（2026-11-19）。结构或版本变化后请同步更新本文件的锚点行与受影响小节。

## 导览图

| 图 | 文件 | 读什么 |
|---|---|---|
| 架构图（组件 / 边界 / 数据流） | [`.archify/architecture-dsh-stock-kanban-20261127-142320/dsh-stock-kanban.architecture.html`](../.archify/architecture-dsh-stock-kanban-20261127-142320/dsh-stock-kanban.architecture.html) | 宿主 vs 浏览器两端、14 条路由、行情链、信任围栏、存储落点 |
| 结构树（目录 / 模块簇） | [`.archify/architecture-dsh-stock-kanban-20261127-142320/dsh-stock-kanban.tree.html`](../.archify/architecture-dsh-stock-kanban-20261127-142320/dsh-stock-kanban.tree.html) | 五大区 → 模块簇 → 关键文件；节点可点开源码行 |

两图均为可交互 HTML（支持深/浅色、路径高亮、语义护照与导出），源候选 JSON 同在 `.archify/architecture-dsh-stock-kanban-20261127-142320/`：`candidate.json`（架构）、`tree.candidate.json`（结构）。改图只需改这两个 JSON 后重跑 `archify finalize`。

> `.archify/` 是本地产物目录，未纳入版本控制；克隆到新机器后如无此目录，可按本文「改动菜谱」重建，或直接用下面的文字结构。

## 一句话架构

一个 DSH 插件同时装两端：**宿主端**（`src/`，Node ESM，零运行时依赖）持有全部业务数据并对外提供 `/stock-kanban/*` exact 路由；**浏览器端**（`client/`，vanilla，打包成 `lib/client.js`）把浮动胶囊 + 面板直挂到 DSH 页面 `body` 的 open shadow root。业务数据跨浏览器共享，界面偏好只在本机 `localStorage`。

## 目录职责

| 路径 | 职责 | 改动后要不要构建 |
|---|---|---|
| `src/host.mjs` | 插件入口：`apply(ctx, config)` 组装 store → chain → quotes → routes，`inject = [webServer, storage]` | 否（重启 DSH） |
| `src/routes.mjs` | 14 条 exact 路由 + trust 壳 + rev CAS + 状态日志门 | 否 |
| `src/access.mjs` | 官方信任检查（`connection.admit` 优先，旧版回落 `requestRejection`；两者都缺席 fail-closed 403）+ 写路由同源校验 | 否 |
| `src/store.mjs` | DSH storage KV 驱动（首选）/ 文件驱动（回退），promise 链串行写 + 每次变更推 `rev` | 否 |
| `src/model.mjs` · `src/identity.mjs` | 记录规范化、备份 schema、排序；市场/身份模型与十指数目录 | 否 |
| `src/portfolio.mjs` · `src/targets.mjs` · `src/sessions.mjs` · `src/quotes.mjs` | 纯函数域：持仓盈亏、目标价状态机、开休市与轮询节奏、行情分组整形 | 否 |
| `src/markets/chain.mjs` | **行情链单一权威**（ADR-0007）：`CHAINS` 链序、`runChain` 逐源补位、per-(provider,market) 记账 | 否 |
| `src/markets/*.mjs` | 各数据源适配器（腾讯 / 东财 / 新浪 / OKX / Binance / Yahoo / 雪球）与美股图表自管链 `us-detail` | 否 |
| `src/markets/search.mjs` | 搜索（本地池 + smartbox）与直连代码校验（走 `runChain`） | 否 |
| `src/diag.mjs` | 宿主 JSONL 诊断，`off / errors / full`，按 UTC 日期滚动 | 否 |
| `client/` | 浏览器端全部源码：浮动壳 / 胶囊 / 面板 / 视图 / 图表 / 手势 / 状态 / 接口 / 文案 | **是，`npm run build`** |
| `lib/client.js` | 唯一构建产物（esbuild，注入版本号与构建指纹），**必须与源码同提交** | 产物 |
| `data/*.json` | 标的池（代码 + 简称），**只能由 `scripts/refresh-pools.mjs` 生成** | 不适用 |
| `locale/zh.json` · `en.json` | 双语文案，键位对齐有守卫测试 | 否 |
| `scripts/` | 构建、串行测试、池刷新、上游探针、原子热部署、CDP 实拍、CI 形态核证 | 否 |
| `tests/` | 56 个 `node:test` 套件，全离线 mock；含一系列结构守卫 | 否 |
| `docs/` | 设计契约（`ui-redesign.md`）、验证记录（`verification.md` §12.x）、ADR、CEP 协议、计划归档 | 否 |
| `.githooks/` · `.github/` | pre-commit 语法闸 / pre-push 全量测试 + 产物新鲜度；CI 与 npm 发布 | 否 |

## 三条主链路

1. **界面取数**：`client/store.mjs` 按 `src/sessions.mjs` 的节奏排轮询 → `client/api.mjs` fetch `/stock-kanban/quotes` → `src/routes.mjs` → `src/quotes.mjs` → `chain.runChain(market, "snap", …)` → 逐源过 `gate()`（TTL 缓存 / 在途合并 / 指数退避）→ 行整形回包 → `main.mjs` 的 `renderAll` 漏斗分发到视图。
2. **图表取数**：详情页 `kline` / `minute` 路由同走 `chain.runChain`（`cache=false`，避免退化答案冻结下一拍）；**美股例外**，由 `src/markets/us-detail.mjs` 自管链（EM trends2 → 雪球 → Yahoo）。
3. **写入**：任何变更路由都过 trust 壳 → 同源 + JSON + 体积上限 → `rev` CAS → `store` 串行写链 → 推进 `rev`；旧页面用过期数据提交得 409。

## 改动菜谱

```bash
# 0) 前置（每次干净克隆一次）
git config core.hooksPath .githooks
test -d node_modules || npm ci          # dsh plugin add/remove 会清掉 node_modules

# 1) 改宿主逻辑：直接改 src/，重启 DSH 服务生效（ESM 缓存）
# 2) 改界面：必须重新打包，产物与源码一并提交
npm run build
# 3) 验证
npm test
```

- 重活（实拍）前先确认没有 headless chrome 残留；**检查须单独一条命令跑**：`pgrep -f '[c]hrome-cft'`（空输出即干净，嵌入含该字样的复合脚本会自匹配误报）。
- 装机目录热更新用 `node scripts/hot-deploy.mjs <仓库相对路径...> [--dest <装机根>] [--dry-run]`，别手搓 bash 循环（备份 + 同目录临时 + rename 断链 + 逐字节 cmp 断言已编码）。
- 渲染层改动再跑 `node scripts/cdp-shot.mjs`（纪律见其头注）。
- 发版链：`refresh-pools.mjs` dry-run 核对 → 实质变化才 `--apply` → bump → `npm run build` → `chore(release)` → 轻量 tag → push → release-monitor。发布前跑 `scripts/ci-parity.sh`。
- 联网 npm 命令要带 `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban`（沙箱 `~/.npm` 只读，会 EROFS）。

## 结构不变量（有测试守着，别绕过）

| 不变量 | 守卫 |
|---|---|
| `AGENTS.md` 里反引号包裹的仓库内路径必须存在 | `tests/agents-paths.test.mjs` |
| `data/*.json` 与 `data/manifest.json` 的来源与哈希一致 | `tests/data-provenance.test.mjs` |
| `locale` zh/en 键位对齐、服务端错误码全覆盖 | `tests/i18n.test.mjs`、`tests/error-codes-i18n.test.mjs` |
| `dsh-m/registry.json` 的 `verified` 只记 DSH 运行时版本，严禁混插件版本 | `tests/registry-verified.test.mjs` |
| `lib/client.js` 与源码同步（rebuild 后 `git diff` 必须为空） | `.github/workflows/ci.yml`、`.githooks/pre-push` |
| 发布 tarball 必须来自当前源码 | `publish.yml` |

## 排错入口

1. 线上故障先看诊断日志：`~/.dsh/stock-kanban/stock-kanban-diag-<UTC日期>.jsonl`（`provider.fail` / `route.status` / `chart.*.fail`，含退避计数与 `backoffMs`），或 `GET /stock-kanban/diag?tail=50`。
2. 驱动与存储形态：`GET /stock-kanban/health` 的 `driver` 字段（`dsh-storage` / `file`）。
3. 上游可达性：`node scripts/probe-upstreams.mjs [--f56]`，一次打印四市场各源结论 + DNS 栈。
4. 搜索/解析问题：`node scripts/probe-markets.mjs`，且探针**必须 import 生产解析函数**，不得复制正则。

## 权威文档索引

| 想知道 | 看 |
|---|---|
| 术语与定案（先查这里再下结论） | `GLOSSARY.md` |
| 界面设计契约与分轮变更 | `docs/ui-redesign.md` |
| 某现象以前是否踩过、怎么修的 | `docs/verification.md`（§12.x 追记式判例，文件头有检索索引） |
| 关键架构决策的取舍 | `docs/adr/0001`–`0009`（链权威 0007、信任围栏 0005、搜索 0006、名称覆写 0008、语义色 0009） |
| 与 dsh-quota-watch 的合并协议 | `docs/interop/capsule-embed-protocol.md`（CEP v1，单一权威） |
| 标的池来源与刷新节奏 | `data/README.md` |
| DSH 接口与技术核查 | `docs/tech-notes.md` |

## 修改纪律（会真的被回滚的那几条）

- 验证记录写 `docs/verification.md` §12.x，追记不重写；**机读事实（CI run id、时间戳、产物 sha）禁手抄**，只留可查命令指针。
- 决策正文写单一权威文档（ADR / GLOSSARY / data README），verification 只记事件与指针。
- 产物核证用 minify 免疫标记（字符串字面量 / 整文件 cmp）；中文在 `lib/client.js` 内是 `\uXXXX` 转义，`grep -c` 计 0 即 exit 1，禁入 `&&` 链。
- 客户端单测勿钉随真实时钟漂移的状态值（休市判定、badgeKind 会随时钟翻转），改断言容器存在性或注入可控时钟。
- 隐私遮挡只是展示层行为（服务端原文下发），改它不要动数据面。
