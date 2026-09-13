// ── TriModel API: TriMMC card endpoints (LG-035 TriMMC 栏 T1) ──
// GET  /v1/config/trimmc-card          — card with api_key DECRYPTED in this
//                                        response only (UI never consumes it;
//                                        UI consumes masked/status surfaces)
// PUT  /v1/config/trimmc-card          — save ⇒ status resets to 'pending'
// PUT  /v1/config/trimmc-card/status   — COS write-back: applied|failed + at
//
// Admin plane: fail-closed 503 (TRIMODEL_ADMIN_TOKEN unset) / 401 (wrong
// Bearer) / 200 — same family as the P2 secure key plane.
import { loadCard, saveCard, emptyCard, validateCard, CARD_STATES, buildEntry, validateStrategy } from '../trimmc-card.js';
import type { TrimmcCardDocument, CardState, CardEntry, StrategyEntity } from '../trimmc-card.js';
import { decrypt } from '../security/key-encryptor.js';
import { maskKey } from '../secure-keys.js';

function requireAdmin(authHeader: string | undefined): { statusCode: 503 | 401; body: Record<string, unknown> } | null {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: 'trimmc card plane disabled: TRIMODEL_ADMIN_TOKEN not configured (fail-closed)' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: 'Unauthorized: invalid or missing admin token' } };
  }
  return null;
}

export function handleGetTrimmcCard(
  authHeader: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  const doc = loadCard(opts?.cardPath);
  if (!doc) {
    const blank = emptyCard();
    return { statusCode: 200, body: { object: 'config.trimmc-card', card: blank, card_file_present: false, entries_decrypted: {}, entries_masked: {} } };
  }
  // api_key decrypted HERE only (UI never consumes it); masked view is the
  // UI-facing surface (tail-4 like the P2 secure-key status plane).
  const entries_decrypted: Record<string, { provider: string; model: string; api_key: string; enabled: boolean; updated_at: string }> = {};
  const entries_masked: Record<string, { provider: string; model: string; masked: string; enabled: boolean; updated_at: string }> = {};
  for (const [id, entry] of Object.entries(doc.provider_entries)) {
    let apiKey = '';
    try {
      apiKey = decrypt(Buffer.from(entry.api_key_encrypted, 'base64'));
    } catch (err) {
      console.warn(`[trimodel] trimmc-card entry '${id}' undecryptable:`, err instanceof Error ? err.message : err);
    }
    const base = { provider: entry.provider, model: entry.model, enabled: entry.enabled, updated_at: entry.updated_at, ...(entry.base_url ? { base_url: entry.base_url } : {}) };
    entries_decrypted[id] = { ...base, api_key: apiKey };
    entries_masked[id] = { ...base, masked: maskKey(apiKey) };
  }
  return { statusCode: 200, body: { object: 'config.trimmc-card', card: doc, card_file_present: true, entries_decrypted, entries_masked } };
}

export function handlePutTrimmcCard(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  if (rawBody === undefined || rawBody.trim() === '') {
    return { statusCode: 400, body: { error: 'request body required (JSON card document)' } };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const card = doc as TrimmcCardDocument;
  // D7 合并语义：PUT provider_entries = 脏条目 upsert（非整卡回写）——
  // 前端只发用户新增/编辑的条目，既有密文条目不回传不覆盖。
  // 形态三态：对象+明文 api_key → 服务端加密水合；对象+api_key_encrypted →
  // 原样保留（密文搬运）；字符串/数组等退化形态 → 400 人话拒不落盘。

  // 退化形态前置拒（水合/校验前即断，防任何路径落盘）
  const providedRaw = (card as { provider_entries?: unknown }).provider_entries;
  if (Array.isArray(providedRaw)) {
    return { statusCode: 400, body: { error: '条目数据格式错误，请重新添加条目' } };
  }
  if (typeof providedRaw === 'object' && providedRaw !== null) {
    for (const [id, entry] of Object.entries(providedRaw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) {
        return { statusCode: 400, body: { error: `条目数据格式错误（${id}），请重新添加条目` } };
      }
    }
  }

  // Hydrate BEFORE validation: UI supplies `api_key` (masked display makes it
  // impossible to paste back — F1-P2 family); the server encrypts here so
  // at-rest storage is ciphertext only.
  if (typeof card.provider_entries === 'object' && card.provider_entries !== null) {
    for (const [id, entry] of Object.entries(card.provider_entries)) {
      const plain = (entry as CardEntry & { api_key?: unknown }).api_key;
      if (typeof plain === 'string' && plain && !plain.includes('*')) {
        card.provider_entries[id] = buildEntry(entry.provider, entry.model, plain, entry.enabled, (entry as CardEntry & { base_url?: string }).base_url);
      }
    }
  }

  // 合并基底：既有卡（provider_entries 保留未被本次 PUT 提及的条目）
  const existing = loadCard(opts?.cardPath);
  const base = existing ?? emptyCard('');
  // D15② 跨 id 幂等去重：同条目名+同厂商+同模型的既有条目，若本次 PUT 又以
  // 新 id 提交同内容 → 视为同一逻辑条目，保留 PUT 侧（updated_at 更新），旧 id
  // 沉默淘汰（零挫败；updated_at 由水合/直传分支刷新）。
  for (const [newId, entry] of Object.entries(card.provider_entries)) {
    const dupIds = Object.entries(base.provider_entries)
      .filter(([oldId, old]) => oldId !== newId && old.provider === entry.provider && old.model === entry.model)
      .map(([oldId]) => oldId);
    for (const oldId of dupIds) delete base.provider_entries[oldId];
  }
  const merged: TrimmcCardDocument = {
    ...base,
    machine: card.machine?.name ? card.machine : base.machine,
    connection: card.connection?.name ? card.connection : base.connection,
    provider_entries: { ...base.provider_entries, ...card.provider_entries },
    rules: Array.isArray(card.rules) ? card.rules : base.rules,
    // 增补件4②：默认模型兜底字段（null/absent = 回落引擎出厂默认）
    default_model: 'default_model' in card ? card.default_model : base.default_model ?? null,
    // 增补件5：策略实体字典合并（UI 编辑的 strategies upsert 到基座）
    strategies: { ...base.strategies, ...card.strategies },
    active_strategy_id: 'active_strategy_id' in card ? card.active_strategy_id ?? null : base.active_strategy_id ?? null,
    status: { state: 'pending', at: new Date().toISOString() },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
  // D10 校验扩展：merged 后全量 validateCard（含策略引用校验）
  // 增补件5：策略校验前置——active_strategy_id 悬挂→400；deleted 含 active→400
  if (merged.active_strategy_id && !(merged.active_strategy_id in (merged.strategies ?? {}))) {
    return { statusCode: 400, body: { error: '引用的策略不存在，请先创建或改选' } };
  }
  if (Array.isArray(merged.deleted_strategy_ids) && merged.active_strategy_id && merged.deleted_strategy_ids.includes(merged.active_strategy_id)) {
    return { statusCode: 400, body: { error: '当前策略不可删除，请先切换至其他策略' } };
  }
  // 增补件5：策略实体校验（validateStrategy 复用 T1 的校验函数）
  if (typeof card.strategies === 'object' && card.strategies !== null) {
    for (const [id, entity] of Object.entries(card.strategies)) {
      const err = validateStrategy(entity as StrategyEntity);
      if (err) return { statusCode: 400, body: { error: `策略 '${id}' 校验失败: ${err}` } };
    }
  }
  // D10 删除通道：deleted_strategy_ids 显式移除（策略删除）
  if (Array.isArray(card.deleted_strategy_ids)) {
    for (const id of card.deleted_strategy_ids) {
      if (typeof id === 'string') {
        if (merged.active_strategy_id === id) {
          return { statusCode: 400, body: { error: '当前策略不可删除，请先切换至其他策略' } };
        }
        delete merged.strategies?.[id];
      }
    }
    merged.deleted_strategy_ids = card.deleted_strategy_ids.filter((id): id is string => typeof id === 'string');
  }
  // D7 删除通道：deleted_entry_ids 显式移除（镜像条目删除）
  if (Array.isArray(card.deleted_entry_ids)) {
    for (const id of card.deleted_entry_ids) {
      if (typeof id === 'string') delete merged.provider_entries[id];
    }
    merged.deleted_entry_ids = card.deleted_entry_ids.filter((id): id is string => typeof id === 'string');
  }
  // D9 校验序重构：validate 对合并后终态（镜像引用经合并解析；真悬挂——
  // 既不在传入也不在既有——仍 400 人话）。原「对传入文档孤立校验」错层
  // 即 f2 谜题第二半：引用既有条目的规则被误判悬挂。
  const validationError = validateCard(merged);
  if (validationError) {
    return { statusCode: 400, body: { error: `trimmc card validation failed: ${validationError}` } };
  }
  try {
    saveCard(merged, opts?.cardPath);
  } catch (err) {
    return { statusCode: 500, body: { error: `failed to persist trimmc-card.json: ${err instanceof Error ? err.message : String(err)}` } };
  }
  return { statusCode: 200, body: { ok: true, status: merged.status, entries: Object.keys(merged.provider_entries), rules: merged.rules } };
}

export function handlePutTrimmcCardStatus(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  let doc: { state?: unknown; error?: unknown } = {};
  try {
    doc = rawBody ? (JSON.parse(rawBody) as { state?: unknown; error?: unknown }) : {};
  } catch (err) {
    return { statusCode: 400, body: { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const state = doc.state;
  if (state !== 'applied' && state !== 'failed') {
    return { statusCode: 400, body: { error: `state must be 'applied' | 'failed' (pending is set by save only); valid: ${CARD_STATES.join(', ')}` } };
  }

  const card = loadCard(opts?.cardPath);
  if (!card) {
    return { statusCode: 404, body: { error: 'no trimmc-card.json on disk — save the card first' } };
  }
  const status: { state: CardState; at: string; error?: string } = { state, at: new Date().toISOString() };
  if (typeof doc.error === 'string' && doc.error) status.error = doc.error;
  card.status = status;
  saveCard(card, opts?.cardPath);
  return { statusCode: 200, body: { ok: true, status } };
}
