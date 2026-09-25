// ── TriModel API: Claude 直连兜底写入（2026-09-15 CEO 直令，任务书 W38/fallback-button）──
// ── v2 连接配置页（TASK-TRIMODEL-RECOVERY-LADDER-01 波①，2026-09-25）：写路径五门全量落地 ──
// ── v3 波③ core 化（2026-09-26）：五门内核剥离至 @trimetaverse/tricode trimodel-cli core，──
//    本文件降为薄 HTTP 壳（鉴权/路由映射/statusCode 语义留壳；写内核/模板真源/diff/审计装配走 core）。
//    壳语义零变锚=276 测套零修改回归 + f887b27 STE 25/25（派工单验收门①⑥；偏-2 503 分支挂账候办不进本波）。
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
// GET    /v1/config/claude-fallback/templates — v2：无鉴权只读（模板非敏感）；连接配置页模板表
//                                               （v3 起真源=TriCode core presets/，CLI 与 HTTP 同源——CTO 裁③）。
// POST   /v1/config/claude-fallback/inject-key— v2：管理令牌 fail-closed；服务端读独立钥文件
//                                               （.deploy-key）按模板直写——钥值全程不过响应体。
//
// 语义：TriModel 配置面不好用时的直连兜底通道——不依赖 TriModel 数据（卡/策略/引擎零触碰），
// 写后重启会话即直连。其余字段值级保留（序列化统一 2 空格缩进——逐字节仅幂等路径成立）；
// 密钥不回显。
//
// 写路径五门（joint-plan §问1，防线继承铁律全量继承）现由 core runWrite 承载：
// ① 备份先行＋轮换近 5 份＋FROZEN-BACKUPS 哨兵豁免＋幂等短路（无变化不写不备份）
// ② 键名服务端锁定（MODEL_TIER_KEYS 9 键族服务端硬编码，客户端只传三值）
// ③ 凭据健康门：PLACEHOLDER/空串/纯空白/短键 四态全拒 fail-closed
// ④ 写前整文档 parse＋diff 预览确认＋写后回读断言（非空＋与提交一致＋JSON 合法）失败自动回滚
// ⑤ 掩码红线（len-only 日志／GET 回读 masked 尾4／响应零钥值）＋结构化审计行（who/when/mode/备份/断言）
//
// 凭据键族（F-1）：AUTH_TOKEN 为主载体；既有迁移/手配机可能以 API_KEY 为载体——
// 检测到存在即同写同值（应急语义=消灭一切残留旧密钥）。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendAudit as coreAppendAudit,
  findPreset,
  listBackups,
  loadPresets,
  makeCoreIO,
  readDeployKey,
  readSettings,
  rollbackTo,
  runWrite,
  tokenMaskedFrom,
  validateTriplet,
  defaultPresetsDir,
  type CoreIO,
  type WriteOutcome,
} from '@trimetaverse/tricode/trimodel-cli';

// 五门内核公共件（测试导入面+壳内使用；实现真源=TriCode core，版本锁定纪律见 package.json）
export {
  BACKUP_KEEP,
  MODEL_TIER_KEYS,
  credentialGate,
  rotateBackups,
} from '@trimetaverse/tricode/trimodel-cli';

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

/** v3 审计行（门⑤）壳侧包装：行格式与落点解析在 core（appendAudit），落点解析随壳 env。 */
export function appendAudit(fields: Record<string, string>): void {
  coreAppendAudit(auditLogPath(), fields);
}

/** v3 模板表：真源=TriCode core presets/（CTO 裁③ 单一真源——HTTP 下拉与 CLI restore-direct
 * 同源；内置 TEMPLATES 常量随 v3 删除）。模板非敏感，无鉴权可读。 */
export function listTemplates(): Array<{ id: string; label: string; base_url: string; model: string; key_placeholder: string; deployed: boolean }> {
  return loadPresets(defaultPresetsDir()).presets.map((p) => ({ ...p }));
}

function adminOk(authHeader: string | undefined): boolean {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  return Boolean(adminToken) && authHeader === `Bearer ${adminToken}`;
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

/** v3 壳侧三元校验包装：三值校验真源=core validateTriplet（健康门/格式门同源）。 */
function validateTripletOr400(input: RestoreInput): { baseUrl: string; apiKey: string; model: string } | { error: { statusCode: number; body: Record<string, unknown> } } {
  const triplet = validateTriplet(input);
  if ('error' in triplet) return { error: { statusCode: 400, body: { error: triplet.error } } };
  return triplet;
}

/** v3 CoreIO 壳侧装配：写内核所需的仓/服务特有项由壳注入（core 零仓感知）。 */
function buildIO(who: string, opts?: { settingsPath?: string; deployKeyPath?: string }): CoreIO {
  return makeCoreIO({
    settingsPath: opts?.settingsPath ?? settingsPath(),
    presetsDir: defaultPresetsDir(),
    auditLogPath: auditLogPath(),
    who,
    deployKeyPathFor: () => ({ path: opts?.deployKeyPath ?? deployKeyPath(), source: 'legacy' }),
  });
}

/** v3 WriteOutcome→HTTP 映射（壳语义：statusCode 留壳；body 字段族与 v2 逐字等价）。 */
function outcomeToHttp(outcome: WriteOutcome): { statusCode: number; body: Record<string, unknown> } {
  if (outcome.ok) {
    return { statusCode: 200, body: { ok: true, ...outcome.data, message: outcome.message } };
  }
  if (outcome.code === 'SETTINGS_UNREADABLE') return { statusCode: 400, body: { error: outcome.message } };
  if (outcome.code === 'WRITE_FAILED_ROLLED_BACK') {
    return { statusCode: 500, body: { error: outcome.message, ...outcome.data } };
  }
  return { statusCode: 500, body: { error: outcome.message } };
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
 * 值 verbatim（直连语义，零代理/relay 改写）；其余字段保留；五门全量（core runWrite 承载）。
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
  const triplet = validateTripletOr400(parsed.input);
  if ('error' in triplet) return triplet.error;
  return outcomeToHttp(runWrite({ baseUrl: triplet.baseUrl, apiKey: triplet.apiKey, model: triplet.model }, buildIO('ui-restore', opts)));
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
  const triplet = validateTripletOr400(parsed.input);
  if ('error' in triplet) return triplet.error;
  return outcomeToHttp(runWrite({ baseUrl: triplet.baseUrl, apiKey: triplet.apiKey, model: triplet.model, dryRun: true }, buildIO('ui-preview', opts)));
}

/** v2 GET backups — 备份清单（文件名/时间/大小；管理令牌 fail-closed；零内容返回）。 */
export function handleGetClaudeFallbackBackups(
  authHeader: string | undefined,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const gate = requireAdmin(authHeader);
  if (gate) return gate;
  const path = opts?.settingsPath ?? settingsPath();
  const bl = listBackups(path);
  return {
    statusCode: 200,
    body: {
      object: 'config.claude-fallback.backups',
      settings_file: bl.settingsFile,
      sentinel: bl.sentinel,
      keep: bl.keep,
      backups: bl.backups,
    },
  };
}

/** v2 POST rollback — 一键回滚（管理令牌 fail-closed；回滚前自动备份当前态=回滚可逆）。
 * 内核=core rollbackTo（含路径穿越/坏备份/回滚后断言防线）；壳只做 400/404/500 分型映射。 */
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
  const outcome = rollbackTo({ backupFile, who: 'ui-rollback' }, buildIO('ui-rollback', opts));
  if (outcome.ok) {
    return { statusCode: 200, body: { ok: true, ...outcome.data, message: outcome.message } };
  }
  if ((outcome.data as { not_found?: boolean }).not_found) {
    return { statusCode: 404, body: { error: outcome.message } };
  }
  if (outcome.code === 'INVALID_INPUT') {
    return { statusCode: 400, body: { error: outcome.message } };
  }
  return { statusCode: 500, body: { error: outcome.message } };
}

/** v2 POST inject-key — 服务端读独立钥文件按模板直写（管理令牌 fail-closed；钥值不过响应体）。
 * body 可选 { template: '<id>' }（缺省 bigmodel）；base_url/model 由服务端模板表提供（门②同源，
 * v3 起真源=TriCode core presets/）。 */
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
  const found = findPreset(defaultPresetsDir(), templateId);
  if ('unknown' in found) {
    return { statusCode: 400, body: { error: `未知模板（${templateId}）。可用模板：${found.available.join('、')}` } };
  }
  if (!found.preset.deployed) {
    return { statusCode: 400, body: { error: `模板 ${found.preset.id} 尚未启用（候批模板，暂不可注入）` } };
  }
  const io = buildIO('ui-inject', opts);
  const keyRes = readDeployKey(templateId, opts?.deployKeyPath);
  if ('failClosed' in keyRes) {
    const detail = keyRes.code === 'DEPLOY_KEY_MISSING' ? 'deploy-key-missing'
      : keyRes.code === 'DEPLOY_KEY_INVALID' ? 'deploy-key-empty' : 'deploy-key-gate-fail';
    appendAudit({ who: 'ui-inject', mode: 'restore', backup: 'none', assert: 'n/a', result: 'error', detail });
    return { statusCode: 422, body: { error: keyRes.message } };
  }
  return outcomeToHttp(runWrite({ baseUrl: found.preset.base_url, apiKey: keyRes.key, model: found.preset.model }, io));
}
