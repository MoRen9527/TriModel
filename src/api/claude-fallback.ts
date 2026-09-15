// ── TriModel API: Claude 直连兜底写入（2026-09-15 CEO 直令，任务书 W38/fallback-button）──
//
// GET  /v1/config/claude-fallback          — 无鉴权只读（loopback；照 runtime-info 先例）
//                                            返回 { base_url, model }；管理令牌正确时附密钥尾 4 位
// POST /v1/config/claude-fallback/restore  — 管理令牌 fail-closed（照卡片三件套）：
//                                            手填三值（地址/密钥/模型）直写本机
//                                            ~/.claude/settings.json 的 env 子集——
//                                            模型档位 9 键全族 verbatim 同值。
//
// 语义：TriModel 配置面不好用时的直连兜底通道——不依赖 TriModel 数据（卡/策略/引擎零触碰），
// 写后重启会话即直连。写前备份 settings.json.bak-<ts>；其余字段保留；密钥不回显。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { maskKey } from '../secure-keys.js';

/** 目标文件：服务端所宿机的 Claude Code 用户设置（env 明文 token 载体，设计如此）。
 * TRIMODEL_CLAUDE_SETTINGS 可钉位（照 D9 TRIMODEL_CARD_FILE 同族）——真链路测试
 * 用它指向临时文件，防误写真实用户设置。 */
export const SETTINGS_FILE_ENV = 'TRIMODEL_CLAUDE_SETTINGS';

export function settingsPath(): string {
  const env = process.env[SETTINGS_FILE_ENV]?.trim();
  if (env) return env;
  return join(homedir(), '.claude', 'settings.json');
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
 * 值 verbatim（直连语义，零代理/relay 改写）；其余字段保留；写前备份；原子落盘。
 */
export function handlePostClaudeFallbackRestore(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { settingsPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: '兜底写入未启用：请先在服务端配置管理令牌' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: '令牌不正确或未填写，请检查连接设置' } };
  }

  let input: { base_url?: unknown; api_key?: unknown; model?: unknown };
  try {
    input = rawBody ? (JSON.parse(rawBody) as typeof input) : {};
  } catch (err) {
    return { statusCode: 400, body: { error: `请求内容不是有效的 JSON：${err instanceof Error ? err.message : String(err)}` } };
  }

  const baseUrl = typeof input.base_url === 'string' ? input.base_url.trim() : '';
  const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!baseUrl) return { statusCode: 400, body: { error: '请填写服务地址' } };
  if (!/^https?:\/\/.+/i.test(baseUrl)) return { statusCode: 400, body: { error: '服务地址需以 http:// 或 https:// 开头' } };
  if (!apiKey) return { statusCode: 400, body: { error: '请填写 API 密钥' } };
  if (apiKey.length < 16) return { statusCode: 400, body: { error: 'API 密钥长度不足（至少 16 位），请核对后重填' } };
  if (!model) return { statusCode: 400, body: { error: '请填写模型名称' } };

  const path = opts?.settingsPath ?? settingsPath();
  const read = readSettings(path);
  if ('error' in read) return { statusCode: 400, body: { error: read.error } };
  const fileExisted = existsSync(path);
  const doc = read.doc;

  // 幂等：三值已全等（地址+密钥+模型档位全族）→ 明示「已是该值」不重写不备份
  const prevEnv = (doc.env ?? {}) as Record<string, unknown>;
  const alreadySame = prevEnv.ANTHROPIC_BASE_URL === baseUrl
    && prevEnv.ANTHROPIC_AUTH_TOKEN === apiKey
    && MODEL_TIER_KEYS.every((k) => prevEnv[k] === model);
  if (alreadySame) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        restored: { base_url: baseUrl, model, already_same: true, file_created: false, backup: null },
        message: '当前已是指定值（' + baseUrl + ' · ' + model + '），无需重写。重启会话后生效。',
      },
    };
  }

  // 备份（存在才备份；同目录 settings.json.bak-<ts>）——回滚锚
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath: string | null = null;
  if (fileExisted) {
    backupPath = `${path}.bak-${ts}`;
    try {
      copyFileSync(path, backupPath);
    } catch (err) {
      return { statusCode: 500, body: { error: `备份设置文件失败，已中止写入：${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  // env 子集写入（其余键逐字保留——展开既有 env 再覆写目标键）
  doc.env = {
    ...prevEnv,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  for (const k of MODEL_TIER_KEYS) doc.env[k] = model;

  // 序列化沿用现役格式（2 空格缩进；尾换行随原文件）——其余字段逐字保留
  const trailing = read.raw.endsWith('\n') ? '\n' : '';
  const out = JSON.stringify(doc, null, 2) + trailing;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, out, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    return { statusCode: 500, body: { error: `写入设置文件失败：${err instanceof Error ? err.message : String(err)}` } };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      restored: {
        base_url: baseUrl,
        model,
        keys_written: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...MODEL_TIER_KEYS],
        file_created: !fileExisted,
        backup: backupPath,
        already_same: false,
      },
      message: `${fileExisted ? '' : '已新建设置文件；'}兜底直连已写入（${baseUrl} · ${model}）。重启会话后生效。`,
    },
  };
}
