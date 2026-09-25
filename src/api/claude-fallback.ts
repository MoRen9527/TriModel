// ── TriModel API: Claude 直连兜底写入（2026-09-15 CEO 直令，任务书 W38/fallback-button）──
// ── v2 连接配置页（TASK-TRIMODEL-RECOVERY-LADDER-01 波①，2026-09-25）：写路径五门全量落地 ──
//
// GET    /v1/config/claude-fallback           — 无鉴权只读（loopback；照 runtime-info 先例）
//                                               返回 { base_url, model }；管理令牌正确时附密钥尾 4 位
// POST   /v1/config/claude-fallback/restore   — 管理令牌 fail-closed（照卡片三件套）：
//                                               手填三值（地址/密钥/模型）直写本机
//                                               ~/.claude/settings.json 的 env 子集——
//                                               模型档位 9 键全族 verbatim 同值。
// POST   /v1/config/claude-fallback/preview   — v2：管理令牌 fail-closed；零写，返回将写入的
//                                               env 子集 diff（凭据 len-only）＋健康门预检读数。
// GET    /v1/config/claude-fallback/backups   — v2：管理令牌 fail-closed；备份清单（文件名/ts/大小）。
// POST   /v1/config/claude-fallback/rollback  — v2：管理令牌 fail-closed；一键回滚到指定备份
//                                               （回滚前自动备份当前态，回滚可逆）。
// GET    /v1/config/claude-fallback/templates — v2：无鉴权只读（模板非敏感）；连接配置页模板表。
// POST   /v1/config/claude-fallback/inject-key— v2：管理令牌 fail-closed；服务端读独立钥文件
//                                               （.deploy-key）按模板直写——钥值全程不过响应体。
//
// 语义：TriModel 配置面不好用时的直连兜底通道——不依赖 TriModel 数据（卡/策略/引擎零触碰），
// 写后重启会话即直连。其余字段值级保留（序列化统一 2 空格缩进——逐字节仅幂等路径成立）；
// 密钥不回显。
//
// 写路径五门（joint-plan §问1，逐条对锁 09-25 五缺陷；防线继承铁律全量继承）：
// ① 备份先行＋轮换近 5 份＋FROZEN-BACKUPS 哨兵豁免＋幂等短路（无变化不写不备份）
// ② 键名服务端锁定（MODEL_TIER_KEYS 9 键族服务端硬编码，客户端只传三值）
// ③ 凭据健康门：PLACEHOLDER/空串/纯空白 三态全拒 fail-closed（照 restore-claude-config.ps1 修-1 同族）
// ④ 写前整文档 parse＋diff 预览确认＋写后回读断言（非空＋与提交一致＋JSON 合法）失败自动回滚
// ⑤ 掩码红线（len-only 日志／GET 回读 masked 尾4／响应零钥值）＋结构化审计行（who/when/mode/备份/断言）
//
// 凭据键族（F-1，CTO 22xx 审）：AUTH_TOKEN 为主载体；既有迁移/手配机可能以 API_KEY
// 为载体——检测到存在即同写同值（应急语义=消灭一切残留旧密钥，两载体并存会致
// 「写面成功、生效面未必新值」）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { maskKey } from '../secure-keys.js';

/** 目标文件：服务端所宿机的 Claude Code 用户设置（env 明文 token 载体，设计如此）。
 * TRIMODEL_CLAUDE_SETTINGS 可钉位（照 D9 TRIMODEL_CARD_FILE 同族）——真链路测试
 * 用它指向临时文件（沙箱），防误写真实用户设置。 */
export const SETTINGS_FILE_ENV = 'TRIMODEL_CLAUDE_SETTINGS';

/** v2 独立钥文件（零自依赖铁律：钥不生于钥要去的那个文件）。
 * TRIMODEL_DEPLOY_KEY 可钉位；缺省=部署位 settings.presets/.deploy-key（事故案 checklist ② 落位）。 */
export const DEPLOY_KEY_ENV = 'TRIMODEL_DEPLOY_KEY';

/** v2 结构化审计行落点（TRIMODEL_AUDIT_LOG 可钉位；缺省=服务端数据域 config-audit.log，
 * 不写 ~/.claude 目录——真活体零接触判据下审计走服务端自己的日志域）。 */
export const AUDIT_LOG_ENV = 'TRIMODEL_AUDIT_LOG';

export function settingsPath(): string {
  const env = process.env[SETTINGS_FILE_ENV]?.trim();
  if (env) return env;
  return join(homedir(), '.claude', 'settings.json');
}

/** v2 独立钥文件路径（fail-closed：缺失/空=拒写不猜）。 */
export function deployKeyPath(): string {
  const env = process.env[DEPLOY_KEY_ENV]?.trim();
  if (env) return env;
  return join(homedir(), '.claude', 'settings.presets', '.deploy-key');
}

function auditLogPath(): string {
  const env = process.env[AUDIT_LOG_ENV]?.trim();
  if (env) return env;
  return join(process.cwd(), 'config-audit.log');
}

/** v2 审计行（门⑤）：`AUDIT | <ts> | who=.. | mode=.. | backup=.. | assert=.. | result=.. | detail=..`
 * 钥值全程不进日志（len-only 语义由调用方保证 detail 内容）。append-only，写失败不阻塞主流程。 */
export function appendAudit(fields: Record<string, string>): void {
  try {
    const line = 'AUDIT | ' + new Date().toISOString() + ' | ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' | ');
    mkdirSync(dirname(auditLogPath()), { recursive: true });
    writeFileSync(auditLogPath(), line + '\n', { flag: 'a', encoding: 'utf-8' });
  } catch { /* 审计失败不阻塞主流程（但主流程自带结构化结果行兜底） */ }
}

/** 模型档位 9 键全族（现役 settings.json 同款键；全族同值保证各档位一致直连）。 */
export const MODEL_TIER_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
] as const;

/** v2 备份轮换保留份数（门①：近 5 份；照 restore-claude-config.ps1 修-3 同族）。 */
export const BACKUP_KEEP = 5;

/** v2 模板表（问3 模板三件套的最小服务端内置版；波③ core 化时迁移至共享包）。
 * 模板非敏感（base_url/model/占位符提示），无鉴权可读。deepseek 等只留接口不实测（范围纪律）。 */
const TEMPLATES = [
  { id: 'bigmodel', label: 'bigmodel 直连（glm）', base_url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3-flash', key_placeholder: '在 bigmodel 控制台生成的 API Key', deployed: true },
  { id: 'deepseek', label: 'deepseek 直连（候批模板）', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', key_placeholder: 'deepseek 平台 API Key', deployed: false },
] as const;

export function listTemplates(): Array<{ id: string; label: string; base_url: string; model: string; key_placeholder: string; deployed: boolean }> {
  return TEMPLATES.map((t) => ({ ...t }));
}

interface SettingsDoc {
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

function readSettings(path: string): { raw: string; doc: SettingsDoc } | { error: string } {
  if (!existsSync(path)) return { raw: '', doc: {} };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return { error: `无法读取设置文件：${err instanceof Error ? err.message : String(err)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // 坏 JSON=拒绝写入不覆盖（人话报错附路径）——写坏配置文件比不写更糟
    return { error: `设置文件内容不是有效的 JSON，已拒绝写入以免覆盖（文件：${path}）。请先手工修复该文件。` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { error: `设置文件顶层不是对象，已拒绝写入（文件：${path}）。` };
  }
  return { raw, doc: doc as SettingsDoc };
}

function tokenMaskedFrom(doc: SettingsDoc): string | null {
  const env = doc.env ?? {};
  const token = typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN
    : typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : '';
  return token ? maskKey(token) : null;
}

function adminOk(authHeader: string | undefined): boolean {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  return Boolean(adminToken) && authHeader === `Bearer ${adminToken}`;
}

/** v2 门③：凭据健康门（fail-closed）——PLACEHOLDER/空串/纯空白 三态全拒（照 ps1 修-1 同族）。
 * 返回 null=通过；字符串=人话拒因。 */
export function credentialGate(apiKey: string): string | null {
  if (apiKey.trim() === '') return 'API 密钥为空或纯空白，已拒绝写入';
  if (/PLACEHOLDER/.test(apiKey)) return '检测到占位符（PLACEHOLDER 残留），请输入真实密钥';
  if (apiKey.length < 16) return 'API 密钥长度不足（至少 16 位），请核对后重填';
  return null;
}

function requireAdmin(authHeader: string | undefined): { statusCode: number; body: Record<string, unknown> } | null {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: '兜底写入未启用：请先在服务端配置管理令牌' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: '令牌不正确或未填写，请检查连接设置' } };
  }
  return null;
}

interface RestoreInput {
  base_url?: unknown;
  api_key?: unknown;
  model?: unknown;
}

function parseRestoreInput(rawBody: string | undefined): { input: RestoreInput } | { error: { statusCode: number; body: Record<string, unknown> } } {
  let input: RestoreInput;
  try {
    input = rawBody ? (JSON.parse(rawBody) as RestoreInput) : {};
  } catch (err) {
    return { error: { statusCode: 400, body: { error: `请求内容不是有效的 JSON：${err instanceof Error ? err.message : String(err)}` } } };
  }
  return { input };
}

/** v2 三值规范化+门③健康门+地址/模型格式校验（restore/preview/inject 共用）。 */
function validateTriplet(input: RestoreInput): { baseUrl: string; apiKey: string; model: string } | { error: { statusCode: number; body: Record<string, unknown> } } {
  const baseUrl = typeof input.base_url === 'string' ? input.base_url.trim() : '';
  const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!baseUrl) return { error: { statusCode: 400, body: { error: '请填写服务地址' } } };
  if (!/^https?:\/\/.+/i.test(baseUrl)) return { error: { statusCode: 400, body: { error: '服务地址需以 http:// 或 https:// 开头' } } };
  const gate = credentialGate(apiKey);
  if (gate) return { error: { statusCode: 400, body: { error: gate } } };
  if (!model) return { error: { statusCode: 400, body: { error: '请填写模型名称' } } };
  return { baseUrl, apiKey, model };
}

/** v2 diff 计算（门④预览）：env 子集逐键 before/after（凭据 len-only，掩码红线）。 */
function envSubsetDiff(prevEnv: Record<string, unknown>, baseUrl: string, apiKey: string, model: string, hasApiKeyCarrier: boolean): Array<Record<string, unknown>> {
  const target: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ...(hasApiKeyCarrier ? { ANTHROPIC_API_KEY: apiKey } : {}),
    ...Object.fromEntries(MODEL_TIER_KEYS.map((k) => [k, model])),
  };
  const credential = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  return Object.entries(target).map(([key, after]) => {
    const before = prevEnv[key];
    const changed = before !== after;
    const isCred = credential.has(key);
    // len 取 code-point 数（Array.from，与 [...str] 等价；lint no-misused-spread 合规形）
    return {
      key,
      changed,
      before: isCred ? (typeof before === 'string' && before ? `len=${String(Array.from(before).length)}` : null) : (before ?? null),
      after: isCred ? `len=${String(Array.from(after).length)}` : after,
    };
  });
}

/** v2 门①备份轮换：保留近 5 份（mtime 降序），FROZEN-BACKUPS 哨兵豁免（防回滚锚被轮换自毁）。 */
export function rotateBackups(path: string): { rotated: boolean; removed: number } {
  const sentinel = join(dirname(path), 'FROZEN-BACKUPS');
  if (existsSync(sentinel)) return { rotated: false, removed: 0 };
  const dir = dirname(path);
  let baks: Array<{ p: string; m: number }> = [];
  try {
    baks = readdirSync(dir)
      .map((f) => join(dir, f))
      .filter((p) => p.startsWith(`${path}.bak-`))
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch { return { rotated: false, removed: 0 }; }
  let removed = 0;
  for (const old of baks.slice(BACKUP_KEEP)) {
    try { unlinkSync(old.p); removed += 1; } catch { /* 单个删除失败不阻塞 */ }
  }
  return { rotated: true, removed };
}

/** v2 门④：写后回读断言——重读 parse+逐键比对（非空+与提交一致+JSON 合法）。 */
function verifyWritten(
  path: string,
  expected: { baseUrl: string; apiKey: string; model: string; hasApiKeyCarrier: boolean },
): { ok: true } | { ok: false; why: string } {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch (err) {
    return { ok: false, why: `写后回读失败（无法读取）：${err instanceof Error ? err.message : String(err)}` };
  }
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch {
    return { ok: false, why: '写后回读失败（JSON 不合法）' };
  }
  const env = (doc as SettingsDoc).env ?? {};
  const checks: Array<[string, unknown, unknown]> = [
    ['ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL, expected.baseUrl],
    ['ANTHROPIC_AUTH_TOKEN', env.ANTHROPIC_AUTH_TOKEN, expected.apiKey],
    ...(expected.hasApiKeyCarrier ? [['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY, expected.apiKey] as [string, unknown, unknown]] : []),
    ...MODEL_TIER_KEYS.map((k) => [k, env[k], expected.model] as [string, unknown, unknown]),
  ];
  for (const [key, actual, want] of checks) {
    if (typeof actual === 'string' && actual.trim() === '') return { ok: false, why: `写后回读断言失败：${key} 为空` };
    if (actual !== want) return { ok: false, why: `写后回读断言失败：${key} 与提交值不一致` };
  }
  return { ok: true };
}

/** v2 五门写入内核（restore/inject-key 共用；门①③④⑤在此一处落地）。
 * opts.dryRun=preview 形态（零写，返回 diff）。 */
function writeEnvSubset(
  who: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  opts?: { settingsPath?: string; dryRun?: boolean },
): { statusCode: number; body: Record<string, unknown> } {
  const path = opts?.settingsPath ?? settingsPath();
  const read = readSettings(path);
  if ('error' in read) {
    appendAudit({ who, mode: 'restore', backup: 'none', assert: 'n/a', result: 'error', detail: 'pre-parse-failed' });
    return { statusCode: 400, body: { error: read.error } };
  }
  const fileExisted = existsSync(path);
  const doc = read.doc;
  const prevEnv: Record<string, unknown> = doc.env ?? {};
  const hasApiKeyCarrier = 'ANTHROPIC_API_KEY' in prevEnv;

  // 门① 幂等短路：三值已全等（地址+密钥+模型档位全族）+ 凭据键族一致（F-1）→ 明示不重写
  const alreadySame = prevEnv.ANTHROPIC_BASE_URL === baseUrl
    && prevEnv.ANTHROPIC_AUTH_TOKEN === apiKey
    && MODEL_TIER_KEYS.every((k) => prevEnv[k] === model)
    && (!hasApiKeyCarrier || prevEnv.ANTHROPIC_API_KEY === apiKey);
  const diff = envSubsetDiff(prevEnv, baseUrl, apiKey, model, hasApiKeyCarrier);
  if (alreadySame) {
    appendAudit({ who, mode: 'restore', backup: 'none', assert: 'n/a', result: 'ok', detail: 'idempotent-short-circuit' });
    return {
      statusCode: 200,
      body: {
        ok: true,
        restored: { base_url: baseUrl, model, already_same: true, file_created: false, backup: null },
        diff,
        message: '当前已是指定值（' + baseUrl + ' · ' + model + '），无需重写。重启会话后生效。',
      },
    };
  }

  if (opts?.dryRun) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        dry_run: true,
        file_present: fileExisted,
        diff,
        message: '预览（零写入）：以上为将写入的 env 子集变更，凭据仅显示长度。',
      },
    };
  }

  // 门① 备份先行（存在才备份）——回滚锚
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath: string | null = null;
  if (fileExisted) {
    backupPath = `${path}.bak-${ts}`;
    try {
      copyFileSync(path, backupPath);
    } catch (err) {
      appendAudit({ who, mode: 'restore', backup: 'none', assert: 'n/a', result: 'error', detail: 'backup-failed' });
      return { statusCode: 500, body: { error: `备份设置文件失败，已中止写入：${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  // 门② 键名服务端锁定：写入键族=服务端常量，客户端只传三值
  doc.env = {
    ...prevEnv,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  for (const k of MODEL_TIER_KEYS) doc.env[k] = model;
  // F-1：既有 API_KEY 载体存在 → 同写同值（消灭残留旧密钥；应急语义两载体都通）
  if (hasApiKeyCarrier) doc.env.ANTHROPIC_API_KEY = apiKey;

  // 原子落盘（序列化沿用现役格式：2 空格缩进；尾换行随原文件）
  const trailing = read.raw.endsWith('\n') ? '\n' : '';
  const out = JSON.stringify(doc, null, 2) + trailing;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, out, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    appendAudit({ who, mode: 'restore', backup: backupPath ?? 'none', assert: 'n/a', result: 'error', detail: 'write-failed' });
    return { statusCode: 500, body: { error: `写入设置文件失败：${err instanceof Error ? err.message : String(err)}` } };
  }

  // 门④ 写后回读断言；失败=自动回滚（本次备份拷回）+ fail-closed 报错
  const verdict = verifyWritten(path, { baseUrl, apiKey, model, hasApiKeyCarrier });
  if (!verdict.ok) {
    if (backupPath) {
      try { copyFileSync(backupPath, path); } catch { /* 回滚失败也要如实报 */ }
    }
    appendAudit({ who, mode: 'restore', backup: backupPath ?? 'none', assert: 'fail', result: 'rolled-back', detail: `len-only keys=${diff.length}` });
    return {
      statusCode: 500,
      body: {
        error: `写后回读断言失败，已自动回滚（${verdict.why}）。配置文件已恢复为写入前状态，未生效任何变更。`,
        rolled_back: true,
        backup: backupPath,
      },
    };
  }

  // 门① 备份轮换（写入成功后才轮换，防回滚锚先丢）
  const rotation = rotateBackups(path);
  appendAudit({ who, mode: 'restore', backup: backupPath ?? 'new-file', assert: 'pass', result: 'ok', detail: `keys=${diff.length} rotation_removed=${rotation.removed}` });
  return {
    statusCode: 200,
    body: {
      ok: true,
      restored: {
        base_url: baseUrl,
        model,
        keys_written: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...(hasApiKeyCarrier ? ['ANTHROPIC_API_KEY'] : []), ...MODEL_TIER_KEYS],
        file_created: !fileExisted,
        backup: backupPath,
        already_same: false,
      },
      diff,
      message: `${fileExisted ? '' : '已新建设置文件；'}兜底直连已写入（${baseUrl} · ${model}）。重启会话后生效。`,
    },
  };
}

/**
 * GET — 无鉴权读现状（地址+模型）；管理令牌正确时附密钥尾 4 位。
 * 文件缺失/坏 JSON=空值返回（读面不炸，写面才拒）。
 */
export function handleGetClaudeFallback(
  authHeader?: string,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const path = opts?.settingsPath ?? settingsPath();
  const read = readSettings(path);
  if ('error' in read) {
    return { statusCode: 200, body: { object: 'config.claude-fallback', file_present: true, readable: false, base_url: null, model: null } };
  }
  const env = read.doc.env ?? {};
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : null;
  const model = typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL : null;
  const body: Record<string, unknown> = {
    object: 'config.claude-fallback',
    file_present: existsSync(path),
    readable: true,
    base_url: baseUrl,
    model,
  };
  // 密钥尾 4 位仅在管理令牌正确时附（错误/缺失令牌=等同无令牌，不给敏感位）
  if (adminOk(authHeader)) {
    const masked = tokenMaskedFrom(read.doc);
    if (masked) body.api_key_masked = masked;
  }
  return { statusCode: 200, body };
}

/**
 * POST restore — 手填三值直写 settings.json env 子集（管理令牌 fail-closed）。
 * 值 verbatim（直连语义，零代理/relay 改写）；其余字段保留；五门全量（见头注）。
 */
export function handlePostClaudeFallbackRestore(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const gate = requireAdmin(authHeader);
  if (gate) return gate;
  const parsed = parseRestoreInput(rawBody);
  if ('error' in parsed) return parsed.error;
  const triplet = validateTriplet(parsed.input);
  if ('error' in triplet) return triplet.error;
  return writeEnvSubset('ui-restore', triplet.baseUrl, triplet.apiKey, triplet.model, opts);
}

/** v2 POST preview — 零写 diff 预览（门④「diff 预览确认」的服务端半边；管理令牌 fail-closed）。 */
export function handlePostClaudeFallbackPreview(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const gate = requireAdmin(authHeader);
  if (gate) return gate;
  const parsed = parseRestoreInput(rawBody);
  if ('error' in parsed) return parsed.error;
  const triplet = validateTriplet(parsed.input);
  if ('error' in triplet) return triplet.error;
  return writeEnvSubset('ui-preview', triplet.baseUrl, triplet.apiKey, triplet.model, { ...opts, dryRun: true });
}

/** v2 GET backups — 备份清单（文件名/时间/大小；管理令牌 fail-closed；零内容返回）。 */
export function handleGetClaudeFallbackBackups(
  authHeader: string | undefined,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const gate = requireAdmin(authHeader);
  if (gate) return gate;
  const path = opts?.settingsPath ?? settingsPath();
  const dir = dirname(path);
  const list: Array<Record<string, unknown>> = [];
  try {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (!full.startsWith(`${path}.bak-`)) continue;
      const st = statSync(full);
      list.push({ file: f, mtime: st.mtime.toISOString(), size: st.size });
    }
  } catch { /* 目录不可读=空清单 */ }
  list.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return {
    statusCode: 200,
    body: {
      object: 'config.claude-fallback.backups',
      settings_file: path,
      sentinel: existsSync(join(dir, 'FROZEN-BACKUPS')),
      keep: BACKUP_KEEP,
      backups: list,
    },
  };
}

/** v2 POST rollback — 一键回滚（管理令牌 fail-closed；回滚前自动备份当前态=回滚可逆）。 */
export function handlePostClaudeFallbackRollback(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const gate = requireAdmin(authHeader);
  if (gate) return gate;
  let input: { backup?: unknown };
  try { input = rawBody ? (JSON.parse(rawBody) as typeof input) : {}; } catch {
    return { statusCode: 400, body: { error: '请求内容不是有效的 JSON' } };
  }
  const backupFile = typeof input.backup === 'string' ? input.backup.trim() : '';
  if (!/^settings\.json\.bak-[0-9A-Za-z:\-.]+$/.test(backupFile)) {
    return { statusCode: 400, body: { error: '备份文件名格式不正确（须为 settings.json.bak-<时间戳> 清单内条目）' } };
  }
  const path = opts?.settingsPath ?? settingsPath();
  const backupPath = resolve(dirname(path), backupFile);
  // 路径穿越防线：解析后必须仍位于 settings 同目录
  if (!backupPath.startsWith(resolve(dirname(path)) + sep)) {
    return { statusCode: 400, body: { error: '备份路径越界，已拒绝' } };
  }
  if (!existsSync(backupPath)) {
    return { statusCode: 404, body: { error: `备份不存在或已被轮换清理（${backupFile}）。可先查看备份清单另选条目。` } };
  }
  // 门④ 同款：回滚前先读目标备份确认 JSON 合法（不把坏备份拷成现役）
  const probe = readSettings(backupPath);
  if ('error' in probe) {
    appendAudit({ who: 'ui-rollback', mode: 'rollback', backup: backupFile, assert: 'n/a', result: 'error', detail: 'backup-corrupt' });
    return { statusCode: 400, body: { error: `该备份内容不是有效的 JSON，已拒绝回滚：${probe.error}` } };
  }
  // 回滚也是写：先把当前态备份（回滚可逆），再拷入目标备份
  let preRollbackBackup: string | null = null;
  if (existsSync(path)) {
    preRollbackBackup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { copyFileSync(path, preRollbackBackup); } catch (err) {
      appendAudit({ who: 'ui-rollback', mode: 'rollback', backup: backupFile, assert: 'n/a', result: 'error', detail: 'pre-backup-failed' });
      return { statusCode: 500, body: { error: `回滚前备份当前配置失败，已中止回滚：${err instanceof Error ? err.message : String(err)}` } };
    }
  }
  try { copyFileSync(backupPath, path); } catch (err) {
    appendAudit({ who: 'ui-rollback', mode: 'rollback', backup: backupFile, assert: 'n/a', result: 'error', detail: 'copy-failed' });
    return { statusCode: 500, body: { error: `回滚拷贝失败：${err instanceof Error ? err.message : String(err)}` } };
  }
  // 门④：回滚后回读断言（JSON 合法+可解析）
  const after = readSettings(path);
  if ('error' in after) {
    if (preRollbackBackup) { try { copyFileSync(preRollbackBackup, path); } catch { /* 如实报 */ } }
    appendAudit({ who: 'ui-rollback', mode: 'rollback', backup: backupFile, assert: 'fail', result: 'rolled-back-again', detail: 'post-verify-failed' });
    return { statusCode: 500, body: { error: '回滚后回读断言失败，已恢复回滚前状态。请检查该备份文件。' } };
  }
  const rotation = rotateBackups(path);
  appendAudit({ who: 'ui-rollback', mode: 'rollback', backup: backupFile, assert: 'pass', result: 'ok', detail: `pre_rollback_backup=${preRollbackBackup ? 'created' : 'none'} rotation_removed=${rotation.removed}` });
  return {
    statusCode: 200,
    body: {
      ok: true,
      rolled_back_to: backupFile,
      pre_rollback_backup: preRollbackBackup,
      message: '已回滚到所选备份。重启会话后生效。',
    },
  };
}

/** v2 POST inject-key — 服务端读独立钥文件按模板直写（管理令牌 fail-closed；钥值不过响应体）。
 * body 可选 { template: '<id>' }（缺省 bigmodel）；base_url/model 由服务端模板表提供（门②同源）。 */
export function handlePostClaudeFallbackInjectKey(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { settingsPath?: string; deployKeyPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const gate = requireAdmin(authHeader);
  if (gate) return gate;
  let templateId = 'bigmodel';
  if (rawBody) {
    try {
      const input = JSON.parse(rawBody) as { template?: unknown };
      if (typeof input.template === 'string' && input.template.trim()) templateId = input.template.trim();
    } catch {
      return { statusCode: 400, body: { error: '请求内容不是有效的 JSON' } };
    }
  }
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return { statusCode: 400, body: { error: `未知模板（${templateId}）。可用模板：${TEMPLATES.map((t) => t.id).join('、')}` } };
  if (!tpl.deployed) return { statusCode: 400, body: { error: `模板 ${tpl.id} 尚未启用（候批模板，暂不可注入）` } };
  const keyPath = opts?.deployKeyPath ?? deployKeyPath();
  let key = '';
  try {
    key = readFileSync(keyPath, 'utf-8').trim();
  } catch {
    appendAudit({ who: 'ui-inject', mode: 'restore', backup: 'none', assert: 'n/a', result: 'error', detail: 'deploy-key-missing' });
    return { statusCode: 422, body: { error: `独立钥文件未落位（${keyPath}）。请先完成部署日供钥步骤，或改用手填密钥。` } };
  }
  if (!key) {
    appendAudit({ who: 'ui-inject', mode: 'restore', backup: 'none', assert: 'n/a', result: 'error', detail: 'deploy-key-empty' });
    return { statusCode: 422, body: { error: '独立钥文件存在但内容为空，已拒绝写入（fail-closed）。请重新落位钥文件。' } };
  }
  const gateCheck = credentialGate(key);
  if (gateCheck) {
    appendAudit({ who: 'ui-inject', mode: 'restore', backup: 'none', assert: 'n/a', result: 'error', detail: 'deploy-key-gate-fail' });
    return { statusCode: 422, body: { error: `独立钥文件内容未通过健康门：${gateCheck}` } };
  }
  return writeEnvSubset('ui-inject', tpl.base_url, key, tpl.model, opts);
}
