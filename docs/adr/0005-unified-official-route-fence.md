# ADR-0005：全部路由统一官方信任围栏（connection.admit / requestRejection 守卫式委派）

日期：2026-11-12　状态：已采纳（随 0.2.5 发布）；**2026-11-27 追记**——`requestRejection` 已被 DSH 0.2.2-rc.2 删除，改为 `admit` 优先 + 旧 API 回落（见文末「追记」）。
触发：PR 评审（fkysly）——exact 裸路由无准入，`isSameOriginRequest` 在 DNS rebinding 下必然通过。

## 背景

`/stock-kanban/*` 以 `webServer.register({ kind: "exact" })` 挂载，DSH 对这类裸路由
不做 Host / Origin / Cookie 准入。写路由仅校验 Origin host === Host 头，DNS rebinding
后 Origin 与 Host 均为攻击者域名，校验必然通过：GET `/export`（含持仓的明文备份）可被
读走，POST `/import` 可被驱动覆盖。读写路由都暴露；DSH 直听 127.0.0.1:3080 的本机场景
暴露面最大。

## 决策

1. **全部路由（含 GET）入口先过官方信任检查** `connection.requestRejection`，
   dsh-m 0.9.0 同款**守卫式委派**：`ctx.get("connection")` 非抛式查询，
   `reject.call(connection, { headers })` → 401/403 原样下发、undefined 放行。
2. **语义三态**（与家族各仓对齐的关键区分）：
   - 官方判定为准；
   - **服务查不到**（含 cordis Local 对未注入名 get 抛错）→ 回落本地栅栏，不砖旧 runtime；
   - **围栏执行抛错** → fail-closed（warn 一次）。
3. **本仓取整段 fail-closed**（服务缺席连本地栅栏都不回落）：评审点名要堵的洞；
   `dsh.engines >= 0.2.2-rc.1` 保证 connection 服务在位（dsh-m 生产先例）。宁可砖不可漏。
   写路由仍保留 `isSameOriginRequest` 作纵深。
4. **不迁移** `ctx.connection.fetch.register`（12 条路由重写为 Response 风格）、
   **不挪** `/api` 前缀（URL 变更牵连客户端）——入口一行委派是最小统一形态。
5. **不抽共享 npm 包**：守「零运行时依赖」；各仓内联同一段守卫 + 统一注释锚点
   （grep「守卫式委派」全家族可同步）。

## 家族落地形态（2026-11-12 六仓同步）

| 仓 | 官方缺席时 | 本地回落栅栏 |
|---|---|---|
| stock-kanban | **fail-closed 403**（本仓特殊点） | 写路由 isSameOriginRequest 纵深 |
| copilot-auth | 回落 | Host∈loopback∪trustedHosts + sec-fetch-site + Origin/Host |
| quota-watch | 回落 | pairing/loopback + 同源 |
| obmc-web / onetree-log | 回落 | trustedRequest（Host 白名单） |
| skins | 回落 | isTrustedRequest（最强自研，loopback peer 绑定） |

dsh-m / dsh-skip-browser-auth 本就运行官方围栏，无需改。send-later / skills / surf
无自建路由，不涉及。

## 后果与验证

- **本机 curl（loopback、无 Origin）照常 200**——官方语义下这是可信运维通道，不是漏洞；
  不要把「裸 curl 应 403」写进验证清单（2026-11-12 实录误判）。
- 判别探针：rebinding 形态（Host=Origin=攻击者域）→ `403 {"error":"untrusted"}`；
  0.2.4 旧代码此形态 200 放行。跨站形态 403（origin-rejected 纵深）。
- 测试：tests/routes.test.mjs「官方信任检查」组——拒绝原样下发 / 放行业务照常 /
  缺席 fail-closed warn-once / 抛错 fail-closed / 读路由不豁免 / 64KiB 体积上限。
- 家族同步入口：grep「守卫式委派」。

## 追记（2026-11-27）：requestRejection 被删除，改为 admit 优先 + 旧 API 回落

**症状**：DSH 0.2.3-alpha.2 上插件安装、激活、路由挂载全部成功，但每个路由一律
`403 {"error":"untrusted"}`；`~/.dsh/stock-kanban/stock-kanban-diag-<UTC>.jsonl` 里
`route.reject` + `route.status` 成对刷屏。UI 表现为「搜索暂时不可用：请求未通过信任检查」
（`client/i18n.mjs` 的 `err.untrusted`），添加标的完全不可用。

**根因**：DSH 在 **0.2.2-rc.2** 移除 `connection.requestRejection`
（`docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/`：「Connection removes …
`requestRejection` … Use `admit` instead of `requestRejection`」）。原实现查不到该函数即
按设计 fail-closed 403，于是守卫把**所有**路由拦死。`engines.dsh` 无上盖，安装与激活阶段
不会报错，故障被完整掩盖到运行时。

**决策**：守卫式委派按版本择优，两个官方入口都试，语义保持一致：

```js
const admit = connection?.admit;                       // >= 0.2.2-rc.2（唯一入口）
if (typeof admit === "function") {
  const admission = admit.call(connection, trustRequestOf(req));
  return "rejection" in admission ? admission.rejection : undefined;   // {peer} 放行
}
const reject = connection?.requestRejection;           // 0.2.0-rc.1 ~ 0.2.2-rc.1
if (typeof reject === "function") return reject.call(connection, { headers: req.headers }) ?? undefined;
return 403;                                            // 两个都没有 → fail-closed
```

- **admit 优先**：0.2.0-rc.1 起两套 API 共存，0.2.2-rc.2 起只剩 `admit`；先试新 API 既覆盖新区间，
  也让共存区间走官方推荐路径。
- **请求形状**：`admit` 收 `ConnectionTrustRequest`——`headers` 之外需 `method` / `url` /
  `socket`（其来源栅栏读 `host` 头）。`trustRequestOf` 从 Node `req` 补齐，缺 `host` 时补
  可解析的绝对 URL 只为形状完整（无 `host` 时 admit 本身就会 403）。
- **拒绝面不变**：`admit` 内部先过 Host/Origin/sec-fetch-site 栅栏再验凭据，与
  `requestRejection` 同属一道官方围栏；ADR 第 1–3 条的语义三态、「宁可砖不可漏」的
  fail-closed 取向全部保留。
- 不引入本地回落栅栏（第 3 条不变）：服务缺席仍整体 403，写路由仍留 `isSameOriginRequest` 纵深。

**验证**（2026-11-27）：

- `tests/routes.test.mjs`「官方信任检查」组扩到 12 例：admit 拒绝原样下发（401/403/503）、
  admit 放行业务照常、admit 收完整 trust request、旧 API 回落三态、admit 优先于旧 API、
  服务缺席 fail-closed warn-once、无任何 API fail-closed、两种 API 各自抛错 fail-closed、
  非数值 rejection 保守 403、读路由不豁免、64KiB 体积上限。
- 全量 `npm test` 513 通过 / 0 失败；`lib/client.js` 重建后零 diff（本次只动宿主侧）。
- 运行时实测：重载插件后连续请求 `/stock-kanban/{health,state,quotes,search}`，
  诊断日志**不再出现任何 `route.reject`**；返回的 401 来自 DSH 框架层的 Cookie 认证
  （`webServer.register` 的 `auth` 默认 `required`），即插件守卫已放行、由框架正常要求登录。

**遗留**：`engines.dsh` 仍为 `>=0.2.0-rc.1` 无上盖。本次修复让插件同时兼容新旧两代 API，
故下界无需抬升；若日后 DSH 再改该入口，需同步本 ADR 与 `src/access.mjs`。
