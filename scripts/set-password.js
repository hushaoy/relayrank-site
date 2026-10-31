"use strict";

/**
 * 只轮换管理员密码，不动站点、API Key、审核记录。
 *
 *   node scripts/set-password.js 新密码至少12位
 *   set ADMIN_PASSWORD=新密码 && node scripts/set-password.js
 *
 * 成功后清空全部会话，并把新密码写入 data/initial-admin.txt。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

async function main() {
  const password = String(process.argv[2] || process.env.ADMIN_PASSWORD || "").trim();
  if (password.length < 12) throw new Error("密码至少 12 位");
  if (!fs.existsSync(DB_FILE)) throw new Error("找不到 " + DB_FILE);

  const db = JSON.parse(String(await fsp.readFile(DB_FILE, "utf8")).replace(/^\uFEFF/, ""));
  const backup = path.join(DATA_DIR, `db-before-password-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fsp.copyFile(DB_FILE, backup);
  await fsp.chmod(backup, 0o600).catch(() => {});

  const salt = crypto.randomBytes(16).toString("hex");
  db.admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  db.admin.username = db.admin.username || "admin";
  db.admin.salt = salt;
  db.admin.hash = hashPassword(password, salt);
  db.sessions = [];

  const tmp = DB_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, DB_FILE);
  await fsp.chmod(DB_FILE, 0o600).catch(() => {});
  await fsp.writeFile(
    path.join(DATA_DIR, "initial-admin.txt"),
    `中转站榜单后台\n地址: http://127.0.0.1:8803/admin\n用户名: ${db.admin.username}\n密码: ${password}\n生成时间: ${new Date().toISOString()}\n（登录后请立即修改密码并删除本文件）\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  console.log(`已重置管理员密码，用户名 ${db.admin.username}`);
  console.log(`新密码写入 ${path.join(DATA_DIR, "initial-admin.txt")}`);
  console.log(`修改前备份 ${backup}`);
}

main().catch((err) => {
  console.error("失败:", err.message);
  process.exit(1);
});
