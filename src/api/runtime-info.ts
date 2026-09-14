// ── TriModel API: Runtime info (LG-035 本地侧 web UI, 2026-09-14) ──
// GET /v1/config/runtime-info — unauthenticated read-only surface so the UI
// can label its scope before any token is entered.
//
// Fields:
//   domain_label        — 本实例服务域的展示标签。sg 部署设 TRIMODEL_DOMAIN_LABEL=TriMMC（sg）；
//                         默认=本地域（TriMLC/TriRLC）（本单交付的本地侧语义）。
//   local_apply_enabled — 「应用到本机」按钮开关（TRIMODEL_LOCAL_APPLY=1 时启用）。
//                         本地侧=1（策略本机直生效，无 COS 应用链）；sg 侧不设=按钮隐藏（零行为变化）。
//   machine             — 宿主名（只读展示）。
import { hostname } from 'node:os';

export function handleRuntimeInfo(): { statusCode: number; body: Record<string, unknown> } {
  return {
    statusCode: 200,
    body: {
      object: 'config.runtime-info',
      domain_label: process.env.TRIMODEL_DOMAIN_LABEL ?? '本地域（TriMLC/TriRLC）',
      local_apply_enabled: process.env.TRIMODEL_LOCAL_APPLY === '1',
      machine: hostname(),
    },
  };
}
