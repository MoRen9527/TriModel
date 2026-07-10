# TriModel Agent Rules

## Module Role

- TriModel 是 Provider/Model 统一配置层。
- 负责多 provider 适配、模型路由、fallback 链配置，为 `TriMC` 提供统一的模型接入点。

## Current Status

- Phase 1 已落地：DeepSeek provider 适配，支持 deepseek-v4-pro、deepseek-v4-flash、deepseek-chat、deepseek-reasoner。
- 可作为 library 被 TriMC import 使用：`import { createModelClient } from 'trimodel'`。

## Strategy Delegation

- 总商业模式、当前商业实验、TriModel 是否进入当前路径，先咨询 `TriMetaverse/BusinessStrategy`。

## Local Fact Sources

- 产品事实：`README.md`
- 代码事实：`src/`（TypeScript ESM library）、`test/`（Node.js native test runner）

## Current Registries

- `TriModelBusinessStrategyRegistry`
- `TriModelProductRegistry`
- `TriModelCodeRegistry`

当前 registry agent canonical discovery 位于 `TriModel/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 禁止虚构 provider 列表、路由逻辑或进度状态。
- 新增 provider 前必须更新本文件、README 和所有 registry 文档。
