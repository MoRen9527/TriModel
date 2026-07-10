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

- ✅ TypeScript ESM library，5 个源文件：`index.ts`, `client.ts`, `config.ts`, `types.ts`, `providers/deepseek.ts`
- ✅ `Provider` 接口 + `DeepSeekProvider` 实现（fetch API，abort timeout，错误处理）
- ✅ `ModelClient` with `chat()`, `listModels()`, `getProvider()`, `healthCheck()`
- ✅ Fallback 链：chat 失败时自动尝试 fallback 模型
- ✅ `test/client.test.ts` — 7 项测试全部通过（含 fallback 测试）
- ✅ `npm test` 使用 Node.js native test runner + tsx
- ✅ `npm run build` → tsc → dist/

## Bug And Gap State

- 仅支持 DeepSeek 单一 provider；OpenAI、Anthropic 等尚未接入。
- 流式输出（stream: true）尚未实现。
- 无 token 用量累计统计或成本追踪。
- 无 CLI 入口 — 作为 library 仅通过 import 使用。
- healthCheck 发送真实 API 请求（cost 1 token），无 mock-only 模式。

## Cross-Module Dependencies

- 直接作为 TriMC 的模型层依赖。
- 环境变量 `DEEPSEEK_API_KEY` 来自宿主（或 TriMC 注入）。
- TriTest 可以通过 mock fetch 机制对 TriModel 进行模型表现验证。

## Architecture State

- 核心架构：`createModelClient()` → `ModelClient` → `Provider` interface ← `DeepSeekProvider`
- 路由：`ModelClient.chat(model, messages)` → 查 `ModelRegistry` → 调 `Provider.chat()` → 失败则 fallback
- 配置：`readConfig()` 从 process.env 读取，可被 `createModelClient(config?)` 覆盖

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
- `../../src/index.ts`
- `../../src/client.ts`
- `../../src/config.ts`
- `../../src/types.ts`
- `../../src/providers/deepseek.ts`
- `../../test/client.test.ts`
