// ── LG-035 P3-sg slice 1 + 增补(模型名标准化): 3334 rewriting proxy tests ──
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unused-vars -- test-local idioms */
// Covers: upstream route resolution (official catalog exact match: deepseek /
// GLM / TMV), body rewrite correctness (policy window in/out, CC placeholder-
// model semantics, bad JSON), forwarding fidelity, SSE streaming integrity,
// 10MB defense, health surface (no key material), 405, keys.enc-first key
// resolution (S5 归并: card entries first, env fallback).
// Node18 compat: node:http servers + fetch client only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  UPSTREAM_ROUTES,
  resolveUpstream,
  rewriteMessagesBody,
} from '../src/anthropic-proxy.js';
import { createProxyServer } from '../src/proxy-server.js';
import { emptyCard, buildEntry, saveCard as cardSave } from '../src/trimmc-card.js';
import type { PolicyShape } from '../src/policy.js';

describe('proxy: upstream route table (official catalog exact match)', () => {
  const ORIGINAL = {
    ds: process.env.DEEPSEEK_API_KEY,
    dsUrl: process.env.DEEPSEEK_ANTHROPIC_BASE_URL,
    glm: process.env.GLM_API_KEY,
    tmvKey: process.env.TRIMODEL_TRIMETAVERSE_API_KEY,
    tmvUrl: process.env.TRIMODEL_TRISTACISS_BASE_URL,
  };

  before(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.GLM_API_KEY = 'sk-glm-test';
    process.env.TRIMODEL_TRIMETAVERSE_API_KEY = 'tmv-sk-test';
    process.env.TRIMODEL_TRISTACISS_BASE_URL = 'http://127.0.0.1:8008/v1';
    delete process.env.DEEPSEEK_ANTHROPIC_BASE_URL;
  });
  after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    };
    restore('DEEPSEEK_API_KEY', ORIGINAL.ds);
    restore('DEEPSEEK_ANTHROPIC_BASE_URL', ORIGINAL.dsUrl);
    restore('GLM_API_KEY', ORIGINAL.glm);
    restore('TRIMODEL_TRIMETAVERSE_API_KEY', ORIGINAL.tmvKey);
    restore('TRIMODEL_TRISTACISS_BASE_URL', ORIGINAL.tmvUrl);
  });

  it('deepseek official names → native anthropic endpoint + DEEPSEEK key', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-flash']) {
      const up = resolveUpstream(model);
      assert.equal(up?.baseUrl, 'https://api.deepseek.com/anthropic');
      assert.equal(up?.apiKey, 'sk-ds-test');
      assert.equal(up?.route.label, 'deepseek-anthropic');
      assert.equal(up?.route.secureProvider, 'deepseek');
    }
  });

  it('GLM official names → GLM anthropic-compat endpoint + GLM key', () => {
    for (const model of ['GLM-5.3', 'GLM-5.3-Flash']) {
      const up = resolveUpstream(model);
      assert.equal(up?.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
      assert.equal(up?.apiKey, 'sk-glm-test');
      assert.equal(up?.route.label, 'glm-anthropic');
      assert.equal(up?.route.secureProvider, 'glm');
    }
  });

  it('TMV → TriStaciss anthropic relay (base /v1 tail stripped) + platform key', () => {
    const up = resolveUpstream('TMV');
    assert.equal(up?.baseUrl, 'http://127.0.0.1:8008', '/v1 tail must be stripped before the shared /v1/messages append');
    assert.equal(up?.apiKey, 'tmv-sk-test');
    assert.equal(up?.route.label, 'tristaciss-anthropic');
    assert.equal(up?.route.secureProvider, 'trimetaverse');
  });

  it('unmatched → null (proxy refuses rather than mis-routing keys)', () => {
    assert.equal(resolveUpstream('mistral-large-x'), null);
    assert.equal(resolveUpstream('tmv-deepseek-v4-pro'), null, 'retired tmv-* names have no route');
    assert.equal(resolveUpstream('glm-5.3'), null, 'case-sensitive: lowercase glm-5.3 is not catalog');
  });

  it('unroutable effective model → no-upstream-route', () => {
    const ORIGINAL_DEFAULT = process.env.TRIMODEL_DEFAULT_MODEL;
    process.env.TRIMODEL_DEFAULT_MODEL = 'mistral-large-x';
    try {
      assert.equal(rewriteMessagesBody('{"model":"whatever","messages":[]}', new Date(), null).code, 'no-upstream-route');
    } finally {
      if (ORIGINAL_DEFAULT === undefined) delete process.env.TRIMODEL_DEFAULT_MODEL; else process.env.TRIMODEL_DEFAULT_MODEL = ORIGINAL_DEFAULT;
    }
  });

  it('S5 归并: card enabled entry key OVERRIDES env (card-first resolution)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-proxykey-test-'));
    try {
      const cardPath = join(dir, 'trimmc-card.json');
      const card = emptyCard('c');
      card.provider_entries['e1'] = buildEntry('deepseek', 'deepseek-v4-pro', 'sk-from-card-entry', true);
      cardSave(card, cardPath);
      process.env.DEEPSEEK_API_KEY = 'sk-from-env';
      const up = resolveUpstream('deepseek-v4-pro', cardPath);
      assert.equal(up?.apiKey, 'sk-from-card-entry');
      // GLM without card entry falls back to env
      process.env.GLM_API_KEY = 'sk-glm-env';
      const glm = resolveUpstream('GLM-5.3', cardPath);
      assert.equal(glm?.apiKey, 'sk-glm-env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S5 归并: card absent → env fallback; corrupted card → env fallback, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-proxykey2-test-'));
    try {
      process.env.DEEPSEEK_API_KEY = 'sk-env-fallback';
      assert.equal(resolveUpstream('deepseek-v4-pro', join(dir, 'missing.json'))?.apiKey, 'sk-env-fallback');
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, 'not json at all');
      assert.equal(resolveUpstream('deepseek-v4-pro', bad)?.apiKey, 'sk-env-fallback');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('route table: three upstream groups over the five-name catalog', () => {
    assert.deepEqual(UPSTREAM_ROUTES.map((r) => r.label), ['deepseek-anthropic', 'glm-anthropic', 'tristaciss-anthropic']);
    assert.deepEqual(UPSTREAM_ROUTES.flatMap((r) => r.matchModels).sort(), ['GLM-5.3', 'GLM-5.3-Flash', 'TMV', 'deepseek-flash', 'deepseek-v4-pro']);
  });
});

describe('proxy: body rewrite correctness', () => {
  const ORIGINAL_KEY = process.env.DEEPSEEK_API_KEY;
  before(() => { process.env.DEEPSEEK_API_KEY = 'sk-ds-rewrite-test'; });
  after(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = ORIGINAL_KEY;
  });

  it('policy window hit: model rewritten to schedule model + route follows', () => {
    const glmWindow: PolicyShape = {
      version: '1',
      schedules: [{ id: 'glm-win', target: 'daemon-default', model: 'GLM-5.3', windows: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai', enabled: true, priority: 10 }],
    };
    const out = rewriteMessagesBody('{"model":"cc-placeholder","messages":[{"role":"user","content":"hi"}],"max_tokens":100}', new Date(), glmWindow);
    assert.equal(out.code, 'ok');
    const body = JSON.parse(out.body!) as { model: string };
    assert.equal(body.model, 'GLM-5.3');
    assert.equal(out.upstream?.route.label, 'glm-anthropic');
    assert.equal(out.rewriteLog?.from, 'cc-placeholder');
    assert.equal(out.rewriteLog?.matched_schedule_id, 'glm-win');
  });

  it('no policy: falls back to official env default (deepseek-v4-pro)', () => {
    const ORIGINAL_DEFAULT = process.env.TRIMODEL_DEFAULT_MODEL;
    delete process.env.TRIMODEL_DEFAULT_MODEL;
    try {
      const out = rewriteMessagesBody('{"model":"cc-placeholder","messages":[]}', new Date(), null);
      assert.equal(out.code, 'ok');
      assert.equal((JSON.parse(out.body!) as { model: string }).model, 'deepseek-v4-pro');
      assert.equal(out.upstream?.route.label, 'deepseek-anthropic');
      assert.equal(out.rewriteLog?.matched_schedule_id, null);
    } finally {
      if (ORIGINAL_DEFAULT === undefined) delete process.env.TRIMODEL_DEFAULT_MODEL; else process.env.TRIMODEL_DEFAULT_MODEL = ORIGINAL_DEFAULT;
    }
  });

  it('CC placeholder model semantics: whatever CC sends is overridden server-side', () => {
    for (const placeholder of ['cc-placeholder', 'x', '']) {
      const out = rewriteMessagesBody(JSON.stringify({ model: placeholder, messages: [] }), new Date(), null);
      assert.equal(out.code, 'ok');
      assert.equal((JSON.parse(out.body!) as { model: string }).model, 'deepseek-v4-pro');
    }
  });

  it('bad JSON → bad-json; missing upstream key → no-api-key', () => {
    assert.equal(rewriteMessagesBody('{broken', new Date(), null).code, 'bad-json');
    const ORIGINAL_GLM = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    const glmWindow: PolicyShape = {
      version: '1',
      schedules: [{ id: 'g', target: 'daemon-default', model: 'GLM-5.3', windows: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai', enabled: true, priority: 1 }],
    };
    assert.equal(rewriteMessagesBody('{"model":"x"}', new Date(), glmWindow).code, 'no-api-key');
    if (ORIGINAL_GLM === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = ORIGINAL_GLM;
  });
});

describe('proxy: E2E — fidelity + SSE integrity + defense + health (in-process)', () => {
  let mockUpstream: Server;
  let mockPort = 0;
  let proxy: Server;
  let proxyPort = 0;
  const ORIGINAL = { dsUrl: process.env.DEEPSEEK_ANTHROPIC_BASE_URL, dsKey: process.env.DEEPSEEK_API_KEY };

  let lastSeen: { headers: IncomingMessage['headers']; body: string } | null = null;

  const SSE_FULL = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hel"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"lo"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'mock-ds-key';
    mockUpstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastSeen = { headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') };
        const body = JSON.parse(lastSeen.body) as { stream?: boolean; model?: string };
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let i = 0;
          const timer = setInterval(() => {
            if (i < SSE_FULL.length) {
              res.write(SSE_FULL.slice(i, i + 2));
              i += 2;
            } else {
              clearInterval(timer);
              res.end();
            }
          }, 10);
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock_001' });
          res.end(JSON.stringify({ ok: true, echo_model: body.model, seen_by: 'mock-upstream' }));
        }
      });
    });
    await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', r));
    mockPort = (mockUpstream.address() as { port: number }).port;
    process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockPort}`;

    proxy = createProxyServer();
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((r) => proxy.close(() => { r(); }));
    await new Promise<void>((r) => mockUpstream.close(() => { r(); }));
    if (ORIGINAL.dsUrl === undefined) delete process.env.DEEPSEEK_ANTHROPIC_BASE_URL; else process.env.DEEPSEEK_ANTHROPIC_BASE_URL = ORIGINAL.dsUrl;
    if (ORIGINAL.dsKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = ORIGINAL.dsKey;
  });

  it('non-streaming: model rewritten, key injected server-side, CC placeholder overridden', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'cc-placeholder-key', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'cc-placeholder', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 }),
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { echo_model: string };
    assert.equal(json.echo_model, 'deepseek-v4-pro');
    assert.ok(lastSeen);
    assert.equal((JSON.parse(lastSeen.body) as { model: string }).model, 'deepseek-v4-pro');
    assert.equal(lastSeen.headers['x-api-key'], 'mock-ds-key');
    assert.equal(lastSeen.headers.authorization, 'Bearer mock-ds-key');
    assert.equal(lastSeen.headers['anthropic-version'], '2023-06-01');
  });

  it('forwarding fidelity: body untouched except model field (deep-compare)', async () => {
    const sent = { model: 'cc-placeholder', messages: [{ role: 'user', content: 'fidelity' }], max_tokens: 32, cache_control_breakpoint: { type: 'ephemeral' }, tool_choice: { type: 'auto' } };
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sent),
    });
    const received = JSON.parse(lastSeen!.body) as Record<string, unknown>;
    const { model: _rewritten, ...restReceived } = received;
    const { model: _sent, ...restSent } = sent;
    assert.deepEqual(restReceived, restSent);
  });

  it('SSE streaming integrity: fragmented upstream chunks pipe complete (不碎不缓冲)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cc-placeholder', messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const aggregated = await res.text();
    assert.equal(aggregated, SSE_FULL, 'client must receive the full SSE stream byte-for-byte');
  });

  it('10MB body cap: oversized request rejected at connection level', async () => {
    const huge = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'y'.repeat(11 * 1024 * 1024) }] });
    await assert.rejects(
      fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: huge }),
      (err: Error) => /fetch failed|terminated|socket|ECONNRESET|aborted/i.test(err.message),
    );
  });

  it('health surface: policy effective + routes, zero key material', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/proxy/health`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('policy_effective'));
    assert.ok(text.includes('upstream_routes'));
    assert.equal(text.includes('mock-ds-key'), false, 'health must never leak upstream key material');
  });

  it('other routes → 405', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`);
    assert.equal(res.status, 405);
  });
});
