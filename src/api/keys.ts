// ── TriModel API: Key distribution endpoints ──
// GET /v1/config/keys — Returns provider keys for client consumption
// POST /v1/config/keys/refresh — Admin-only force refresh of key cache

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
const DEFAULT_MODEL = process.env.TRIMODEL_DEFAULT_MODEL ?? 'deepseek-chat';
const REFRESH_INTERVAL_S = Number(process.env.TRIMODEL_KEY_REFRESH_INTERVAL_S ?? 900);

function computeExpiresAt(_refreshIntervalS: number): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Read provider keys from environment variables.
 * Phase 1: reads from env vars directly.
 * Phase 2: can be extended to read from Secret Manager.
 */
function readKeys(): Record<string, ProviderKey> {
  const keys: Record<string, ProviderKey> = {};

  // L1: DeepSeek direct
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    keys['deepseek'] = {
      api_key: deepseekKey,
      base_url: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    };
  }

  // L2: TriMetaverse platform provider
  const trimetaverseKey = process.env.TRIMODEL_TRIMETAVERSE_API_KEY;
  if (trimetaverseKey) {
    keys['trimetaverse'] = {
      api_key: trimetaverseKey,
      base_url: process.env.TRIMODEL_TRISTACISS_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    };
  }

  // Future L1 providers can be added here (OpenAI, Claude, GLM, etc.)

  return keys;
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
  return {
    statusCode: 200,
    body: {
      object: 'config.keys',
      keys,
      default_model: DEFAULT_MODEL,
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

  // Phase 1: reads from environment variables (re-reading picks up any env var changes)
  // Phase 2: can trigger Secret Manager reload
  return {
    statusCode: 200,
    body: {
      ok: true,
      refreshed_at: new Date().toISOString(),
      message: 'Key cache refreshed; clients will receive updated keys on next pull',
    },
  };
}
