// ── TriModel API: TriMMC card endpoints (LG-035 TriMMC 栏 T1) ──
// GET  /v1/config/trimmc-card          — card with api_key DECRYPTED in this
//                                        response only (UI never consumes it;
//                                        UI consumes masked/status surfaces)
// PUT  /v1/config/trimmc-card          — save ⇒ status resets to 'pending'
// PUT  /v1/config/trimmc-card/status   — COS write-back: applied|failed + at
//
// Admin plane: fail-closed 503 (TRIMODEL_ADMIN_TOKEN unset) / 401 (wrong
// Bearer) / 200 — same family as the P2 secure key plane.
import { loadCard, saveCard, emptyCard, validateCard, CARD_STATES, buildEntry } from '../trimmc-card.js';
import type { TrimmcCardDocument, CardState, CardEntry } from '../trimmc-card.js';
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
    const base = { provider: entry.provider, model: entry.model, enabled: entry.enabled, updated_at: entry.updated_at };
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
        card.provider_entries[id] = buildEntry(entry.provider, entry.model, plain, entry.enabled);
      }
    }
  }

  const validationError = validateCard(doc);
  if (validationError) {
    return { statusCode: 400, body: { error: `trimmc card validation failed: ${validationError}` } };
  }

  // 合并基底：既有卡（provider_entries 保留未被本次 PUT 提及的条目）
  const existing = loadCard(opts?.cardPath);
  const base = existing ?? emptyCard('');
  const merged: TrimmcCardDocument = {
    ...base,
    machine: card.machine?.name ? card.machine : base.machine,
    connection: card.connection?.name ? card.connection : base.connection,
    provider_entries: { ...base.provider_entries, ...card.provider_entries },
    rules: Array.isArray(card.rules) ? card.rules : base.rules,
    status: { state: 'pending', at: new Date().toISOString() },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
  // D7 删除通道：deleted_entry_ids 显式移除（镜像条目删除）
  if (Array.isArray(card.deleted_entry_ids)) {
    for (const id of card.deleted_entry_ids) {
      if (typeof id === 'string') delete merged.provider_entries[id];
    }
    merged.deleted_entry_ids = card.deleted_entry_ids.filter((id): id is string => typeof id === 'string');
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
