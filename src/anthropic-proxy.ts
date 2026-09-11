// ── TriModel 3334 Lightweight Rewriting Forwarder (LG-035 P3-sg Slice 1) ──
//
// Purpose: CC (claude code) speaks the Anthropic Messages protocol against
// this proxy (port 3334); the proxy rewrites the body's `model` field to the
// policy-effective default model, resolves the upstream (DeepSeek native
// Anthropic endpoint / GLM anthropic-compat) from the model prefix, injects
// the upstream API key server-side (the CC-side key field is placeholder
// semantics), and pipes the upstream response — SSE or JSON — byte-for-byte
// back without buffering or rewriting.
//
// Isolation铁律: this is a SEPARATE listener (proxy-server.ts, 3334). The
// 3333 configuration plane (server.ts) is untouched — zero behaviour change.
//
// Node18 compat (slice-1 A): uses only node:http / node:https / node:url /
// node:path — no fetch streaming, no Node-20-only APIs.
// (fetch 流管道弃用=18 稳定性优先，CTO 令文钦定 node:https request。)
import { effectiveModel, envDefaultModel, evaluatePolicy, loadPolicy } from './policy.js';
import type { PolicyShape } from './policy.js';
import { readSecureKeys } from './secure-keys.js';
import http from 'node:http';
import https from 'node:https';

// ── Upstream route table（映射表代码内常量）──

export interface UpstreamRoute {
  readonly prefix: string;
  /** Anthropic-compat base URL (no trailing slash; path /v1/messages appended). */
  readonly baseUrl: () => string;
  /** Env var name holding the upstream API key. */
  readonly apiKeyEnv: string;
  /** keys.enc provider name (P2 secure store) overriding the env key. */
  readonly secureProvider: string;
  /**
   * Optional upstream model-name mapping (tmv-* registry canonical names are
   * not understood by native endpoints — strip the registry shell):
   * tmv-deepseek-v4-pro → deepseek-v4-pro.
   */
  readonly mapModelName?: (model: string) => string;
}

export const UPSTREAM_ROUTES: readonly UpstreamRoute[] = [
  {
    // Registry canonical names (env default family) — longest prefix first.
    prefix: 'tmv-deepseek',
    // 现役实证：src/providers/deepseek-anthropic.ts 常量同源
    baseUrl: () => process.env.DEEPSEEK_ANTHROPIC_BASE_URL ?? 'https://api.deepseek.com/anthropic',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    secureProvider: 'deepseek',
    mapModelName: (model) => model.replace(/^tmv-/, ''),
  },
  {
    prefix: 'deepseek',
    baseUrl: () => process.env.DEEPSEEK_ANTHROPIC_BASE_URL ?? 'https://api.deepseek.com/anthropic',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    secureProvider: 'deepseek',
  },
  {
    prefix: 'tmv-glm',
    // GLM anthropic-compat 端点候实勘补全（bigmodel 兼容路径以 sg 实测为准，
    // P3-sg 切片 2 部署窗核对；GLM_API_KEY 见 .env.example 注释行）
    baseUrl: () => process.env.GLM_ANTHROPIC_BASE_URL ?? 'https://open.bigmodel.cn/api/anthropic',
    apiKeyEnv: 'GLM_API_KEY',
    secureProvider: 'glm',
    mapModelName: (model) => model.replace(/^tmv-/, ''),
  },
  {
    prefix: 'glm',
    baseUrl: () => process.env.GLM_ANTHROPIC_BASE_URL ?? 'https://open.bigmodel.cn/api/anthropic',
    apiKeyEnv: 'GLM_API_KEY',
    secureProvider: 'glm',
  },
];

export interface ResolvedUpstream {
  route: UpstreamRoute;
  baseUrl: string;
  apiKey: string;
}

/**
 * Prefix-route the (already rewritten) model to its upstream + key.
 *
 * Key resolution order (灰度前接线，2026-09-11): keys.enc (P2 secure store)
 * same-name provider api_key FIRST, env fallback second — COS 运维通道
 * （SSH 隧道→UI→secure 写面）写入后下一请求即生效零重启（readSecureKeys
 * 逐调用读文件，零缓存）。keys.enc absent/corrupted ⇒ env fallback
 * (readSecureKeys fail-safe family — never throws).
 */
export function resolveUpstream(model: string, keystorePath?: string): ResolvedUpstream | null {
  const route = UPSTREAM_ROUTES.find((r) => model.startsWith(r.prefix));
  if (!route) return null;
  const baseUrl = route.baseUrl().replace(/\/+$/, '');
  let apiKey = process.env[route.apiKeyEnv] ?? '';
  const secure = readSecureKeys(keystorePath);
  const secureKey = secure?.providers[route.secureProvider]?.api_key;
  if (secureKey) apiKey = secureKey;
  return { route, baseUrl, apiKey };
}

// ── Body rewrite ──

export interface RewriteOutcome {
  ok: boolean;
  /** 'bad-json' | 'no-upstream-route' | 'no-api-key' | 'ok' */
  code: 'ok' | 'bad-json' | 'no-upstream-route' | 'no-api-key';
  error?: string;
  body?: string; // rewritten JSON string (model field replaced, rest preserved)
  upstream?: ResolvedUpstream;
  rewriteLog?: {
    from: string;
    to: string;
    matched_schedule_id: string | null;
    upstream_prefix: string;
  };
}

/**
 * Parse the CC request body, overwrite `model` with the policy-effective
 * default model, resolve the upstream, and re-serialize. SEC whitelist: the
 * log record carries model names only — no key material ever enters logs.
 * policyOverride: test seam (defaults to the on-disk policy.json).
 */
export function rewriteMessagesBody(
  rawBody: string,
  now: Date = new Date(),
  policyOverride?: PolicyShape | null,
): RewriteOutcome {
  let doc: { model?: unknown } & Record<string, unknown>;
  try {
    doc = JSON.parse(rawBody) as { model?: unknown } & Record<string, unknown>;
  } catch (err) {
    return { ok: false, code: 'bad-json', error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` };
  }

  const originalModel = typeof doc.model === 'string' ? doc.model : '(none)';
  const policy = policyOverride !== undefined ? policyOverride : loadPolicy();
  const hit = evaluatePolicy(now, policy);
  const evaluation = hit
    ? { model: hit.model, matched_schedule_id: hit.matched_schedule_id, source: 'policy' as const }
    : { model: envDefaultModel(), matched_schedule_id: null, source: 'env-default' as const };
  const upstream = resolveUpstream(evaluation.model);
  if (!upstream) {
    return { ok: false, code: 'no-upstream-route', error: `no upstream route for model '${evaluation.model}' (routes: ${UPSTREAM_ROUTES.map((r) => r.prefix + '*').join(', ')})` };
  }
  if (!upstream.apiKey) {
    return { ok: false, code: 'no-api-key', error: `upstream key env ${upstream.route.apiKeyEnv} not configured` };
  }
  // Registry-shell mapping: tmv-* names become native upstream names on the wire.
  const wireModel = upstream.route.mapModelName ? upstream.route.mapModelName(evaluation.model) : evaluation.model;
  doc.model = wireModel;

  return {
    ok: true,
    code: 'ok',
    body: JSON.stringify(doc),
    upstream,
    rewriteLog: {
      from: originalModel,
      to: wireModel,
      matched_schedule_id: evaluation.matched_schedule_id,
      upstream_prefix: upstream.route.prefix,
    },
  };
}

// ── Forwarding（node:https request，流式透传）──

export interface ForwardOptions {
  upstream: ResolvedUpstream;
  body: string;
  /** Client headers to preserve (hop-by-hop/auth headers stripped by caller). */
  contentType?: string;
  anthropicVersion?: string;
}

/**
 * Forward the rewritten body to the upstream Anthropic-compatible endpoint.
 * Returns the upstream response object for the caller to pipe through —
 * the response is NOT buffered or rewritten (SSE chunks flow byte-for-byte).
 */
export function forwardToUpstream(opts: ForwardOptions): Promise<http.IncomingMessage> {
  const target = new URL(`${opts.upstream.baseUrl}/v1/messages`);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const payload = Buffer.from(opts.body, 'utf-8');

  return new Promise((resolvePromise, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          // Server-side injection — overrides any CC-side placeholder values.
          'x-api-key': opts.upstream.apiKey,
          authorization: `Bearer ${opts.upstream.apiKey}`,
          'content-type': opts.contentType ?? 'application/json',
          ...(opts.anthropicVersion ? { 'anthropic-version': opts.anthropicVersion } : {}),
          'content-length': String(payload.length),
        },
      },
      (res) => resolvePromise(res),
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Headers safe to pass through to the CC client (drop hop-by-hop + auth). */
export function pickPassthroughHeaders(upstreamHeaders: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'content-length' || lower === 'x-api-key' || lower === 'authorization') continue;
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  // SSE: ensure chunked streaming survives the pipe.
  out['transfer-encoding'] = 'chunked';
  return out;
}
