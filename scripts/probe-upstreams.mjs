#!/usr/bin/env node
/**
 * 上游可达性矩阵探针（2026-11-17 retro）：一次打齐四市场数据源关键端点，每源一行结论。
 *
 * 用法：node scripts/probe-upstreams.mjs [--f56]
 *   --f56  额外打 EM trends2 全字段（f51,f53,f56）并统计美股第 3 列非零行数——
 *          EM 恢复可达后一键定谳「f56 对美股是否有值」（§12.67 未验证项）。
 *
 * 背景：2026-11-16 美股盘中美股分时整链灭，夜诊手搓 curl 矩阵三次（诊断/镜像域试探/晨检）
 * ——本脚本是那套矩阵的工具化。零依赖、并行、8s 超时、恒 exit 0（红绿看输出）。
 * 封锁形态备忘：EM push2 双协议 502、push2his 双栈连接后空回应、编号镜像域连 TCP 都建不起来。
 */
import { resolve4, resolve6 } from "node:dns/promises";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT = 8000;
const f56 = process.argv.includes("--f56");

async function hit(url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
    return { status: String(res.status), ms: Date.now() - t0, res };
  } catch (e) {
    return { status: "FAIL " + String(e?.cause?.code ?? e?.message ?? e).slice(0, 30), ms: Date.now() - t0, res: null };
  }
}

const rows = [];
const jobs = [];
const add = (label, p) => jobs.push(p.then((r) => rows.push({ label, ...r })));

/* 东方财富 */
add("EM push2 stock/get https", hit("https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f57&invt=2&fltt=2", { referer: "https://quote.eastmoney.com/" }));
add("EM push2 stock/get http ", hit("http://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f57&invt=2&fltt=2", { referer: "https://quote.eastmoney.com/" }));
const trendsUrl = (fields) => "https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=105.AAPL&fields1=f1,f2&fields2=" + fields + "&iscr=0&ndays=1";
add("EM push2his trends2 https", hit(trendsUrl("f51,f53"), { referer: "https://quote.eastmoney.com/" }));
add("EM push2his trends2 http ", hit(trendsUrl("f51,f53").replace("https:", "http:"), { referer: "https://quote.eastmoney.com/" }));
for (const n of [21, 23, 40]) {
  add(`EM ${n}.push2his trends2`, hit(`https://${n}.push2his.eastmoney.com/api/qt/stock/trends2/get?secid=105.AAPL&fields1=f1,f2&fields2=f51,f53&iscr=0&ndays=1`, { referer: "https://quote.eastmoney.com/" }));
}
add("DNS push2 A/AAAA", resolveCounts("push2.eastmoney.com"));
add("DNS push2his A/AAAA", resolveCounts("push2his.eastmoney.com"));

/* Yahoo */
const yhUrl = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d&includePrePost=false";
add("Yahoo query1 chart", hit(yhUrl, { referer: "https://finance.yahoo.com/" }));
add("Yahoo query2 chart", hit(yhUrl.replace("query1", "query2"), { referer: "https://finance.yahoo.com/" }));

/* 雪球（guest 引导 + minute） */
add("雪球 引导+minute AAPL", (async () => {
  const t0 = Date.now();
  try {
    const home = await fetch("https://xueqiu.com/", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter((c) => c.includes("=")).join("; ");
    if (!cookie.includes("xq_a_token=")) return { status: "FAIL no-cookie", ms: Date.now() - t0 };
    const res = await fetch("https://stock.xueqiu.com/v5/stock/chart/minute.json?symbol=AAPL&period=1d", {
      headers: { "user-agent": UA, accept: "application/json", referer: "https://xueqiu.com/", cookie },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const j = await res.json();
    return { status: `${res.status} items=${j?.data?.items?.length ?? 0}`, ms: Date.now() - t0 };
  } catch (e) {
    return { status: "FAIL " + String(e?.message ?? e).slice(0, 30), ms: Date.now() - t0 };
  }
})());

/* Binance / 腾讯 */
add("Binance ping", hit("https://api.binance.com/api/v3/ping"));
add("Binance ticker BTCUSDT", hit("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"));
add("腾讯 fqkline usAAPL.OQ", hit("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=usAAPL.OQ,day,,,5,qfq"));

/* f56 定谳（--f56） */
if (f56) {
  add("EM trends2 f51,f53,f56 定谳", (async () => {
    const r = await hit(trendsUrl("f51,f53,f56"), { referer: "https://quote.eastmoney.com/" });
    if (!r.res) return { status: r.status + "（EM 不可达，f56 定谳继续挂起）", ms: r.ms };
    const j = await r.res.json();
    const rows2 = Array.isArray(j?.data?.trends) ? j.data.trends : [];
    let nonzero = 0;
    for (const line of rows2) {
      const v = parseFloat(String(line).split(",")[2]);
      if (Number.isFinite(v) && v > 0) nonzero += 1;
    }
    return { status: `${r.status} rows=${rows2.length} f56非零=${nonzero}（${nonzero > 0 ? "有值→量纲修复成立" : "无值→v=0 退化与修正前一致"}）`, ms: r.ms };
  })());
}

async function resolveCounts(host) {
  const t0 = Date.now();
  const a = await resolve4(host).then((r) => r.length).catch(() => 0);
  const aaaa = await resolve6(host).then((r) => r.length).catch(() => 0);
  return { status: `A=${a} AAAA=${aaaa}`, ms: Date.now() - t0 };
}

await Promise.allSettled(jobs);
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
for (const r of rows) console.log(`${pad(r.label, 30)} ${pad(r.status, 46)} ${r.ms}ms`);
console.log(`\n上游矩阵探针完成（${rows.length} 项；恒 exit 0，红绿看上表）`);
