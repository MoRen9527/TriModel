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
└── providers/
    └── deepseek.ts       # DeepSeekProvider implements Provider

test/
└── client.test.ts        # 7 项测试 (fetch mock, fallback, unknown model, config)
```

### Entry Points

| Entry | Path | Description |
|-------|------|-------------|
| `main` | `dist/src/index.js` | 库入口: `export { ModelClient, DeepSeekProvider, createModelClient, ... }` |
| `types` | `dist/src/index.d.ts` | 类型导出 |

注意：TriModel 没有 CLI 入口 (`bin`)，是纯 library 模块。

### Dependencies

| Package | Purpose |
|---------|---------|
| `typescript` | 编译 |
| `tsx` | 开发/测试运行时 |
| `@types/node` | Node.js 类型定义 |

- **Runtime deps**: `{}` — 零运行时依赖，仅使用 Node.js 内置 `fetch`。

## Code Health

### Build

- `npm run build` → `tsc` → `dist/` ✅ Clean passing
- `npm run check` → `tsc --noEmit` ✅ Type check passing

### Test

| Suite | Tests | Status |
|-------|-------|--------|
| `test/client.test.ts` | 7 | ✅ All passing |
| — DeepSeekProvider.chat | 2 | ✅ chat + reasoner |
| — ModelClient.listModels | 1 | ✅ model listing |
| — ModelClient.chat (routing) | 2 | ✅ normal + fallback |
| — ModelClient (unknown model) | 1 | ✅ throws |
| — readConfig | 1 | ✅ defaults |

### Coverage Summary

| Layer | Status |
|-------|--------|
| Client (client.ts) | ✅ Provider registry, model routing, fallback chain, health check |
| Config (config.ts) | ✅ Env var reading, defaults, merge |
| Types (types.ts) | ✅ Message, ChatResponse, Provider, ModelRegistry, ModelRoutingConfig |
| Provider (deepseek.ts) | ✅ fetch API, abort timeout, error handling, usage parsing |

## Git Health

- **Last commit**: 2026-07-05 (Checkpoint 066: TriDeployment-TriTest CLI Polish)
- **Uncommitted changes**: business-state.md, product-state.md, code-state.md (本次 registry 更新)
- **Branches**: main
- **Recent velocity**: Phase 1 最小接入 1 个月内完成

## Quality Risks

1. **单 provider 依赖**: 仅实现 DeepSeek，无 provider 多样性保证。
2. **无 lint/format 工具**: 未配置 ESLint 或 Prettier。
3. **无 CI**: 无 GitHub Actions 或 CI 流水线。
4. **fallback 递归风险**: fallback 链 `deepseek-v4-pro → deepseek-chat → deepseek-v4-pro` — 两个都失败时会循环（当前由单次 try/catch 保护，不会死循环，但会抛原始错误）。
5. **无流式支持**: stream 尚不支持，对大响应不友好。
6. **AGENTS.md / README.md 仍标"待初始化"**: 与当前代码进度脱节。

## Sources

- `../../package.json`
- `../../tsconfig.json`
- `../../src/index.ts`
- `../../src/client.ts`
- `../../src/config.ts`
- `../../src/types.ts`
- `../../src/providers/deepseek.ts`
- `../../test/client.test.ts`
