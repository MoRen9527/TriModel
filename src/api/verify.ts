// ── GET /v1/config/verify — 诚实三态读数端点（深测②合一窗 S1·A 案落地）──
// A 案（候裁点④ BOD 终裁）：daemon config verify 扩三态字段，「CLI show 同源，
// 一份数据两消费端」——派生逻辑从 UI connLocalState 判定树（ui/index.html）
// 服务端单点下沉，S4 接线后 UI 两页（页顶生效读数行+兜底卡三态）与后续 CLI
// 消费端共用本读数。
//
// 语义边界（CPO 卷 §4.5，5d175a26）：本端点字段语义=「落地配置与下发意图的
// 比对结果」（三态读数答「配置到没到位」），**非健康检查**（健康答「服务活
// 不活」，健康面=/health 端点既有）——两义禁混写，响应体禁塞健康/存活字段。
//
// 零密钥面：纯版本/时刻比对，不 decrypt 任何 provider entry。

import { loadCard } from '../trimmc-card.js';
import { FACE_IDS, faceCardPath, readFaceLedger } from '../card-faces.js';
import type { FaceId } from '../card-faces.js';

export type HandlerResult = { statusCode: number; body: Record<string, unknown> };

// ── 鉴权（同族 fail-closed：与 config-cards requireAdmin 同形）──

function requireAdmin(authHeader: string | undefined): HandlerResult | null {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: 'verify plane disabled: TRIMODEL_ADMIN_TOKEN not configured (fail-closed)' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: 'Unauthorized: invalid or missing admin token' } };
  }
  return null;
}

// ── 纯派生（单测直接驱动；与 UI connLocalState 判定树逐分支同构）──

/** 五态：诚实三态（已存未拉/已拉未落/已落生效）+ 落盘失败 + 未配置
 *（细估卷 S1「四态读数」= 三态+失败态；未配置=空态如实呈现，UI 现役既有）。 */
export type VerifyState =
  | 'not-configured'
  | 'stored-not-pulled'
  | 'pulled-not-applied'
  | 'applied'
  | 'apply-failed';

export const VERIFY_STATE_LABELS: Record<VerifyState, string> = {
  'not-configured': '未配置',
  'stored-not-pulled': '已存未拉',
  'pulled-not-applied': '已拉未落',
  'applied': '已落生效',
  'apply-failed': '落盘失败',
};

export interface VerifyFaceInput {
  card_present: boolean;
  /** 卡面 local_config.version（服务端下发意图版本；无卡/无意图=0）。 */
  local_config_version: number;
  local_config_updated_at: string | null;
  /** daemon status 回写面（台账 local_config）；null=未回写过。 */
  version_applied: number | null;
  applied_at: string | null;
  write_result: 'ok' | 'failed' | null;
  last_pull_at: string | null;
  last_pull_result: 'ok' | 'denied' | 'failed' | null;
}

export interface VerifyFaceReading {
  state: VerifyState;
  state_label: string;
  /** 拉取链异常（denied/failed）——UI 现役「·拉取链异常」后缀的结构化面。 */
  pull_chain_degraded: boolean;
}

export function deriveVerifyState(input: VerifyFaceInput): VerifyFaceReading {
  const degraded = input.last_pull_result === 'denied' || input.last_pull_result === 'failed';
  // 无卡或卡面无本地配置意图（version<=0）=未配置（空态如实；即使台账有旧
  // 回写——卡被清后意图面已消失，不推断「仍生效」）。
  if (!input.card_present || input.local_config_version <= 0) {
    return { state: 'not-configured', state_label: VERIFY_STATE_LABELS['not-configured'], pull_chain_degraded: degraded };
  }
  if (input.version_applied != null && input.version_applied === input.local_config_version && input.write_result === 'ok') {
    return { state: 'applied', state_label: VERIFY_STATE_LABELS.applied, pull_chain_degraded: degraded };
  }
  if (input.write_result === 'failed') {
    return { state: 'apply-failed', state_label: VERIFY_STATE_LABELS['apply-failed'], pull_chain_degraded: degraded };
  }
  const pulled = input.last_pull_at != null && input.local_config_updated_at != null && input.last_pull_at >= input.local_config_updated_at;
  if (pulled) {
    return { state: 'pulled-not-applied', state_label: VERIFY_STATE_LABELS['pulled-not-applied'], pull_chain_degraded: degraded };
  }
  return { state: 'stored-not-pulled', state_label: VERIFY_STATE_LABELS['stored-not-pulled'], pull_chain_degraded: degraded };
}

// ── 端点 handler ──

export function handleGetConfigVerify(authHeader: string | undefined): HandlerResult {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  const ledger = readFaceLedger();
  const faces: Record<string, unknown> = {};
  for (const face of FACE_IDS as readonly FaceId[]) {
    const doc = loadCard(faceCardPath(face));
    const intent = doc?.local_config ?? null;
    const applied = ledger.faces[face]?.local_config ?? null;
    const entry = ledger.faces[face] ?? null;
    const reading = deriveVerifyState({
      card_present: doc != null,
      local_config_version: intent?.version ?? 0,
      local_config_updated_at: intent?.updated_at ?? null,
      version_applied: applied?.version_applied ?? null,
      applied_at: applied?.applied_at ?? null,
      write_result: applied?.write_result ?? null,
      last_pull_at: entry?.last_pull_at ?? null,
      last_pull_result: entry?.last_pull_result ?? null,
    });
    faces[face] = {
      face,
      card_present: doc != null,
      // 下发意图面
      intent_version: intent?.version ?? null,
      intent_updated_at: intent?.updated_at ?? null,
      // daemon 落地回写面
      version_applied: applied?.version_applied ?? null,
      applied_at: applied?.applied_at ?? null,
      write_result: applied?.write_result ?? null,
      write_error: applied?.write_error ?? null,
      // 拉取链面
      last_pull_at: entry?.last_pull_at ?? null,
      last_pull_result: entry?.last_pull_result ?? null,
      // 派生三态（本端点核心字段）
      ...reading,
    };
  }
  return {
    statusCode: 200,
    body: { object: 'config.verify', faces, generated_at: new Date().toISOString() },
  };
}
