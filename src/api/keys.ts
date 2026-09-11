// ── TriModel API: Key distribution endpoints ──
// GET /v1/config/keys — Returns provider keys for client consumption
// POST /v1/config/keys/refresh — Admin-only force refresh of key cache
// PUT /v1/config/keys/secure — Write one provider key → keys.enc (LG-035 P2 B)
// GET /v1/config/keys/secure/status — provider name list + masked tails only
// (NO GET /v1/config/keys/secure: plaintext never leaves the server.)
import { effectiveModel } from '../policy.js';
import { recordModelTransitionIfChanged } from '../transition.js';
import { KNOWN_PROVIDERS, maskKey, readSecureKeys, upsertSecureKey } from '../secure-keys.js';

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
 * Read provider keys: env vars first, then keys.enc overlay (LG-035 P2 B).
 * keys.enc present ⇒ same-name provider entries OVERRIDE the env L1 keys;
 * .env remains the bootstrap fallback when keys.enc is absent. A broken
 * keystore degrades to env keys (fail-safe family, see secure-keys.ts).
 */
function readKeys(keystorePath?: string): Record<string, ProviderKey> {
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

  // keys.enc overlay (P2 B): same-name providers override env keys
  const secure = readSecureKeys(keystorePath);
  if (secure) {
    for (const [provider, entry] of Object.entries(secure.providers)) {
      keys[provider] = {
        api_key: entry.api_key,
        ...(entry.base_url ? { base_url: entry.base_url } : {}),
      };
    }
  }

  return keys;
}

// ── LG-035 P2 B: secure write plane ──
// QB1 (CTO 2026-09-11): admin plane is FAIL-CLOSED — governed by its own
// TRIMODEL_ADMIN_TOKEN; unset ⇒ 503 disabled (write plane off by default),
// set ⇒ Bearer strict check. Distinct from the keys-read TRIMODEL_API_TOKEN.

interface SecureKeyPutBody {
  provider?: unknown;
  api_key?: unknown;
  base_url?: unknown;
}

export function handlePutSecureKeys(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { keystorePath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: 'secure key write plane disabled: TRIMODEL_ADMIN_TOKEN not configured (fail-closed)' } };
  }
  const authError = requireBearer(adminToken, authHeader);
  if (authError) return authError;

  if (rawBody === undefined || rawBody.trim() === '') {
    return { statusCode: 400, body: { error: 'request body required (JSON provider key document)' } };
  }
  let doc: SecureKeyPutBody;
  try {
    doc = JSON.parse(rawBody) as SecureKeyPutBody;
  } catch (err) {
    return { statusCode: 400, body: { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }

  const provider = typeof doc.provider === 'string' ? doc.provider : '';
  const apiKey = typeof doc.api_key === 'string' ? doc.api_key : '';
  const baseUrl = typeof doc.base_url === 'string' && doc.base_url.length > 0 ? doc.base_url : undefined;
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    return { statusCode: 400, body: { error: `provider must be one of: ${KNOWN_PROVIDERS.join(', ')}` } };
  }
  if (!apiKey) {
    return { statusCode: 400, body: { error: 'api_key must be a non-empty string' } };
  }
  // F1-P2 (CTO 2026-09-11): masked-tail values ('****xxxx') must never be
  // stored as real keys — depth-in-depth guard against echo pollution
  // (user pastes the masked display back into the form → silent bad key).
  if (apiKey.includes('*') || (baseUrl !== undefined && baseUrl.includes('*'))) {
    return { statusCode: 400, body: { error: 'masked value rejected — 疑似回显污染：masked 尾 4 位展示值不是真实密钥，请填入完整原始键' } };
  }

  try {
    upsertSecureKey(provider, apiKey, baseUrl, opts?.keystorePath);
  } catch (err) {
    return { statusCode: 500, body: { error: `failed to persist keys.enc: ${err instanceof Error ? err.message : String(err)}` } };
  }
  // Masked tail only — plaintext never echoed back.
  return { statusCode: 200, body: { ok: true, provider, masked: maskKey(apiKey), base_url: baseUrl ?? null } };
}

export function handleSecureKeysStatus(
  authHeader: string | undefined,
  opts?: { keystorePath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: 'secure key plane disabled: TRIMODEL_ADMIN_TOKEN not configured (fail-closed)' } };
  }
  const authError = requireBearer(adminToken, authHeader);
  if (authError) return authError;

  const secure = readSecureKeys(opts?.keystorePath);
  const providers = secure
    ? Object.entries(secure.providers).map(([provider, entry]) => ({
        provider,
        masked: maskKey(entry.api_key),
        base_url: entry.base_url ?? null,
        updated_at: entry.updated_at,
      }))
    : [];
  return { statusCode: 200, body: { object: 'config.keys.secure.status', providers, keystore_present: secure !== null } };
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
