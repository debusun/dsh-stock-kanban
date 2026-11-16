import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* smartbox 夹具编码守卫（2026-11-16 retro，§12.63）：
   GBK 通道夹具（fetch stub → arrayBuffer → TextDecoder("gbk")）若含非 ASCII，
   中文 UTF-8 字节会被 GBK 两两错位解析，可能吞掉后续 `~` 分隔符使字段数 5→4
   （§12.60 实录：「新之江」→「姹焴xzj」，测试红因与被测逻辑无关，误诊一轮）。
   规则：v_hint="…" 夹具内容必须 ASCII；本行或次行直接调用 parseSmartbox(/parseTencentNames(
   的直解单测（纯 JS 字符串、不经 GBK 通道）豁免。 */

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const DIRECT_PARSE = /parseSmartbox\(|parseTencentNames\(/;

test("守卫：smartbox 夹具（v_hint）内容全 ASCII——GBK 通道防字节错位吞分隔符", async () => {
  const offenders = [];
  for (const f of (await readdir(TESTS_DIR)).filter((name) => name.endsWith(".test.mjs"))) {
    const lines = (await readFile(join(TESTS_DIR, f), "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/v_hint="([^"]*)"/g)) {
        const directCall = DIRECT_PARSE.test(line) || (lines[i + 1] ? DIRECT_PARSE.test(lines[i + 1]) : false);
        if (/[^\x00-\x7F]/.test(m[1]) && !directCall) {
          offenders.push(`${f}:${i + 1} "${m[1].slice(0, 40)}"`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "GBK 通道 smartbox 夹具含非 ASCII；修法：夹具名 ASCII 化，或同行直接调用 parseSmartbox/parseTencentNames（直解豁免）",
  );
});
