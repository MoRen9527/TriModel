# TriModel Phase 2 Backlog

## 来源

- **源工作流**: cpo-trimodel-deployment (Phase 1 配置平面改造)
- **上游**: cpo-trimodel-7（小全完成）→ cpo-trimodel-8（CTO 小狄登记）
- **登记日期**: 2026-07-22
- **登记人**: CTO 小狄

## 背景

cpo-trimodel-deployment Phase 1 完成了 TriModel 配置平面 HTTP API 服务（4 端点 + DeepSeek-Anthropic provider adapter）、TriLC Key 缓存与 mirror 推送、TriPilot TriLCClient 接入。三仓库代码已 commit+push。

Phase 1 交付门禁中以下 8 项被标记为 CONDITIONAL_PASS，统一转入 Phase 2 backlog。

## Phase 2 Backlog（8 项 CONDITIONAL_PASS）

| # | ID | 类型 | 描述 | 优先级 | 预估工时 |
|---|-----|------|------|--------|----------|
| 1 | TM-REG-001 | 测试 | readConfig 单元测试 CONDITIONAL_PASS：期望空 Key，`.env` 已配置真实 Key。需要隔离测试环境或 mock dotenv 注入 | P1 | 0.5h |
| 2 | TM-GAP-PROVIDER | 功能 | 单 provider 依赖：仅实现 DeepSeek，无 provider 多样性保证。需接入 OpenAI / Anthropic / GLM 等至少一个额外 provider | P2 | 4h |
| 3 | TM-GAP-LINT | 工程 | 无 lint/format 工具：未配置 ESLint 或 Prettier。需补齐标准 TypeScript lint/format 配置 | P2 | 1h |
| 4 | TM-GAP-CI | 工程 | 无 CI：无 GitHub Actions 流水线。需补齐 `npm run check && npm test` 的 CI workflow | P2 | 1h |
| 5 | TM-GAP-FALLBACK | 风险 | fallback 链递归风险：`deepseek-v4-pro → deepseek-chat → deepseek-v4-pro`。需增加 fallback 深度计数或环路检测 | P1 | 1h |
| 6 | TM-GAP-STREAM | 功能 | 无流式支持：stream 尚不支持，对大响应不友好。需补齐 SSE streaming 支持 | P1 | 3h |
| 7 | TM-GAP-AGENTS | 文档 | AGENTS.md / README.md 仍标"待初始化"，与当前代码进度脱节。需更新为 Phase 1 完成后的准确实态 | P2 | 0.5h |
| 8 | TM-GAP-S2 | 安全 | S3→S2 安全升级：当前 S3（600 文件权限 + 127.0.0.1 监听），Phase 2 需升级到 S2（AES-256-GCM 加密 + 机器指纹派生密钥） | P1 | 4h |

## 跨模块 Phase 2 依赖

TriLC 侧对应的 Phase 2 待办（不在本 backlog 内，仅记录关联）：
- Key 缓存 S2 加密升级（与 TM-GAP-S2 联动）
- 后续树：arch-trilc-tray（Tray 实现）、arch-trilc-sync（sync-engine+端点）、arch-trilc-msi-e2e（MSI+集成验证）

## 验收门禁

- Phase 2 backlog 项进入执行前需 CPO 确认优先级和排期
- 每项完成后更新本文件状态（`PENDING → IN_PROGRESS → DONE`）
- 全量 close 后由 CTO 做 Phase 2 交付门禁裁决

## Sources

- `../../registry/code-state.md` — Quality Risks 章节
- `../../registry/code-state.md` — Test 表格（TM-REG-001）
- cpo-trimodel-7 三仓库 commit: TriModel `4e0154d`, TriLC `ade4b0e`, TriPilot `974a7bf`
