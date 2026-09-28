// ── TriModel API: generalized card-face endpoints (LG-058 P0, 方案 v3 §2) ──
// 泛化层纯新增件：卡面引擎（加密/校验/状态机/apply）零改，全部写路径委托
// 现役 trimmc-card handler（cardPath opt 注入）——merge/删除通道/校验单源
// 零复制；备份守卫在 saveCard 引擎层共享（card-write-guard.ts）。
//
// GET  /v1/config/cards/{face}?view=managed — UI 面：掩码+状态（admin fail-closed）
// GET  /v1/config/cards/{face}?view=pull    — daemon 面：server 域内解密后的
//                                             受控载荷（api-token/face-token；
//                                             明文仅存响应生命周期，不落 server 盘）
// PUT  /v1/config/cards/{face}              — admin；写前守卫（备份/轮换/审计）在引擎层
// PUT  /v1/config/cards/{face}/status       — admin；应用方回写 applied|failed
// POST /v1/config/cards/{face}/apply        — admin；活动策略落本机生效面
//
// face 校验守卫（§2.2）：{face} 不在册=404（防枚举）；在册但凭据不绑=401。
// 鉴权双层（§2.3）：写面 TRIMODEL_ADMIN_TOKEN fail-closed 原样；拉取面
// TRIMODEL_API_TOKEN（keys 同族）+TRIMODEL_FACE_TOKENS 可选绑定（P0=未配置
// 即 api-token 通配过渡态；已配置=face 精确绑定）。
import { handleGetTrimmcCard, handlePutTrimmcCard, handlePutTrimmcCardStatus, handleApplyStrategy } from './trimmc-card.js';
import { loadCard } from '../trimmc-card.js';
import { decrypt } from '../security/key-encryptor.js';
import { effectiveModel } from '../policy.js';
import { FACES, isRegisteredFace, faceCardPath, readFaceLedger, updateFaceLedger, appendFaceEvent } from '../card-faces.js';
import type { FaceId } from '../card-faces.js';

type HandlerResult = { statusCode: number; body: Record<string, unknown> };

// ── 鉴权 ──

function requireAdmin(authHeader: string | undefined): HandlerResult | null {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: 'card plane disabled: TRIMODEL_ADMIN_TOKEN not configured (fail-closed)' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: 'Unauthorized: invalid or missing admin token' } };
  }
  return null;
}

/** face token map：`mmc=<tok>,mlc=<tok>` → Record；空串/畸形段跳过。 */
export function parseFaceTokens(envValue: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (envValue ?? '').split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const face = pair.slice(0, idx).trim();
    const tok = pair.slice(idx + 1).trim();
    if (face && tok) map[face] = tok;
  }
  return map;
}

/** 拉取面鉴权（P0 过渡态：FACE_TOKENS 未配置=api-token 通配；已配置=face 精确绑定）。 */
function requirePullAuth(authHeader: string | undefined, face: FaceId): HandlerResult | null {
  const apiToken = process.env.TRIMODEL_API_TOKEN ?? '';
  if (!apiToken) {
    return { statusCode: 401, body: { error: 'pull plane disabled: TRIMODEL_API_TOKEN not configured (fail-closed, keys family)' } };
  }
  const faceTokens = parseFaceTokens(process.env.TRIMODEL_FACE_TOKENS);
  const expected = Object.keys(faceTokens).length > 0 ? faceTokens[face] : apiToken;
  if (!expected || !authHeader || authHeader !== `Bearer ${expected}`) {
    return { statusCode: 401, body: { error: 'Unauthorized: invalid or missing pull token for this face' } };
  }
  return null;
}

// ── pull origin（loopback/remote 判定；缺省 loopback=in-process 直调语义）──

export function pullOriginFrom(remoteAddress: string | undefined): 'loopback' | 'remote' {
  if (!remoteAddress) return 'loopback';
  const a = remoteAddress.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' ? 'loopback' : 'remote';
}

/** pull 载荷刷新间隔（keys 端点同源表达式 keys.ts L43；函数级读=测试可钉）。 */
function pullRefreshIntervalS(): number {
  return Number(process.env.TRIMODEL_KEY_REFRESH_INTERVAL_S ?? 900);
}

export interface PullRequestOrigin {
  remoteAddress?: string;
}

// ── GET（managed/pull 双视图）──

export function handleGetConfigCard(
  authHeader: string | undefined,
  face: string,
  search: string,
  origin?: PullRequestOrigin,
): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}` } };
  }
  const view = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('view') ?? 'managed';
  if (view !== 'managed' && view !== 'pull') {
    return { statusCode: 400, body: { error: `invalid view '${view}' (valid: managed | pull)` } };
  }

  if (view === 'managed') {
    const authError = requireAdmin(authHeader);
    if (authError) return authError;
    // 委托现役 handler（body 原样返回；face=mmc 时与别名端点逐字段等价）。
    return handleGetTrimmcCard(authHeader, { cardPath: faceCardPath(face) });
  }

  // view=pull（daemon 受控载荷；§三 时序）
  const pullAuthError = requirePullAuth(authHeader, face);
  if (pullAuthError) {
    appendFaceEvent({ face, etype: 'pull', result: 'denied', reason: 'pull_denied', detail: 'pull auth rejected' });
    updateFaceLedger(face, { last_pull_at: new Date().toISOString(), last_pull_from: pullOriginFrom(origin?.remoteAddress), last_pull_result: 'denied' });
    return pullAuthError;
  }
  const from = pullOriginFrom(origin?.remoteAddress);
  const doc = loadCard(faceCardPath(face));
  // default_model=评估序投影（方案 L32 基线「窗口命中→卡 default_model→env」
  // 本方案不改此语义）——daemon 侧策略跟随（STE gate anchor③）依赖此投影，
  // 非卡静态值；source 随载荷附（§3.2 生效读数归因）。凭据维仍纯卡面。
  const eff = effectiveModel();
  if (!doc) {
    // 在册 face 无卡：200+card_present=false（404 语义专留 face 不在册；
    // default_model 投影照附——daemon 模型维中继不受卡缺席影响，凭据空缺）
    appendFaceEvent({ face, etype: 'pull', result: 'ok', detail: 'pull served, card absent' });
    updateFaceLedger(face, { last_pull_at: new Date().toISOString(), last_pull_from: from, last_pull_result: 'ok' });
    return {
      statusCode: 200,
      body: {
        object: 'config.card-pull', face, card_present: false,
        default_model: eff.model, default_model_source: eff.source,
        entries: {}, strategy: null, warnings: [],
        refresh_interval_s: pullRefreshIntervalS(),
      },
    };
  }
  // server 域内解密（§三：拉取流永不传输 at-rest 密文文件，只传受控载荷；
  // 明文仅存响应生命周期）。解不开的条目跳过+warnings（不静默猜）。
  const entries: Record<string, { provider: string; model: string; api_key: string; enabled: boolean; updated_at: string; base_url?: string }> = {};
  const warnings: string[] = [];
  let skippedUndecryptable = 0;
  for (const [id, entry] of Object.entries(doc.provider_entries)) {
    if (!entry.enabled) continue; // 禁用条目不进拉取载荷（daemon 只消费启用面）
    let apiKey = '';
    try {
      apiKey = decrypt(Buffer.from(entry.api_key_encrypted, 'base64'));
    } catch {
      skippedUndecryptable += 1;
      warnings.push(`entry '${id}' undecryptable in server domain — skipped`);
      continue;
    }
    entries[id] = {
      provider: entry.provider,
      model: entry.model,
      api_key: apiKey,
      enabled: entry.enabled,
      updated_at: entry.updated_at,
      ...(entry.base_url ? { base_url: entry.base_url } : {}),
    };
  }
  const activeId = doc.active_strategy_id;
  const active = activeId ? doc.strategies[activeId] ?? null : null;
  appendFaceEvent({
    face,
    etype: 'pull',
    result: 'ok',
    detail: `pull served (entries=${Object.keys(entries).length}, skipped=${skippedUndecryptable}, from=${from})`,
  });
  updateFaceLedger(face, { last_pull_at: new Date().toISOString(), last_pull_from: from, last_pull_result: 'ok' });
  return {
    statusCode: 200,
    body: {
      object: 'config.card-pull',
      face,
      card_present: true,
      default_model: eff.model,
      default_model_source: eff.source,
      entries,
      strategy: active ? { id: activeId, name: active.name, rule_ids: active.rule_ids } : null,
      warnings,
      refresh_interval_s: pullRefreshIntervalS(),
    },
  };
}

// ── PUT（写；守卫在 saveCard 引擎层）──

export function handlePutConfigCard(authHeader: string | undefined, face: string, rawBody: string | undefined): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) return authError;
  return handlePutTrimmcCard(authHeader, rawBody, { cardPath: faceCardPath(face) });
}

// ── PUT status（应用方回写；成功后 status 审计+台账 applied_state 同步）──

export function handlePutConfigCardStatus(authHeader: string | undefined, face: string, rawBody: string | undefined): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}/status` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) {
    // CTO 裁 1(甲)：wrapper 层鉴权拒 emit——401/403=写面安全事件记 denied
    // （503=admin 未配置常态禁用，不记防刷账）；len-only。
    if (authError.statusCode === 401 || authError.statusCode === 403) {
      appendFaceEvent({ face, etype: 'status', result: 'denied', reason: 'admin_auth', detail: 'status write-back rejected (admin auth)' });
    }
    return authError;
  }
  const result = handlePutTrimmcCardStatus(authHeader, rawBody, { cardPath: faceCardPath(face) });
  if (result.statusCode === 200) {
    const body = result.body as { status?: { state?: string } };
    const state = body.status?.state;
    appendFaceEvent({ face, etype: 'status', result: 'ok', detail: `status write-back state=${state ?? 'unknown'}` });
    if (state === 'applied' || state === 'failed') {
      updateFaceLedger(face, { applied_state: state });
    }
  } else {
    // CTO 裁 1(甲)（de6d49f8）：非 200 补 emit——鉴权拒（401/403/503）=写面
    // 安全事件记 denied，其余记 failed（len-only，detail 仅状态码与原因域）。
    const denied = result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 503;
    appendFaceEvent({
      face,
      etype: 'status',
      result: denied ? 'denied' : 'failed',
      reason: denied ? 'admin_auth' : `http_${result.statusCode}`,
      detail: `status write-back rejected http=${result.statusCode}`,
    });
  }
  return result;
}

// ── POST apply（活动策略落本机生效面；成功后 apply 审计）──

export function handlePostConfigCardApply(authHeader: string | undefined, face: string): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}/apply` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) {
    // CTO 裁 1(甲)：wrapper 层鉴权拒 emit（同 status：401/403 记 denied，503 不记）
    if (authError.statusCode === 401 || authError.statusCode === 403) {
      appendFaceEvent({ face, etype: 'apply', result: 'denied', reason: 'admin_auth', detail: 'apply rejected (admin auth)' });
    }
    return authError;
  }
  const result = handleApplyStrategy(authHeader, { cardPath: faceCardPath(face) });
  if (result.statusCode === 200) {
    const body = result.body as { applied?: { strategy_id?: string; schedules?: number } };
    appendFaceEvent({
      face,
      etype: 'apply',
      result: 'ok',
      detail: `applied strategy=${body.applied?.strategy_id ?? 'unknown'} schedules=${body.applied?.schedules ?? 0}`,
    });
  } else {
    // CTO 裁 1(甲)（de6d49f8）：非 200 补 emit（与 status 同映射：鉴权拒=denied）
    const denied = result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 503;
    appendFaceEvent({
      face,
      etype: 'apply',
      result: denied ? 'denied' : 'failed',
      reason: denied ? 'admin_auth' : `http_${result.statusCode}`,
      detail: `apply rejected http=${result.statusCode}`,
    });
  }
  return result;
}

// ── 台账读面（UI 徽章数据源；复用现役 GET ledger 无独立端点——P2 UI 接线时
// 经 managed 视图返回，此处仅模块导出供测试/CLI 用）──

export function faceLedgerSnapshot() {
  return { object: 'config.face-ledger', ledger: readFaceLedger(), faces: FACES };
}
