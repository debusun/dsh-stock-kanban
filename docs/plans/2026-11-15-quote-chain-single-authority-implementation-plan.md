# 行情链单一权威（ADR-0007）实施计划

## 目标

- 把「行情链」收拢为单一深模块：新建 `src/markets/chain.mjs`（数据化链表 + 提供方注册表 + per-(provider, market) 记账 + `runChain` runner），四个消费者（批量快照、详情单码、直连添加校验、cn/hk K线与分时备源）全部改吃同一 runner，删除 `resolveDirect` 与 `fullAdapter`/`guardedFull` 两份手工拷贝。
- cn/hk K线/分时获得 EM 备源腿（腾讯 K线端点不再单点）；us 详情内部链维持原样。
- 对外契约不变：路由响应形状逐字段不变、client 零改动（`lib/client.js` 应零 diff）、i18n 键不变。
- 落档：验证记录 `docs/verification.md` 追记 §12.52；随 v0.3.5 发版。
- 明确非目标：us-detail 内部链不并入；client 不改；不加路由响应字段；不动 ADR-0004/0005/0006 定案。

## 架构快照

- 现状：链知识三份拷贝——`quotes.mjs` 的 `CHAINS`+`providers[]`+`fetchProvider`（批量）、同文件 `fullAdapter`+`guardedFull`+`getQuoteFull` 循环（详情单码）、`search.mjs` `resolveDirect` 手写腿（校验）；cn/hk K线/分时经 `routes.adapterFor` 只挂腾讯。三份退避/缓存账互不知晓；同步靠注释（search.mjs「链序与 quotes.mjs CHAINS.us 一致」）。
- 本次：`chain.mjs` 导出 `CHAINS`（快照链表，现值 cn: tencent→eastmoney→sina；hk: tencent→eastmoney；us: eastmoney→tencent-us→yahoo；crypto: okx）与 `createChain({ now, diag, ttlMs, backoffBaseMs, backoffMaxMs, providers })` 工厂。三件套记账（失败计数/指数退避/TTL 缓存/在途合并）整体进 chain，键为 `provider|market`，缓存键 `ns|codes`（ns 区分快照/K线/分时形态）。runner 统一 attempt 形态：单码 = 长度 1 的 code-set，不再有第二条循环。
- `quotes.mjs` 瘦身为行情域语义层：按市场分组 → `runChain` → 行整形（id/identity/status/quote/fetchedAt/quoteTime/source/fallbackFrom/error），`price > 0` 有效判留在本层；`health()` 薄转发 chain。
- `resolveDirect(market, code, { chain })`：校验 = 单码过链，`errorKind` 直接映射 quote-unavailable（transport）/ symbol-not-found（no-data）。
- `routes.mjs`：kline/minute 对 cn/hk/crypto 改走链（attempt 表按提供方静态装配，EM 腿按市场给 adjust：hk=none、cn=qfq）；us 仍走 us-detail 适配器；响应 JSON 形状不变。
- `eastmoney.mjs`：`fetchKline`/`fetchMinuteDetail` 补 `directSecid` 分支（现无条件 `resolveUSSecid`，cn/hk 代码取不到 secid）与可选 `adjust` 参数（缺省 qfq，us-detail 零感知）。
- 测试分工：`tests/chain.test.mjs` 用 fake providers 直测编排（离线）；既有 fetch 桩套件全保留护 URL 拓扑；probe 脚本补真上游口径核对。

## 全局约束

- 运行时零 npm 依赖；本计划不新增任何依赖（devDeps 不动）。
- `npm test` 保持全离线：新增用例一律 fake providers 或 fetch stub 封闭，绝不触网；探针（Task 7）是唯一真上游动作，且不进测试。
- 对外契约冻结：不改 `client/`、不加路由响应字段、不改 i18n 键；`lib/client.js` 全程零 diff（发版时 build+diff 断言仍须绿）。
- 文件编辑前必先 read 同一文件；文件读写走 OPS 工具，构建/测试/git 走 bash；`grep -c` 计 0 即 exit 1，禁入 `&&` 链。
- build/test 前 `test -d node_modules`，缺失先 `npm ci`（联网 npm 命令加 `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban`）；确认无 headless chrome 进程。
- Node ≥20；bash（Linux）；仓库 `/home/ubuntu/workspace/dsh-stock-kanban`；仓库惯例 main 直推，开始实现前与主人确认一次。
- 发版纪律照 AGENTS.md：轻量 tag；先 fix/feat 提交（不含版本号）再 `chore(release): vX.Y.Z`；推送前 `scripts/ci-parity.sh`；`release-monitor.sh` 两阶段轮询，窗口内不重推 tag。
- 验证记录新编号取 §12.51 的下一个：**§12.52**；目标版本 **v0.3.5**（v0.3.4 已发，tag 在）。

## 输入工件

- grill-with-docs 两轮共识（2026-11-15）：R1 Q1–Q8 全按推荐（落位 chain.mjs / attempt 注入 / errorKind 上提 / 校验吃退避 / cn-hk K线补腿 / providers 注入 / ADR+GLOSSARY / 发版）；R2 Q1–Q4 全按推荐（工厂装配 / fullCache 删除+缺行缓存 / hk fqt=0 cn fqt=1 / 测试分工）。
- `docs/adr/0007-quote-chain-single-authority.md`（已落盘）；GLOSSARY「行情链」「报价校验」修订（已落盘）。
- 事实底账：`resolveDirect` 缺腿事故 1e31a38（2026-11-13）；双提交补腿 b87734b + 12bedba；`eastmoney.fetchKline` 硬编码 fqt=1 且无条件 `resolveUSSecid`（L248–259）；腾讯 K线 qfq 键缺失回落 day → adjust 'none'（tencent.mjs L193–202）；`docs/verification.md` 末尾 §12.51；package.json 0.3.4 已发。

## 文件结构与职责

- Create: `src/markets/chain.mjs` —— 链表、提供方注册表（import 六个 markets 模块）、记账三件套、`runChain`、`health`。
- Modify: `src/quotes.mjs` —— 删 `CHAINS`/`providers[]`/`fetchProvider`/`guardedFull`/`fullCache`/`fullAdapter` 与两条链循环；构造器改 `{ chain }`；保留行整形与 `health` 薄转发。
- Modify: `src/host.mjs`（`apply()` 内装配点，现 `createQuoteService({ diag })` 一行处）—— 建 chain 单点，注入 quotes 与 routes。
- Modify: `src/routes.mjs` —— `deps.chain` 必填；`addSymbolRoute` 传 chain；kline/minute 对 cn/hk/crypto 改走链；`adapterFor` 收窄为 us 专用。
- Modify: `src/markets/search.mjs`（`resolveDirect`）—— 删手写腿，签名加 `{ chain }`。
- Modify: `src/markets/eastmoney.mjs`（`fetchKline`/`fetchMinuteDetail`）—— `directSecid` 分支 + 可选 `adjust`。
- Test: `tests/chain.test.mjs`（Create）—— fake providers 编排套件。
- Modify: `tests/quotes-service.test.mjs`、`tests/quotes-full-us.test.mjs`、`tests/quotes-us-chain.test.mjs`、`tests/routes.test.mjs` —— 构造适配（createChain 注入；createQuoteService 调用面全量清点 = 此 4 个测试文件 + src/host.mjs，逐处适配，既有桩用例逐条保留）。
- Modify: `tests/search-index.test.mjs` —— resolveDirect 调用传 chain 实例。
- Modify: `tests/providers-eastmoney.test.mjs` —— K线/分时 secid 分支与 adjust 用例。
- Modify: `scripts/probe-markets.mjs` —— EM cn/hk K线与 cn 分时真上游探针。
- Modify: `README.md`（「行情来源与限制」表 L95–98）—— cn/hk K线备源列。
- Modify: `docs/verification.md` —— 末尾追记 §12.52。

## 任务清单

### Task 1: chain.mjs 骨架 + 基础编排三例（红→绿）

- 目标：`createChain`/`runChain` 最小实现，钉死 attempt/validate/cell 契约。
- 涉及文件：Create `tests/chain.test.mjs`、Create `src/markets/chain.mjs`。
- 接口契约：
  - Consumes: 现有提供方模块形态 `{ handles(market)→bool, fetch(codes)→Map<code,quote>, quoteTime?(quote)→ms|null }`（`src/markets/tencent.mjs` 等六个）。
  - Produces: `createChain({ now, diag, ttlMs = 10000, backoffBaseMs = 30000, backoffMaxMs = 300000, providers = 内置表 }) → { runChain, health, now }`；`runChain(market, ns, codes, attempt, { validate, supports }) → Promise<Map<code, cell>>`，`attempt(provider, codes) → Promise<Map<code, value>>`（抛错=传输失败），`validate(value) → boolean`（必填），`supports(provider) → boolean`（缺省 `provider.handles(market)`）；`cell = { ok, value, quoteTime, source, fallbackFrom, error, errorKind }`，`errorKind ∈ 'transport' | 'no-data' | null`；`cell.quoteTime = provider.quoteTime ? provider.quoteTime(value) : (value?.quoteTimeMs ?? null)`；**cell 值语义（钉死）**：ok cell → `value`=供数源对该码返回的原值、`error`=null；no-data cell（validate 耗尽）→ `value`=末源对该码返回的原值、`error`=null；transport cell（全链抛错）→ `value`=null、`error`=末次 attempt 错误消息。Task 2/3/5/6 按此签名消费。
- 验证范围：`node scripts/run-tests.mjs tests/chain.test.mjs` 红→绿；不触其他测试。

- [ ] Step 1: 写失败测试。`tests/chain.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createChain } from "../src/markets/chain.mjs";

/* 行情链 runner 编排套件：fake providers 直测，全离线。
   契约（ADR-0007）：attempt 抛错=传输失败；validate 不过=无数据；
   cell.errorKind ∈ transport|no-data|null；补位行标 fallbackFrom。 */

const P = (name, map, { throw: thr = false } = {}) => ({
  name,
  handles: () => true,
  fetch: thr ? async () => { throw new Error(name + "-down"); } : async (codes) => map,
  quoteTime: null,
});
const q = (price) => ({ price, name: "n", quoteTimeMs: 1 });

test("runChain：单源成功，cell 带 source 与 quoteTime", async () => {
  const chain = createChain({ providers: [P("a", new Map([["x", q(10)]]))] });
  const out = await chain.runChain("cn", "t", ["x"], (p, codes) => p.fetch(codes), { validate: (v) => v && v.price > 0 });
  const cell = out.get("x");
  assert.equal(cell.ok, true);
  assert.equal(cell.source, "a");
  assert.equal(cell.quoteTime, 1);
  assert.equal(cell.errorKind, null);
});

test("runChain：首源缺行 → 次源补位，fallbackFrom=首源", async () => {
  const chain = createChain({ providers: [P("a", new Map()), P("b", new Map([["x", q(10)]]))] });
  const out = await chain.runChain("cn", "t", ["x"], (p, codes) => p.fetch(codes), { validate: (v) => v && v.price > 0 });
  const cell = out.get("x");
  assert.equal(cell.ok, true);
  assert.equal(cell.source, "b");
  assert.equal(cell.fallbackFrom, "a");
});

test("runChain：全链传输失败 → ok:false + errorKind transport", async () => {
  const chain = createChain({ providers: [P("a", null, { throw: true }), P("b", null, { throw: true })] });
  const out = await chain.runChain("cn", "t", ["x"], (p, codes) => p.fetch(codes), { validate: (v) => v && v.price > 0 });
  const cell = out.get("x");
  assert.equal(cell.ok, false);
  assert.equal(cell.errorKind, "transport");
  assert.match(cell.error, /b-down/);
});
```

- Run: `node scripts/run-tests.mjs tests/chain.test.mjs`
- Expected: 红——`Cannot find module '../src/markets/chain.mjs'`（createChain 不存在）。
- [ ] Step 2: 写最小实现。`src/markets/chain.mjs`：头部注释写定案（ADR-0007 摘要 + attempt/validate/errorKind 契约）；import 六个提供方模块；导出 `CHAINS`（现值四市场）；`createChain` 内置 `providers` 表（name/handles/fetch/quoteTime，quoteTime：tencent→`tencentQuoteTime`、tencent-us→`tencentUsQuoteTime`、其余 null）；`runChain` 按 `CHAINS[market]` 顺序逐源：`supports` 过滤 → try `attempt`（throw 记 transport、`fallbackFrom` 首错源）→ 对返回 Map 逐码 `validate`（不过=该码交下源并记 fallbackFrom）→ 全链耗尽的码出 `errorKind` cell（**值语义钉死**：no-data cell 的 `value`=末源对该码返回的原值——Task 6 的 `cell.value?.error` 保真映射依赖此语义；transport cell 的 `value`=null、`error`=末次 attempt 错误消息）；未耗尽的码出 ok cell（source/fallbackFrom/quoteTime）。diags：真实 attempt 抛错时发 `{ ev: "provider.fail", provider, market, error, failures, backoffMs }`（try/catch 包裹，诊断不得影响行情）。
- [ ] Step 3: 运行确认通过。
- Run: `node scripts/run-tests.mjs tests/chain.test.mjs`
- Expected: 3 用例全绿。

### Task 2: chain 记账面用例补齐（红→绿）

- 目标：退避跳源与快速失败、成功清零、no-data errorKind、TTL 缓存与 ns 隔离、缺行随成功缓存、health() 嵌套载荷。
- 涉及文件：Modify `tests/chain.test.mjs`（追加用例）、Modify `src/markets/chain.mjs`（记账实现）。
- 接口契约：
  - Consumes: Task 1 的 `createChain`/`runChain` 签名与 cell 形状。
  - Produces: `health()` 载荷**两层契约，逐字镜像现 `quotes.mjs health()`**：顶层 provider 键 = providers 表全量恒在（未触达 = 空对象 `{}` 占位）；market 子键仅在触达时出现，形状 `{ failures, backoffRemainMs, lastOkAt, lastErrorAt, lastError }`。依据：routes.test.mjs L197 既有断言（fresh server 上 `providers.tencent !== undefined`，注释「未触达时 provider 键存在但为空对象」）+ verification.md §12.49 档同口径——顶层过滤即破坏「路由响应形状逐字段不变」冻结。记账键 `provider|market`、缓存键 `ns|codes 排序拼接`；退避窗口内该源被跳过不打上游（调用计数断言依据）。
- 验证范围：`node scripts/run-tests.mjs tests/chain.test.mjs` 全绿。

- [ ] Step 1: 追加用例（逐字使用，接在 Task 1 用例后；`q` 复用 Task 1 的定义，不重复声明）：

```js
const counting = (name, map, { throw: thr = false } = {}) => {
  const p = P(name, map, { throw: thr });
  let calls = 0;
  return Object.assign(p, {
    fetch: thr ? async () => { calls++; throw new Error(name + "-down"); } : async (codes) => { calls++; return map; },
    calls: () => calls,
  });
};

test("runChain：传输失败进退避，窗口内跳源快速失败，成功清零", async () => {
  let t = 1000;
  let badDown = true;
  let badCalls = 0;
  const bad = { name: "bad", handles: () => true, quoteTime: null, fetch: async () => { badCalls++; if (badDown) throw new Error("bad-down"); return new Map([["x", q(10)]]); } };
  const good = counting("good", new Map([["x", q(10)]]));
  const chain = createChain({ now: () => t, backoffBaseMs: 100, providers: [bad, good] });
  const run = () => chain.runChain("cn", "t", ["x"], (p, c) => p.fetch(c), { validate: (v) => v && v.price > 0 });
  await run(); // bad 抛 → good 补位，bad.failures=1
  await run(); // bad 在退避窗口内被跳过（不打上游），good 直接供数
  assert.equal(badCalls, 1, "退避期内不得重打死源");
  t += 200; // 越过退避窗口
  await run();
  assert.equal(badCalls, 2, "退避过期后恢复尝试");
  badDown = false; // 源恢复
  await run();
  assert.equal(chain.health().bad.cn.failures, 0, "真实成功清零");
});

test("runChain：validate 不过耗尽 → errorKind no-data", async () => {
  const chain = createChain({ providers: [P("a", new Map([["x", q(0)]])), P("b", new Map([["x", q(0)]]))] });
  const out = await chain.runChain("cn", "t", ["x"], (p, c) => p.fetch(c), { validate: (v) => v && v.price > 0 });
  assert.equal(out.get("x").errorKind, "no-data");
  assert.equal(out.get("x").value?.price, 0, "no-data cell 携带末源原值（Task 6 保真映射依赖）");
});

test("runChain：TTL 缓存命中不打上游；ns 隔离；缺行随成功响应缓存", async () => {
  let t = 1000;
  const p = counting("a", new Map([["x", q(10)]]));
  const chain = createChain({ now: () => t, ttlMs: 1000, providers: [p] });
  const run = () => chain.runChain("cn", "t", ["x"], (pp, c) => pp.fetch(c), { validate: (v) => v && v.price > 0 });
  await run(); await run();
  assert.equal(p.calls(), 1, "TTL 内命中缓存");
  await chain.runChain("cn", "other", ["x"], (pp, c) => pp.fetch(c), { validate: (v) => v && v.price > 0 });
  assert.equal(p.calls(), 2, "ns 隔离，不同命名空间各打各的");
  const empty = counting("e", new Map());
  const c2 = createChain({ now: () => t, ttlMs: 1000, providers: [empty, p] });
  await c2.runChain("cn", "t", ["x"], (pp, c) => pp.fetch(c), { validate: (v) => v && v.price > 0 });
  await c2.runChain("cn", "t", ["x"], (pp, c) => pp.fetch(c), { validate: (v) => v && v.price > 0 });
  assert.equal(empty.calls(), 1, "缺行随成功响应缓存：TTL 内不重打缺行源");
});

test("health()：顶层 provider 键恒在（未触达=空对象占位），market 子键仅触达——镜像现契约", async () => {
  const p = counting("a", new Map([["x", q(10)]]));
  const untouched = counting("z", new Map());
  const chain = createChain({ providers: [p, untouched] });
  await chain.runChain("cn", "t", ["x"], (pp, c) => pp.fetch(c), { validate: (v) => v && v.price > 0 });
  const h = chain.health();
  assert.deepEqual(Object.keys(h).sort(), ["a", "z"], "顶层键 = providers 表全量");
  assert.deepEqual(h.z, {}, "未触达 provider = 空对象占位（routes.test L197 契约）");
  assert.equal(h.a.cn.failures, 0);
  assert.equal(typeof h.a.cn.lastOkAt, "number");
});
```

- Run: `node scripts/run-tests.mjs tests/chain.test.mjs`
- Expected: 红——退避/缓存/health 行为尚未实现（failures 计数缺失、重复打源、health 形状不符）。
- [ ] Step 2: 实现记账：per-`provider|market` 状态（failures/backoffUntil/lastOkAt/lastErrorAt/lastError，移植现 `quotes.mjs` `stateOf`/`backoffMs` 语义）；缓存 `Map(ns|codes → {at, rows})` + 在途合并 `Map(ns|codes → Promise)`（移植现 `fetchProvider` 语义）；退避跳过 = 直接视该源传输失败（不发 diag、不计 failures，与现「backoff 快速失败不发 provider.fail」一致）；transport 错误不写缓存，成功响应整体写缓存（缺行随行）。
- [ ] Step 3: 运行确认全部用例绿。
- Run: `node scripts/run-tests.mjs tests/chain.test.mjs`
- Expected: 全绿（Task 1 三例不回归）。

### Task 3: quotes.mjs 迁移（删两条链循环）+ 三处测试构造适配

- 目标：`getQuotes`/`getQuoteFull` 统一走 chain，`quotes.mjs` 只剩行情域语义；对外签名与返回形状逐字段不变。
- 涉及文件：Modify `src/quotes.mjs`、`tests/quotes-service.test.mjs`、`tests/quotes-full-us.test.mjs`、`tests/routes.test.mjs`（仅构造适配）。
- 接口契约：
  - Consumes: Task 1/2 的 `createChain`/`runChain`/`health` 契约；现有提供方模块（经 chain 内置表，quotes.mjs 不再直接 import markets/*）。
  - Produces: `createQuoteService({ chain })`（chain 必填，缺省抛错）；`getQuotes(identities)`/`getQuoteFull(identities)` 返回 Map 形状不变（`{ id, identity, status, quote, fetchedAt, quoteTime, source, fallbackFrom, error }`；error 行 quoteTime/source/fallbackFrom 恒 null，照旧）；`health()` 薄转发 `chain.health()`（两层契约不变：顶层 provider 键恒在空对象占位、market 子键仅触达）。Task 5/6/Task-host 消费。
- 验证范围：`npm test` 全套绿（既有桩用例逐条保留，行为不回归）。

- [ ] Step 1: 失败信号先行——`tests/quotes-service.test.mjs` 顶部新增构造器契约用例：

```js
test("createQuoteService：chain 必填（ADR-0007）", () => {
  assert.throws(() => createQuoteService({}), /chain/);
});
```

（现构造器解构不校验 chain → 不抛 → **红**；Step 2 落地后绿，钉死必填契约。仅把既有构造改成 chain 注入不会红——现构造器静默忽略未知键、行为等价全绿，这正是需要显式契约用例的原因。）顺带把 `tests/quotes-full-us.test.mjs` 头部构造改为 chain 注入（`createQuoteService({ ttlMs: 0 })` → `createQuoteService({ chain: createChain({ ttlMs: 0 }) })`，加 `import { createChain } from "../src/markets/chain.mjs"`），验证注入形态行为等价（保持绿）。
- Run: `node scripts/run-tests.mjs tests/quotes-service.test.mjs && node scripts/run-tests.mjs tests/quotes-full-us.test.mjs`
- Expected: 红绿分明——新契约用例红；quotes-service/quotes-full-us 既有用例全绿。
- [ ] Step 2: 重写 `src/quotes.mjs`：删 `CHAINS`/`providers[]`/`fetchProvider`/`guardedFull`/`fullCache`/`fullAdapter` 与 `getQuotes`/`getQuoteFull` 内的链循环；`createQuoteService({ chain })`（无 chain 即 throw）；一个内部函数按市场分组 → `chain.runChain(market, "snap", codes, (p, cs) => p.fetch(cs), { validate: (v) => v && v.price > 0 })` → 行整形（`getQuotes` 全量、`getQuoteFull` 单码形态共用该路径；fetchedAt 取 `chain.now()`）；error 行 `error = cell.error ?? "no-data"`；`health()` 薄转发。头部注释改写为 ADR-0007 摘要（保留 §12.45/§12.46 语义说明迁移至 chain.mjs 头注）。
- [ ] Step 3: 适配其余构造：`tests/quotes-service.test.mjs` 全部 `createQuoteService({ ttlMs, now, diag })` → `createQuoteService({ chain: createChain({ ttlMs, now, diag }) })`（逐处保留原注入值）；`tests/quotes-full-us.test.mjs` 四处 `createQuoteService({ ttlMs: … })` 同款注入；`tests/quotes-us-chain.test.mjs` L21 `createQuoteService({ ttlMs: 0 })` → `createQuoteService({ chain: createChain({ ttlMs: 0 }) })`（它测 us 快照链序，行为被保留，仅构造适配）；`tests/routes.test.mjs` `startServer` 内 `createQuoteService({})` → `createQuoteService({ chain: createChain({}) })`。**桩用例与断言逐条不动**（mockFetchWorld 护 URL 拓扑，正是分工设计）。
- [ ] Step 4: 全套验证。
- Run: `npm test`
- Expected: 全绿；`git diff --stat lib/client.js` 为空（client 未动）。

### Task 4: eastmoney K线/分时扩展（directSecid 分支 + adjust 参数）

- 目标：cn/hk 代码能取到 EM secid 并按市场控制复权口径；us 路径行为不变。
- 涉及文件：Modify `src/markets/eastmoney.mjs`（`fetchKline`/`fetchMinuteDetail`）、Modify `tests/providers-eastmoney.test.mjs`。
- 接口契约：
  - Consumes: 本文件既有 `directSecid(code)`（string=直接映射 / null=美股需探测 / undefined=EM 不服务）与 `resolveUSSecid(code, { strict })`。
  - Produces: `fetchKline(code, period, { adjust = "qfq" } = {})`——fqt = adjust === "none" ? 0 : 1；secid 解析序：`directSecid` string 直用 → null 走 `resolveUSSecid` strict → undefined 返回 `not-found`（不发网络）；`fetchMinuteDetail` 同 secid 分支（无 adjust）。Task 6 的 EM K线腿按市场传 `{ adjust: "none" | "qfq" }`。
- 验证范围：`node scripts/run-tests.mjs tests/providers-eastmoney.test.mjs` 红→绿。

- [ ] Step 1: 写失败测试（追加到 `tests/providers-eastmoney.test.mjs`；该文件为具名导入，把 `fetchKline` 加入既有 `import { directSecid, fetchBatchSnapshots, fetchQuote, resolveUSSecid } from "../src/markets/eastmoney.mjs"` 列表）：

```js
test("fetchKline：cn 代码走 directSecid（secid=1.600519，fqt=1），不触发美股探测", async () => {
  const urls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new Error("stop"); };
  try {
    await fetchKline("sh600519", "day");
  } catch { /* 网络桩截停即可，断言 URL 形状 */ }
  finally { globalThis.fetch = orig; }
  assert.ok(urls.some((u) => u.includes("secid=1.600519") && u.includes("fqt=1")), urls.join("|"));
  assert.ok(!urls.some((u) => u.includes("fields=f57")), "不得走美股 secid 探测端点");
});

test("fetchKline：hk + adjust none → fqt=0；hkHSI 别名 → not-found 零网络", async () => {
  const urls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new Error("stop"); };
  try {
    await fetchKline("hk00700", "day", { adjust: "none" }); // 红相：走美股探测（URL 形状错）；绿相：directSecid 直映 116.00700 + fqt=0（URL 已记）
    const r = await fetchKline("hkHSI", "day", { adjust: "none" }); // 必须在 stub 区内：绿相 directSecid undefined → 零网络 not-found；红相探测被桩截停 → fetch-failed（断言红且离线）
    assert.ok(urls.some((u) => u.includes("secid=116.00700") && u.includes("fqt=0")), urls.join("|"));
    assert.equal(r.error, "not-found");
  } finally { globalThis.fetch = orig; }
});
```

```js
test("fetchKline：美股 secid 探测传输失败 → fetch-failed 形态，不抛穿（§12.32 契约，回归守卫）", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("HTTP 502"); };
  try {
    const r = await fetchKline("NVDA", "day"); // directSecid=null → 走严格探测
    assert.equal(r.candles.length, 0);
    assert.equal(r.error, "fetch-failed");
    assert.match(r.errorDetail ?? "", /secid-transport/);
  } finally { globalThis.fetch = orig; }
});
```

（前两例红——directSecid 分支缺失；第三例为**回归守卫**：现实现已绿（try/catch 包探测，eastmoney.mjs L249–254），改造后必须仍绿——us-detail.mjs L182/201 裸 await 靠 error 对象契约回退，抛穿即 us K线/分时 500。三例全部在 stub 区内断言，零触网。）
- Run: `node scripts/run-tests.mjs tests/providers-eastmoney.test.mjs`
- Expected: 红绿混合——前两例红（现 `fetchKline` 对 `sh600519` 走 `resolveUSSecid`，URL 出现 `fields=f57` 探测端点，且无 fqt=0 形态），第三例绿（既有 try/catch 契约）。
- [ ] Step 2: 改实现：两函数 secid 解析改为（**保留 §12.32 try/catch 契约**，`fetchMinuteDetail` 空壳字段换为 date/prevClose/points 同型）：

```js
const direct = directSecid(code);
let secid = typeof direct === "string" ? direct : null;
if (direct === null) {
  try {
    secid = await resolveUSSecid(code, { strict: true });
  } catch (e) {
    return { candles: [], adjust: null, error: "fetch-failed", errorDetail: String(e?.message ?? e).slice(0, 80) }; // 对齐既有 errorDetail 惯例（eastmoney L188/253 同 slice 80）
  }
} else if (direct === undefined) {
  return { candles: [], adjust: null, error: "not-found" }; // hkHSI 等别名不经 EM，零网络
}
if (!secid) return { candles: [], adjust: null, error: "not-found" };
```

`fetchKline` 加第三参 `{ adjust = "qfq" } = {}`，URL `fqt=` 处取 `adjust === "none" ? 0 : 1`；返回值 `adjust` 字段如实（none 时 `'none'`）。us 既有用例零改动须仍绿。
- [ ] Step 3: 运行确认。
- Run: `node scripts/run-tests.mjs tests/providers-eastmoney.test.mjs && node scripts/run-tests.mjs tests/us-detail.test.mjs`
- Expected: 两文件全绿（us-detail 是 adjust 缺省 qfq 的回归面）。

### Task 5: search.mjs resolveDirect 迁移（删手写腿）

- 目标：校验路径改单码过链，`quote-unavailable`/`symbol-not-found` 语义由 errorKind 映射。
- 涉及文件：Modify `src/markets/search.mjs`（`resolveDirect` 及文件头定案清单）、Modify `tests/search-index.test.mjs`。
- 接口契约：
  - Consumes: Task 1/2 runner 契约（cell.errorKind）；Task 3 之后 chain 为唯一记账。
  - Produces: `resolveDirect(market, code, { chain })`——chain 必填（缺省解构后判空 throw `"chain-required"`）；返回形状不变（`{ ok: true, identity, name, kind } | { ok: false, error }`）。Task 6 的 `addSymbolRoute` 消费。
- 验证范围：`node scripts/run-tests.mjs tests/search-index.test.mjs` 与全套绿。

- [ ] Step 1: 失败信号先行——`tests/search-index.test.mjs` 顶部加 `import { createChain } from "../src/markets/chain.mjs";`，既有 6 处 `resolveDirect(market, code)` 调用全部改为 `resolveDirect(market, code, { chain })`，每个相关 test 内 `const chain = createChain();`（每用例独立实例，避免文件级账本串味）。**并改写既有钉死断言**（L189–201，现为「cn 腾讯+EM+新浪三源全灭 → 维持现状 symbol-not-found」评审 R1-3 pin）：标题改为「cn 腾讯+EM+新浪三源全灭 → quote-unavailable（ADR-0007 supersede 旧 R1-3 pin：全链传输失败不再伪装标的不存在）」，断言 `dead.error === "symbol-not-found"` 改为 `=== "quote-unavailable"`。
- Run: `node scripts/run-tests.mjs tests/search-index.test.mjs`
- Expected: 红——**红前提 = 被改写的 L201 断言**（现 `resolveDirect` 全链传输失败仍返 symbol-not-found；仅把调用改传 chain 不会红，现签名静默忽略第三参），其余既有用例绿。
- [ ] Step 2: 改实现：`resolveDirect` 删 cn/hk/us/crypto 四段手写 try/catch 腿与 `transportFailed` 私账；改为 `const cells = await chain.runChain(market, "snap", [identity.code], (p, cs) => p.fetch(cs), { validate: (v) => v && v.price > 0 }); const cell = cells.get(identity.code);`；`cell.ok` → 取 `quote = cell.value` 照旧走名称/kind 出口；`!cell.ok` → `error: cell.errorKind === "transport" ? "quote-unavailable" : "symbol-not-found"`。文件头定案清单补一行「校验链 = 行情链（ADR-0007）」。仅被校验路径使用的提供方 import 随之清理（`parseSmartbox` 的 `seedUSSecid` 依赖保留）。
- [ ] Step 3: 运行确认。
- Run: `node scripts/run-tests.mjs tests/search-index.test.mjs && npm test`
- Expected: search-index 全绿（含既有「直连添加全源挂报 quote-unavailable」用例）；全套绿。

### Task 6: routes.mjs 接线（deps.chain + K线/分时入链）

- 目标：路由层消费 chain；cn/hk K线/分时获 EM 备源腿；响应 JSON 形状逐字段不变。
- 涉及文件：Modify `src/routes.mjs`、Modify `tests/routes.test.mjs`、Modify `src/host.mjs`。
- 接口契约：
  - Consumes: Task 3 `createQuoteService({ chain })`；Task 4 EM `{ adjust }`；Task 5 `resolveDirect(market, code, { chain })`。
  - Produces: `createRoutes({ store, quotes, chain, logger, trust, diag })`（chain 必填）；`adapterFor` 收窄为 `market === "us"` 专用（us-detail 自管链不变）；cn/hk/crypto K线/分时响应字段与现一致（id/period/candles/adjust/error/errorDetail + id/date/prevClose/points/error/errorDetail/updatedAt）。Task 7/8/9 消费运行态。
- 验证范围：`node scripts/run-tests.mjs tests/routes.test.mjs` 红→绿；全套绿。

- [ ] Step 1: 写失败测试（追加到 `tests/routes.test.mjs`，沿用其 `startServer`/`t.j`/`H(t.base)` 既有形态；startServer 须同步给 `createRoutes` 传 `chain: createChain({})`——构造适配属本步）：

```js
test("K线：cn 腾讯腿挂 → EM 腿补位（fqt=1），响应形状不变", async () => {
  const t = await startServer();
  const orig = globalThis.fetch;
  const jsonOk = (body) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(body), "utf8"), json: async () => body });
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes("secid=1.600519") && s.includes("kline")) return jsonOk({ data: { klines: ["2026-11-14,10,11,12,9,1000", "2026-11-15,11,12,13,10,2000"] } });
    throw new Error("down"); // 其余一律失败（含腾讯 K线）
  };
  try {
    const res = await t.j("/stock-kanban/kline?id=cn:sh600519&period=day", { headers: H(t.base) });
    assert.equal(res.error, null);
    assert.equal(res.candles.length, 2);
    assert.equal(res.adjust, "qfq");
    assert.equal(res.errorDetail, null);
  } finally { globalThis.fetch = orig; }
});
```

（`startServer` 返回的 `t` 携带 `base`/`j`——与文件既有用法一致；新测试不套 `mockUpstream`，桩测试内自装自卸。）
- Run: `node scripts/run-tests.mjs tests/routes.test.mjs`
- Expected: 红——现 `adapterFor` 对 cn 只挂腾讯，腾讯挂即整块 fetch-failed。
- [ ] Step 2: 改实现：`createRoutes` 解构加 `chain`（缺失 throw）；`addSymbolRoute` 改 `resolveDirect(market, code, { chain: deps.chain })`；`adapterFor` 收窄 us；kline/minute 处理器对 cn/hk/crypto 装配 attempt 表（handler 内动态 import，保持本文件 markets 动态 import 惯例）——kline：`tencent.fetchKline(code, period)`、`eastmoney.fetchKline(code, period, { adjust: market === "hk" ? "none" : "qfq" })`、`okx.fetchKline(code, period)`；minute：`tencent.fetchMinuteDetail(code)`、`eastmoney.fetchMinuteDetail(code)`、`okx.fetchMinuteDetail(code)`；attempt 包装契约：返回结果 `error === "fetch-failed"` 时 throw（=传输失败），否则入 Map；`validate`：kline `r && !r.error && r.candles?.length > 0`，minute `r && !r.error && r.points?.length >= 2`；`supports = (p) => p.name in 表`；`ns` 分别 `"kline:" + period`、`"minute"`。全链失败映射：`errorKind === "transport"` → `{ …空壳, error: "fetch-failed", errorDetail: cell.error }`；`no-data` → `error: cell.value?.error ?? "no-data"`、`errorDetail: cell.value?.errorDetail ?? null`（**保留末源错误码**——tencent `api-error`、okx `invalid-code` 等不被吞成泛化 no-data；响应形状逐字段不变）。空壳字段与现响应一致：kline candles:[] adjust:null，minute date:null prevClose:null points:[]；成功 cell 的 `value` 即原 result，走既有响应装配与「<2 点按 no-data」归一逻辑不变。
- [ ] Step 3: host.mjs 装配：`const chain = createChain({ diag: (row) => diag.append(row) }); const quotes = createQuoteService({ chain });` → `createRoutes({ store, quotes, chain, logger, trust, diag })`。
- [ ] Step 4: 运行确认。
- Run: `node scripts/run-tests.mjs tests/routes.test.mjs && npm test`
- Expected: routes 全绿（既有 18 用例——评审 runner 实测计数——加新备源用例）；全套绿。

### Task 7: probe 真上游口径核对（唯一真网络任务）

- 目标：实测 EM cn/hk K线与 cn/hk 分时、us 回归共五项口径，作为 §12.52 记录与 Task 6 口径的实证收口。
- 涉及文件：Modify `scripts/probe-markets.mjs`。
- 接口契约：
  - Consumes: Task 4 的 `eastmoney.fetchKline/fetchMinuteDetail`（探针纪律：import 生产解析函数，不得复制正则）；既有 `probe()`/`getText()` 骨架。
  - Produces: 探针结果 JSON（`probe-result.json` 惯例），五项结论写入 Task 9 的 §12.52。
- 验证范围：手动跑（联网），逐项读数记录；非测试，不进 npm test。

- [ ] Step 1: 追加五个探针：`em-cn-kline`（sh600519 day，记录 volume 原始值与腾讯同代码同日期归一值对照——volume 单位裁决）、`em-hk-kline-none`（hk00700 day `{ adjust: "none" }`，断言可用且价位与腾讯 day 同量级）、`em-cn-minute`（sh600519 trends2 可用性）、`em-hk-minute`（hk00700 trends2 + secid 116.00700 可用性——Task 6 hk 分时 EM 腿的真上游证据）、`em-us-kline-regression`（NVDA day 缺省 qfq 回归对照）。
- [ ] Step 2: 跑探针。
- Run: `node scripts/probe-markets.mjs`
- Expected: 五项 ok:true；读数记录（volume 单位若与腾讯归一口径不一致 → 在 Task 6 的 EM kline attempt 内加 `klineVolumeToShares` 同款归一并复跑本步，修正后 README 口径句随之）。网络不可达时如实记「探针未执行」，不伪造。
- [ ] Step 3: 结果留档：输出 JSON 存 `docs/reports/`（该目录既有惯例；若仅控制台输出则复制粘贴进 §12.52 草稿）。

### Task 8: README 行情来源表 + cdp-shot 详情实拍

- 目标：文档面与渲染面收口。
- 涉及文件：Modify `README.md`（L95–98 行情来源与限制表）；运行 `scripts/cdp-shot.mjs`。
- 接口契约：
  - Consumes: Task 6 落地后的源码行为（渲染回归证据不依赖宿主装载新代码，见 Step 2 证据等级）；`tests/readme-portability.test.mjs` 渲染守卫（禁浮动排版）。
  - Produces: README 表格 cn/hk/指数行 K线列备源描述；cn/hk 详情页实拍图各一张（§12.52 附件引用，证据等级 = 渲染回归证据，见 Step 2）。
- 验证范围：readme-portability 测试绿；实拍图生成且详情页正常渲染。

- [ ] Step 1: README 表格更新（精确锚点：cn 行 L95、hk 行 L96、指数行 L98）：
  - A 股/ETF 行（L95）K线列「腾讯 fqkline」→「腾讯 fqkline；备源：东方财富 kline（前复权 qfq）」；
  - 港股行（L96）K线列——该行第 4 列现为「同上」（注意：「同上（同批）；备源：同上」是该行第 2 列快照文字，勿混）→「腾讯 fqkline（qfq 键缺失回落 day，不复权）；备源：东方财富 kline（fqt=0 不复权）」；
  - 指数行（L98）K线列「腾讯 fqkline（中/港）」→「腾讯 fqkline（中/港，备源：东方财富 kline——cn/hk 指数经 directSecid 直映同享备源腿）」，其余文字保留；
  - 美股行不动；复权口径列 hk/指数行措辞核对着实。
- Run: `node scripts/run-tests.mjs tests/readme-portability.test.mjs`
- Expected: 绿。
- [ ] Step 2: cdp-shot 实拍（纪律见其头注：chrome 后台起跑、假活 `--down` 重启、重活前进程清零）：cn（sh600519）与 hk（hk00700）详情页各一张，确认 K线/分时正常渲染、数据源脚注正常。**证据等级（如实，写入 §12.52）**：cdp-shot 只拍 127.0.0.1:3080 活宿主 tab，宿主现装 v0.3.4（npm 版，不含本计划新代码）；本步骤**不向活宿主装载新构建**（`dsh plugin add` 会清 workspace node_modules——AGENTS.md 两次实录，风险大于收益）——实拍仅作**渲染面回归证据**（client 零改动 ⇒ 新旧渲染一致），EM 备源新行为的生效判据由 routes 桩测试（Task 6）+ probe 真上游（Task 7）承担，不在实拍面主张。
- Run: `node scripts/cdp-shot.mjs`（按其头注参数）
- Expected: 两图生成；详情页无渲染回归；§12.52 登记句含证据等级说明（「实拍宿主 v0.3.4 旧代码，渲染回归证据；新行为判据见桩测试与探针」）。

### Task 9: verification §12.52 追记 + 主提交

- 目标：验证面落档；主提交入库。
- 涉及文件：Modify `docs/verification.md`（末尾追记 §12.52）。
- 接口契约：
  - Consumes: Task 1–8 全部产物与读数（含 §12.51 既有 health 断言仍绿的证据）。
  - Produces: §12.52 完整验证面（实现摘要 / 测试面 / probe 读数 / 实拍引用 / 未验证项如实登记——未验证不冒充已验证）。
- 验证范围：全套 npm test 终验 + git 提交成功。

- [ ] Step 1: 追记 §12.52（编号接 §12.51）：ADR-0007 链收拢、四消费者、cn/hk K线备源、hk fqt=0 口径、缺行缓存语义、探针读数（五项）、cdp-shot 引用（含 Task 8 Step 2 证据等级句）、未验证项（如真实上游故障注入备源只经桩测覆盖等，如实列）；既有出入随录：cn/hk 指数 K线响应 adjust='qfq'（腾讯 qfqday 命中）与 README 指数行「不复权」文案的张力系既有问题，本计划不改、如实登记。
- [ ] Step 2: 终验。
- Run: `npm test`
- Expected: 全绿。
- [ ] Step 3: 提交（fix/feat 正文提交，不含版本号）：
- Run: `git add -A && git commit -m "refactor(quotes): 行情链单一权威——chain.mjs 数据化链表 + attempt 注入 runner，resolveDirect/fullAdapter 并链，cn/hk K线 EM 备源（ADR-0007，§12.52）"`
- Expected: commit 成功（pre-commit 语法闸过）。

### Task 10: 发版 v0.3.5

- 目标：按仓发版链发布。
- 涉及文件：`package.json`（bump 0.3.5）、`lib/client.js`（build 重建，预期零 diff）。
- 接口契约：
  - Consumes: AGENTS.md 发版链全文；Task 9 的绿证。
  - Produces: npm 上架 v0.3.5 + release-monitor 两阶段确认。
- 验证范围：ci-parity 绿 + release-monitor 上架确认。

- [ ] Step 1: `npm version 0.3.5 --no-git-tag-version`（或手改 package.json）；`npm run build`（注入断言绿；`git diff --stat lib/client.js` 应为空——client 未改，若有 diff 即为红线，停下排查）。
- [ ] Step 2: 发布前门禁。
- Run: `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban bash scripts/ci-parity.sh`
- Expected: 无宿主布局克隆全量绿（防环境依赖守卫漏网）。
- [ ] Step 3: `git add package.json package-lock.json lib/client.js && git commit -m "chore(release): v0.3.5" && git tag v0.3.5 && git push && git push origin v0.3.5`（轻量 tag；窗口内不重推）。
- [ ] Step 4: 上架轮询。
- Run: `bash ../01_docs/dsh-intall-know-how/tools/release-monitor.sh iasiv5/dsh-stock-kanban v0.3.5 dsh-stock-kanban 0.3.5`
- Expected: 两阶段全绿，npm 页可见 0.3.5。
- [ ] Step 5（可选，不阻塞收尾）：宿主升级装载 v0.3.5 后实拍 cn/hk 详情页一轮，版本探针 = 设置页页尾 0.3.5（可观测生效判据），结果补记 §12.52——作为 Task 8 降级证据（Step 2）的闭环增强；装载动作遵守 AGENTS（`dsh plugin add` 清 node_modules 副作用 → 先跑完测试再装载）。

## 执行纪律

- 开始实现前先批判性复查整份计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划再动手。
- 按任务顺序执行（Task 3 依赖 Task 1/2；Task 5/6 依赖 Task 3；Task 6 另依赖 Task 4；7–10 顺序收口），不无声跳步、合并步或改变任务目标。
- 每完成一个任务跑该任务定义的验证；每个 checkpoint commit 在任务边界（建议 Task 2、4、6、9 后各一记）。
- 遇阻、重复失败或计划与仓库现实不符，立即停下说明，不猜。
- 开始实现前确认当前在 main 且与主人确认直推一次。
- 全部任务完成后输出修改摘要与 §12.52 链接。

## 最终验证

- `npm test` 全绿（含新增 chain 套件与全部既有桩套件）；`git diff --stat lib/client.js` 为空；`tests/readme-portability.test.mjs` 绿；`scripts/ci-parity.sh` 绿；probe 五项读数入 §12.52；cdp-shot cn/hk 两图正常；release-monitor 确认 v0.3.5 上架。
- 命令环境：bash（Linux），Node ≥20；联网命令带 `npm_config_cache=/home/ubuntu/workspace/.dsh-research/npm-cache-dsh-stock-kanban`。

## 审阅 Checkpoint

- 计划正文结束后请求主人审阅；审阅通过前不进入实现。默认执行方：普通编码 agent 或人工执行者。
