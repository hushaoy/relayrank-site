"use strict";

/**
 * 安全工具：URL 白名单 / SSRF 防护 / 会话哈希 / 客户端 IP。
 * 设计原则：默认拒绝私网、回环、链路本地、云元数据地址；带 API Key 的请求只允许 HTTPS。
 */

const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const net = require("node:net");
const { URL } = require("node:url");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.username || u.password) return "";
    return u.href.slice(0, 300);
  } catch {
    return "";
  }
}

function isPrivateIp(ip) {
  const value = String(ip || "").trim().toLowerCase();
  if (!value) return true;

  if (net.isIPv4(value)) {
    const parts = value.split(".").map(Number);
    const [a, b, c] = parts;
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (net.isIPv6(value)) {
    const s = value.replace(/^\[|\]$/g, "");
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("::ffff:")) {
      const mapped = s.slice("::ffff:".length);
      if (net.isIPv4(mapped)) return isPrivateIp(mapped);
      const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
    return (
      s.startsWith("fc") ||
      s.startsWith("fd") ||
      s.startsWith("fe8") ||
      s.startsWith("fe9") ||
      s.startsWith("fea") ||
      s.startsWith("feb") ||
      s.startsWith("ff")
    );
  }

  return true;
}

function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const opts = options || {};
    const family = Number(opts.family) || 0;
    const list = family ? addresses.filter((a) => Number(a.family) === family) : addresses;
    if (!list.length) return callback(new Error("没有可用地址"));
    if (opts.all) {
      return callback(null, list.map((a) => ({ address: a.address, family: Number(a.family) || 4 })));
    }
    const first = list[0];
    return callback(null, first.address, Number(first.family) || 4);
  };
}

/**
 * 校验目标 URL 并返回固定 DNS 解析结果的 lookup。
 * allowHttp=true 只应在“不带密钥”的公开探测中使用；带密钥必须 HTTPS。
 */
async function assertPublicUrl(raw, { allowHttp = false, allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw new Error("地址格式不正确");
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("只允许 HTTP/HTTPS 地址");
  }
  if (!allowHttp && u.protocol !== "https:") {
    throw new Error("带密钥的请求只允许 HTTPS");
  }
  if (u.username || u.password) {
    throw new Error("地址中不允许包含用户名或密码");
  }
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) {
    throw new Error("端口不在允许范围内");
  }

  if (allowPrivate) {
    return { url: u, addresses: [], dnsMs: 0, lookup: null };
  }

  const started = Date.now();
  let addresses;
  try {
    addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new Error("域名解析失败");
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw new Error("域名没有可用地址");
  }
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error("私有地址不允许访问");
  }

  return {
    url: u,
    addresses,
    dnsMs: Date.now() - started,
    lookup: pinnedLookup(addresses)
  };
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    // Cloudflare 隧道优先取 CF-Connecting-IP，避免所有访客共用边缘节点 IP
    const cf = String(req.headers["cf-connecting-ip"] || "").trim();
    if (net.isIP(cf)) return cf;
    // nginx 用 $remote_addr 覆盖 X-Real-IP，客户端无法伪造
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (net.isIP(real)) return real;
    const chain = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => net.isIP(part));
    if (chain.length) return chain[chain.length - 1];
  }
  return req.socket.remoteAddress || "unknown";
}

function cookieHeader(req, name, value, maxAgeSeconds, { httpOnly = true, sameSite = "Strict" } = {}) {
  const secure =
    process.env.COOKIE_SECURE === "1" ||
    (process.env.COOKIE_SECURE !== "0" &&
      ((process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https") ||
        Boolean(req.socket.encrypted)));
  const parts = [`${name}=${value}`, "Path=/", `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join("; ");
}

module.exports = {
  sha256,
  safeHttpUrl,
  isPrivateIp,
  assertPublicUrl,
  clientIp,
  cookieHeader
};
