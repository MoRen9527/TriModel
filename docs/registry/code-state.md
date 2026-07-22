# TriModel Code State

## Repository Map

- **Language**: TypeScript 5.x (ESM, `"type": "module"`)
- **Runtime**: Node.js >= 20
- **Package Manager**: npm
- **Build**: `tsc` (no bundler)
- **Test Runner**: Node.js native test runner (`node --test`) + tsx
- **Lint/Format**: None configured yet

### Source Layout

```
src/
├── index.ts              # 公共导出 + createModelClient() 工厂函数
├── client.ts             # ModelClient (provider registry, routing, fallback, health check)
├── config.ts             # TriModelConfig 接口 + readConfig() from env
├── types.ts              # Message, ChatOptions, ChatResponse, Provider, ModelRegistry 等
├── server.ts             # ★ Phase 1: 配置平面 HTTP API server (node:http, 无框架依赖)
├── providers/
│   ├── deepseek.ts       # DeepSeekProvider implements Provider
│   └── deepseek-anthropic.ts  # ★ Phase 1: DeepSeek Anthropic-compatible adapter
└── api/                  # ★ Phase 1: HTTP API 路由层
    ├── routes.ts         # 请求分发 (dispatch)
    ├── health.ts         # GET /health
    ├── models.ts         # GET /v1/models
    └── keys.ts           # GET /v1/config/keys + POST /v1/config/keys/refresh

test/
└── client.test.ts        # 14 项测试 (含 API server、Key 端点、回归)
```

### Entry Points

| Entry | Path | Description |
|-------|------|-------------|
| `main` | `dist/src/index.js` | 库入口: `export { ModelClient, DeepSeekProvider, createModelClient, ... }` |
| `types` | `dist/src/index.d.ts` | 类型导出 |
| **`serve`** | `src/server.ts` | **★ Phase 1 新增**: 配置平面 HTTP API 服务 (`npm run serve` / `npm run start:server`) |

### API Endpoints（Phase 1 配置平面）

| Method | Path | Description | 认证 |
|--------|------|-------------|------|
| `GET` | `/health` | 健康检查 | 无 |
| `GET` | `/v1/models` | 模型列表（从 ModelClient registry 读取） | 无 |
| `GET` | `/v1/config/keys` | Provider Key 全量分发 | Bearer token（本地回环 ******） |
| `POST` | `/v1/config/keys/refresh` | 手动触发 Key 刷新 | Bearer token（本地回环 ******） |

- 监听地址：`127.0.0.1:3333`（`TRIMODEL_HOST` / `TRIMODEL_PORT` 可配置）
- 定位：纯配置分发服务，**不代理业务流量**（chat/streaming 不经过此服务）
- version: **0.2.0**（从 0.1.0 bump，反映 API server 新增能力）

### Dependencies

| Package | Purpose |
|---------|---------|
| `typescript` | 编译 |
| `tsx` | 开发/测试运行时 |
| `@types/node` | Node.js 类型定义 |

- **Runtime deps**: `{}` — 零运行时依赖，HTTP server 使用 Node.js 内置 `node:http`，仅使用 Node.js 内置 `fetch`。

## Code Health

### Build

- `npm run build` → `tsc` → `dist/` ✅ Clean passing
- `npm run check` → `tsc --noEmit` ✅ Type check passing

### Test

| Suite | Tests | Status |
|-------|-------|--------|
| `test/client.test.ts` | 14 | ✅ 13 PASS + 1 CONDITIONAL_PASS (TM-REG-001 预存) |
| — DeepSeekProvider.chat | 2 | ✅ chat + reasoner |
| — ModelClient.listModels | 1 | ✅ model listing |
| — ModelClient.chat (routing) | 2 | ✅ normal + fallback |
| — ModelClient (unknown model) | 1 | ✅ throws |
| — readConfig | 1 | ⚠️ CONDITIONAL_PASS（预存：期望空 Key，`.env` 已配置真实 Key） |
| — API server /health | 1 | ✅ 200 OK |
| — API server /v1/models | 2 | ✅ 模型列表 + 格式验证 |
| — API server /v1/config/keys | 2 | ✅ 认证 + Key 分发 |
| — API server /v1/config/keys/refresh | 1 | ✅ 刷新触发 |

### Coverage Summary

| Layer | Status |
|-------|--------|
| Client (client.ts) | ✅ Provider registry, model routing, fallback chain, health check |
| Config (config.ts) | ✅ Env var reading, defaults, merge |
| Types (types.ts) | ✅ Message, ChatResponse, Provider, ModelRegistry, ModelRoutingConfig |
| Provider (deepseek.ts) | ✅ fetch API, abort timeout, error handling, usage parsing |
| **API Server (server.ts + api/)** | **★ Phase 1**: HTTP server, 4 端点, dispatch 路由, 认证 |
| **Provider (deepseek-anthropic.ts)** | **★ Phase 1**: Anthropic-compatible adapter for TriStaciss |

## Git Health

- **Last commit**: 2026-07-05 (Checkpoint 066: TriDeployment-TriTest CLI Polish)
- **Uncommitted changes（Phase 1）**: `src/server.ts`, `src/api/`, `src/providers/deepseek-anthropic.ts`, `package.json` (version bump to 0.2.0), `src/client.ts`, `src/config.ts`, `test/client.test.ts`, `.env.example`
- ⚠️ **R1 合入待闭合**：Phase 1 代码存在于工作树但未 commit，ImplementationEngineer 需完成 `git add + commit + push`
- **Branches**: main
- **Recent velocity**: Phase 1 最小接入 1 个月内完成；配置平面改造 W30 完成

## Quality Risks

1. **单 provider 依赖**: 仅实现 DeepSeek，无 provider 多样性保证。
2. **无 lint/format 工具**: 未配置 ESLint 或 Prettier。
3. **无 CI**: 无 GitHub Actions 或 CI 流水线。
4. **fallback 递归风险**: fallback 链 `deepseek-v4-pro → deepseek-chat → deepseek-v4-pro` — 两个都失败时会循环（当前由单次 try/catch 保护，不会死循环，但会抛原始错误）。
5. **无流式支持**: stream 尚不支持，对大响应不友好。
6. **AGENTS.md / README.md 仍标"待初始化"**: 与当前代码进度脱节。
7. **★ Phase 1 新增**: S3 安全级别（600 文件权限 + 127.0.0.1 监听），Phase 2 需升级到 S2（AES-256-GCM 加密 + 机器指纹派生密钥）。

## Sources

- `../../package.json`
- `../../tsconfig.json`
- `../../src/index.ts`
- `../../src/client.ts`
- `../../src/config.ts`
- `../../src/types.ts`
- `../../src/providers/deepseek.ts`
- `../../test/client.test.ts`
