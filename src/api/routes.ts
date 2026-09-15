// ── TriModel API: Route dispatcher ──
// Maps URL paths to handlers. Configuration-plane only (no chat proxy).
import type { ModelClient } from '../client.js';
import { handleHealth } from './health.js';
import { handleModels } from './models.js';
import { handleGetKeys, handleRefreshKeys, handlePutSecureKeys, handleSecureKeysStatus } from './keys.js';
import { handleGetTrimmcCard, handlePutTrimmcCard, handlePutTrimmcCardStatus, handleApplyStrategy } from './trimmc-card.js';
import { handleRuntimeInfo } from './runtime-info.js';
import { handleGetClaudeFallback, handlePostClaudeFallbackRestore } from './claude-fallback.js';
import { handleGetPolicy, handlePutPolicy } from './policy.js';

export type RouteResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
};

export async function dispatch(
  client: ModelClient,
  method: string,
  url: string,
  headers: Record<string, string>,
  rawBody?: string,
): Promise<RouteResult> {
  const jsonHeaders = { 'content-type': 'application/json' };

  // GET /health
  if (url === '/health' && method === 'GET') {
    const result = await handleHealth(client);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // GET /v1/models
  if (url === '/v1/models' && method === 'GET') {
    const result = handleModels(client);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // GET /v1/config/keys
  if (url === '/v1/config/keys' && method === 'GET') {
    const auth = headers['authorization'];
    const result = handleGetKeys(auth);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // POST /v1/config/keys/refresh
  if (url === '/v1/config/keys/refresh' && method === 'POST') {
    const auth = headers['authorization'];
    const result = handleRefreshKeys(auth);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // PUT /v1/config/keys/secure — Bearer-protected provider key write (P2 B);
  // no GET counterpart exists by design (no plaintext read-back).
  if (url === '/v1/config/keys/secure' && method === 'PUT') {
    const auth = headers['authorization'];
    const result = handlePutSecureKeys(auth, rawBody);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // GET /v1/config/keys/secure/status — masked tails only (Bearer)
  if (url === '/v1/config/keys/secure/status' && method === 'GET') {
    const auth = headers['authorization'];
    const result = handleSecureKeysStatus(auth);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // GET /v1/config/policy — current policy + effective preview (P1: no auth,
  // loopback-only; admin token is a pending adjudication item)
  if (url === '/v1/config/policy' && method === 'GET') {
    const result = handleGetPolicy();
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // PUT /v1/config/policy — validate + persist (P1: no auth, loopback-only;
  // pending adjudication item noted in src/api/policy.ts)
  if (url === '/v1/config/policy' && method === 'PUT') {
    const result = handlePutPolicy(rawBody);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // TriMMC card (LG-035 T1): admin fail-closed trio
  if (url === '/v1/config/trimmc-card' && method === 'GET') {
    const result = handleGetTrimmcCard(headers['authorization']);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }
  if (url === '/v1/config/trimmc-card' && method === 'PUT') {
    const result = handlePutTrimmcCard(headers['authorization'], rawBody);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }
  if (url === '/v1/config/trimmc-card/status' && method === 'PUT') {
    const result = handlePutTrimmcCardStatus(headers['authorization'], rawBody);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // LG-035 本地侧（2026-09-14）：运行时信息（无鉴权只读，供 UI 标注域与功能开关）
  if (url === '/v1/config/runtime-info' && method === 'GET') {
    const result = handleRuntimeInfo();
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // Claude 直连兜底（2026-09-15 CEO 直令）：GET 无鉴权读现状；POST 管理令牌 fail-closed
  if (url === '/v1/config/claude-fallback' && method === 'GET') {
    const result = handleGetClaudeFallback(headers['authorization']);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }
  if (url === '/v1/config/claude-fallback/restore' && method === 'POST') {
    const result = handlePostClaudeFallbackRestore(headers['authorization'], rawBody);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // LG-035 本地侧：「应用到本机」——活动策略落本机生效面（policies/local.json）
  if (url === '/v1/config/trimmc-card/apply' && method === 'POST') {
    const result = handleApplyStrategy(headers['authorization']);
    return { statusCode: result.statusCode, headers: jsonHeaders, body: result.body };
  }

  // 404 for unhandled routes
  return {
    statusCode: 404,
    headers: jsonHeaders,
    body: { error: 'Not found', path: url },
  };
}
