// ── LG-035 P3-sg STE gate: 3334 rewriting proxy (slice 1) ──
// STE 小柯门禁（CTO 六点对表）：G1 3333 零触碰隔离+health 零键值；G2 映射四案
// （含两 502 防御=不发错 key 到错端点，mock 上游零请求断言）；G3 SSE 逐字节
// 不碎+非缓冲时序证明；G4 转发保真 deep-compare（除 model 改写+auth 注入外
// 零改动+hop-by-hop 剔除）；G5 缺口探针（405 形态稳定+观测环白名单）；G6
// Node18 静态断言（真 18 实测候 sg 冒烟——本机 nvm 无 18 且全局切换危及在飞
// 席进程，静态+标注，CTO 预案）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer, type Server, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createProxyServer } from '../src/proxy-server.js';
import { rewriteMessagesBody } from '../src/anthropic-proxy.js';
import type { PolicyShape } from '../src/policy.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = join(REPO_ROOT, 'policy.json');
const DS_KEY = 'sk-gate-deepseek-sentinel';
const GLM_KEY = 'sk-gate-glm-sentinel';

let proxy: Server | null = null;
let mock: Server | null = null;
let proxyPort = 0;
let mockPort = 0;
let policySnap: string | null = null;
const savedEnv: Record<string, string | undefined> = {};

interface CapturedRequest { headers: IncomingMessage['headers']; body: string; at: number }
const captured: CapturedRequest[] = [];
let mockMode: 'json' | 'sse' = 'json';
let mockWriteSchedule: number[] = []; // ms timestamps of upstream writes (streaming proof)
let mockEndedAt = 0;

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolveP(p));
    });
    srv.on('error', reject);
  });
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function policyFor(model: string): PolicyShape {
  // window covering now ± 8h — always active for deterministic routing
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  const [h, m] = fmt.format(new Date()).split(':').map(Number);
  const now = h * 60 + m;
  const at = (x: number): string => `${String(Math.floor((((x % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((x % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
  return {
    version: '1',
    schedules: [{
      id: 'gate-p3', target: 'daemon-default', model,
      windows: [{ start: at(now - 480), end: at(now + 480) }],
      timezone: 'Asia/Shanghai', enabled: true, priority: 10,
    }],
  };
}

function post(path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingMessage['headers']; chunks: Buffer[]; text: string; firstChunkAt: number | null }> {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let firstChunkAt: number | null = null;
        res.on('data', (c: Buffer) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(c);
        });
        res.on('end', () => resolveP({
          status: res.statusCode ?? 0, headers: res.headers, chunks,
          text: Buffer.concat(chunks).toString('utf-8'), firstChunkAt,
        }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function get(path: string): Promise<{ status: number; text: string }> {
  return fetch(`http://127.0.0.1:${proxyPort}${path}`).then(async (r) => ({ status: r.status, text: await r.text() }));
}

describe('GATE P3-sg: 3334 rewriting proxy (in-process dual server)', () => {
  before(async () => {
    policySnap = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf-8') : null;
    rmSync(POLICY_FILE, { force: true }); // deterministic: env-default routing
    setEnv('DEEPSEEK_API_KEY', DS_KEY);
    setEnv('GLM_API_KEY', GLM_KEY);
    setEnv('TRIMODEL_DEFAULT_MODEL', 'tmv-deepseek-v4-pro');

    // mock upstream (http → exercises the node:http branch of forwardToUpstream);
    // BOTH route families must point here — never let gate tests reach real endpoints
    mockPort = await freePort();
    setEnv('GLM_ANTHROPIC_BASE_URL', `http://127.0.0.1:${mockPort}`);
    setEnv('DEEPSEEK_ANTHROPIC_BASE_URL', `http://127.0.0.1:${mockPort}`);
    const m = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf-8'), at: Date.now() });
        if (mockMode === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          mockWriteSchedule = [];
          const pieces = ['data: {"a":1}\n\n', 'event: ping\ndata: {"b":2}\n\n', 'data: [DONE]\n\n'];
          let i = 0;
          const writeNext = (): void => {
            if (i >= pieces.length) {
              mockEndedAt = Date.now();
              res.end();
              return;
            }
            mockWriteSchedule.push(Date.now());
            res.write(pieces[i]);
            i += 1;
            setTimeout(writeNext, 300);
          };
          writeNext();
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'x-api-key': 'upstream-echo-must-not-leak' });
          res.end(JSON.stringify({ ok: true, id: 'msg_mock', content: [{ type: 'text', text: 'mock-reply' }] }));
        }
      });
    });
    await new Promise<void>((res) => m.listen(mockPort, '127.0.0.1', () => res()));
    mock = m;

    proxyPort = await freePort();
    const p = createProxyServer();
    proxy = p;
    await new Promise<void>((res) => p.listen(proxyPort, '127.0.0.1', () => res()));
  });

  after(() => {
    proxy?.close();
    mock?.close();
    if (policySnap === null) rmSync(POLICY_FILE, { force: true });
    else writeFileSync(POLICY_FILE, policySnap, 'utf-8');
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('G1 isolation: proxy serves no config-plane surface; /proxy/health 200 with zero key material', async () => {
    const cfg = await get('/v1/config/keys');
    assert.equal(cfg.status, 405, 'config-plane routes must not exist on the proxy listener');
    const health = await get('/proxy/health');
    assert.equal(health.status, 200);
    const body = JSON.parse(health.text) as { service: string; upstream_routes: { prefix: string; apiKeyEnv: string; key_configured: boolean }[] };
    assert.equal(body.service, 'trimodel-proxy');
    assert.ok(body.upstream_routes.every((r) => r.key_configured));
    assert.ok(!health.text.includes(DS_KEY) && !health.text.includes(GLM_KEY), 'health must never echo key material');
    assert.ok(health.text.includes('DEEPSEEK_API_KEY'), 'health shows env var NAMES only');
  });

  it('G2 mapping four cases (pure): deepseek/glm routes+key+strip, unmatched & keyless 502-codes, longest-prefix', () => {
    const policy = policyFor('tmv-deepseek-v4-pro');
    const ds = rewriteMessagesBody('{"model":"claude-x","messages":[]}', new Date(), policy);
    assert.equal(ds.code, 'ok');
    assert.equal(ds.upstream?.route.prefix, 'tmv-deepseek', 'longest prefix wins over bare deepseek');
    assert.equal(ds.upstream?.apiKey, DS_KEY);
    assert.equal(ds.upstream?.baseUrl, `http://127.0.0.1:${mockPort}`, 'DEEPSEEK base URL env override honored');
    const dsBody = JSON.parse(ds.body ?? '{}') as { model: string };
    assert.equal(dsBody.model, 'deepseek-v4-pro', 'tmv- registry shell stripped for native endpoint');

    const glm = rewriteMessagesBody('{"model":"claude-x"}', new Date(), policyFor('tmv-glm-5.3'));
    assert.equal(glm.code, 'ok');
    assert.equal(glm.upstream?.route.prefix, 'tmv-glm');
    assert.equal(glm.upstream?.apiKey, GLM_KEY);
    assert.equal(glm.upstream?.baseUrl, `http://127.0.0.1:${mockPort}`, 'GLM base URL env override honored');

    const unknown = rewriteMessagesBody('{"model":"claude-x"}', new Date(), policyFor('mistral-large-x'));
    assert.equal(unknown.code, 'no-upstream-route', 'unmatched model refused (never mis-routed)');

    setEnv('GLM_API_KEY', undefined);
    const keyless = rewriteMessagesBody('{"model":"claude-x"}', new Date(), policyFor('tmv-glm-5.3'));
    assert.equal(keyless.code, 'no-api-key', 'matched route without key refused');
    setEnv('GLM_API_KEY', GLM_KEY);

    assert.equal(rewriteMessagesBody('{broken', new Date(), policy).code, 'bad-json');
  });

  it('G4 fidelity deep-compare: only model rewritten + auth injected; hop-by-hop/auth dropped; no leak back', async () => {
    mockMode = 'json';
    const before = captured.length;
    const original = { model: 'claude-sonnet-whatever', system: 'sys-prompt', messages: [{ role: 'user', content: 'hi' }], max_tokens: 99, stream: false, temperature: 0.7 };
    const res = await post('/v1/messages', JSON.stringify(original), {
      authorization: 'Bearer cc-placeholder',
      'x-api-key': 'cc-placeholder',
      'anthropic-version': '2023-06-01',
      connection: 'keep-alive',
      'x-should-not-forward': 'nope',
    });
    assert.equal(res.status, 200);
    assert.equal(captured.length, before + 1, 'exactly one upstream request');
    const cap = captured[captured.length - 1];

    const sent = JSON.parse(cap.body) as Record<string, unknown>;
    assert.equal(sent.model, 'deepseek-v4-pro', 'model rewritten to policy wire name');
    for (const k of Object.keys(original)) {
      if (k === 'model') continue;
      assert.deepEqual(sent[k], original[k as keyof typeof original], `field '${k}' must survive untouched`);
    }
    assert.equal(cap.headers['x-api-key'], DS_KEY, 'server-side key injection');
    assert.equal(cap.headers.authorization, `Bearer ${DS_KEY}`);
    assert.equal(cap.headers['anthropic-version'], '2023-06-01', 'anthropic-version passthrough');
    assert.equal(cap.headers['x-should-not-forward'], undefined, 'arbitrary client headers not forwarded');

    // response passthrough: upstream content byte-identical; upstream auth headers NOT leaked back
    assert.equal(res.text, JSON.stringify({ ok: true, id: 'msg_mock', content: [{ type: 'text', text: 'mock-reply' }] }));
    assert.equal(res.headers['x-api-key'], undefined, 'upstream x-api-key must not leak to client');
    assert.equal(res.headers.authorization, undefined, 'upstream authorization must not leak to client');

    const health = JSON.parse((await get('/proxy/health')).text) as { recent_rewrites: Record<string, unknown>[] };
    const last = health.recent_rewrites[health.recent_rewrites.length - 1];
    for (const k of Object.keys(last)) {
      assert.ok(['at', 'from', 'to', 'matched_schedule_id', 'upstream_prefix'].includes(k), `ring field '${k}' outside SEC whitelist`);
    }
  });

  it('G3 SSE byte-for-byte, unbuffered: fragments preserved, first byte precedes upstream end', async () => {
    mockMode = 'sse';
    mockEndedAt = 0;
    const res = await post('/v1/messages', JSON.stringify({ model: 'claude-x', stream: true }));
    assert.equal(res.status, 200);
    assert.equal(String(res.headers['content-type']).includes('text/event-stream'), true, 'SSE content-type passthrough');
    assert.equal(res.headers['content-length'], undefined, 'no content-length on streamed SSE');
    assert.equal(res.headers['x-api-key'], undefined, 'upstream auth stripped from client response');

    const expected = 'data: {"a":1}\n\nevent: ping\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    assert.equal(res.text, expected, 'SSE bytes must arrive unmodified end-to-end');
    assert.ok(res.chunks.length >= 2, `fragments must not collapse into one buffered write (got ${res.chunks.length})`);
    assert.ok(res.firstChunkAt !== null && mockEndedAt > 0 && res.firstChunkAt < mockEndedAt - 150,
      `first client byte at ${res.firstChunkAt} must precede upstream end ${mockEndedAt} by >150ms (no buffering)`);
  });

  it('G2-E2E: unmatched model → 502 with ZERO upstream requests (never sends wrong key to wrong endpoint)', async () => {
    mockMode = 'json';
    const before = captured.length;
    writeFileSync(POLICY_FILE, JSON.stringify(policyFor('mistral-unknown-x')), 'utf-8');
    const res = await post('/v1/messages', JSON.stringify({ model: 'whatever', messages: [] }));
    assert.equal(res.status, 502);
    assert.equal(captured.length, before, 'refused rewrite must NOT reach any upstream');
    const health = JSON.parse((await get('/proxy/health')).text) as { policy_effective: { model: string } };
    assert.equal(health.policy_effective.model, 'mistral-unknown-x');
    rmSync(POLICY_FILE, { force: true }); // back to env-default for remaining/cleanup
  });

  it('G5 gap probe: unknown routes stable 405 shape; oversized body rejected at connection level', async () => {
    const wrong1 = await get('/v1/messages');
    assert.equal(wrong1.status, 405);
    assert.ok(wrong1.text.includes('hint'), '405 carries a stable hint shape');
    const wrong2 = await post('/elsewhere', '{}');
    assert.equal(wrong2.status, 405);

    let observed = 'ok';
    try {
      const big = JSON.stringify({ model: 'x', pad: 'y'.repeat(10_500_000) });
      const r = await post('/v1/messages', big);
      observed = `status ${r.status}`;
    } catch (err) {
      observed = `connection error: ${err instanceof Error ? err.message : String(err)}`;
    }
    assert.ok(!observed.startsWith('status 2'), `oversized body must be rejected, got ${observed}`);
  });

  it('G6 Node18 static: engines floor + import allowlist + no Node-20-only tokens (real-18 → sg smoke候)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { engines: { node: string }; scripts: Record<string, string> };
    assert.equal(pkg.engines.node, '>=18.20.0');
    assert.equal(typeof pkg.scripts['serve:proxy'], 'string', 'serve:proxy entry present');

    const ALLOWED_IMPORTS = new Set(['node:http', 'node:https', 'node:url', 'node:path']);
    const FORBIDDEN = ['fetch(', 'structuredClone', 'Array.fromAsync', 'navigator.', 'File(', 'ReadableStream'];
    for (const file of ['src/anthropic-proxy.ts', 'src/proxy-server.ts']) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) {
          assert.ok(ALLOWED_IMPORTS.has(spec), `${file}: import '${spec}' outside the Node18-safe allowlist`);
        }
      }
      for (const tok of FORBIDDEN) {
        assert.ok(!src.includes(tok), `${file}: Node18-risky token '${tok}' present`);
      }
    }
    // annotation: real Node18 execution deferred to sg smoke (nvm-windows global
    // switch would risk in-flight seat processes; CTO pre-approved static+annotate)
  });
});
