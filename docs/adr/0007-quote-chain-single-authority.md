# ADR-0007：行情链单一权威（数据化链表 + attempt 注入 runner）

日期：2026-11-15　状态：已采纳（grill-with-docs 两轮共识；实施计划 `docs/plans/2026-11-15-quote-chain-single-authority-implementation-plan.md`，随 v0.3.5 落地）

「行情链」（GLOSSARY：某市场取数的提供方顺序）这一知识曾有三份手工拷贝——`quotes.mjs` 的 `CHAINS`+`providers[]`（批量快照）、同文件 `fullAdapter`+`getQuoteFull` 循环（详情单码）、`search.mjs` 的 `resolveDirect` try/catch 腿（直连添加校验）——同步靠注释维系（「链序与 quotes.mjs CHAINS.us 一致」）。漂移已实际发生：2026-11-13 `resolveDirect` 缺腾讯美股腿，EM push2 502 + Yahoo 429 期间直连添加全线误报 symbol-not-found（1e31a38 修复）；补新浪一条腿的税是双提交双文件（b87734b + 12bedba）加 mock 扩容。另外 cn/hk 的 K线/分时经 `routes.adapterFor` 只挂腾讯一条腿，从未进链——正是 dce614a 美股指数 K线整块挂的事故形状，只是尚未在 cn/hk 爆。

**决定**：新建 `src/markets/chain.mjs` 作为链与提供方记账的唯一权威。`createChain({ now, diag, ttlMs, providers })` 工厂产出 `{ runChain, health, now }`；失败计数 / 指数退避 / TTL 缓存 / 在途合并三件套随提供方走、整体收进 chain（per-(provider, market) 键，键内再按 `ns` 命名空间分缓存）。四个消费者全部改吃同一 runner：批量快照（quotes.getQuotes）、详情单码（getQuoteFull）、直连添加校验（resolveDirect）、cn/hk K线与分时备源（routes kline/minute）；us 详情内部链维持原样（us-detail 私有缓存/退避暂不并入）。runner interface 为 `runChain(market, ns, codes, attempt, opts)`：`attempt(provider, codes) → Map<code, value>`，**抛错 = 传输失败**；`opts.validate(value) → boolean`，不过 = 无数据；两者合成 per-row 一等语义 `errorKind: 'transport' | 'no-data'`——校验路径的 quote-unavailable ≠ symbol-not-found 由此而来，不再各处私记。字段口径适配（批量 ulist、单码、K线 CSV、分时 trends）留在各消费者与 markets 模块，chain 只管顺序与记账。

## Considered Options

- **四形态大 interface（runner 内置 getBatch/getSingle/getKline/getMinute）**：拒绝——四形态字段口径根本不同，强行收进 chain 会把它变成字段适配垃圾场，interface 撑宽而 depth 下降。
- **只共享链表数据、各调用方保留自己的循环**：拒绝——把注释同步升级成代码同步只解决一半漂移，三本互不知晓的退避账依旧（quotes 有 per-(provider,market) 退避、resolveDirect 全链裸打、us-detail 私有账）。
- **模块单例状态**：拒绝——markets/ 层模块级可变状态已是已知 wart（SECID_CACHE 无 reset、seedUSSecid 暗写）；工厂 + host.mjs 单点装配 + 测试显式建实例，与核心层 DI 惯例（createQuoteService/createRoutes/Store）一致。
- **校验路径绕过退避（用户主动添加低频，怕误伤）**：拒绝——共享账本让校验成功也清零 failures（一次成功校验即上游存活证据，加速全链恢复）；退避期快速失败返回陈旧缓存或 quote-unavailable，不会误拦有效代码。
- **us-detail 内部链并入 chain**：暂缓——其私有缓存/退避/口径一并迁移 diff 大、验证面大，违背「一步动一处」；chain 稳定一个版本后再评估。
- **K线复权口径**：hk 备源腿 fqt=0（对齐腾讯实际输出：qfq 键缺失回落 day，`adjust` 如实上报 none），cn 腿 fqt=1（与腾讯 qfqday 同口径）——避免腾讯挂、EM 接管时同一标的历史价位整体跳变。EM K线 volume 单位与 qfq 有效性以探针实测定口径（§12.52），不预判。

## Consequences

- 补一条腿 = 改 chain 链表一处 + 对应 markets 模块；编排测试（tests/chain.test.mjs，fake providers 直测补位/退避/记账）与传输拓扑测试（globalThis.fetch 桩 + 真实解析函数）各护各的，`mockFetchWorld` 不再随加腿扩容。
- cn/hk K线/分时获得 EM 备源腿（`eastmoney.fetchKline/fetchMinuteDetail` 补 `directSecid` 分支与可选 `adjust` 参数，us 路径行为不变）；腾讯 K线端点不再单点。README 行情来源表同步。
- `fullCache`/`guardedFull`/`fullAdapter` 删除，双份记账归一；单码请求 = 长度 1 的 code-set，缺行随成功响应进 TTL 缓存（10s 窗口，详情轮询 15s 自愈，行为差异可忽略）。
- 校验请求完全继承提供方退避（与轮询同账同罚同恢复）。
- 与 ADR-0006 无冲突（0006 管搜索源分工：池 vs 在线；本 ADR 管取数链形状）；ADR-0004（渲染漏斗）、ADR-0005（路由围栏）不触碰。client 零改动，`lib/client.js` 产物无 diff。
