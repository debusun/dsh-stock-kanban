#!/usr/bin/env node
/**
 * 热部署（050 纪律编码化，2026-11-17 retro）：把仓库文件原子替换进装机目录，重启前让服务端改动先行在役。
 *
 * 用法：node scripts/hot-deploy.mjs <仓库相对路径...> [--dest <装机包根>] [--dry-run]
 *   - 默认装机根：~/.dsh/profiles/web/node_modules/<package.json name>（desktop 机或异布局用 --dest 覆盖）
 *   - 每文件：装机现文件备份（存在才备）→ 仓库文件复制到装机同目录临时名 → rename 原子替换
 *     （断 pnpm store 硬链接，050 铁律：禁原地覆写）→ 逐字节 cmp 收尾断言；任何 FAIL 退出码 1
 *   - 备份目录：HOT_DEPLOY_BACKUP_DIR 覆盖，默认锚点 ~/workspace/.dsh-research/stock-kanban-hotdeploy/<时间戳>/
 *     （无该锚点的机器回退 ~/.dsh-research/stock-kanban-hotdeploy/）
 *
 * 实录（2026-11-17）：手搓 bash 循环两次，第一次 src/ vs src/markets/ 路径写错致两文件 MISMATCH
 * （收尾 cmp 拦下）——本脚本以「仓库相对路径 = 装机相对路径」映射消灭该错误类。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REPO = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const destIdx = args.indexOf("--dest");
const DEST = destIdx >= 0 ? args[destIdx + 1] : join(homedir(), ".dsh", "profiles", "web", "node_modules", pkg.name);
const rels = args.filter((a, i) => !a.startsWith("--") && !(destIdx >= 0 && i === destIdx + 1));
if (rels.length === 0) {
  console.error("用法：node scripts/hot-deploy.mjs <仓库相对路径...> [--dest <装机包根>] [--dry-run]");
  process.exit(2);
}
if (!existsSync(DEST)) {
  console.error(`装机根不存在：${DEST}（--dest 指定或先安装插件）`);
  process.exit(2);
}
const anchor = join(homedir(), "workspace", ".dsh-research");
const BACKUP = process.env.HOT_DEPLOY_BACKUP_DIR
  || (existsSync(anchor) ? join(anchor, "stock-kanban-hotdeploy") : join(homedir(), ".dsh-research", "stock-kanban-hotdeploy"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = join(BACKUP, stamp);

let failed = 0;
for (const rel of rels) {
  const src = join(REPO, rel);
  const inst = join(DEST, rel);
  if (!existsSync(src)) {
    console.log(`FAIL ${rel}: 仓库无此文件`);
    failed += 1;
    continue;
  }
  if (dry) {
    console.log(`DRY  ${rel} -> ${inst}${existsSync(inst) ? "" : "（新文件）"}`);
    continue;
  }
  mkdirSync(dirname(inst), { recursive: true });
  const isNew = !existsSync(inst);
  if (!isNew) {
    const bak = join(backupDir, rel);
    mkdirSync(dirname(bak), { recursive: true });
    cpSync(inst, bak);
  }
  const tmp = join(dirname(inst), `.tmp-${basename(rel)}-${process.pid}`);
  cpSync(src, tmp);
  renameSync(tmp, inst); // 原子替换断硬链接（050）
  const same = Buffer.compare(readFileSync(src), readFileSync(inst)) === 0;
  const links = statSync(inst).nlink;
  console.log(`${same && links === 1 ? "OK  " : "FAIL"} ${rel} -> ${inst}（cmp ${same ? "IDENTICAL" : "MISMATCH"}，nlink=${links}${isNew ? "，新文件" : `，备份 ${bak2name(backupDir, rel)}` }）`);
  if (!same || links !== 1) failed += 1;
}
function basename(p) {
  return p.split("/").pop() ?? p;
}
function bak2name(dir, rel) {
  return join(dir, rel);
}
console.log(failed === 0 ? `hot-deploy: OK（${dry ? "dry-run" : "已断链部署"}；宿主重启前不生效——ESM 缓存）` : `hot-deploy: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
