// ── TriModel API: Route dispatcher ──
// Maps URL paths to handlers. Configuration-plane only (no chat proxy).
import type { ModelClient } from '../client.js';
import { handleHealth } from './health.js';
import { handleModels } from './models.js';
import { handleGetKeys, handleRefreshKeys } from './keys.js';
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

  // 404 for unhandled routes
  return {
    statusCode: 404,
    headers: jsonHeaders,
    body: { error: 'Not found', path: url },
  };
}
