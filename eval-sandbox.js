"use strict";

/**
 * 模型代码题的隔离执行器。
 *
 * 默认禁用（EVAL_SANDBOX 未设为 1 时直接返回失败），避免把模型输出当本机代码执行。
 * 启用后只通过 Docker 运行：无网络、只读根文件系统、非 root、CPU/内存/PID 限额、
 * 丢弃全部 capability、禁止提权。Docker 不可用时返回失败，绝不回退到本机 python。
 */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_OUTPUT = 64 * 1024;

function sandboxEnabled() {
  return process.env.EVAL_SANDBOX === "1";
}

function runDocker(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.env.DOCKER_BIN || "docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH || "" },
        windowsHide: true
      });
    } catch (e) {
      return resolve({ code: -1, output: "无法启动 Docker：" + e.message });
    }

    let output = "";
    let bytes = 0;
    let done = false;
    const finish = (code, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, output: (output + extra).slice(-MAX_OUTPUT) });
    };

    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        child.kill("SIGKILL");
        return;
      }
      output += chunk.toString("utf8");
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => finish(-1, "\nDocker 启动失败：" + e.message));
    child.on("close", (code) => finish(typeof code === "number" ? code : -1));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(124, `\n沙箱超时（${timeoutMs}ms）`);
    }, timeoutMs + 3000);
  });
}

async function runPython(code, tests, { timeout = 6000 } = {}) {
  if (!sandboxEnabled()) {
    return { pass: false, detail: "代码执行已禁用（未启用 EVAL_SANDBOX）" };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-sandbox-"));
  try {
    await fs.writeFile(path.join(dir, "answer.py"), String(code || "") + "\n", { mode: 0o600 });
    await fs.writeFile(path.join(dir, "t.py"), "from answer import *\n" + String(tests || "") + "\nprint('PASS')\n", { mode: 0o600 });

    const image = process.env.EVAL_SANDBOX_IMAGE || "python:3.12-slim";
    const seconds = Math.max(1, Math.ceil(Number(timeout) / 1000));
    const args = [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--user",
      "65534:65534",
      "--memory",
      "128m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "64",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-e",
      "HOME=/tmp",
      "-v",
      `${dir}:/work:ro`,
      "-w",
      "/work",
      image,
      "timeout",
      String(seconds),
      "python",
      "/work/t.py"
    ];

    const result = await runDocker(args, Number(timeout) || 6000);
    const text = String(result.output || "");
    const pass = result.code === 0 && text.includes("PASS") && !/Traceback|AssertionError|Error/i.test(text);
    return {
      pass,
      detail: pass
        ? "沙箱单测通过"
        : text.split("\n").filter((line) => line.trim()).slice(-3).join(" / ").slice(0, 180) || "沙箱执行失败"
    };
  } catch (e) {
    return { pass: false, detail: "沙箱执行失败：" + String(e.message || e).slice(0, 120) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runPython, sandboxEnabled };
