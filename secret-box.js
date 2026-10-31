"use strict";

const crypto = require("node:crypto");

function masterKey() {
  const raw = String(process.env.KEY_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("KEY_ENCRYPTION_KEY 必须是 32 字节 base64");
  return key;
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith("enc:v1:");
}

function encryptSecret(value) {
  const text = String(value || "");
  if (!text || isEncrypted(text)) return text;
  const key = masterKey();
  if (!key) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!isEncrypted(text)) return text;
  const key = masterKey();
  if (!key) throw new Error("数据库里有加密 Key，但未设置 KEY_ENCRYPTION_KEY");
  const parts = text.split(":");
  if (parts.length !== 5) throw new Error("加密 Key 格式损坏");
  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const ciphertext = Buffer.from(parts[4], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { isEncrypted, encryptSecret, decryptSecret };
