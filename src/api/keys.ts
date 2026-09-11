// ── TriModel API: Key distribution endpoints ──
// GET /v1/config/keys — Returns provider keys for client consumption
// POST /v1/config/keys/refresh — Admin-only force refresh of key cache
// PUT /v1/config/keys/secure — RETIRED (LG-035 S5): 410 Gone, keys live in
//   TriMMC card entries now (auto-migrated from keys.enc at boot).
// GET /v1/config/keys/secure/status — legacy-migration indicator.
import { effectiveModel } from '../policy.js';
import { recordModelTransitionIfChanged } from '../transition.js';
import { deriveProviderKeys } from '../key-source.js';
import { cardExists } from '../trimmc-card.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface ProviderKey {
  api_key: string;
  base_url?: string;
}

interface KeysResponse {
  object: string;
  keys: Record<string, ProviderKey>;
  default_model: string;
  refresh_interval_s: number;
  expires_at: string;
}

interface RefreshResponse {
  ok: boolean;
  refreshed_at: string;
  message: string;
}

const API_TOKEN = process.env.TRIMODEL_API_TOKEN ?? '';
// O-R3-1 (2026-08-13): keys API 报告的 default_model 同步 tmv-* 注册表
// （消费方 TriLC key-cache 会取此值，旧名 'deepseek-v4-pro' 与 C12/C13 后
// 生产注册表错配）。env TRIMODEL_DEFAULT_MODEL 覆盖仍优先。
// LG-035 P1 (2026-09-11): default_model 热链接入策略面——每次请求经
// effectiveModel() 逐请求求值（STE 勘误对齐：不做模块级常量冻结，PUT 后
// 下一次 GET 即得新值）；policy.json 命中窗口返回窗口模型，否则回落
// env default（loadPolicy 文件缺席=行为与旧值完全一致）。env fallback
// 求值逻辑归 src/policy.ts envDefaultModel()。
const REFRESH_INTERVAL_S = Number(process.env.TRIMODEL_KEY_REFRESH_INTERVAL_S ?? 900);

function computeExpiresAt(_unused: number): string {
  void _unused;
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Read provider keys (S5 归并读链): trimmc-card enabled entries derived per
 * vendor (latest updated_at) OVERRIDE env L1 keys; .env is the final
 * bootstrap fallback. keys.enc retired from the read chain (migrated at
 * boot). Fail-safe: card absent/corrupt → env (deriveProviderKeys).
 */
function readKeys(cardPath?: string): Record<string, ProviderKey> {
  const keys: Record<string, ProviderKey> = {};

  // L1: DeepSeek direct
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    keys['deepseek'] = {
      api_key: deepseekKey,
      base_url: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    };
  }

  // L1: Anthropic native (Phase 2)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    keys['anthropic'] = {
      api_key: anthropicKey,
      base_url: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    };
  }

  // L1: OpenAI native (Phase 2)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    keys['openai'] = {
      api_key: openaiKey,
      base_url: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
    };
  }

  // L2: TriMetaverse platform provider
  const trimetaverseKey = process.env.TRIMODEL_TRIMETAVERSE_API_KEY;
  if (trimetaverseKey) {
    keys['trimetaverse'] = {
      api_key: trimetaverseKey,
      base_url: process.env.TRIMODEL_TRISTACISS_BASE_URL ?? 'http://127.0.0.1:8008/v1',
    };
  }

  // keys.enc overlay retired (S5) — card entries derive over env instead.
  const derived = deriveProviderKeys(keys, cardPath);
  const merged: Record<string, ProviderKey> = {};
  for (const [provider, k] of Object.entries(derived)) {
    merged[provider] = { api_key: k.api_key, ...(k.base_url ? { base_url: k.base_url } : {}) };
  }

  return merged;
}

// ── LG-035 P2 B: secure write plane ──
// QB1 (CTO 2026-09-11): admin plane is FAIL-CLOSED — governed by its own
// TRIMODEL_ADMIN_TOKEN; unset ⇒ 503 disabled (write plane off by default),
// set ⇒ Bearer strict check. Distinct from the keys-read TRIMODEL_API_TOKEN.


export function handlePutSecureKeys(
  _authHeader: string | undefined,
  _rawBody: string | undefined,
  _opts?: { keystorePath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  // S5 退役（LG-035 UI 重设计）：410 Gone + 人话指引。密钥活源=TriMMC 卡条目
  // （keys.enc 已 boot 自动迁移）；sg 侧运维通道=条目表单录入。
  void _authHeader;
  void _rawBody;
  void _opts;
  return {
    statusCode: 410,
    body: { error: '此功能已升级：请在「模型信息」条目中录入密钥（旧密钥已在启动时自动迁移，无需重复录入）' },
  };
}

export function handleSecureKeysStatus(
  authHeader: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: '管理写面未启用：请先在服务端配置管理令牌' } };
  }
  const authError = requireBearer(adminToken, authHeader);
  if (authError) return authError;

  // S5: status = legacy migration indicator (keys.enc retired from read chain)
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const legacyPresent = existsSync(join(here, 'keys.enc'));
  const migratedPresent = existsSync(join(here, 'keys.enc.migrated'));
  const cardPresent = cardExists(opts?.cardPath ?? undefined);
  return {
    statusCode: 200,
    body: {
      object: 'config.keys.secure.status',
      legacy_present: legacyPresent,
      migrated: migratedPresent,
      card_present: cardPresent,
      message: legacyPresent
        ? '检测到旧密钥文件，将在服务重启时自动迁入模型条目'
        : migratedPresent
          ? '旧密钥已自动迁入「模型信息」条目'
          : '无旧密钥文件；密钥请在「模型信息」条目中录入',
    },
  };
}

function requireBearer(expected: string, authHeader: string | undefined): { statusCode: 401; body: { error: string } } | null {
  const bearer = `Bearer ${expected}`;
  if (!authHeader || authHeader !== bearer) {
    return { statusCode: 401, body: { error: 'Unauthorized: invalid or missing token' } };
  }
  return null;
}

export function handleGetKeys(authHeader: string | undefined): { statusCode: number; body: KeysResponse | { error: string } } {
  // 401: Missing or invalid auth
  if (!API_TOKEN) {
    return {
      statusCode: 401,
      body: { error: 'TRIMODEL_API_TOKEN not configured on server' },
    };
  }

  const expectedBearer = `Bearer ${API_TOKEN}`;
  if (!authHeader || authHeader !== expectedBearer) {
    return {
      statusCode: 401,
      body: { error: 'Unauthorized: invalid or missing API token' },
    };
  }

  const keys = readKeys();
  const effective = effectiveModel();
  // LG-035 P2 A (local half): record a transition when the effective model
  // changed since the last GET (value comparison, not per-tick). Model name
  // only — no key material ever enters this record (SEC red line).
  recordModelTransitionIfChanged(effective);
  return {
    statusCode: 200,
    body: {
      object: 'config.keys',
      keys,
      default_model: effective.model,
      refresh_interval_s: REFRESH_INTERVAL_S,
      expires_at: computeExpiresAt(REFRESH_INTERVAL_S),
    },
  };
}

export function handleRefreshKeys(authHeader: string | undefined): { statusCode: number; body: RefreshResponse | { error: string } } {
  if (!API_TOKEN) {
    return {
      statusCode: 401,
      body: { error: 'TRIMODEL_API_TOKEN not configured on server' },
    };
  }

  const expectedBearer = `Bearer ${API_TOKEN}`;
  if (!authHeader || authHeader !== expectedBearer) {
    return {
      statusCode: 401,
      body: { error: 'Unauthorized: invalid or missing API token' },
    };
  }

  // TM-R-003: Actually re-read environment variables on refresh
  // Phase 2: triggers Secret Manager reload (currently env var re-read)
  const keys = readKeys();
  console.log(`[trimodel] keys refreshed: ${String(Object.keys(keys).length)} providers`);

  return {
    statusCode: 200,
    body: {
      ok: true,
      refreshed_at: new Date().toISOString(),
      message: `Key cache refreshed (${String(Object.keys(keys).length)} providers); clients will receive updated keys on next pull`,
    },
  };
}
