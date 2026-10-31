"use strict";

/**
 * 登录防爆破：持久化失败计数 + 指数退避锁定。
 *
 * 设计要点：
 * - 账号维度按「用户名 + IP」计数，攻击者无法靠乱试用户名把真管理员锁死；
 * - IP 维度单独计数，共享出口 NAT 不会因为单个账号失败被误伤太久；
 * - 全局失败速率兜底，防止分布式低速撞库把磁盘写爆；
 * - 只落盘 sha256 摘要与掩码 IP，数据库被读走也不能直接还原攻击来源；
 * - 进程重启后锁定状态仍然有效，不会靠重启服务绕过。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

function maskIp(value) {
  const ip = String(value || "").replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    return `${parts.slice(0, 2).join(":")}::x`;
  }
  return ip ? ip.slice(0, 32) : "unknown";
}

class LoginGuard {
  constructor(options = {}) {
    this.file = options.file || path.join(process.cwd(), "login-guard.json");
    this.accountMax = options.accountMax || 5;
    this.accountWindowMs = options.accountWindowMs || 15 * 60 * 1000;
    this.accountLockMs = options.accountLockMs || 15 * 60 * 1000;
    this.ipMax = options.ipMax || 20;
    this.ipWindowMs = options.ipWindowMs || 15 * 60 * 1000;
    this.ipLockMs = options.ipLockMs || 30 * 60 * 1000;
    this.globalMax = options.globalMax || 120;
    this.globalWindowMs = options.globalWindowMs || 60 * 1000;
    this.globalLockMs = options.globalLockMs || 60 * 1000;
    this.maxEntries = options.maxEntries || 4000;

    this.entries = new Map();
    this.globalFails = [];
    this.globalLockedUntil = 0;
    this.loaded = false;
    this.saveQueue = Promise.resolve();
    this.saveTimer = null;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
      const entries = Array.isArray(data.entries) ? data.entries : [];
      for (const item of entries) {
        if (!item || !item.id || !item.kind) continue;
        this.entries.set(item.id, {
          id: String(item.id),
          kind: item.kind === "ip" ? "ip" : "account",
          label: String(item.label || ""),
          fails: Array.isArray(item.fails) ? item.fails.filter((t) => Number.isFinite(t)).slice(-200) : [],
          lockedUntil: Number(item.lockedUntil) || 0,
          strikes: Math.max(0, Number(item.strikes) || 0),
          lastAt: Number(item.lastAt) || 0
        });
      }
      this.globalFails = Array.isArray(data.globalFails) ? data.globalFails.filter((t) => Number.isFinite(t)).slice(-500) : [];
      this.globalLockedUntil = Number(data.globalLockedUntil) || 0;
      this.sweep();
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        console.error("[login-guard] 读取失败，按空状态启动：", err.message);
      }
    }
  }

  now() {
    return Date.now();
  }

  accountId(username, ip) {
    return sha(`account:${String(username || "").toLowerCase()}:${String(ip || "")}`);
  }

  ipId(ip) {
    return sha(`ip:${String(ip || "")}`);
  }

  windowFor(kind) {
    return kind === "ip" ? this.ipWindowMs : this.accountWindowMs;
  }

  countRecent(entry, now) {
    const windowMs = this.windowFor(entry.kind);
    entry.fails = (entry.fails || []).filter((t) => now - t < windowMs);
    return entry.fails.length;
  }

  lockDuration(kind, strikes) {
    const base = kind === "ip" ? this.ipLockMs : this.accountLockMs;
    const factor = Math.pow(2, Math.min(Math.max(strikes, 0), 5));
    return base * factor;
  }

  check(username, ip) {
    const now = this.now();
    if (this.globalLockedUntil > now) {
      return {
        ok: false,
        scope: "global",
        retryAfterSec: Math.ceil((this.globalLockedUntil - now) / 1000),
        label: "全站登录"
      };
    }

    const ids = [
      { id: this.accountId(username, ip), kind: "account", label: String(username || "admin").slice(0, 32) },
      { id: this.ipId(ip), kind: "ip", label: maskIp(ip) }
    ];

    for (const item of ids) {
      const entry = this.entries.get(item.id);
      if (!entry) continue;
      if (entry.lockedUntil > now) {
        return {
          ok: false,
          scope: entry.kind,
          retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
          label: entry.label
        };
      }
    }

    return { ok: true };
  }

  ensureEntry(id, kind, label) {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, kind, label, fails: [], lockedUntil: 0, strikes: 0, lastAt: 0 };
      this.entries.set(id, entry);
    }
    entry.label = label || entry.label;
    return entry;
  }

  fail(username, ip) {
    const now = this.now();
    const account = this.ensureEntry(this.accountId(username, ip), "account", String(username || "admin").slice(0, 32));
    const address = this.ensureEntry(this.ipId(ip), "ip", maskIp(ip));

    for (const entry of [account, address]) {
      const recent = this.countRecent(entry, now);
      entry.fails.push(now);
      entry.lastAt = now;
      const max = entry.kind === "ip" ? this.ipMax : this.accountMax;
      if (recent + 1 >= max && entry.lockedUntil <= now) {
        entry.lockedUntil = now + this.lockDuration(entry.kind, entry.strikes);
        entry.strikes += 1;
        entry.fails = [];
      }
    }

    this.globalFails = this.globalFails.filter((t) => now - t < this.globalWindowMs);
    this.globalFails.push(now);
    if (this.globalFails.length >= this.globalMax) {
      this.globalLockedUntil = now + this.globalLockMs;
      this.globalFails = [];
    }

    this.sweep();
    this.scheduleSave();
    return {
      accountFails: this.countRecent(account, now),
      ipFails: this.countRecent(address, now)
    };
  }

  success(username, ip) {
    this.entries.delete(this.accountId(username, ip));
    this.entries.delete(this.ipId(ip));
    this.scheduleSave();
  }

  sweep() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      const stale = !entry.lockedUntil || entry.lockedUntil < now;
      const last = entry.lastAt || 0;
      if (stale && now - last > 24 * 60 * 60 * 1000) this.entries.delete(id);
    }
    if (this.entries.size > this.maxEntries) {
      const sorted = Array.from(this.entries.values()).sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0));
      for (const entry of sorted.slice(0, this.entries.size - this.maxEntries)) {
        this.entries.delete(entry.id);
      }
    }
    if (this.globalLockedUntil && this.globalLockedUntil < now) this.globalLockedUntil = 0;
  }

  list() {
    const now = this.now();
    const items = Array.from(this.entries.values())
      .filter((entry) => entry.lockedUntil > now || (entry.lastAt && now - entry.lastAt < 24 * 60 * 60 * 1000))
      .sort((a, b) => (b.lockedUntil || 0) - (a.lockedUntil || 0) || (b.lastAt || 0) - (a.lastAt || 0))
      .slice(0, 60)
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        fails: this.countRecent(entry, now),
        locked: entry.lockedUntil > now,
        lockedUntil: entry.lockedUntil || null,
        retryAfterSec: entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0,
        strikes: entry.strikes,
        lastAt: entry.lastAt ? new Date(entry.lastAt).toISOString() : null
      }));
    return {
      entries: items,
      globalLocked: this.globalLockedUntil > now,
      globalRetryAfterSec: this.globalLockedUntil > now ? Math.ceil((this.globalLockedUntil - now) / 1000) : 0,
      total: items.length
    };
  }

  unlock(id) {
    const entry = this.entries.get(String(id || ""));
    if (!entry) return false;
    entry.fails = [];
    entry.lockedUntil = 0;
    entry.strikes = 0;
    this.scheduleSave();
    return true;
  }

  unlockAll() {
    for (const entry of this.entries.values()) {
      entry.fails = [];
      entry.lockedUntil = 0;
      entry.strikes = 0;
    }
    this.globalLockedUntil = 0;
    this.globalFails = [];
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error("[login-guard] 写入失败：", err.message));
    }, 250);
    this.saveTimer.unref?.();
  }

  flush() {
    const payload = JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: Array.from(this.entries.values()),
        globalFails: this.globalFails.slice(-500),
        globalLockedUntil: this.globalLockedUntil || 0
      },
      null,
      2
    );
    this.saveQueue = this.saveQueue.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + ".tmp";
      await fsp.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tmp, this.file);
      await fsp.chmod(this.file, 0o600).catch(() => {});
    });
    return this.saveQueue;
  }
}

module.exports = { LoginGuard, maskIp };
