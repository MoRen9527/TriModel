#!/usr/bin/env node
// ── TriModel 3334 Rewriting Proxy Server (LG-035 P3-sg 切片 1) ──
//
// SEPARATE listener from the 3333 configuration plane (server.ts untouched —
// 双端口隔离铁律：3333 配置面零行为变更). This process serves exactly two
// routes:
//   POST /v1/messages   — anthropic protocol: rewrite model → inject upstream
//                         key → byte-for-byte pipe (SSE or JSON)
//   GET  /proxy/health  — self-check: policy effective value + upstream route
//                         table + last N rewrite summaries (no key material)
//   everything else     — 405
//
// Start: npm run serve:proxy
// Node18 compat: node:http only.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { effectiveModel } from './policy.js';
import {
  UPSTREAM_ROUTES,
  forwardToUpstream,
  pickPassthroughHeaders,
  rewriteMessagesBody,
} from './anthropic-proxy.js';

const HOST = process.env.TRIMODEL_PROXY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TRIMODEL_PROXY_PORT ?? 3334);
// POST /v1/messages body cap (connection-level oversized-request defense,
// P2 family); anthropic payloads are small but thinking blocks add up.
const MAX_BODY_BYTES = 10_000_000;
// Rewrite observation ring buffer (SEC whitelist: model names only).
const REWRITE_LOG_LIMIT = 20;
const rewriteLog: Array<{ at: string; from: string; to: string; matched_schedule_id: string | null; upstream_prefix: string }> = [];
let lastUpstreamStatus: { code: number | null; at: string } | null = null;

function collectBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { resolvePromise(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', reject);
  });
}

export function createProxyServer(): import('node:http').Server {
  return createServer(handler);
}

async function handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    // ── Health（3334 自检：policy 有效值+路由表+最近改写摘要，无密钥材料）──
    if (url === '/proxy/health' && method === 'GET') {
      const evaluation = effectiveModel();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'trimodel-proxy',
        policy_effective: evaluation,
        upstream_routes: UPSTREAM_ROUTES.map((r) => ({ prefix: `${r.prefix}*`, baseUrl: r.baseUrl(), apiKeyEnv: r.apiKeyEnv, key_configured: Boolean(process.env[r.apiKeyEnv]) })),
        last_upstream_status: lastUpstreamStatus,
        recent_rewrites: rewriteLog.slice(-REWRITE_LOG_LIMIT),
      }));
      return;
    }

    // ── 主路径：POST /v1/messages ──
    if (url === '/v1/messages' && method === 'POST') {
      let rawBody: string;
      try {
        rawBody = await collectBody(req);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'body error' }));
        return;
      }

      const rewritten = rewriteMessagesBody(rawBody);
      if (!rewritten.ok || !rewritten.body || !rewritten.upstream) {
        const statusMap: Record<string, number> = { 'bad-json': 400, 'no-upstream-route': 502, 'no-api-key': 502 };
        res.writeHead(statusMap[rewritten.code] ?? 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: rewritten.error ?? rewritten.code }));
        return;
      }

      if (rewritten.rewriteLog) {
        const entry = { at: new Date().toISOString(), ...rewritten.rewriteLog };
        rewriteLog.push(entry);
        if (rewriteLog.length > REWRITE_LOG_LIMIT) rewriteLog.shift();
        // 改写观测一行（SEC 白名单：仅 model 名，无密钥材料）
        console.log(`[proxy] rewrite ${entry.from} -> ${entry.to} (schedule=${entry.matched_schedule_id ?? 'fallback'}, upstream=${entry.upstream_prefix})`);
      }

      const clientHeaders = req.headers;
      const upstreamRes = await forwardToUpstream({
        upstream: rewritten.upstream,
        body: rewritten.body,
        contentType: typeof clientHeaders['content-type'] === 'string' ? clientHeaders['content-type'] : 'application/json',
        anthropicVersion: typeof clientHeaders['anthropic-version'] === 'string' ? clientHeaders['anthropic-version'] : undefined,
      });

      lastUpstreamStatus = { code: upstreamRes.statusCode ?? null, at: new Date().toISOString() };
      // 流式透传：statusCode+保真 headers→逐字节 pipe（SSE 分片不缓冲不改写）
      res.writeHead(upstreamRes.statusCode ?? 502, pickPassthroughHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      return;
    }

    // ── 其余路由 ──
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed', hint: 'POST /v1/messages or GET /proxy/health' }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[proxy] request error:', message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal proxy error' }));
    } else {
      res.end();
    }
  }
}

// Main-module guard: `import` (tests) gets createProxyServer() without binding;
// `npm run serve:proxy` binds 3334.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createProxyServer().listen(PORT, HOST, () => {
    console.log(`[proxy] anthropic rewriting proxy listening on http://${HOST}:${PORT}`);
    console.log(`[proxy] routes: POST /v1/messages · GET /proxy/health (config plane 3333 untouched)`);
  });
}
