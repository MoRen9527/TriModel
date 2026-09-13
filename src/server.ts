#!/usr/bin/env node
// ── TriModel Configuration-Plane HTTP Server ──
// Phase 1: low-QPS config distribution (model list + provider keys + policy).
// Business traffic (chat/streaming) does NOT flow through this server —
// clients fetch keys here, then connect directly to providers.
//
// Start: npm run serve (dev) | npm run start:server (production)

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createModelClient, readConfig } from './index.js';
import { dispatch } from './api/routes.js';
import { migrateKeysEncToCard } from './secure-keys.js';
import { loadCard, migrateLegacyDistCard } from './trimmc-card.js';
import { migrateLegacyPolicy, getCardDefaultModel, registerCardDefaultModelFn } from './policy.js';

const HOST = process.env.TRIMODEL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TRIMODEL_PORT ?? 3333);
// PUT /v1/config/policy connection-level oversized-request defense (F2 口径:
// 超限即连接级断开 ECONNRESET，非规范 413 响应——Content-Length 预检规范化
// 候下批)；policies are tiny documents.
const MAX_BODY_BYTES = 1_000_000;

// ── /ui static file service (GET only) ──
// Serves the single-page policy editor from ui/. Loopback-only by server bind;
// path traversal is rejected by prefix check after normalization.
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(url: string, res: import('node:http').ServerResponse): boolean {
  if (!url.startsWith('/ui')) return false;
  if (url !== '/ui' && url !== '/ui/' && !url.startsWith('/ui/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  const relative = url === '/ui' || url === '/ui/' ? 'index.html' : url.slice('/ui/'.length);
  const filePath = normalize(join(UI_ROOT, relative));
  if (!filePath.startsWith(UI_ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return true;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
  return true;
}

function readRawBody(req: import('node:http').IncomingMessage): Promise<string> {
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

async function main(): Promise<void> {
  // S5 one-shot migration: keys.enc → TriMMC card synthetic entries
  // (auto_imported), then keys.enc renamed to keys.enc.migrated (幂等).
  migrateLegacyPolicy();
  registerCardDefaultModelFn(() => { try { const doc = loadCard(); return doc && doc.default_model ? doc.default_model : null; } catch { return null; } });
  // D9: legacy dist-adjacent card → canonical cwd path (rename-style, idempotent)
  const cardMigration = migrateLegacyDistCard();
  if (cardMigration.reason && cardMigration.reason !== 'no-legacy') {
    console.log(`[trimodel] card migration: ${cardMigration.reason}`);
  }
  const migration = migrateKeysEncToCard();
  if (migration.reason && migration.reason !== 'no-legacy') {
    console.log(`[trimodel] keys.enc migration: ${migration.reason} (imported: ${migration.imported.join(', ') || 'none'})`);
  }

  // Single ModelClient instance, initialized at startup, reused for the server lifetime
  const client = createModelClient(readConfig());

  const server = createServer(async (req, res) => {
    // Collect request headers into a plain object
    const reqHeaders: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      reqHeaders[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
    }

    try {
      const url = req.url ?? '/';

      // GET-only static UI plane, handled before the JSON dispatcher
      if ((req.method ?? 'GET') === 'GET' && serveStatic(url, res)) return;

      // PUT /v1/config/policy needs the request body; other routes ignore it
      const rawBody = (req.method ?? '') === 'PUT' ? await readRawBody(req) : undefined;

      const result = await dispatch(client, req.method ?? 'GET', url, reqHeaders, rawBody);
      res.writeHead(result.statusCode, result.headers);
      res.end(JSON.stringify(result.body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[trimodel] request error:', message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[trimodel] configuration-plane API listening on http://${HOST}:${PORT}`);
    console.log(`[trimodel] endpoints: /health /v1/models /v1/config/keys /v1/config/keys/refresh /v1/config/policy (GET|PUT) /ui`);
  });
}

main().catch((err) => {
  console.error('[trimodel] failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
