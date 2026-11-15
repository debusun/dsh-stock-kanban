#!/usr/bin/env node
// EM K线三口径补测专用探针（ADR-0007 计划外建议①收口，§12.53）：全量探针的轻量子集——
// push2his kline 端点间歇不可达（§12.52 三窗口实录）期间，本脚本供可达窗口/宿主环境随手复跑，
// 几秒出裁决，不必等 31 项全量。ok 语义与主探针对齐：detail.error 必抛入 ✗ 分支，杜绝恒真 ✓。
//
// 三口径裁决锚（GLOSSARY「报价校验」/§12.47 股口径）：
//   cn qfq 有效性 + volume 量纲：EM 末根量 / 腾讯快照量（f36=股）≈1 → EM 原生股 ✓；≈0.01 → 手（需归一）；
//   hk fqt=0：可用且末根收盘与腾讯同日差 < 1%（腾讯 hk 实际输出 day/none，口径须对齐）；
//   us 回归：NVDA day 缺省 qfq 仍可用。
// 用法：node scripts/probe-em-kline.mjs（联网，~10s；JSON 打 stdout，调用方 tee 落盘）
import { fetchKline as emFetchKline } from "../src/markets/eastmoney.mjs";
import { fetchKline as txFetchKline, parseBatchSnapshot } from "../src/markets/tencent.mjs";

const out = { at: new Date().toISOString(), results: [] };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function probe(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    out.results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    out.results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
  }
}

async function snapVolume(code) {
  const res = await fetch(`https://qt.gtimg.cn/q=${code}`, { headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseBatchSnapshot(new TextDecoder("gbk").decode(Buffer.from(await res.arrayBuffer()))).get(code)?.volume ?? null;
}

await probe("em-cn-kline sh600519 day qfq（volume 量纲裁决：末根/腾讯快照）", async () => {
  const em = await emFetchKline("sh600519", "day");
  if (em.error) throw new Error("em-kline: " + em.error + (em.errorDetail ? "/" + em.errorDetail : ""));
  const snapVol = await snapVolume("sh600519");
  const last = em.candles[em.candles.length - 1] ?? null;
  const ratio = last && snapVol ? Number((last.volume / snapVol).toFixed(3)) : null;
  return {
    candles: em.candles.length, adjust: em.adjust,
    lastTime: last?.time ?? null, lastClose: last?.close ?? null, lastVolume: last?.volume ?? null,
    snapVolume: snapVol, volumeRatioEmOverSnap: ratio,
    verdict: ratio === null ? "snap-unavailable" : ratio > 0.5 && ratio < 2 ? "EM 原生股 ✓" : ratio > 0.005 && ratio < 0.02 ? "EM 为手——routes 需归一（回开 Task 7 Step 2 路径）" : "比值异常，如实人工判读",
  };
});

await probe("em-hk-kline-none hk00700 day fqt=0（+腾讯同日收盘对照）", async () => {
  const em = await emFetchKline("hk00700", "day", { adjust: "none" });
  if (em.error) throw new Error("em-kline: " + em.error);
  const tx = await txFetchKline("hk00700", "day");
  const emLast = em.candles[em.candles.length - 1] ?? null;
  const txSame = tx.candles.find((c) => c.time === emLast?.time) ?? null;
  const delta = emLast && txSame ? Number(Math.abs(emLast.close - txSame.close).toFixed(2)) : null;
  return {
    candles: em.candles.length, adjust: em.adjust, lastTime: emLast?.time ?? null,
    emLastClose: emLast?.close ?? null, txSameClose: txSame?.close ?? null, closeDelta: delta,
    verdict: delta !== null && delta < Math.max(1, (txSame?.close ?? 1) * 0.01) ? "fqt=0 与腾讯 day 同量级 ✓" : "价位差超界，人工判读",
  };
});

await probe("em-us-kline-regression NVDA day 缺省 qfq", async () => {
  const r = await emFetchKline("NVDA", "day");
  if (r.error) throw new Error("em-kline: " + r.error);
  const last = r.candles[r.candles.length - 1] ?? null;
  return { candles: r.candles.length, adjust: r.adjust, lastTime: last?.time ?? null, lastClose: last?.close ?? null };
});

const pass = out.results.filter((r) => r.ok).length;
console.log(JSON.stringify(out, null, 2));
console.error(`probe-em-kline done: ${pass}/${out.results.length} ok`);
for (const r of out.results) console.error(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? ` (${r.ms}ms)` : ` — ${r.error}`}`);
