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
  /** D10 window 规则携带：时段窗（HH:MM，start<end；应用时映射 policy window 条目）。 */
  windows?: { start: string; end: string }[];
  priority?: number;
  enabled?: boolean;
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
  /** 增补件4②：默认模型兜底（可空=回落引擎出厂默认；计算序中间层）。 */
  default_model?: string | null;
  /** 增补件5：策略实体化（策略字典，id 为键）。 */
  strategies?: Record<string, StrategyEntity>;
  /** 增补件5：当前活动策略 id（null=无活动策略）。 */
  active_strategy_id?: string | null;
  /** 增补件5：已删除策略 id 列表（防幽灵引用）。 */
  deleted_strategy_ids?: string[];
}

export interface StrategyWindow {
  start: string; // 'HH:MM' inclusive
  end: string;   // 'HH:MM' exclusive
}

export interface StrategyRule {
  type: 'window';
  windows: StrategyWindow[];
  model: string; // 官方五名（catalog）
  priority: number;
  enabled: boolean;
}

export interface StrategyEntity {
  name: string;
  purpose: string;
  models: string[]; // 可切换模型集（catalog 五名子集）
  rules: StrategyRule[];
  default_model: string; // 兜底（窗口未命中时使用）
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ── 增补件5：策略实体化 ──

export interface StrategyWindow {
  start: string; // 'HH:MM' inclusive
  end: string;   // 'HH:MM' exclusive
}

export interface StrategyRule {
  type: 'window';
  windows: StrategyWindow[];
  model: string; // 官方五名（catalog）
  priority: number;
  enabled: boolean;
}

export interface StrategyEntity {
  name: string;
  purpose: string;
  models: string[]; // 可切换模型集（catalog 五名子集）
  rules: StrategyRule[];
  default_model: string; // 兜底（窗口未命中时使用）
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface StrategyConfig {
  strategies: Record<string, StrategyEntity>;
  active_strategy_id: string | null;
  deleted_strategy_ids: string[];
}

// ── D9 路径规范化（预走查 f2 谜题根修）──
// 旧实现按 import.meta.url 解析（dev=仓根 / compiled=dist 邻接）→ 编译运行
// 时读写落 dist/trimmc-card.json（f2 态实证）。新候选序：
//   1. TRIMODEL_CARD_FILE env（显式钉死）
//   2. process.cwd()/trimmc-card.json（规范位——systemd WorkingDirectory 钉仓根）
//   3. legacy dist 邻接（只读兼容；boot 迁移器改名式搬至规范位）
// 读兼容 legacy，写仅规范位。

export const CARD_FILE_ENV = 'TRIMODEL_CARD_FILE';

export function canonicalCardPath(): string {
  const env = process.env[CARD_FILE_ENV]?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'trimmc-card.json');
}

/** Legacy location: adjacent to the compiled dist/src (or dev src) directory. */
export function legacyCardPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'trimmc-card.json');
}

function candidateCardPaths(): string[] {
  const env = process.env[CARD_FILE_ENV]?.trim();
  if (env) return [resolve(env)];
  return [canonicalCardPath(), legacyCardPath()];
}

/**
 * D9 boot one-shot migration: legacy dist-adjacent card → canonical cwd path
 * (rename-style, keys.enc family). Idempotent: skips when canonical exists or
 * legacy absent.
 */
export function migrateLegacyDistCard(legacyOverride?: string, canonicalOverride?: string): { migrated: boolean; reason?: 'already-canonical' | 'no-legacy' } {
  const legacy = legacyOverride ?? legacyCardPath();
  const canonical = canonicalOverride ?? canonicalCardPath();
  if (existsSync(canonical)) return { migrated: false, reason: 'already-canonical' };
  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };
  // D6 同族：目标目录首存自建（canonical 的父目录可能尚不存在）
  mkdirSync(dirname(canonical), { recursive: true });
  renameSync(legacy, canonical);
  console.log(`[trimodel] legacy card migrated: ${legacy} → ${canonical}`);
  return { migrated: true };
}

export function emptyCard(connectionName = ''): TrimmcCardDocument {
  return {
    version: 2,
    machine: { name: hostname() },
    connection: { name: connectionName },
    provider_entries: {},
    rules: [],
    strategies: {},
    active_strategy_id: null,
    deleted_strategy_ids: [],
    status: { state: 'pending', at: new Date().toISOString() },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
}

/** Strategy CRUD: upsert a strategy entity. */
export function upsertStrategy(doc: TrimmcCardDocument, id: string, entity: StrategyEntity): void {
  if (!doc.strategies) doc.strategies = {};
  doc.strategies[id] = entity;
}

/** Strategy CRUD: delete a strategy (active strategy 禁删守卫). */
export function deleteStrategy(doc: TrimmcCardDocument, id: string): { ok: boolean; error?: string } {
  if (!doc.strategies || !doc.strategies[id]) return { ok: false, error: `strategy '${id}' not found` };
  if (doc.active_strategy_id === id) return { ok: false, error: `active strategy '${id}' cannot be deleted; switch first` };
  delete doc.strategies[id];
  if (!doc.deleted_strategy_ids) doc.deleted_strategy_ids = [];
  doc.deleted_strategy_ids.push(id);
  return { ok: true };
}

/** Strategy CRUD: set the active strategy id. */
export function setActiveStrategy(doc: TrimmcCardDocument, id: string | null): void {
  doc.active_strategy_id = id;
}

/** Get the active strategy entity, or null if none set / not found. */
export function getActiveStrategy(doc: TrimmcCardDocument): StrategyEntity | null {
  if (!doc.active_strategy_id || !doc.strategies) return null;
  return doc.strategies[doc.active_strategy_id] ?? null;
}

/** Validate a strategy entity (五名目录+规则格式). */
export function validateStrategy(entity: StrategyEntity): string {
  if (typeof entity.name !== 'string' || !entity.name.trim()) return '策略名称必填';
  if (!entity.models || entity.models.length === 0) return '策略模型集不能为空';
  for (const m of entity.models) {
    if (!isCatalogModel(m)) return `模型 '${m}' not in official catalog: ${MODEL_CATALOG_LIST}`;
  }
  if (!entity.rules || entity.rules.length === 0) return '策略规则不能为空';
  for (const rule of entity.rules) {
    if (rule.type !== 'window') return `rule type must be 'window' (fixed retired)`;
    for (const w of rule.windows) {
      const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (!timeRe.test(w.start) || !timeRe.test(w.end)) return `rule window time must be 'HH:MM'`;
      if (w.start >= w.end) return 'rule window must have start < end';
    }
    if (!isCatalogModel(rule.model)) return `rule model '${rule.model}' not in official catalog: ${MODEL_CATALOG_LIST}`;
  }
  if (!isCatalogModel(entity.default_model)) return `default_model '${entity.default_model}' not in official catalog: ${MODEL_CATALOG_LIST}`;
  return '';
}

/** Read + decrypt entries. Absent file → null; corrupt → null (fail-safe). */
export function loadCard(pathOverride?: string): TrimmcCardDocument | null {
  const candidates = pathOverride ? [pathOverride] : candidateCardPaths();
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
  // D9: writes go to the canonical path only (pathOverride = test seam).
  const target = pathOverride ?? canonicalCardPath();
  // D6 同族：目标目录可能不存在（fresh 卡/测试注入路径）——首存自建。
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, target);
}

export function cardExists(pathOverride?: string): boolean {
  const candidates = pathOverride ? [pathOverride] : candidateCardPaths();
  return candidates.some((p: string) => existsSync(p));
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
export function buildEntry(provider: string, model: string, apiKey: string, enabled: boolean, baseUrl?: string): CardEntry {
  return {
    provider,
    model,
    api_key_encrypted: encrypt(apiKey).toString('base64'),
    enabled,
    updated_at: new Date().toISOString(),
    // D8: base_url must survive the hydrate round-trip (S10⑤ 必填+S5 derive 路由消费点)
    ...(baseUrl ? { base_url: baseUrl } : {}),
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
    // D10: window 规则携带时段窗——沿用 P1 引擎校验口径（HH:MM、start<end、
    // 零长窗拒）；fixed 规则不携带。
    if (r.type === 'window') {
      if (!Array.isArray(r.windows) || r.windows.length === 0) {
        return `rules[${i}].windows must be a non-empty array for window rules`;
      }
      const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
      for (const [j, w] of r.windows.entries()) {
        if (typeof w !== 'object' || w === null) return `rules[${i}].windows[${j}] must be an object`;
        const win = w as { start?: unknown; end?: unknown };
        if (typeof win.start !== 'string' || !timeRe.test(win.start)) return `rules[${i}].windows[${j}].start must be 'HH:MM'`;
        if (typeof win.end !== 'string' || !timeRe.test(win.end)) return `rules[${i}].windows[${j}].end must be 'HH:MM'`;
        if (win.start >= win.end) return `rules[${i}].windows[${j}] must have start < end`;
      }
      if (r.priority !== undefined && (typeof r.priority !== 'number' || !Number.isFinite(r.priority))) {
        return `rules[${i}].priority must be a finite number`;
      }
      if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return `rules[${i}].enabled must be a boolean`;
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
