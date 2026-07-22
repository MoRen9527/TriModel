#!/usr/bin/env node
// ── TriModel Configuration-Plane HTTP Server ──
// Phase 1: low-QPS config distribution (model list + provider keys).
// Business traffic (chat/streaming) does NOT flow through this server —
// clients fetch keys here, then connect directly to providers.
//
// Start: npm run serve (dev) | npm run start:server (production)

import { createServer } from 'node:http';
import { createModelClient, readConfig } from './index.js';
import { dispatch } from './api/routes.js';

const HOST = process.env.TRIMODEL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TRIMODEL_PORT ?? 3333);

async function main(): Promise<void> {
  // Single ModelClient instance, initialized at startup, reused for the server lifetime
  const client = createModelClient(readConfig());

  const server = createServer(async (req, res) => {
    // Collect request headers into a plain object
    const reqHeaders: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      reqHeaders[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
    }

    try {
      const result = await dispatch(client, req.method ?? 'GET', req.url ?? '/', reqHeaders);
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
    console.log(`[trimodel] endpoints: /health /v1/models /v1/config/keys /v1/config/keys/refresh`);
  });
}

main().catch((err) => {
  console.error('[trimodel] failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
