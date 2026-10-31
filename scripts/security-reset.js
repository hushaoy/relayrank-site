"use strict";

/**
 * 一次性安全重置：
 *   1. 备份 data/db.json 到 data/private-backups/
 *   2. 清除全部会话（旧版本存的是明文 sid/token）
 *   3. 清除所有站点的 apiKey（这些 Key 已随旧发行包泄露，必须在服务商侧吊销）
 *   4. 轮换 admin 密码，写入 data/initial-admin.txt（权限 600）
 *
 * 用法：node scripts/security-reset.js
 * 保留原密码：KEEP_PASSWORD=1 node scripts/security-reset.js
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function newPassword() {
  return crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 20);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

async function main() {
  if (!fs.existsSync(DB_FILE)) throw new Error("找不到 " + DB_FILE);
  const db = JSON.parse(String(await fsp.readFile(DB_FILE, "utf8")).replace(/^\uFEFF/, ""));
  const backupDir = path.join(DATA_DIR, "private-backups");
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backupDir, `db-before-security-reset-${stamp}.json`);
  await fsp.copyFile(DB_FILE, backup);
  await fsp.chmod(backup, 0o600).catch(() => {});

  const oldSessions = Array.isArray(db.sessions) ? db.sessions.length : 0;
  const oldKeys = Array.isArray(db.sites) ? db.sites.filter((s) => s && s.apiKey).length : 0;
  db.sessions = [];
  db.submissions = Array.isArray(db.submissions) ? db.submissions : [];
  for (const site of Array.isArray(db.sites) ? db.sites : []) {
    if (site && site.apiKey) delete site.apiKey;
  }
  db.securityVersion = 2;

  let password = "";
  if (process.env.KEEP_PASSWORD !== "1") {
    password = newPassword();
    db.admin = db.admin && typeof db.admin === "object" ? db.admin : { username: "admin" };
    db.admin.salt = crypto.randomBytes(16).toString("hex");
    db.admin.hash = hashPassword(password, db.admin.salt);
  }

  const tmp = DB_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, DB_FILE);
  await fsp.chmod(DB_FILE, 0o600).catch(() => {});
  await fsp.writeFile(DB_FILE + ".bak", JSON.stringify(db, null, 2), { encoding: "utf8", mode: 0o600 }).catch(() => {});

  if (password) {
    await fsp.writeFile(
      path.join(DATA_DIR, "initial-admin.txt"),
      `中转站榜单后台\n地址: http://127.0.0.1:8803/admin\n用户名: admin\n密码: ${password}\n生成时间: ${new Date().toISOString()}\n（登录后立即修改密码并删除本文件）\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  console.log(`[reset] 备份: ${backup}`);
  console.log(`[reset] 已清除会话 ${oldSessions} 条，已移除 apiKey ${oldKeys} 个`);
  console.log(`[reset] 新密码已写入 ${path.join(DATA_DIR, "initial-admin.txt")}（${password ? "已轮换" : "保持原密码"}）`);
}

main().catch((err) => {
  console.error("[reset] 失败：", err.message);
  process.exit(1);
});
