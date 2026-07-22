# TriModel Product State

## Module Overview

- `TriModel` 是 TriMetaverse 的模型接入统一配置层。当前已从占位模块演进为可工作的 TypeScript ESM library。
- 提供 `createModelClient()` 工厂函数，TriMC 等 orchestration 层通过它统一调用模型。
- 支持模型注册表 + fallback 链：主模型失败时自动降级到备选模型。
- 当前唯一 provider 实现是 DeepSeek，支持 4 个模型。

## Current Product Scope

- Provider 抽象层：`Provider` 接口（chat、healthCheck、info）。
- 模型路由：`ModelRegistry` 记录每个模型的主 provider、fallback 模型和超时。
- 工厂函数：`createModelClient(config?)` — 读取环境变量并合并自定义配置，返回 `ModelClient` 实例。
- 当前支持的模型：
  - `deepseek-v4-pro` — 主模型，fallback → deepseek-chat, 超时 120s
  - `deepseek-v4-flash` — 快速模型，fallback → deepseek-v4-pro
  - `deepseek-chat` — 通用对话，fallback → deepseek-v4-pro
  - `deepseek-reasoner` — 推理模型，fallback → deepseek-chat

## Current Progress

- ✅ TypeScript ESM library，6 个源文件：`index.ts`, `client.ts`, `config.ts`, `types.ts`, `usage.ts`, `providers/deepseek.ts`, `providers/trimetaverse.ts`
- ✅ `Provider` 接口 + `DeepSeekProvider` 实现（fetch API，abort timeout，错误处理）
- ✅ `ModelClient` with `chat()`, `listModels()`, `getProvider()`, `healthCheck()`
- ✅ Fallback 链：chat 失败时自动尝试 fallback 模型
- ✅ `test/client.test.ts` — 7 项测试全部通过（含 fallback 测试）
- ✅ `test/usage.test.ts` — 7 项测试全部通过（UsageAccumulator 聚合器）
- ✅ TokenUsage 统一统计：`ChatResponse.usage` 编译期必选，跨 Provider 零值兜底
- ✅ `UsageAccumulator` — session 级用量聚合器（add/summary/reset，按 model 分组，partial 标记）
- ✅ `npm test` 使用 Node.js native test runner + tsx
- ✅ `npm run build` → tsc → dist/

## Bug And Gap State

- 仅支持 DeepSeek 单一 provider；OpenAI、Anthropic 等尚未接入。
- 流式输出（stream: true）尚未实现。
- ~~无 token 用量累计统计或成本追踪。~~ ✅ 已完成（2026-07-14, CTO-007 Phase 4）：`UsageAccumulator` 提供跨 provider 的 session 级 token 聚合，含 partial 标记。Credit 计费归属 TriStaciss，不在 TriModel scope。
- 无 CLI 入口 — 作为 library 仅通过 import 使用。
- healthCheck 发送真实 API 请求（cost 1 token），无 mock-only 模式。

## Cross-Module Dependencies

- 直接作为 **TriMC**、**TriLC**、**TriSkill** 等消费者的模型层依赖。消费端 `import TriModel` 时零配置即可使用，Key 由 TriModel 自身管理。
- **TriLC**（2026-07-22 确认）：作为 TriModel 消费者，通过 `GET /v1/models` 拉取模型列表，`GET /v1/config/keys` 拉取 Provider Key。TriLC 为 TriPilot 提供模型发现统一路径（TriPilot → TriLC `/v1/models` → TriModel）。
- TriTest 可以通过 mock fetch 机制对 TriModel 进行模型表现验证。

## API Key Architecture

TriModel 作为独立模块，**自管 API Key**，而非依赖消费端注入。

### 三层密钥模型

| 层 | 变量名 | 持有位置 | 用途 |
|----|--------|----------|------|
| L1 直连 | `DEEPSEEK_API_KEY` / `GLM_API_KEY` 等 | TriModel `.env` | TriModel → 各模型 Provider 直连 |
| L2 元 Provider | `TRIMODEL_TRIMETAVERSE_API_KEY` | TriModel `.env` | TriModel → TriStaciss 认证（`tmv-sk-*` 格式），TriStaciss 对 TriModel 而言与普通 Provider 无差别 |
| L3 真模型 | TriStaciss 内部 key | TriStaciss `.env` | TriStaciss → 真实模型调用，**对 TriModel 不可见** |

### 配置优先级（Key Resolution Order）

1. **构造函数参数**（实例级覆盖）：`createModelClient({ deepseekApiKey: 'sk-custom' })` — 仅影响该实例，不影响同进程内其他消费者
2. **TriModel `.env` 默认值**（Key 池基线）：所有消费者共享的默认 Key
3. ~~**process.env 全局覆盖**~~：**已废弃**。消费端不应通过 process.env 全局覆盖 Key，避免同进程内不同消费者的 Key 互相污染

### 设计原则

- **TriModel `.env`（gitignored）**：Key 真源，可存真实 Key。npm 发布时不进包，当前阶段全部本地 dev 不构成阻塞。
- **TriModel `.env.example`**：纯文档契约，声明"我需要哪些 env var"，不含真实 Key。
- **消费端不配 `.env` 给 TriModel 用**：TriMC 等消费端 `import TriModel` 零配置直接使用；如需覆盖，通过构造函数参数做实例级覆盖。
- **无全局污染**：Consumer A 覆盖自己的 Key 不影响 Consumer B。

## Architecture State

- 核心架构：`createModelClient(config?)` → `ModelClient` → `Provider` interface ← `DeepSeekProvider` / `TriMetaverseProvider`
- 用量层：`UsageAccumulator.add(ChatResponse)` → `summary()` → `{ calls, tokens, byModel, partial }`
- 路由：`ModelClient.chat(model, messages)` → 查 `ModelRegistry` → 调 `Provider.chat()` → 失败则 fallback
- 配置：`readConfig()` 先读 TriModel 自身 `.env` 作为默认 Key，再接受 `createModelClient(config?)` 构造函数参数做实例级覆盖。不依赖消费端 process.env 注入。
- Key 管理：TriModel `.env` 是 Key 池真源；`.env.example` 是纯文档契约；消费端零配置 import 即可使用
- **★ Phase 1 配置平面（2026-07-22）**：
  - HTTP API 服务（`node:http`，零框架依赖，`127.0.0.1:3333`）
  - 4 端点：`/health`、`/v1/models`、`/v1/config/keys`、`/v1/config/keys/refresh`
  - 定位：纯配置分发，不代理业务流量（chat/streaming 不经过此服务）
  - library 模式保留：本地 dev 和 TriLC fallback 继续使用 `import 'trimodel'`

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
- `../../src/index.ts`
- `../../src/client.ts`
- `../../src/config.ts`
- `../../src/types.ts`
- `../../src/providers/deepseek.ts`
- `../../src/providers/trimetaverse.ts`
- `../../src/usage.ts`
- `../../test/client.test.ts`
- `../../test/usage.test.ts`
