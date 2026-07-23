# TriModel Agent Rules

## Module Role

- TriModel 是 Provider/Model 统一配置层。
- 负责多 provider 适配、模型路由、fallback 链配置，为 `TriMC` 提供统一的模型接入点。
- **配置平面**：HTTP API server（`src/server.ts`）负责 Key 分发和模型列表，不代理业务流量。

## Current Status

- **Phase 2 实施中**（2026-07-22）：8 项 CONDITIONAL_PASS 逐步落地。
- Phase 1 已落地：DeepSeek provider 适配 + 配置平面 HTTP API。
- Phase 2 新增：Anthropic / OpenAI provider、SSE streaming、fallback 链修复、S2 加密、CI/CD。
- 可作为 library 被 TriMC import 使用：`import { createModelClient } from 'trimodel'`。

## Key Architecture

- **Config Plane Only**：TriModel 分发 API keys + model lists。Business traffic (chat/streaming) 直接从 clients 到 providers。
- **Providers**：
  - DeepSeek (native OpenAI-compatible + Anthropic-compatible)
  - Anthropic (native Messages API)
  - OpenAI (native Chat Completions API)
  - TriMetaverse (routes through TriStaciss)
- **Format**：ESM、TypeScript 5.x、Node.js >= 20、zero runtime dependencies
- **Test**：Node.js native test runner (`node --test`) + tsx
- **Lint**：ESLint flat config (`eslint.config.mjs`) with typescript-eslint strict-type-checked
- **CI**：GitHub Actions (lint + type-check + test + build on push/PR)

## Directory Structure

```
src/
├── index.ts              # Public exports + createModelClient()
├── client.ts             # ModelClient (provider registry, routing, fallback, stream)
├── config.ts             # TriModelConfig + readConfig()
├── types.ts              # Core type definitions
├── server.ts             # Config-plane HTTP server (node:http)
├── usage.ts              # UsageAccumulator for token tracking
├── api/
│   ├── routes.ts         # HTTP route dispatcher
│   ├── health.ts         # GET /health
│   ├── models.ts         # GET /v1/models
│   └── keys.ts           # GET/POST /v1/config/keys
├── providers/
│   ├── deepseek.ts       # DeepSeek (OpenAI-compatible)
│   ├── deepseek-anthropic.ts  # DeepSeek (Anthropic-compatible)
│   ├── anthropic.ts      # Anthropic native
│   ├── openai.ts         # OpenAI native
│   ├── trimetaverse.ts   # TriMetaverse platform
│   └── stream/
│       ├── anthropic-sse-parser.ts  # Shared Anthropic SSE parser
│       └── openai-sse-parser.ts     # Shared OpenAI-compatible SSE parser
└── security/
    └── key-encryptor.ts  # S2 AES-256-GCM encryption (Phase 2)
```

## Key Conventions

- **Backward compatibility**：`TriModelConfig` 新增字段均有默认空值，不传则行为与 Phase 1 一致。
- **Fallback depth limit**：max 2 hops，防止死循环。`All fallback models exhausted` → 友好提示。
- **S2 encryption rollback**：`TRIMODEL_KEY_STORAGE_MODE=s3` → 明文模式。
- **No proxy**：配置平面仅分发 Key，chat/streaming 流量不经过 TriModel server。

## Strategy Delegation

- 总商业模式、当前商业实验、TriModel 是否进入当前路径，先咨询 `TriMetaverse/BusinessStrategy`。

## Local Fact Sources

- 产品事实：`README.md`
- 代码事实：`src/`（TypeScript ESM library）、`test/`（Node.js native test runner）
- CI 事实：`.github/workflows/ci.yml`

## Current Registries

- `TriModelBusinessStrategyRegistry`
- `TriModelProductRegistry`
- `TriModelCodeRegistry`

当前 registry agent canonical discovery 位于 `TriModel/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 禁止虚构 provider 列表、路由逻辑或进度状态。
- 新增 provider 前必须更新本文件、README 和所有 registry 文档。
- 所有代码改动需通过 `npm run lint` + `npm test` + `npm run build`。
