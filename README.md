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
| **DeepSeek** | deepseek-chat, deepseek-reasoner | OpenAI-compatible |
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
| `TRIMODEL_DEFAULT_MODEL` | `deepseek-chat` | Default model |
| `TRIMODEL_PORT` | `3333` | Config-plane HTTP port |

## API Endpoints (Config Plane)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check |
| `GET` | `/v1/models` | None | List available models |
| `GET` | `/v1/config/keys` | Bearer token | Get provider keys |
| `POST` | `/v1/config/keys/refresh` | Bearer token | Force key refresh |

## Development

- **Node.js**: >= 20
- **TypeScript**: 5.x ESM (`"type": "module"`)
- **Test Runner**: Node.js native (`node --test`)
- **CI**: GitHub Actions (lint + type-check + test + build on push/PR)
