# TriModel Business State

## Registry Role

- 本文件是 `TriModel` 的 business registry 工作层。
- `TriModel` 的 `product-state.md` 与 `code-state.md` 默认应以本文件作为业务上游约束。

## Module Business Role

- `TriModel` 是 TriMetaverse 的 Provider/Model 统一配置层，负责多 provider 适配、模型路由、fallback 链配置。
- 为 `TriMC` 提供统一的模型接入点，屏蔽底层 provider 差异。
- 通过 Provider 抽象接口实现 provider 可插拔：新增 provider 只需实现 `Provider` 接口。

## Current Default Business Position

- 当前默认定位是模型接入基础设施层。
- Phase 1 已实现 DeepSeek provider 完整适配（deepseek-v4-pro、deepseek-v4-flash、deepseek-chat、deepseek-reasoner）。
- 通过 `createModelClient()` 工厂函数对外暴露，TriMC 可以直接 import 使用。

## Current Business Scope

- **Phase 1（已完成）**：DeepSeek API 适配、模型路由（含 fallback 链）、health check、TypeScript 类型体系。
- **Phase 2（规划）**：新增 provider（OpenAI、Anthropic 等），流式输出支持，token 用量统计与成本追踪。
- **Phase 3（规划）**：多 provider 负载均衡、模型性能基准测试、动态路由策略。

## Boundary Notes

- 禁止虚构 provider 列表、路由逻辑或进度状态。
- 新增 provider 或修改 fallback 链涉及上游商业决策时，应先回中央 `BusinessStrategy`。
- 本模块是 library，不是服务进程 — 无 CLI、无 HTTP server。

## Cross-Module Dependencies

- 直接支撑 TriMC 的模型调用层，是 TriMC 的底层依赖。
- 与 TriTest 的关系：TriTest 可以通过 TriModel 的 mock fetch 机制进行模型表现固化测试。

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
- `../../src/client.ts`
- `../../src/providers/deepseek.ts`
- `../../src/types.ts`
