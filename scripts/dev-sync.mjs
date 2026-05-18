#!/usr/bin/env node
/**
 * Dian 插件远程开发同步脚本
 * 用法:
 *   node scripts/dev-sync.mjs
 *
 * 配置（优先顺序：环境变量 > dev.config.mjs > package.json）:
 *   DIAN_DEV_WS_URL      默认 ws://127.0.0.1:3901
 *   DIAN_DEV_TOKEN       必填
 *   DIAN_DEV_PLUGIN_NAME 默认取 package.json 的 name
 *   DIAN_DEV_DIST_DIR    默认 dist
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import WebSocket from "ws";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── 配置读取 ────────────────────────────────────────────────────────────────

async function loadConfig() {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  } catch { /* ignore */ }

  let file = {};
  try {
    const m = await import(resolve(ROOT, "dev.config.mjs"));
    file = m.default ?? m;
  } catch { /* ignore */ }

  const wsUrl     = process.env.DIAN_DEV_WS_URL     ?? file.wsUrl     ?? "ws://127.0.0.1:3901";
  const token     = process.env.DIAN_DEV_TOKEN     ?? file.token     ?? "";
  const pluginName = process.env.DIAN_DEV_PLUGIN_NAME ?? file.pluginName ?? pkg.name ?? "my-plugin";
  const distDir   = process.env.DIAN_DEV_DIST_DIR   ?? file.distDir   ?? "dist";
  const debounceMs = Number(process.env.DIAN_DEV_DEBOUNCE ?? file.debounceMs ?? 300);

  if (!token) {
    console.error("[dev-sync] 缺少 token: 设置 DIAN_DEV_TOKEN 或在 dev.config.mjs 中配置");
    process.exit(1);
  }

  return { wsUrl, token, pluginName, distDir: resolve(ROOT, distDir), debounceMs };
}

// ── 打包 ────────────────────────────────────────────────────────────────────

function packDirToBase64(dir) {
  const files = {};
  function walk(d, prefix = "") {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
      } else {
        files[rel.replace(/\\/g, "/")] = readFileSync(full);
      }
    }
  }
  walk(dir);
  const zipped = zipSync(files, { level: 6 });
  return Buffer.from(zipped).toString("base64");
}

// ── WS 客户端 ────────────────────────────────────────────────────────────────

class DevSyncClient {
  constructor({ wsUrl, token, pluginName, onReconnect }) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.pluginName = pluginName;
    this.onReconnect = onReconnect;
    this.ws = null;
    this.authed = false;
    this._closing = false;
    this._connecting = false;
    this._reconnectTimer = null;
    this._pendingBundle = null;
  }

  async connect() {
    if (this._connecting || this.ws?.readyState === WebSocket.OPEN) return;
    this._connecting = true;
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        this._connecting = false;
        reject(err);
        return;
      }

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this._connecting = false;
          this.ws?.close();
          reject(new Error("连接超时"));
        }
      }, 5000);

      this.ws.on("open", () => {
        this.send({ type: "auth", token: this.token, pluginName: this.pluginName });
      });

      this.ws.on("message", (raw) => {
        let data;
        try { data = JSON.parse(String(raw)); } catch { return; }
        switch (data.type) {
          case "auth-result":
            clearTimeout(timer);
            resolved = true;
            this._connecting = false;
            if (data.ok) {
              this.authed = true;
              console.info("[dev-sync] 认证成功");
              if (this._pendingBundle) {
                this.pushBundle(this._pendingBundle);
                this._pendingBundle = null;
              }
              resolve(true);
            } else {
              console.error("[dev-sync] 认证失败:", data.message);
              reject(new Error(data.message));
            }
            break;
          case "bundle-accepted":
            console.info("[dev-sync] 服务端已接收 bundle");
            break;
          case "reload-complete":
            console.info("[dev-sync] 插件热重载完成");
            break;
          case "reload-error":
            console.error("[dev-sync] 热重载失败:", data.message);
            break;
          case "error":
            console.error("[dev-sync] 服务端错误:", data.message);
            break;
        }
      });

      this.ws.on("close", () => {
        clearTimeout(timer);
        this.authed = false;
        this._connecting = false;
        if (!this._closing && !resolved) {
          reject(new Error("连接被关闭"));
        } else if (!this._closing) {
          console.info("[dev-sync] 连接断开，5 秒后自动重连...");
          this._scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        if (!resolved) {
          clearTimeout(timer);
          resolved = true;
          this._connecting = false;
          reject(err);
        } else {
          console.error("[dev-sync] 连接错误:", err.message);
        }
      });
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closing) return;
      try {
        await this.connect();
        console.info("[dev-sync] 重连成功");
        this.onReconnect?.();
      } catch (err) {
        console.error("[dev-sync] 重连失败:", err.message);
        this._scheduleReconnect();
      }
    }, 5000);
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  pushBundle(base64) {
    if (!this.authed || this.ws?.readyState !== WebSocket.OPEN) {
      this._pendingBundle = base64;
      console.info("[dev-sync] 连接未就绪，已缓存 bundle");
      return;
    }
    this.send({ type: "push-bundle", pluginName: this.pluginName, bundle: base64 });
  }

  close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.ws?.close();
  }
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  const config = await loadConfig();
  const { wsUrl, token, pluginName, distDir, debounceMs } = config;

  if (!existsSync(distDir)) {
    console.error(`[dev-sync] dist 目录不存在: ${distDir}`);
    console.error("请先运行 npm run build 或 npm run dev:plugin");
    process.exit(1);
  }

  console.info(`[dev-sync] 目标插件: ${pluginName}`);
  console.info(`[dev-sync] 服务端: ${wsUrl}`);
  console.info(`[dev-sync] 监听目录: ${distDir}`);

  let pendingBundle = null;
  const client = new DevSyncClient({ wsUrl, token, pluginName, onReconnect: () => {
    if (pendingBundle) {
      client.pushBundle(pendingBundle);
      pendingBundle = null;
    }
  }});
  await client.connect();

  const firstBundle = packDirToBase64(distDir);
  console.info(`[dev-sync] 首次推送 ${Math.round(firstBundle.length / 1024)}KB...`);
  client.pushBundle(firstBundle);
  pendingBundle = firstBundle;

  // 监听文件变动
  let timer = null;
  const push = () => {
    try {
      const bundle = packDirToBase64(distDir);
      console.info(`[dev-sync] 推送 ${Math.round(bundle.length / 1024)}KB...`);
      client.pushBundle(bundle);
      pendingBundle = bundle;
    } catch (err) {
      console.error("[dev-sync] 打包失败:", err.message);
    }
  };

  const debouncedPush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, debounceMs);
  };

  const { watch } = await import("node:fs");
  const watchers = [];
  function watchDir(dir) {
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) debouncedPush();
      });
      watchers.push(w);
    } catch (err) {
      console.warn(`[dev-sync] 无法监听 ${dir}:`, err.message);
    }
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) watchDir(full);
    }
  }

  watchDir(distDir);

  const stop = () => {
    console.info("[dev-sync] 正在关闭...");
    watchers.forEach(w => w.close());
    client.close();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("[dev-sync] 异常:", err);
  process.exit(1);
});
