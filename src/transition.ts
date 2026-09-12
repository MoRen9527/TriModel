// ── TriModel default-model transition detector (LG-035 P2 工作流 A，本地半边) ──
//
// 拓扑定谳（2026-09-11 实勘，CTO 裁定①：MMC 向遇阻同降级）：
//   bundle 分发链 = TriRLC init-sync 生成（写 fleet 工作树 + commit/push 双远端）
//     → MMC/RMC cron 拉取 → config-sync apply CLI → TRIMC_CONFIG_DIR/init-sync/。
//   甲案（MMC HTTP bundle-set 端点）不存在——接收侧仅 CLI apply，零 HTTP 面；
//   乙案（TriModel 直写 bundle 源）不可达——fleet 真源在 sg（/srv/fleet），
//   本机无工作树且生成链/幂等纪律归 TriRLC init-sync（sg 分叉仓）。
//   → 本批落地 = 跃迁检测器（本文件）：effective default_model 变更跃迁时
//   （值比较，非逐分钟 tick）追加一行跃迁记录；P3 由 TriRLC 生成端消费。
//
// A×B 交叉红线（SEC-20260813-001，CTO 裁定②）：跃迁记录白名单构造——仅
// { at, from, to, source }（model 名），严禁任何密钥材料/keys 维字段进入。
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface ModelTransitionRecord {
  at: string;
  from: string;
  to: string;
  source: 'policy' | 'card-default' | 'env-default';
  matched_schedule_id: string | null;
}

/** In-process last reported model (transition = value change vs this). */
let lastReportedModel: string | null = null;

function transitionsLogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'model-transitions.jsonl');
}

/** Test seam: forget the in-process last-reported value. */
export function resetTransitionStateForTest(): void {
  lastReportedModel = null;
}

/**
 * Compare the just-evaluated effective model against the last reported value;
 * on change append one JSONL transition record (never throws — append errors
 * warn and leave the keys chain untouched).
 */
export function recordModelTransitionIfChanged(
  evaluated: { model: string; source: 'policy' | 'card-default' | 'env-default'; matched_schedule_id: string | null },
  pathOverride?: string,
): ModelTransitionRecord | null {
  const previous = lastReportedModel;
  lastReportedModel = evaluated.model;
  if (previous === null || previous === evaluated.model) return null;

  // Whitelist construction (SEC red line): model names only.
  const record: ModelTransitionRecord = {
    at: new Date().toISOString(),
    from: previous,
    to: evaluated.model,
    source: evaluated.source,
    matched_schedule_id: evaluated.matched_schedule_id,
  };
  try {
    appendFileSync(pathOverride ?? transitionsLogPath(), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    console.warn('[trimodel] failed to append model transition record:', err instanceof Error ? err.message : err);
  }
  return record;
}
