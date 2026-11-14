import test from "node:test";
import assert from "node:assert/strict";
import { createChain } from "../src/markets/chain.mjs";

/* 行情链 runner 编排套件：fake providers 直测，全离线（ADR-0007 / 实施计划 Task 1–2）。
   契约：attempt 抛错=传输失败；validate 不过=无数据；cell.errorKind ∈ transport|no-data|null；
   补位行标 fallbackFrom；退避/缓存/health 记账面见下方记账用例。 */

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

/* ---- 记账面（Task 2）：退避 / 缓存 / ns 隔离 / health 两层契约 ---- */

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
  t += 300; // 越过第二次退避窗口（1200+200=1400），让恢复的源被真实尝试（计划测试时钟缺步的最小修正）
  badDown = false; // 源恢复
  await run();
  assert.equal(chain.health().bad.cn.failures, 0, "真实成功清零");
});

test("runChain：validate 不过耗尽 → errorKind no-data，value=末源原值", async () => {
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
