# TriModel

Unified model configuration layer for TriMetaverse.

## What is TriModel?

TriModel provides a unified interface for AI model access across multiple providers:
- **Library**: `ModelClient` with provider registry, model routing, and fallback chain
- **Configuration Plane**: HTTP API server for key distribution and model listing
- **Zero Runtime Deps**: Built on Node.js `fetch` and `node:http`, no framework dependencies

## Quick Start

```bash
npm install
cp .env.example .env  # Configure your API keys
npm run dev            # Run library entry point
npm run serve          # Start config-plane HTTP server on port 3333
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run library entry point |
| `npm run serve` | Start config-plane HTTP server |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | Run unit tests (Node.js native test runner) |
| `npm run check` | TypeScript type-check |
| `npm run lint` | ESLint code quality check |
| `npm run lint:fix` | Auto-fix ESLint issues |

## Supported Providers

| Provider | Models | API Format |
|----------|--------|------------|
| **DeepSeek** | deepseek-v4-pro, deepseek-v4-flash（deepseek-chat / deepseek-reasoner 为退役名兼容别名） | OpenAI-compatible |
| **DeepSeek (Anthropic)** | deepseek-v4-pro, deepseek-v4-flash | Anthropic Messages |
| **Anthropic** | claude-sonnet-4, claude-haiku-3-5, claude-opus-4 | Anthropic Messages |
| **OpenAI** | gpt-5, gpt-5-mini, gpt-5-nano | OpenAI Chat Completions |
| **TriMetaverse** | Multi-model routing | TriStaciss proxy |

## Architecture

```
┌─────────────┐     Keys / Models     ┌──────────────┐
│  TriLC /    │ ◄──────────────────► │  TriModel    │
│  TriMC      │   HTTP (127.0.0.1)   │  Config Plane│
└──────┬──────┘                       └──────────────┘
       │                                    │
       │  Chat / Stream                     │ Config only
       ▼                                    ▼
┌─────────────┐                      ┌──────────────┐
│  DeepSeek   │                      │  .env        │
│  Anthropic  │                      │  keys.json   │
│  OpenAI     │                      │  (S2 enc)    │
└─────────────┘                      └──────────────┘
```

- **Config Plane Only**: Business traffic (chat/streaming) goes directly from clients to providers.
- **Fallback Chain**: Automatic provider failover with depth-limited cascade (max 2 hops).
- **Security (S2)**: AES-256-GCM encryption with machine-fingerprint-derived keys (Phase 2).

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `TRIMODEL_DEFAULT_MODEL` | `deepseek-v4-pro` | Default model |
| `TRIMODEL_PORT` | `3333` | Config-plane HTTP port |

## API Endpoints (Config Plane)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check |
| `GET` | `/v1/models` | None | List available models |
| `GET` | `/v1/config/keys` | Bearer token | Get provider keys |
| `POST` | `/v1/config/keys/refresh` | Bearer token | Force key refresh |

## Development

- **Node.js**: >= 18.20.0（LG-035 P3-sg 切片 1 自 20 放宽；现役开发环境 20+，兼容底线 18.20.0——src 零 Node-20-only API 实勘 2026-09-11）
- **TypeScript**: 5.x ESM (`"type": "module"`)
- **Test Runner**: Node.js native (`node --test`)
- **CI**: GitHub Actions (lint + type-check + test + build on push/PR)

## 本地侧 Web UI（LG-035 本地域，2026-09-14）

本地域（TriMLC 8713 / TriRLC 8711）的时段切换配置面=本机 TriModel 实例（`http://127.0.0.1:3333/ui`）：

- **域标签**：`TRIMODEL_DOMAIN_LABEL`（默认 `本地域（TriMLC/TriRLC）`；sg 部署设 `TriMMC（sg）`）。
- **「应用到本机」**：`TRIMODEL_LOCAL_APPLY=1` 时启用——把活动策略落 `policies/local.json`（本机直生效，替代 sg 侧 COS 应用链）；sg 侧不设=按钮隐藏（零行为变化）。
- **策略目录规范位**：`TRIMODEL_POLICIES_DIR` env > 进程 cwd（`policies/`）；boot 自动迁移 legacy 编译邻接旧位（D9 同族，幂等）。
- **消费链**：TriMLC/TriRLC key-cache 从 `TRILC_TRIMODEL_API_URL`（默认 `http://127.0.0.1:3333`）拉 `default_model`（=策略窗命中→卡默认→env 出厂三层求值）。
- 启动（本地）：`TRIMODEL_LOCAL_APPLY=1 node dist/src/server.js`（工作目录=仓库根）。

## Deployment (sg)

- 部署面归 COS（LG-035 P3-sg 切片 2）；工程侧两项部署验证（P3-sg 切片 1 定）：
  1. `--test-concurrency` 旗标在 Node 18.20.8 的支持性候 sg 实测（`node --test --test-concurrency=1` 一次即知）；不支持则部署 profile 的 test 命令摘旗（本地保留旗标，不影响产物）。
  2. `npm run build` 后在 sg 以部署 Node 版本 `node -e "import('file://.../dist/src/index.js').then(()=>console.log('ok'))"` 冒烟（构建产物 18 可加载性自证）。
  3. **卡路径钉死（D9）**：trimmc-card.json 解析序=`TRIMODEL_CARD_FILE` env → `process.cwd()/trimmc-card.json` → legacy dist 邻接（只读，boot 迁移改名式搬至规范位）。systemd unit **必须钉 WorkingDirectory=仓根**，否则卡落 cwd 漂移位。
