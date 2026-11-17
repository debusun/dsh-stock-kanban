import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 语法闸（2026-11-13 retro）：TS 注解混入纯 .mjs 曾两次炸在构建/测试加载阶段
 *  （client/charts.mjs `: any`、tests/client-dom.test.mjs `: any[]`）——
 *  node --check 对每个入库 .mjs 做确定性语法检查，TS 语法泄漏即红；毫秒级/文件。 */
test("语法闸：所有入库 .mjs 通过 node --check（防 TS 注解泄漏）", () => {
  const files = execSync("git ls-files '*.mjs'", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const bad = [];
  for (const f of files) {
    try {
      execSync(`node --check ${JSON.stringify(f)}`, { stdio: "pipe" });
    } catch (e) {
      bad.push(`${f}: ${String((e.stderr || e.message) ?? "").split("\n")[0]}`);
    }
  }
  assert.deepEqual(bad, [], `以下 .mjs 语法不合法（多为 TS 注解泄漏）：\n${bad.join("\n")}`);
});

test("styles.mjs 模板串守卫：FLOAT_STYLE_TEXT 为纯 CSS 模板串，body 内反引号必须为零（2026-11-15 retro）", () => {
  // 实录：CSS 注释里写反引号提前终结模板串 → hero/dom 测试加载级失败 + esbuild 崩，报错只有进程 tail 隐晦难定位。
  // FLOAT_STYLE_TEXT 全程无插值，body 内反引号合法数量 = 0；有人要加插值时会读到本条信息并自觉升级守卫。
  const src = readFileSync(new URL("../client/styles.mjs", import.meta.url), "utf8");
  const open = src.indexOf("`");
  assert.ok(open >= 0, "未找到 FLOAT_STYLE_TEXT 模板串开引号");
  const rest = src.slice(open + 1);
  const close = rest.indexOf("`");
  assert.ok(close >= 0, "未找到模板串闭引号");
  const stray = rest.slice(0, close).match(/`/g);
  assert.equal(stray, null, `模板串内出现反引号 ${stray?.length ?? 0} 处——会提前终结模板串（报错隐晦）；CSS 注释里用「」替代反引号`);
});

test("正则字面量扫闸：.mjs 内不得出现字面双反斜杠+简写类（文件工具显示转义陷阱，2026-11-17 retro）", () => {
  // 实录：读文件工具把单反斜杠 d 显示成双反斜杠（显示层转义），照显示抄进 binance.mjs → 日期正则永不匹配
  // → 全量 no-data 假象，靠测试才揪出。全库惯例是单反斜杠（落闸前 grep 预检零命中）。
  // 匹配器与换行都用码点构造：源码内不出现字面双反斜杠（自扫描自命中），注释也不用反斜杠字形（同一个坑）。
  const BS = String.fromCharCode(92); // 单个反斜杠字符
  const LF = String.fromCharCode(10);
  const literalDoubleClass = new RegExp(BS + BS + BS + BS + "[dwsb]", "g"); // 匹配源码字节：连续两个反斜杠 + d/w/s/b
  const files = execSync("git ls-files '*.mjs'", { encoding: "utf8" })
    .split(LF)
    .filter(Boolean);
  const bad = [];
  for (const f of files) {
    const hits = readFileSync(f, "utf8").match(literalDoubleClass);
    if (hits) bad.push(`${f}: ${hits.length} 处（显示转义被照抄？简写类应为单反斜杠）`);
  }
  assert.deepEqual(bad, [], `以下 .mjs 含字面双反斜杠简写类（正则永不匹配的静默杀手）：${LF}${bad.join(LF)}`);
});
