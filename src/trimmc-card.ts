// ── TriModel TriMMC Card v2 store (LG-035 TriMMC 栏，CEO 复批 2026-09-11) ──
//
// trimmc-card.json at the TriModel repo root (gitignored). Schema v2:
//   {
//     version: 2,
//     machine: { name },                       // 栏头只读
//     connection: { name, ...predefined },     // 子栏一：名称必填+预置档案
//     provider_entries: {                      // 子栏二：候选池（id 为键）
//       <entry_id>: { provider, model, api_key_encrypted, enabled, updated_at }
//     },
//     rules: [ { rule_id, type: 'fixed'|'window', entry_id } ],  // 引用清单
//     status: { state: 'pending'|'applied'|'failed', at, error? },
//     reserved: { quota_switch: null, instances_group: null, env_tag: null }
//   }
//
// 逐条目加密（key-encryptor AES-256-GCM）：at-rest 永远是密文；明文仅在
// GET /v1/config/trimmc-card 响应内解密存在（UI 永不消费该响应的 key 字段）。
// rules 引用清单域：运行语义（fixed 条目）真源=policy.json schedules
// （id=trimmc:<entry_id>），本清单仅用于卡片展示与悬挂引用校验——零双真源。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { hostname } from 'node:os';
import { decrypt, encrypt } from './security/key-encryptor.js';
import { isCatalogModel, MODEL_CATALOG_LIST } from './model-catalog.js';

export const CARD_STATES = ['pending', 'applied', 'failed'] as const;
export type CardState = (typeof CARD_STATES)[number];

export interface CardEntry {
  provider: string;
  model: string; // 官方五名（catalog）
  api_key_encrypted: string; // base64(encrypt(api_key))
  enabled: boolean;
  updated_at: string;
  /** S5 迁移标记：keys.enc 一次性迁移合成的条目。 */
  auto_imported?: boolean;
  /** S5 派生面：条目级 base_url（选填）。 */
  base_url?: string;
}

export interface CardRuleRef {
  rule_id: string;
  type: 'fixed' | 'window';
  entry_id: string;
}

export interface TrimmcCardDocument {
  version: 2;
  machine: { name: string };
  connection: { name: string } & Record<string, unknown>;
  provider_entries: Record<string, CardEntry>;
  rules: CardRuleRef[];
  status: { state: CardState; at: string; error?: string };
  reserved: { quota_switch: null; instances_group: null, env_tag: null };
  /** D7 合并语义：PUT 时要求删除的既有条目 id（UI 删除镜像条目通道）。 */
  deleted_entry_ids?: string[];
}

function cardPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, '..', 'trimmc-card.json'), resolve(here, '..', '..', 'trimmc-card.json')];
}

export function emptyCard(connectionName = ''): TrimmcCardDocument {
  return {
    version: 2,
    machine: { name: hostname() },
    connection: { name: connectionName },
    provider_entries: {},
    rules: [],
    status: { state: 'pending', at: new Date().toISOString() },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
}

/** Read + decrypt entries. Absent file → null; corrupt → null (fail-safe). */
export function loadCard(pathOverride?: string): TrimmcCardDocument | null {
  const candidates = pathOverride ? [pathOverride] : cardPaths();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TrimmcCardDocument;
      if (parsed && parsed.version === 2 && typeof parsed.provider_entries === 'object') return parsed;
      console.warn(`[trimodel] trimmc-card.json at ${path} has invalid shape — ignoring`);
      return null;
    } catch (err) {
      console.warn(`[trimodel] trimmc-card.json at ${path} unparsable — ignoring:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

export function saveCard(doc: TrimmcCardDocument, pathOverride?: string): void {
  const target = pathOverride ?? cardPaths()[0];
  // D6 同族：目标目录可能不存在（fresh 卡/测试注入路径）——首存自建。
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, target);
}

export function cardExists(pathOverride?: string): boolean {
  const candidates = pathOverride ? [pathOverride] : cardPaths();
  return candidates.some((p) => existsSync(p));
}

/** GET-side view: entries with api_key decrypted (never consumed by UI). */
export interface DecryptedCardEntry extends Omit<CardEntry, 'api_key_encrypted'> {
  api_key: string;
}

export function decryptEntries(doc: TrimmcCardDocument): Record<string, DecryptedCardEntry> {
  const out: Record<string, DecryptedCardEntry> = {};
  for (const [id, entry] of Object.entries(doc.provider_entries)) {
    let apiKey = '';
    try {
      apiKey = decrypt(Buffer.from(entry.api_key_encrypted, 'base64'));
    } catch (err) {
      console.warn(`[trimodel] trimmc-card entry '${id}' undecryptable:`, err instanceof Error ? err.message : err);
    }
    out[id] = { provider: entry.provider, model: entry.model, enabled: entry.enabled, updated_at: entry.updated_at, ...(entry.auto_imported ? { auto_imported: true } : {}), ...(entry.base_url ? { base_url: entry.base_url } : {}), api_key: apiKey };
  }
  return out;
}

/** PUT-side: encrypt one api_key into a card entry (at-rest ciphertext only). */
export function buildEntry(provider: string, model: string, apiKey: string, enabled: boolean): CardEntry {
  return {
    provider,
    model,
    api_key_encrypted: encrypt(apiKey).toString('base64'),
    enabled,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Structural validation for PUT /v1/config/trimmc-card (save=pending).
 * Returns error string or ''. Checks:
 *   - every entry.model ∈ official catalog (五名)
 *   - every rule.entry_id references an EXISTING entry (no dangling)
 *   - fixed rule model (∈ enabled-entry model set ∩ catalog) is enforced at
 *     the policy plane; here rules are a reference list so we only check
 *     entry existence + type enum + state enum.
 */
export function validateCard(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return 'card must be a JSON object';
  const d = doc as Partial<TrimmcCardDocument> & Record<string, unknown>;
  if (d.version !== 2) return 'version must be 2';
  if (typeof d.machine !== 'object' || d.machine === null || typeof (d.machine as { name?: unknown }).name !== 'string') {
    return 'machine.name must be a string';
  }
  if (typeof d.connection !== 'object' || d.connection === null || typeof (d.connection as { name?: unknown }).name !== 'string' || (d.connection as { name: string }).name.trim() === '') {
    return 'connection.name is required (名称必填)';
  }
  if (typeof d.provider_entries !== 'object' || d.provider_entries === null || Array.isArray(d.provider_entries)) {
    // D7: array-of-ids退化形态（CEO 23:57 实锚）显式拒
    return 'provider_entries must be an object keyed by entry id';
  }
  for (const [id, entry] of Object.entries(d.provider_entries as Record<string, unknown>)) {
    // D7: string/array 等退化形态结构性拒（正常形态=对象含 model/api_key_encrypted）
    if (typeof entry !== 'object' || entry === null) {
      return `provider_entries[${id}] must be an object (malformed entry data — please re-add the entry)`;
    }
  }
  for (const [id, entry] of Object.entries(d.provider_entries)) {
    if (typeof entry !== 'object' || entry === null) return `provider_entries[${id}] must be an object`;
    const e = entry as Partial<CardEntry>;
    if (typeof e.provider !== 'string' || !e.provider) return `provider_entries[${id}].provider required`;
    if (typeof e.model !== 'string' || !isCatalogModel(e.model ?? '')) {
      return `provider_entries[${id}].model must be one of the official catalog: ${MODEL_CATALOG_LIST}`;
    }
    if (typeof e.api_key_encrypted !== 'string' || !e.api_key_encrypted) return `provider_entries[${id}].api_key_encrypted required`;
    if (typeof e.enabled !== 'boolean') return `provider_entries[${id}].enabled must be boolean`;
  }
  if (!Array.isArray(d.rules)) return 'rules must be an array';
  for (const [i, rule] of (d.rules as unknown[]).entries()) {
    if (typeof rule !== 'object' || rule === null) return `rules[${i}] must be an object`;
    const r = rule as Partial<CardRuleRef>;
    if (r.type !== 'fixed' && r.type !== 'window') return `rules[${i}].type must be 'fixed'|'window' (quota is schema-reserved and rejected)`;
    if (typeof r.entry_id !== 'string' || !(r.entry_id in (d.provider_entries as Record<string, unknown>))) {
      return `rules[${i}].entry_id '${r.entry_id}' does not reference an existing entry (悬挂引用)`;
    }
  }
  if (typeof d.status === 'object' && d.status !== null) {
    const st = d.status as { state?: unknown };
    if (st.state !== undefined && !(CARD_STATES as readonly string[]).includes(st.state as string)) {
      return `status.state must be one of: ${CARD_STATES.join(', ')}`;
    }
  }
  return '';
}

/** Rules referencing a given entry (for delete-guard). */
export function rulesReferencing(doc: TrimmcCardDocument, entryId: string): CardRuleRef[] {
  return doc.rules.filter((r) => r.entry_id === entryId);
}
