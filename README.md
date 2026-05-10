# Dian 插件开发手册

> 适用版本：Dian `0.1.x` · plugin-runtime `0.1.x`

Dian 插件系统基于 TypeScript 装饰器，支持**消息处理、HTTP 路由、指令注册、Web UI**四大能力，插件以 ZIP 包形式安装，事件 Handler 热加载生效。

---

## 目录

1. [环境准备](#1-环境准备)
2. [项目结构](#2-项目结构)
3. [插件声明 @Plugin](#3-插件声明-plugin)
4. [消息 Handler @Handler](#4-消息-handler-handler)
5. [拦截器 @Interceptor](#5-拦截器-interceptor)
6. [onSetup — 高级注册](#6-onsetup--高级注册)
   - [6.1 HTTP API 路由](#61-http-api-路由)
   - [6.2 命令式指令](#62-命令式指令)
   - [6.3 Web UI](#63-web-ui)
7. [EventContext API](#7-eventcontext-api)
8. [BotEvent 数据结构](#8-botevent-数据结构)
9. [构建 & 打包](#9-构建--打包)
10. [安装方式](#10-安装方式)
11. [热重载说明](#11-热重载说明)
12. [完整示例](#12-完整示例)

---

## 1. 环境准备

```bash
# 在 Dian 项目根目录先执行一次全量构建
npm run build

# 进入模板目录安装依赖
cd plugin-template
npm install
```

修改以下两处，设置你的插件 ID（全局唯一）：

**`package.json`**
```json
{ "name": "my-plugin" }
```

**`src/index.ts`** 中的 `@Plugin`
```ts
@Plugin({ name: "my-plugin", ... })
```

> **注意**：`package.json` 的 `name` 与 `@Plugin` 的 `name` 必须一致，否则打包和 URL 路由会对不上。

---

## 2. 项目结构

```
plugin-template/
├── src/
│   ├── index.ts          ← 插件主入口（唯一必须的文件）
│   └── public/           ← Web UI 静态文件目录（可选）
│       └── index.html
├── scripts/
│   └── pack.mjs          ← 打包脚本（PowerShell Compress-Archive）
├── package.json
├── tsconfig.json
└── tsup.config.ts        ← 打包配置（将所有依赖 bundle 为单文件）
```

构建产物（`dist/`）会被打包进 ZIP：

```
dist/
├── index.js      ← 插件逻辑（已 bundle，含 decorators）
└── public/       ← Web UI（由 tsup onSuccess 复制）
    └── index.html
```

---

## 3. 插件声明 @Plugin

每个插件的**默认导出类**必须标注 `@Plugin`，提供插件元信息。

```ts
import "reflect-metadata";
import { Plugin } from "@dian/plugin-runtime";

@Plugin({
  name: "my-plugin",          // 必填，全局唯一 ID
  description: "插件描述",    // 可选，显示在管理界面
  version: "1.0.0",           // 可选
  author: "your-name",        // 可选
  icon: "🔌",                 // 可选，emoji 或图片 URL
})
export default class MyPlugin {
  // ...
}
```

---

## 4. 消息 Handler @Handler

`@Handler` 标注的方法会在消息文本匹配时被调用，支持**精确字符串**或**正则表达式**匹配。

```ts
import { Handler, type EventContext } from "@dian/plugin-runtime";

// 精确匹配 "!ping"（区分大小写）
@Handler("!ping")
async onPing(ctx: EventContext): Promise<void> {
  console.log("收到 ping，发送者：", ctx.event.payload.senderName);
}

// 正则匹配，支持捕获组
@Handler(/^!echo\s+(.+)$/)
async onEcho(ctx: EventContext): Promise<void> {
  const text = ctx.event.payload.text ?? "";
  const [, content] = text.match(/^!echo\s+(.+)$/) ?? [];
  console.log("echo:", content);
}
```

**匹配规则**：
- 字符串 → 与 `event.payload.text` 完全相等
- 正则 → `regex.test(event.payload.text ?? "")`
- 多个 `@Handler` 可以标注在同一个类的不同方法上
- 若拦截器调用了 `ctx.stopPropagation()`，本 Handler 将不被执行

---

## 5. 拦截器 @Interceptor

拦截器在所有 Handler **之前**执行，可用于日志、鉴权、消息过滤等。

```ts
import { Interceptor, type EventContext } from "@dian/plugin-runtime";

@Interceptor(50)   // 数字为优先级，越小越先执行，默认 100
async filter(ctx: EventContext): Promise<void> {
  // 屏蔽特定群的所有消息
  if (ctx.event.payload.groupId === "blocked_group_id") {
    ctx.stopPropagation();   // 阻止后续所有 Handler
    return;
  }

  // 日志记录（不阻止，继续执行后续 Handler）
  console.log(`[${ctx.event.botId}] ${ctx.event.payload.text}`);
}
```

---

## 6. onSetup — 高级注册

在类中定义 `onSetup(ctx: PluginSetupContext)` 方法，Dian 在加载插件时会调用它，用于注册 HTTP 路由、指令和 UI。

```ts
import { type PluginSetupContext } from "@dian/plugin-runtime";

onSetup(ctx: PluginSetupContext): void {
  // 见下文各小节
}
```

### 6.1 HTTP API 路由

```ts
ctx.route(method, path, handler);
```

- **访问地址**：`/plugins/<name>/api<path>`
- `method`：`"GET"` `"POST"` `"PUT"` `"DELETE"` `"PATCH"`
- `handler`：Fastify 路由处理函数 `(request, reply) => void`

```ts
// GET /plugins/my-plugin/api/status
ctx.route("GET", "/status", (_req, reply) => {
  reply.send({ ok: true, ts: Date.now() });
});

// POST /plugins/my-plugin/api/config
ctx.route("POST", "/config", (req, reply) => {
  const body = req.body as { key: string; value: string };
  // ... 保存配置
  reply.send({ saved: true });
});
```

> **注意**：HTTP 路由在**服务器启动时**注册，安装后需**重启 Dian 服务**才能生效。事件 Handler 和指令支持热加载，无需重启。

### 6.2 命令式指令

等同于 `@Handler`，但额外携带 `name` 和 `description` 用于在管理界面展示。

```ts
ctx.command({
  name: "/help",             // 显示名
  pattern: "!help",          // 匹配字符串，也可传 RegExp
  description: "显示帮助",   // 可选，管理界面展示
  async handler(c: EventContext) {
    console.log("help requested");
  },
});
```

### 6.3 Web UI

将静态文件放到 `src/public/`，声明后 Dian 自动 serve：

```ts
ctx.ui({
  staticDir: "./public",   // 相对于 dist/index.js 的目录
  entry: "index.html",     // 入口文件，默认 index.html
});
```

- **访问地址**：`/plugins/<name>/ui/`
- 管理界面的「插件界面」区域会以 **iframe** 嵌入此地址
- 页面内可以用相对路径调用插件自己的 API：

```js
// 在 public/index.html 内
fetch("/plugins/my-plugin/api/status")
  .then(r => r.json())
  .then(data => console.log(data));
```

---

## 7. EventContext API

```ts
interface EventContext {
  /** 当前事件 */
  readonly event: BotEvent;

  /**
   * 阻止当前事件继续向后续 Handler 传递。
   * 调用后，优先级更低的拦截器和所有 Handler 不再执行。
   */
  stopPropagation(): void;
}
```

---

## 8. BotEvent 数据结构

```ts
interface BotEvent {
  eventId:   string;                              // 唯一事件 ID
  botId:     string;                              // 触发事件的 Bot ID
  type:      "message" | "notice" | "request";   // 事件大类
  subtype:   string;                              // 事件子类型
  timestamp: number;                              // Unix 毫秒时间戳
  payload: {
    text?:        string;   // 消息文本
    userId?:      string;   // 发送者 QQ 号
    groupId?:     string;   // 群号（私聊时为空）
    messageId?:   string;   // 消息 ID
    senderName?:  string;   // 发送者昵称 / 群名片
  };
  raw: unknown;   // OneBot 协议原始数据（可强转为具体类型）
}
```

---

## 9. 构建 & 打包

```bash
# 开发时监听变动
npm run dev

# 一次性构建
npm run build

# 构建 + 打包为 ZIP（Windows，依赖 PowerShell）
npm run pack
```

`npm run pack` 生成 `<name>.zip`，ZIP 内容即为 `dist/` 目录的平铺结构：

```
my-plugin.zip/
├── index.js
└── public/
    └── index.html
```

---

## 10. 安装方式

### 方式一：管理界面上传（推荐）

1. 打开 Dian 管理界面 → **插件模块**
2. 点击左上角 **⬆ 上传**图标
3. 拖入或选择 `<name>.zip`
4. 点击 **安装**，等待成功提示
5. 点击刷新，插件出现在列表中

### 方式二：手动解压

将 ZIP 解压到 `plugins/<name>/` 目录：

```
Dian/
└── plugins/
    └── my-plugin/         ← 解压到此处
        ├── index.js
        └── public/
            └── index.html
```

---

## 11. 热重载说明

Dian 使用 chokidar 监听 `plugins/` 目录，文件变化时自动重载：

| 功能 | 热加载 | 说明 |
|---|---|---|
| `@Handler` 消息处理 | ✅ 即时生效 | 无需任何操作 |
| `@Interceptor` 拦截器 | ✅ 即时生效 | 无需任何操作 |
| `ctx.command` 指令 | ✅ 即时生效 | 无需任何操作 |
| `ctx.route` HTTP 路由 | ❌ 需重启 | Fastify 不支持运行时动态注册 |
| `ctx.ui` Web UI | ❌ 需重启 | 静态 serve 在启动时注册 |

> **调试建议**：修改 Handler/拦截器逻辑时，`npm run dev` + 保存即可生效；新增/修改路由时，重新 pack → 上传 → 重启服务。

---

## 12. 完整示例

```ts
import "reflect-metadata";
import {
  Plugin,
  Handler,
  Interceptor,
  type EventContext,
  type PluginSetupContext,
} from "@dian/plugin-runtime";

@Plugin({
  name: "my-plugin",
  description: "示例插件",
  version: "1.0.0",
  author: "your-name",
  icon: "🔌",
})
export default class MyPlugin {
  // ── 拦截器（最先执行） ────────────────────────────────────────────────────
  @Interceptor(10)
  async log(ctx: EventContext): Promise<void> {
    const { type, payload } = ctx.event;
    if (type === "message") {
      console.log(`[my-plugin] <${payload.senderName}> ${payload.text}`);
    }
  }

  // ── 消息 Handler ──────────────────────────────────────────────────────────
  @Handler("!ping")
  async onPing(_ctx: EventContext): Promise<void> {
    console.log("pong!");
  }

  @Handler(/^!repeat\s+(.+)$/)
  async onRepeat(ctx: EventContext): Promise<void> {
    const [, content] = (ctx.event.payload.text ?? "").match(/^!repeat\s+(.+)$/) ?? [];
    console.log("repeat:", content);
  }

  // ── HTTP 路由 / 指令 / UI ─────────────────────────────────────────────────
  onSetup(ctx: PluginSetupContext): void {
    ctx.route("GET", "/status", (_req, reply) => {
      reply.send({ ok: true, plugin: "my-plugin" });
    });

    ctx.command({
      name: "/help",
      pattern: "!help",
      description: "显示帮助",
      async handler(c) {
        console.log("help from", c.event.payload.senderName);
      },
    });

    ctx.ui({ staticDir: "./public", entry: "index.html" });
  }
}
```
