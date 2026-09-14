// ── TriModel TriMMC Card v4 store (LG-035 schema v4 终稿，CTO 2026-09-14) ──
//
// trimmc-card.json at the TriModel repo root (gitignored). Schema v4（三实体模型）:
//   {
//     version: 4,
//     machine: { name },                       // 栏头只读
//     connection: { name, ...predefined },
//     provider_entries: { <entry_id>: { provider, model, api_key_encrypted, enabled, updated_at } },
//     model_sets:  { <msid>: { name, entry_ids, created_at, updated_at } },   // 三实体①
//     rules:       { <rid>: { name, type: 'time'|'default'|'quota', enabled, ...分型字段 } },  // 三实体②（同名翻型：v2 引用清单数组→实体字典）
//     strategies:  { <pid>: { name, purpose?, model_set_id, rule_ids } },     // 三实体③（引用式）
//     active_strategy_id: <pid> | null,
//     default_model?: string | null,           // 派生缓存：apply 时自活动策略 default 规则同步；真源=规则实体
//     status / reserved / deleted_* 通道照旧
//   }
//
// 逐条目加密（key-encryptor AES-256-GCM）：at-rest 永远是密文；明文仅在
// GET /v1/config/trimmc-card 响应内解密存在（UI 永不消费该响应的 key 字段）。
// v2/v3 → v4 迁移：boot 时 migrateCardV4（幂等三判据，终稿 §二）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { hostname } from 'node:os';
import { decrypt, encrypt } from './security/key-encryptor.js';
import { isCatalogModel, MODEL_CATALOG_LIST } from './model-catalog.js';

export const CARD_VERSION = 4;

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

// ── v4 三实体（schema 终稿 §一）──

export interface ModelSetEntity {
  name: string;          // 卡内唯一
  entry_ids: string[];   // 引用 provider_entries；守卫=悬挂拒绝
  created_at: string;
  updated_at: string;
}

export type RuleType = 'time' | 'default' | 'quota';

/** time 型窗（CEO 22:12+BOD 22:2x 修正令：entry_id 下沉窗级——三窗两模型=一条规则三窗各带条目）。 */
export interface RuleWindow {
  start: string;   // 'HH:MM' inclusive
  end: string;     // 'HH:MM' exclusive
  entry_id: string; // 该窗用哪个条目（窗级模型）
}

export interface RuleEntity {
  name: string;          // 卡内唯一
  type: RuleType;
  enabled: boolean;      // 停用=保留但不参与组合
  /** time 必备：多窗整组，窗级 entry_id（「三窗切换」=一条规则三窗各带模型；HH:MM，start<end，跨午夜=P2）。 */
  windows?: RuleWindow[];
  entry_id?: string;     // default/quota 语义位（default 必备=默认用哪个条目；time 型不用——已下沉窗级）
  watch_entry_id?: string; // quota 必备（监控谁）
  fallback_ids?: string[]; // quota 必备（有序转入序列，≥1）
  created_at: string;
  updated_at: string;
}

export interface StrategyEntity {
  name: string;          // 卡内唯一
  purpose?: string;      // 5b 沿用，可选
  model_set_id: string;  // 守卫=必须存在
  rule_ids: string[];    // 守卫=逐项存在；可含 time/default/quota 混合
  created_at: string;
  updated_at: string;
}

// v3 StrategyEntity（内嵌式）废弃（增补件 6 §五）；以下 legacy 类型仅供
// boot 迁移器输入解析使用，不在运行面出现。

export interface StrategyWindow {
  start: string; // 'HH:MM' inclusive
  end: string;   // 'HH:MM' exclusive
}

export interface StrategyRuleV3 {
  type: 'window';
  windows: StrategyWindow[];
  model: string; // 官方五名（catalog）
  priority: number;
  enabled: boolean;
}

export interface StrategyEntityV3 {
  name: string;
  purpose: string;
  models: string[];
  rules: StrategyRuleV3[];
  default_model: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** v2 顶层规则清单域（同名翻型前的数组形态；仅迁移器消费）。 */
export interface CardRuleRefV2 {
  rule_id: string;
  type: 'fixed' | 'window';
  entry_id: string;
  windows?: { start: string; end: string }[];
  priority?: number;
  enabled?: boolean;
}

export interface TrimmcCardDocument {
  version: typeof CARD_VERSION;
  machine: { name: string };
  connection: { name: string } & Record<string, unknown>;
  provider_entries: Record<string, CardEntry>;
  model_sets: Record<string, ModelSetEntity>;
  rules: Record<string, RuleEntity>;
  strategies: Record<string, StrategyEntity>;
  active_strategy_id: string | null;
  status: { state: CardState; at: string; error?: string };
  reserved: { quota_switch: null; instances_group: null, env_tag: null };
  /** D7 合并语义：PUT 时要求删除的既有条目 id（UI 删除镜像条目通道）。 */
  deleted_entry_ids?: string[];
  /** v4 新增对称删除通道。 */
  deleted_model_set_ids?: string[];
  deleted_rule_ids?: string[];
  /** （现行）策略删除通道。 */
  deleted_strategy_ids?: string[];
  /** 派生缓存：apply 时自活动策略 default 规则同步；真源=规则实体，无编辑面。 */
  default_model?: string | null;
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
    version: CARD_VERSION,
    machine: { name: hostname() },
    connection: { name: connectionName },
    provider_entries: {},
    model_sets: {},
    rules: {},
    strategies: {},
    active_strategy_id: null,
    deleted_strategy_ids: [],
    status: { state: 'pending', at: new Date().toISOString() },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
}

// ── v4 三实体 CRUD（活动性由 active_strategy_id 单点表达，无 enabled 位）──

export function upsertStrategy(doc: TrimmcCardDocument, id: string, entity: StrategyEntity): void {
  doc.strategies[id] = entity;
}

/** Strategy CRUD: delete a strategy (活动策略禁删守卫). */
export function deleteStrategy(doc: TrimmcCardDocument, id: string): { ok: boolean; error?: string } {
  if (!doc.strategies[id]) return { ok: false, error: `strategy '${id}' not found` };
  if (doc.active_strategy_id === id) return { ok: false, error: `活动策略使用中，请先切换` };
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
  if (!doc.active_strategy_id) return null;
  return doc.strategies[doc.active_strategy_id] ?? null;
}

/** Read + decrypt entries. Absent file → null; corrupt → null (fail-safe).
 * v2/v3 入态自动迁移 v4（migrateCardV4，幂等；失败 fail-safe null 不落盘）。 */
export function loadCard(pathOverride?: string): TrimmcCardDocument | null {
  const candidates = pathOverride ? [pathOverride] : candidateCardPaths();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { provider_entries?: unknown }).provider_entries !== 'object') {
        console.warn(`[trimodel] trimmc-card.json at ${path} has invalid shape — ignoring`);
        return null;
      }
      const raw = parsed as { version?: unknown };
      if (raw.version === CARD_VERSION) {
        // 丙补强（BOD 22:2x 令⑤）：窗级形态识别——旧粒度 v4 卡（time 规则 rule 级
        // entry_id、窗无 entry_id）升级下沉（防窗级模型被压扁/漏识别）。
        const doc = parsed as TrimmcCardDocument;
        if (isLegacyGranularityV4(doc)) {
          const upgraded = upgradeCardV4Windows(doc);
          if (upgraded) saveCard(upgraded, path);
          return upgraded ?? doc;
        }
        return doc;
      }
      // 判据乙：rules 已对象（非数组）或 model_sets 已对象 → 半迁移/手工态，
      // 只补版本与缺省键，不重跑打包（防「当前配置」重复生成、防 id 二次生成）。
      if (isHalfMigrated(parsed)) return finalizeHalfMigrated(parsed as unknown as TrimmcCardDocument);
      // v2 / v2+strategies 入态 → 变换迁移（丙：失败原子不落盘，原卡不动）。
      if (raw.version === 2) {
        const migrated = migrateCardV4(parsed as unknown as LegacyCardInput, path);
        if (!migrated) return null; // 变换失败：loadCard fail-safe（原卡保持，下次 boot 重试）
        return migrated;
      }
      console.warn(`[trimodel] trimmc-card.json at ${path} unsupported version ${String(raw.version)} — ignoring`);
      return null;
    } catch (err) {
      console.warn(`[trimodel] trimmc-card.json at ${path} unparsable — ignoring:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

// ── v4 迁移器（schema 终稿 §二）──

/** 迁移器入态：v2 卡（version 2 + 可选 v3 策略域）。 */
export interface LegacyCardInput {
  version: 2;
  machine?: { name?: unknown };
  connection?: { name?: unknown };
  provider_entries?: Record<string, CardEntry>;
  rules?: unknown;
  strategies?: Record<string, StrategyEntityV3>;
  active_strategy_id?: string | null;
  default_model?: string | null;
}

function isHalfMigrated(parsed: unknown): boolean {
  const d = parsed as { rules?: unknown; model_sets?: unknown };
  return (typeof d.rules === 'object' && d.rules !== null && !Array.isArray(d.rules))
    || (typeof d.model_sets === 'object' && d.model_sets !== null);
}

/** 判据乙收尾：补 version=4 与缺失缺省键（不重跑打包）。 */
function finalizeHalfMigrated(doc: TrimmcCardDocument): TrimmcCardDocument {
  doc.version = CARD_VERSION;
  doc.model_sets ??= {};
  doc.rules ??= {};
  doc.strategies ??= {};
  if (doc.active_strategy_id === undefined) doc.active_strategy_id = null;
  return doc;
}

/** id 生成：三前缀+随机段（终稿 §一；卡内唯一由键位保证）。 */
function newId(prefix: 'ms_' | 'rule_' | 'st_'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sortEntriesById(entries: Record<string, CardEntry>): Array<[string, CardEntry]> {
  return Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 变换规则 3：default_model（模型名）→ 解析条目（enabled 且 model 匹配，多条取 id 字典序最小）。 */
function resolveEntryForModel(entries: Record<string, CardEntry>, model: string | null | undefined): string | null {
  if (!model) return null;
  for (const [id, e] of sortEntriesById(entries)) {
    if (e.enabled && e.model === model) return id;
  }
  return null;
}

/**
 * v2/v2+strategies → v4（终稿 §二 变换规则 1-5）。
 * 丙判据：变换任何一步抛错 → 返回 null（原子不落盘；tmp 写+rename 由 saveCard
 * 承载，失败即弃）；迁移前备份 trimmc-card.pre-v4.bak.json（保留一代，成功不删）。
 */
export function migrateCardV4(legacy: LegacyCardInput, pathForBackup?: string): TrimmcCardDocument | null {
  try {
    const entries = legacy.provider_entries ?? {};
    const now = new Date().toISOString();
    const log: string[] = [];

    // 备份（保留一代；再迁移覆盖）
    if (pathForBackup && existsSync(pathForBackup)) {
      try { copyFileSync(pathForBackup, `${pathForBackup}.pre-v4.bak.json`); } catch { /* 备份失败不阻断迁移（.migration-backup 双保险在卷） */ }
    }

    const out: TrimmcCardDocument = {
      version: CARD_VERSION,
      machine: (legacy.machine as TrimmcCardDocument['machine']) ?? { name: hostname() },
      connection: (legacy.connection as TrimmcCardDocument['connection']) ?? { name: '' },
      provider_entries: entries,
      model_sets: {},
      rules: {},
      strategies: {},
      active_strategy_id: null,
      status: { state: 'pending', at: now },
      reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };

    const v3Strategies = legacy.strategies ?? {};
    const v3ActiveHit = legacy.active_strategy_id && v3Strategies[legacy.active_strategy_id] ? v3Strategies[legacy.active_strategy_id] : null;

    if (v3ActiveHit) {
      // 变换规则 1：active v3 策略=真源；顶层 rules 数组视为陈旧展示域清空。
      if (Array.isArray(legacy.rules) && legacy.rules.length > 0) log.push(`cleared ${legacy.rules.length} stale top-level rule refs`);
      // 变换规则 5：v3 策略逐个升格（活动者保持活动；命名空间独立）。
      for (const [oldPid, s3] of Object.entries(v3Strategies)) {
        const pid = newId('st_');
        // 规则 2（BOD 22:2x 修正令：窗级 entry_id）：v3 内嵌规则**全部窗归一条** time
        // 实体（每窗带自己的 entry_id——三窗两模型=「一条规则三窗」），名=策略名。
        const ruleIds: string[] = [];
        const mergedWindows: RuleWindow[] = [];
        let anyEnabled = false;
        for (const r of s3.rules ?? []) {
          if (!Array.isArray(r.windows) || r.windows.length === 0) continue;
          for (const w of r.windows) {
            if (!TIME_RE_V4.test(w.start) || !TIME_RE_V4.test(w.end)) throw new Error(`v3 strategy '${oldPid}' rule window malformed`);
            if (w.start >= w.end) throw new Error(`v3 strategy '${oldPid}' rule window start>=end`);
            const entryId = resolveEntryForModel(entries, r.model);
            if (!entryId) throw new Error(`v3 strategy '${oldPid}' rule model '${r.model}' has no enabled entry`);
            mergedWindows.push({ start: w.start, end: w.end, entry_id: entryId });
          }
          anyEnabled = anyEnabled || r.enabled !== false;
        }
        if (mergedWindows.length > 0) {
          const rid = newId('rule_');
          out.rules[rid] = {
            name: `${s3.name}#时段`,
            type: 'time', enabled: anyEnabled,
            windows: mergedWindows.sort((a, b) => (a.start < b.start ? -1 : 1)),
            created_at: now, updated_at: now,
          };
          ruleIds.push(rid);
        }
        // 规则 3：v3 策略 default_model → default 实体（名=<策略名>#默认——CTO 终稿 §二.3 族口径，
        // 多 v3 策略不撞名；现役单规则场景名「默认模型」属 22:2x 令特例，不泛化进循环——F-1 修补）。
        const defaultEntry = resolveEntryForModel(entries, s3.default_model);
        if (defaultEntry) {
          const rid = newId('rule_');
          out.rules[rid] = { name: `${s3.name}#默认`, type: 'default', enabled: true, entry_id: defaultEntry, created_at: now, updated_at: now };
          ruleIds.push(rid);
        } else if (s3.default_model) {
          log.push(`strategy '${oldPid}' default_model '${s3.default_model}' resolved to no entry (falls back to system default)`);
        }
        // 规则 4：v3 models[] → 「<策略名>集」（entry_ids=enabled 条目中 model∈models，按 id 字典序稳定）。
        const msid = newId('ms_');
        const wanted = new Set(s3.models ?? []);
        const entryIds = sortEntriesById(entries).filter(([, e]) => e.enabled && wanted.has(e.model)).map(([id]) => id);
        out.model_sets[msid] = { name: `${s3.name}集`, entry_ids: entryIds, created_at: now, updated_at: now };
        out.strategies[pid] = {
          name: s3.name, ...(s3.purpose ? { purpose: s3.purpose } : {}),
          model_set_id: msid, rule_ids: ruleIds, created_at: now, updated_at: now,
        };
        if (legacy.active_strategy_id === oldPid) {
          out.active_strategy_id = pid;
          out.default_model = defaultEntry ? entries[defaultEntry].model : legacy.default_model ?? null;
        }
      }
    } else {
      // 真源=顶层 rules（window 型）+ default_model → 打包「当前配置」。
      let ruleOrdinal = 0;
      const ruleIds: string[] = [];
      const mergedWindows: RuleWindow[] = [];
      for (const ref of Array.isArray(legacy.rules) ? (legacy.rules as CardRuleRefV2[]) : []) {
        if (ref.type !== 'window') continue;
        if (!(ref.entry_id in entries)) throw new Error(`top-level rule '${ref.rule_id}' entry '${ref.entry_id}' dangling`);
        for (const win of ref.windows ?? []) {
          if (!TIME_RE_V4.test(win.start) || !TIME_RE_V4.test(win.end)) throw new Error(`rule '${ref.rule_id}' window malformed`);
          if (win.start >= win.end) throw new Error(`rule '${ref.rule_id}' window start>=end`);
          mergedWindows.push({ start: win.start, end: win.end, entry_id: ref.entry_id });
        }
      }
      if (mergedWindows.length > 0) {
        const rid = newId('rule_');
        out.rules[rid] = {
          name: (legacy.rules as CardRuleRefV2[])[0]?.rule_id || '时段规则',
          type: 'time', enabled: true,
          windows: mergedWindows.sort((a, b) => (a.start < b.start ? -1 : 1)),
          created_at: now, updated_at: now,
        };
        ruleIds.push(rid);
      }
      const defaultEntry = resolveEntryForModel(entries, legacy.default_model);
      if (defaultEntry) {
        const rid = newId('rule_');
        out.rules[rid] = { name: '默认模型', type: 'default', enabled: true, entry_id: defaultEntry, created_at: now, updated_at: now };
        ruleIds.push(rid);
      } // 顶层打包=单「当前配置」策略场景，「默认模型」不撞（22:2x 令特例）
      // 规则 4：无 v3 策略 → 「当前模型集」=全部 enabled 条目。
      const msid = newId('ms_');
      out.model_sets[msid] = {
        name: '当前模型集',
        entry_ids: sortEntriesById(entries).filter(([, e]) => e.enabled).map(([id]) => id),
        created_at: now, updated_at: now,
      };
      const pid = newId('st_');
      out.strategies[pid] = {
        name: '当前配置', purpose: 'boot 迁移自旧版卡',
        model_set_id: msid, rule_ids: ruleIds, created_at: now, updated_at: now,
      };
      out.active_strategy_id = pid;
      out.default_model = defaultEntry ? entries[defaultEntry].model : legacy.default_model ?? null;
    }

    if (pathForBackup) saveCard(out, pathForBackup); // tmp+rename 原子落盘（丙判据承载点）
    for (const line of log) console.log(`[trimodel] card v4 migration: ${line}`);
    console.log(`[trimodel] card migrated to v4: ${Object.keys(out.strategies).length} strategy(ies), ${Object.keys(out.rules).length} rule(s), ${Object.keys(out.model_sets).length} model set(s); active=${out.active_strategy_id ?? 'none'}`);
    return out;
  } catch (err) {
    console.warn(`[trimodel] card v4 migration failed (card untouched, will retry next boot):`, err instanceof Error ? err.message : err);
    return null;
  }
}

const TIME_RE_V4 = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 丙补强判别：v4 卡存在 time 规则用 rule 级 entry_id（窗无 entry_id）=旧粒度。 */
function isLegacyGranularityV4(doc: TrimmcCardDocument): boolean {
  return Object.values(doc.rules ?? {}).some(
    (r) => r.type === 'time' && typeof r.entry_id === 'string' && Array.isArray(r.windows) && r.windows.length > 0 && r.windows.every((w) => !w.entry_id),
  );
}

/** 丙补强升级（CTO v1.1 形态门自愈）：旧粒度 v4 → 窗级归并——entry_id 下沉每窗
 * + 同策略引用的 time 规则归一条（名=去 #序尾缀）。跨策略不并（CTO v1.1 ③：
 * 跨策略同窗合法——同时刻只有一策略活动）。 */
function upgradeCardV4Windows(doc: TrimmcCardDocument): TrimmcCardDocument | null {
  try {
    const now = new Date().toISOString();
    for (const s of Object.values(doc.strategies ?? {})) {
      const timeRids = s.rule_ids.filter((rid) => {
        const r = doc.rules[rid];
        return r && r.type === 'time' && Array.isArray(r.windows);
      });
      const legacyGranularity = timeRids.some((rid) => typeof doc.rules[rid].entry_id === 'string');
      if (timeRids.length === 0 || !legacyGranularity) continue;
      // 归并：全部 time 规则的窗（entry_id 下沉）并一条；名=首规则名去 #尾缀。
      const mergedWindows: RuleWindow[] = [];
      for (const rid of timeRids) {
        const r = doc.rules[rid];
        const ruleEntry = r.entry_id;
        mergedWindows.push(...(r.windows ?? []).map((w) => ({ start: w.start, end: w.end, entry_id: w.entry_id ?? ruleEntry! })));
      }
      const firstName = doc.rules[timeRids[0]].name.replace(/#\d+$/, '') || '时段规则';
      const newRid = timeRids[0];
      doc.rules[newRid] = { name: `${firstName}#时段`, type: 'time', enabled: doc.rules[newRid].enabled, windows: mergedWindows.sort((a, b) => (a.start < b.start ? -1 : 1)), created_at: now, updated_at: now };
      for (const rid of timeRids.slice(1)) delete doc.rules[rid];
      s.rule_ids = [newRid, ...s.rule_ids.filter((rid) => !timeRids.includes(rid))];
      // 首版迁移命名指纹清理：「<策略名>默认」→「<策略名>#默认」（族对齐；不统一字面量——多策略撞名，F-1 修补）。
      for (const rid of s.rule_ids) {
        const r = doc.rules[rid];
        if (r && r.type === 'default' && r.name === `${firstName.replace(/#时段$/, '')}默认`) r.name = `${firstName.replace(/#时段$/, '')}#默认`;
      }
    }
    // 未被策略引用的散置旧粒度 time 规则（理论少见）：仅下沉不合并。
    for (const r of Object.values(doc.rules)) {
      if (r.type === 'time' && typeof r.entry_id === 'string' && Array.isArray(r.windows)) {
        const ruleEntry = r.entry_id;
        r.windows = r.windows.map((w) => ({ start: w.start, end: w.end, entry_id: w.entry_id ?? ruleEntry }));
        delete r.entry_id;
        r.updated_at = now;
      }
    }
    return doc;
  } catch (err) {
    console.warn('[trimodel] card v4 window-granularity upgrade failed (kept as-is):', err instanceof Error ? err.message : err);
    return null;
  }
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
 * Structural validation for PUT /v1/config/trimmc-card (save=pending) — v4.
 * 终稿 §一/§五：三实体分型必备性 + 引用守卫全矩阵（悬挂引用/窗重叠/唯一性）。
 * Returns error string or ''.
 */
export function validateCard(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return 'card must be a JSON object';
  const d = doc as Partial<TrimmcCardDocument> & Record<string, unknown>;
  if (d.version !== CARD_VERSION) return `version must be ${CARD_VERSION}`;
  if (typeof d.machine !== 'object' || d.machine === null || typeof (d.machine as { name?: unknown }).name !== 'string') {
    return 'machine.name must be a string';
  }
  if (typeof d.connection !== 'object' || d.connection === null || typeof (d.connection as { name?: unknown }).name !== 'string' || (d.connection as { name: string }).name.trim() === '') {
    return 'connection.name is required (名称必填)';
  }
  if (typeof d.provider_entries !== 'object' || d.provider_entries === null || Array.isArray(d.provider_entries)) {
    return 'provider_entries must be an object keyed by entry id';
  }
  const providerEntries = d.provider_entries;
  for (const [id, entry] of Object.entries(d.provider_entries as Record<string, unknown>)) {
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

  // ── 模型集（守卫：集内条目悬挂拒；名称卡内唯一）──
  if (typeof d.model_sets !== 'object' || d.model_sets === null || Array.isArray(d.model_sets)) {
    return 'model_sets must be an object keyed by set id';
  }
  const msNames = new Set<string>();
  for (const [id, ms] of Object.entries(d.model_sets)) {
    if (typeof ms !== 'object' || ms === null) return `model_sets[${id}] must be an object`;
    const m = ms as Partial<ModelSetEntity>;
    if (typeof m.name !== 'string' || !m.name.trim()) return `model_sets[${id}].name required`;
    if (msNames.has(m.name)) return `名称「${m.name}」已存在`;
    msNames.add(m.name);
    if (!Array.isArray(m.entry_ids)) return `model_sets[${id}].entry_ids must be an array`;
    for (const eid of m.entry_ids) {
      if (typeof eid !== 'string' || !(eid in providerEntries)) {
        return `model_sets[${id}] 引用的条目 '${String(eid)}' 不存在`;
      }
    }
  }

  // ── 规则实体（守卫：分型必备性/条目悬挂/名称唯一；三型互斥多余字段不拒）──
  if (typeof d.rules !== 'object' || d.rules === null || Array.isArray(d.rules)) {
    return 'rules must be an object keyed by rule id';
  }
  const ruleNames = new Set<string>();
  for (const [id, r] of Object.entries(d.rules)) {
    if (typeof r !== 'object' || r === null) return `rules[${id}] must be an object`;
    const rule = r as Partial<RuleEntity>;
    if (typeof rule.name !== 'string' || !rule.name.trim()) return `rules[${id}].name required`;
    if (ruleNames.has(rule.name)) return `名称「${rule.name}」已存在`;
    ruleNames.add(rule.name);
    if (rule.type !== 'time' && rule.type !== 'default' && rule.type !== 'quota') {
      return `rules[${id}].type must be 'time'|'default'|'quota'`;
    }
    if (typeof rule.enabled !== 'boolean') return `rules[${id}].enabled must be boolean`;
    const entryExists = (eid: string | undefined): eid is string => typeof eid === 'string' && eid in providerEntries;
    if (rule.type === 'time') {
      if (!Array.isArray(rule.windows) || rule.windows.length === 0) return `rules[${id}].windows required for time rules（至少一个时段窗）`;
      for (const [j, w] of (rule.windows as Array<{ start?: unknown; end?: unknown; entry_id?: unknown }>).entries()) {
        if (typeof w !== 'object' || w === null) return `rules[${id}].windows[${j}] must be an object`;
        if (typeof w.start !== 'string' || !TIME_RE_V4.test(w.start)) return `rules[${id}].windows[${j}].start must be 'HH:MM'`;
        if (typeof w.end !== 'string' || !TIME_RE_V4.test(w.end)) return `rules[${id}].windows[${j}].end must be 'HH:MM'`;
        if (w.start >= w.end) return `rules[${id}].windows[${j}] must have start < end`;
        if (typeof w.entry_id !== 'string' || !(w.entry_id in providerEntries)) return `rules[${id}].windows[${j}] 引用的条目不存在`;
      }
    } else if (rule.type === 'default') {
      if (!entryExists(rule.entry_id)) return `rules[${id}] 引用的条目不存在`;
    } else {
      if (!entryExists(rule.watch_entry_id)) return `rules[${id}] 监控的条目不存在`;
      if (!Array.isArray(rule.fallback_ids) || rule.fallback_ids.length === 0) return `rules[${id}] 转入序列不能为空`;
      for (const fid of rule.fallback_ids) {
        if (typeof fid !== 'string' || !(fid in providerEntries)) return `rules[${id}] 引用的条目不存在`;
      }
    }
  }

  // ── 策略（守卫：引用集/规则逐项存在；名称唯一；活动指针悬挂拒）──
  if (typeof d.strategies !== 'object' || d.strategies === null || Array.isArray(d.strategies)) {
    return 'strategies must be an object keyed by strategy id';
  }
  const stNames = new Set<string>();
  for (const [id, s] of Object.entries(d.strategies)) {
    if (typeof s !== 'object' || s === null) return `strategies[${id}] must be an object`;
    const st = s as Partial<StrategyEntity>;
    if (typeof st.name !== 'string' || !st.name.trim()) return `strategies[${id}].name required`;
    if (stNames.has(st.name)) return `名称「${st.name}」已存在`;
    stNames.add(st.name);
    if (typeof st.model_set_id !== 'string' || !(st.model_set_id in d.model_sets)) {
      return `strategies[${id}] 引用的模型集不存在`;
    }
    if (!Array.isArray(st.rule_ids)) return `strategies[${id}].rule_ids must be an array`;
    for (const rid of st.rule_ids) {
      if (typeof rid !== 'string' || !(rid in d.rules)) return `strategies[${id}] 引用的规则不存在`;
    }
    // 同策略内 time 规则窗重叠拒（终稿 §五矩阵；CEO 22:12 粒度——重叠跨实体与
    // 实体内 windows 一起摊平判定）。
    const timeRules = st.rule_ids
      .map((rid) => (typeof rid === 'string' ? d.rules?.[rid] : undefined))
      .filter((r): r is RuleEntity => !!r && r.type === 'time' && r.enabled !== false && Array.isArray(r.windows));
    for (let i = 0; i < timeRules.length; i++) {
      const windows = timeRules[i].windows as RuleWindow[];
      for (let x = 0; x < windows.length; x++) {
        for (let y = x + 1; y < windows.length; y++) {
          if (windows[x].start < windows[y].end && windows[y].start < windows[x].end) {
            return `规则「${timeRules[i].name}」内部的时段窗口重叠`;
          }
        }
        for (let j = i + 1; j < timeRules.length; j++) {
          const other = timeRules[j].windows as RuleWindow[];
          for (const w of other) {
            if (windows[x].start < w.end && w.start < windows[x].end) {
              return `规则「${timeRules[i].name}」与「${timeRules[j].name}」的时段窗口重叠`;
            }
          }
        }
      }
    }
  }
  if (d.active_strategy_id !== null && d.active_strategy_id !== undefined) {
    if (typeof d.active_strategy_id !== 'string' || !(d.active_strategy_id in d.strategies)) {
      return `引用的策略不存在，请先创建或改选`;
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

/**
 * 删除守卫查询族（终稿 §五：被集**或被规则**引用的条目均禁删——全族口径）。
 * 返回引用方描述（用于人话拒绝文案）；空串=无引用可删。
 */
export function entryReferenceGuards(doc: TrimmcCardDocument, entryId: string): string {
  for (const ms of Object.values(doc.model_sets ?? {})) {
    if (ms.entry_ids.includes(entryId)) return `该条目正被模型集「${ms.name}」引用，请先从模型集移除`;
  }
  for (const r of Object.values(doc.rules ?? {})) {
    const referenced =
      (r.type === 'time' ? (r.windows ?? []).some((w) => w.entry_id === entryId) : r.entry_id === entryId)
      || r.watch_entry_id === entryId || (r.fallback_ids ?? []).includes(entryId);
    if (referenced) return `该条目正被规则「${r.name}」引用，请先在规则中移除`;
  }
  return '';
}

/** 模型集删除守卫：被策略引用禁删。空串=可删。 */
export function modelSetReferenceGuard(doc: TrimmcCardDocument, msid: string): string {
  for (const s of Object.values(doc.strategies ?? {})) {
    if (s.model_set_id === msid) return `该模型集正被策略「${s.name}」引用，请先解除引用`;
  }
  return '';
}

/** 规则删除守卫：被策略引用禁删。空串=可删。 */
export function ruleReferenceGuard(doc: TrimmcCardDocument, rid: string): string {
  for (const s of Object.values(doc.strategies ?? {})) {
    if (s.rule_ids.includes(rid)) return `该规则正被策略「${s.name}」引用，请先解除引用`;
  }
  return '';
}
