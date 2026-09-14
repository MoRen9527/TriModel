// ── TriModel: Schedule-based default-model policy ──
// LG-035 P1 (2026-09-11): time-window policy over the default model.
//
// Design notes:
// - policy.json lives at the TriModel repo root (same resolution pattern as
//   config.ts dotenv: dev src/ → root, compiled dist/src/ → root).
// - File absent / unparsable / bad shape ⇒ loadPolicy() returns null and the
//   caller falls back to env default — behaviour identical to pre-policy days
//   (backward-compat guarantee).
// - savePolicy() writes tmp + rename (atomic on same filesystem).
// - Windows are evaluated in Asia/Shanghai local time explicitly (host TZ is
//   never consulted). Start is inclusive, end is exclusive.
// - P1 candidate-domain note: NO authentication on policy write path by design
//   (admin-token enforcement is a pending adjudication item; the config-plane
//   server binds 127.0.0.1 only). See src/api/policy.ts.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { MODEL_CATALOG, MODEL_CATALOG_LIST } from './model-catalog.js';

export interface PolicyWindow {
  start: string; // 'HH:MM' inclusive, Asia/Shanghai local time
  end: string; // 'HH:MM' exclusive
}

export interface PolicySchedule {
  id: string;
  target: 'daemon-default';
  model: string;
  windows: PolicyWindow[];
  timezone: 'Asia/Shanghai';
  enabled: boolean;
  priority: number; // higher number wins when multiple windows match
  /**
   * D15/增补件4②：type 收窄='window' 单型（缺省即 window；'fixed' 退役——
   * boot 迁移器转写 default_model 后剥离）。'quota' 为 schema 级预留——运行
   * 时显式拒绝。
   */
  type?: 'window';
}

export interface PolicyShape {
  version: string;
  schedules: PolicySchedule[];
}

export interface PolicyEvaluation {
  model: string;
  matched_schedule_id: string;
}

const SUPPORTED_TIMEZONE = 'Asia/Shanghai';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Env fallback shared with keys.ts（官方名，LG-035 增补标准化）。 */
export function envDefaultModel(): string {
  return process.env.TRIMODEL_DEFAULT_MODEL ?? 'deepseek-v4-pro';
}

/**
 * 增补件5：卡 default_model 兜底（计算序中间层：窗口命中 → 卡 default_model
 * → env 出厂默认）。从 trimmc-card.json 读取 default_model 字段。
 * 延迟绑定：loadCard 从 trimmc-card.ts 注入（防环：trimmc-card 不依赖 policy）。
 */
let _cardDefaultModelFn: (() => string | null) | null = null;

/** Register a card default_model getter (called from server.ts at boot). */
export function registerCardDefaultModelFn(fn: () => string | null): void {
  _cardDefaultModelFn = fn;
}

/** Get card default_model via registered getter, or null (fail-safe). */
export function getCardDefaultModel(): string | null {
  if (!_cardDefaultModelFn) return null;
  try { return _cardDefaultModelFn(); } catch { return null; }
}

// ── v4 quota 求值层钩子位（schema 终稿 §三/§四；MVP=空实装层 inert）──
// 额度触发=异常路径优先于常规（增补件 6 §三）：信号就绪且活动策略 quota 规则
// 的监控条目耗尽 → fallback_ids 依序首个可用。MVP 实装=钩子位+空信号（恒走
// 常规序，零影响）；信号实接（usage 基座→判定形态）联调窗另排。

export interface QuotaDecision {
  model: string;
  /** 失败态：序列耗尽=停留+提示（增补件 6 §三）。 */
  exhausted?: boolean;
}

let _quotaSignalFn: (() => QuotaDecision | null) | null = null;

/** Register the quota-signal decision getter (called from server.ts at boot). */
export function registerQuotaSignalFn(fn: () => QuotaDecision | null): void {
  _quotaSignalFn = fn;
}

/** Get the quota override decision via registered getter, or null (常规序). */
export function getQuotaDecision(): QuotaDecision | null {
  if (!_quotaSignalFn) return null;
  try { return _quotaSignalFn(); } catch { return null; }
}

function toMinutes(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Format a Date as 'HH:MM' in the given IANA timezone (never the host TZ). */
function hhmmInZone(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date);
}

function windowMatches(hhmm: string, window: PolicyWindow): boolean {
  const now = toMinutes(hhmm);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (Number.isNaN(now) || Number.isNaN(start) || Number.isNaN(end)) return false;
  if (start < end) {
    // Same-day window: [start, end)
    return now >= start && now < end;
  }
  if (start > end) {
    // Overnight window (e.g. 18:00-00:00): [start, midnight) ∪ [00:00, end)
    return now >= start || now < end;
  }
  // start === end: zero-length window matches nothing
  return false;
}

/**
 * Evaluate the policy at instant `now`. Enabled schedules are ordered by
 * descending priority; the first schedule with a matching window wins.
 * Returns null when nothing matches (caller falls back to env default).
 */
export function evaluatePolicy(
  now: Date,
  policy: PolicyShape | null | undefined,
): PolicyEvaluation | null {
  if (!policy || !Array.isArray(policy.schedules)) return null;
  const enabled = policy.schedules
    .filter((s) => s && s.enabled)
    .sort((a, b) => b.priority - a.priority);
  for (const schedule of enabled) {
    // D15/增补件4②：fixed 分支退役（迁移器转写 default_model 后剥离）
    if (schedule.timezone !== SUPPORTED_TIMEZONE) continue; // P1: single-TZ support
    const hhmm = hhmmInZone(now, schedule.timezone);
    if (Array.isArray(schedule.windows) && schedule.windows.some((w) => windowMatches(hhmm, w))) {
      return { model: schedule.model, matched_schedule_id: schedule.id };
    }
  }
  return null;
}

/** Validate an untrusted document against PolicyShape. Returns error string or ''. */
export function validatePolicyShape(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return 'policy must be a JSON object';
  const p = doc as Record<string, unknown>;
  if (typeof p.version !== 'string' || p.version.length === 0) return 'version must be a non-empty string';
  if (!Array.isArray(p.schedules)) return 'schedules must be an array';
  for (const [i, raw] of p.schedules.entries()) {
    if (typeof raw !== 'object' || raw === null) return `schedules[${i}] must be an object`;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id.length === 0) return `schedules[${i}].id must be a non-empty string`;
    if (s.target !== 'daemon-default') return `schedules[${i}].target must be 'daemon-default'`;
    if (typeof s.model !== 'string' || s.model.length === 0) return `schedules[${i}].model must be a non-empty string`;
    // LG-035 增补：model ∈ 恰五名目录（大小写精确）；旧名（tmv-* 等）显式 400 附列表。
    if (!(MODEL_CATALOG as readonly string[]).includes(s.model)) {
      return `schedules[${i}].model must be one of the official catalog: ${MODEL_CATALOG_LIST}`;
    }
    if (!Array.isArray(s.windows) || s.windows.length === 0) {
      return `schedules[${i}].windows must be a non-empty array`;
    }
    for (const [j, w] of (Array.isArray(s.windows) ? (s.windows as unknown[]) : []).entries()) {
      if (typeof w !== 'object' || w === null) return `schedules[${i}].windows[${j}] must be an object`;
      const win = w as Record<string, unknown>;
      if (typeof win.start !== 'string' || !TIME_RE.test(win.start)) {
        return `schedules[${i}].windows[${j}].start must be 'HH:MM' (00:00-23:59)`;
      }
      if (typeof win.end !== 'string' || !TIME_RE.test(win.end)) {
        return `schedules[${i}].windows[${j}].end must be 'HH:MM' (00:00-23:59)`;
      }
      // F1 (CTO 2026-09-11): zero-length windows never match at runtime
      // (U13a) — reject at write time so config semantics stay consistent
      // with engine semantics (no silent no-op windows).
      if (win.start === win.end) {
        return `schedules[${i}].windows[${j}] must not have start == end (zero-length window never matches)`;
      }
    }
    if (s.timezone !== SUPPORTED_TIMEZONE) return `schedules[${i}].timezone must be '${SUPPORTED_TIMEZONE}' (P1)`;
    // D15/增补件4②: type 收窄='window' 单型（fixed 退役，迁移器转写）；
    // 'quota' 仍 schema 级预留显式拒。
    if (s.type !== undefined && s.type !== 'window') {
      return `schedules[${i}].type must be 'window' (absent defaults to 'window'); 'fixed' retired (migrate via boot), 'quota' reserved and not accepted`;
    }
    if (typeof s.enabled !== 'boolean') return `schedules[${i}].enabled must be a boolean`;
    if (typeof s.priority !== 'number' || !Number.isFinite(s.priority)) {
      return `schedules[${i}].priority must be a finite number`;
    }
  }
  const ids = new Set<string>();
  for (const s of p.schedules as PolicySchedule[]) {
    if (ids.has(s.id)) return `duplicate schedule id: ${s.id}`;
    ids.add(s.id);
  }
  return '';
}

// ── S11 按机分域（LG-035 复走查⑧架构裁决）：策略作用域=TriMMC 卡目标机 ──
// 存储 policies/<machine>.json（machine 规范化小写连字符；本机=固定名 local）。
// boot 幂等迁移：现存 policy.json → policies/local.json（改名式，keys.enc 族）。
// 引擎零双轨：evaluatePolicy 纯函数不动，evaluateForMachine = 单函数按机求值
// （逐调用读对应机文档，零缓存零重启语义）。

export const DEFAULT_MACHINE = 'local';

/** machine 名规范化：小写连字符（非法字符折叠为 '-'，空 → local）。 */
export function sanitizeMachine(machine: string): string {
  const clean = machine.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || DEFAULT_MACHINE;
}

let policiesDirOverride: string | null = null;

/** Test seam: redirect the policies/ directory (repo root untouched in tests). */
export function setPoliciesDirForTest(dir: string | null): void {
  policiesDirOverride = dir;
}

/**
 * 规范位（写入口，D9 同款防编译位二义）：env 钉位 > 进程 cwd。
 * 旧实现按 import.meta.url 编译邻接解析 → dist 构建版写 dist/policies/
 * （随 dist 清理丢策略；本地侧部署实证 2026-09-14）。
 */
function policiesDir(): string {
  if (policiesDirOverride) return policiesDirOverride;
  const env = process.env.TRIMODEL_POLICIES_DIR?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'policies');
}

/** legacy 位（只读兼容）：D9 前旧写位=import.meta.url 编译邻接。 */
function legacyPoliciesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'policies');
}

/** Boot 迁移：legacy 位策略文件 → 规范位（逐文件 rename，规范位无同名时；幂等）。 */
export function migrateLegacyPoliciesDir(): { migrated: string[] } {
  const migrated: string[] = [];
  const legacy = legacyPoliciesDir();
  const canonical = policiesDir();
  if (legacy === canonical || !existsSync(legacy)) return { migrated };
  try {
    for (const name of readdirSync(legacy)) {
      if (!name.endsWith('.json')) continue;
      const target = join(canonical, name);
      if (existsSync(target)) continue;
      mkdirSync(canonical, { recursive: true });
      renameSync(join(legacy, name), target);
      migrated.push(name);
    }
  } catch (err) {
    console.warn('[trimodel] policies dir migration skipped:', err instanceof Error ? err.message : err);
  }
  return { migrated };
}

export function policyPathForMachine(machine: string): string {
  return join(policiesDir(), `${sanitizeMachine(machine)}.json`);
}

/** Read one machine's policy document. Absent/corrupt → null (fail-safe). */
export function loadPolicyForMachine(machine: string = DEFAULT_MACHINE): PolicyShape | null {
  const name = `${sanitizeMachine(machine)}.json`;
  const primary = loadPolicy(join(policiesDir(), name));
  if (primary) return primary;
  // legacy 兼容读：仅未注入 override/env 时（测试隔离不受影响）
  if (!policiesDirOverride && !process.env.TRIMODEL_POLICIES_DIR?.trim()) {
    return loadPolicy(join(legacyPoliciesDir(), name));
  }
  return null;
}

export function savePolicyForMachine(machine: string, doc: PolicyShape): void {
  const target = policyPathForMachine(machine);
  // D6 (STE 实锤 2026-09-11): fresh 态（无 legacy→迁移不触发）policies/ 不存在
  // → writeFileSync ENOENT → PUT 500。首存自建目录（recursive）。
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}
`, 'utf-8');
  renameSync(tmp, target);
}

/** Single-engine per-machine evaluation (S11.2: 机为参数，非多实例引擎). */
export function evaluateForMachine(machine: string, now: Date = new Date()): PolicyEvaluation | null {
  return evaluatePolicy(now, loadPolicyForMachine(machine));
}

/** Boot one-shot migration: legacy repo-root policy.json → policies/local.json. */
export function migrateLegacyPolicy(): { migrated: boolean; reason?: 'already-local' | 'no-legacy' | 'already-migrated' } {
  const here = dirname(fileURLToPath(import.meta.url));
  const legacy = resolve(here, '..', 'policy.json');
  const local = policyPathForMachine(DEFAULT_MACHINE);
  if (existsSync(local)) return { migrated: false, reason: 'already-local' };
  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };
  if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true });
  renameSync(legacy, local);
  console.log(`[trimodel] legacy policy.json migrated to policies/local.json`);
  return { migrated: true };
}


/**
 * Load policy.json from the TriModel repo root. Returns null when the file is
 * absent, unparsable, or fails shape validation — never throws (the server
 * must keep serving the env default when policy storage is broken).
 */
export function loadPolicy(pathOverride?: string): PolicyShape | null {
  const candidates = pathOverride ? [pathOverride] : [policyPathForMachine(DEFAULT_MACHINE)];
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue; // absent (or unreadable) → try next candidate
    }
    try {
      const doc: unknown = JSON.parse(text);
      const error = validatePolicyShape(doc);
      if (error) {
        console.warn(`[trimodel] policy.json at ${path} failed validation: ${error}`);
        return null;
      }
      return doc as PolicyShape;
    } catch (err) {
      console.warn(`[trimodel] policy.json at ${path} is not valid JSON:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

/** Atomically persist the policy (tmp + rename). Default target: repo root. */
export function savePolicy(policy: PolicyShape, pathOverride?: string): void {
  const target = pathOverride ?? policyPathForMachine(DEFAULT_MACHINE);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
  renameSync(tmp, target);
}

/** One-call helper for hot-path consumers: policy hit or env default.
 * v4：quota 异常路径优先（钩子位；MVP 空信号恒 null → 常规序零变化）。 */
export function effectiveModel(now: Date = new Date()): {
  model: string;
  matched_schedule_id: string | null;
  source: 'quota' | 'policy' | 'card-default' | 'env-default';
} {
  const quota = getQuotaDecision();
  if (quota) return { model: quota.model, matched_schedule_id: null, source: 'quota' };
  const hit = evaluatePolicy(now, loadPolicy());
  if (hit) return { model: hit.model, matched_schedule_id: hit.matched_schedule_id, source: 'policy' };
  // 增补件4② 三层计算序中间层：窗口未命中 → 卡 default_model → env 出厂默认
  const cardModel = getCardDefaultModel();
  if (cardModel) return { model: cardModel, matched_schedule_id: null, source: 'card-default' };
  return { model: envDefaultModel(), matched_schedule_id: null, source: 'env-default' };
}
