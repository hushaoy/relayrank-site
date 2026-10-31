"use strict";

/**
 * 查看 / 清除登录失败锁定。
 *
 *   node scripts/unlock-login.js           # 只查看
 *   node scripts/unlock-login.js --clear   # 清除全部锁定
 *
 * 适用场景：管理员把自己锁在门外，或需要立刻解封某个 IP。
 */

const path = require("node:path");
const { LoginGuard } = require("../login-guard.js");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));

async function main() {
  const guard = new LoginGuard({ file: path.join(DATA_DIR, "login-guard.json") });
  await guard.load();
  const state = guard.list();
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`锁定条目: ${state.entries.length}`);
  for (const item of state.entries) {
    const until = item.locked ? new Date(item.lockedUntil).toLocaleString("zh-CN", { hour12: false }) : "未锁定";
    console.log(`- [${item.kind}] ${item.label} 失败 ${item.fails} 次，${until}`);
  }
  if (process.argv.includes("--clear")) {
    guard.unlockAll();
    await guard.flush();
    console.log("已清除全部锁定记录。");
  }
}

main().catch((err) => {
  console.error("执行失败:", err.message);
  process.exit(1);
});
