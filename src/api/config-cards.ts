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
import { FACES, isRegisteredFace, faceCardPath, cardTemplatesDir, readFaceLedger, updateFaceLedger, appendFaceEvent } from '../card-faces.js';
import type { FaceId } from '../card-faces.js';
import { preSaveCardGuard } from '../card-write-guard.js';
import type { PreSaveGuardResult } from '../card-write-guard.js';
import { readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';

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
    // 委托现役 handler。CTO 裁（facc0989，P2 随批 additive）：§2.2 契约 L67/L167
    // 台账字段接线——200 成功分支 body 扩展 face+ledger 摘要；401/404 守卫路径
    // 零动（G9 additive 同族）。红线②：raw face-events 审计账不进 body（UI 审计
    // 行只消费 ledger 摘要面）。
    const result = handleGetTrimmcCard(authHeader, { cardPath: faceCardPath(face) });
    if (result.statusCode === 200) {
      return { statusCode: 200, body: { ...result.body, face, ledger: readFaceLedger() } };
    }
    return result;
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
    const body = result.body as { status?: { state?: string; tier?: number } };
    const state = body.status?.state;
    const tier = body.status?.tier;
    appendFaceEvent({ face, etype: 'status', result: 'ok', detail: `status write-back state=${state ?? 'unknown'}${tier ? ` tier=${tier}` : ''}` });
    if (state === 'applied' || state === 'failed') {
      // LG-058 N1：applied_tier 随回写同步（tier 缺省=null=回写时层级未决）
      updateFaceLedger(face, { applied_state: state, applied_tier: tier === 1 || tier === 2 || tier === 3 ? tier : null });
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

// ── 卡面维护面（LG-058 N2：备份清单/回滚/模板清单/应用模板）──
// 语义=整卡替换（CEO #5「一键把这张卡的配置换成预设组合」——切换语义，
// 非 PUT 合并链）。写路径全走 preSaveCardGuard 守卫（备份先行+keep=5 轮换+
// write 审计，机制真源=card-write-guard.ts）与 saveCard 同形原子写（tmp+rename，
// 引擎零动复用守卫单源）。文件名白名单校验=「清单含」单断言即含 basename 形
// （清单本身来自 readdir 前缀过滤，穿越名不可达清单）。审计 etype 沿 'write'
// （FaceEventType 零扩），detail 区分 rollback/template。

const CARD_BACKUP_KEEP = 5; // 对表 card-write-guard 轮换档（io-kernel rotateBackups keep=5）

/** 卡备份文件名清单（`<card>.bak-` 前缀族；目录未建=空）。 */
function cardBackupNames(face: FaceId): string[] {
  const cardPath = faceCardPath(face);
  const prefix = `${basename(cardPath)}.bak-`;
  try {
    return readdirSync(dirname(cardPath)).filter((n) => n.startsWith(prefix)).sort();
  } catch {
    return [];
  }
}

/** 文件名白名单校验：必须在对应清单内（穿越名/伪造名一律拒）。 */
function whitelistedName(name: unknown, allowed: string[]): name is string {
  return typeof name === 'string' && name.length > 0 && allowed.includes(name);
}

/** 卡文档最低合法性（写坏卡前置拒）：JSON 对象+provider_entries 对象形态
 * （与 PUT 退化形态前置拒同判据族）。 */
function isPlausibleCardDoc(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const pe = (doc as { provider_entries?: unknown }).provider_entries;
  return pe !== undefined && pe !== null && typeof pe === 'object' && !Array.isArray(pe);
}

/** 守卫+原子写（saveCard 同形：preSaveCardGuard→幂等短路→tmp+rename）。 */
function guardedAtomicWrite(doc: unknown, cardPath: string): PreSaveGuardResult {
  const guard = preSaveCardGuard(doc, cardPath);
  if (guard.skipped) return guard;
  mkdirSync(dirname(cardPath), { recursive: true });
  const tmp = `${cardPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, cardPath);
  return guard;
}

/** GET /v1/config/cards/{face}/backups — 备份清单（名/字节/mtime；内容零出）。 */
export function handleGetConfigCardBackups(authHeader: string | undefined, face: string): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}/backups` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) return authError;
  const dir = dirname(faceCardPath(face));
  const backups = cardBackupNames(face)
    .map((file) => {
      const st = statSync(resolve(dir, file));
      return { file, size_bytes: st.size, modified_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { statusCode: 200, body: { object: 'config.card-backups', face, keep: CARD_BACKUP_KEEP, backups } };
}

/** POST /v1/config/cards/{face}/rollback — 整卡回滚（恢复前守卫自动备份当前=
 * 对称安全网，回滚本身也可再回滚）。 */
export function handlePostConfigCardRollback(authHeader: string | undefined, face: string, rawBody: string | undefined): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}/rollback` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) return authError;
  let body: { backup?: unknown };
  try {
    body = JSON.parse(rawBody ?? '') as { backup?: unknown };
  } catch {
    return { statusCode: 400, body: { error: 'invalid JSON body' } };
  }
  const allowed = cardBackupNames(face);
  if (!whitelistedName(body.backup, allowed)) {
    return { statusCode: 400, body: { error: 'backup 文件名无效或不在备份清单内（白名单校验，防路径穿越）' } };
  }
  const name: string = body.backup;
  const dir = dirname(faceCardPath(face));
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(resolve(dir, name), 'utf-8'));
  } catch {
    return { statusCode: 400, body: { error: '备份内容不可解析（非合法 JSON），拒绝恢复' } };
  }
  if (!isPlausibleCardDoc(doc)) {
    return { statusCode: 400, body: { error: '备份内容不是合法卡文档（provider_entries 缺失或形态非法），拒绝恢复' } };
  }
  let guard: PreSaveGuardResult;
  try {
    guard = guardedAtomicWrite(doc, faceCardPath(face));
  } catch (err) {
    return { statusCode: 500, body: { error: `回滚失败（写前守卫拒）：${err instanceof Error ? err.message : String(err)}` } };
  }
  appendFaceEvent({
    face,
    etype: 'write',
    result: 'ok',
    detail: `card rollback from=${name} (prior_backup=${guard.backup_file ? basename(guard.backup_file) : 'none'}${guard.skipped ? ', idempotent-skip' : ''})`,
  });
  return {
    statusCode: 200,
    body: {
      object: 'config.card-rollback', face, restored_from: name,
      prior_backup: guard.backup_file ? basename(guard.backup_file) : null,
      message: '已回滚。daemon 下次拉取落地。',
    },
  };
}

/** GET /v1/config/cards/{face}/templates — 模板清单（目录未建=空列表常态 200）。 */
export function handleGetConfigCardTemplates(authHeader: string | undefined, face: string): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}/templates` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) return authError;
  const tplDir = cardTemplatesDir(face);
  let names: string[] = [];
  try {
    names = readdirSync(tplDir).filter((n) => n.endsWith('.json'));
  } catch { /* 目录未建=暂无模板 */ }
  const templates = names
    .map((file) => {
      const st = statSync(resolve(tplDir, file));
      return { file, size_bytes: st.size, modified_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { statusCode: 200, body: { object: 'config.card-templates', face, templates } };
}

/** POST /v1/config/cards/{face}/apply-template — 应用模板（整卡替换；
 * 守卫自动备份当前；daemon 下次拉取落地）。 */
export function handlePostConfigCardApplyTemplate(authHeader: string | undefined, face: string, rawBody: string | undefined): HandlerResult {
  if (!isRegisteredFace(face)) {
    return { statusCode: 404, body: { error: 'Not found', path: `/v1/config/cards/${face}/apply-template` } };
  }
  const authError = requireAdmin(authHeader);
  if (authError) return authError;
  let body: { template?: unknown };
  try {
    body = JSON.parse(rawBody ?? '') as { template?: unknown };
  } catch {
    return { statusCode: 400, body: { error: 'invalid JSON body' } };
  }
  const tplDir = cardTemplatesDir(face);
  let allowed: string[] = [];
  try {
    allowed = readdirSync(tplDir).filter((n) => n.endsWith('.json'));
  } catch { /* 目录未建=暂无模板 */ }
  if (!whitelistedName(body.template, allowed)) {
    return { statusCode: 400, body: { error: 'template 文件名无效或不在模板清单内（白名单校验，防路径穿越）' } };
  }
  const name: string = body.template;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(resolve(tplDir, name), 'utf-8'));
  } catch {
    return { statusCode: 400, body: { error: '模板内容不可解析（非合法 JSON），拒绝应用' } };
  }
  if (!isPlausibleCardDoc(doc)) {
    return { statusCode: 400, body: { error: '模板内容不是合法卡文档（provider_entries 缺失或形态非法），拒绝应用' } };
  }
  let guard: PreSaveGuardResult;
  try {
    guard = guardedAtomicWrite(doc, faceCardPath(face));
  } catch (err) {
    return { statusCode: 500, body: { error: `应用模板失败（写前守卫拒）：${err instanceof Error ? err.message : String(err)}` } };
  }
  appendFaceEvent({
    face,
    etype: 'write',
    result: 'ok',
    detail: `template applied=${name} (prior_backup=${guard.backup_file ? basename(guard.backup_file) : 'none'}${guard.skipped ? ', idempotent-skip' : ''})`,
  });
  return {
    statusCode: 200,
    body: {
      object: 'config.card-template-applied', face, template: name,
      prior_backup: guard.backup_file ? basename(guard.backup_file) : null,
      message: '模板已应用（整卡替换）。daemon 下次拉取落地。',
    },
  };
}

// ── 台账读面（UI 徽章数据源；复用现役 GET ledger 无独立端点——P2 UI 接线时
// 经 managed 视图返回，此处仅模块导出供测试/CLI 用）──

export function faceLedgerSnapshot() {
  return { object: 'config.face-ledger', ledger: readFaceLedger(), faces: FACES };
}
