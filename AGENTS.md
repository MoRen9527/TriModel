# TriModel Agent Rules

## Module Role

- TriModel 预留为 Provider/Model 统一配置层。
- 负责多 provider 适配、模型路由、fallback 链配置，为 `TriMC` 与 `Tride` 两个 orchestration 提供统一的模型接入点。

## Current Status

- 当前待初始化 / 待接入。
- 在真实实现、README 或结构文档落地前，所有细节都应标记为 `待初始化`。

## Strategy Delegation

- 总商业模式、当前商业实验、TriModel 是否进入当前路径，先咨询 `TriMetaverse/BusinessStrategy`。

## Current Registries

- `TriModelBusinessStrategyRegistry`
- `TriModelProductRegistry`
- `TriModelCodeRegistry`

当前 registry agent canonical discovery 位于 `TriModel/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 禁止虚构 provider 列表、路由逻辑或进度状态。
