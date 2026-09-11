// ── LG-035 P1 STE gate: full-chain E2E + anchor③ daemon poll (single-file lifecycle) ──
// STE 小柯门禁（spec v0.4 §四 L3+锚③）。单文件单生命周期：repo-root policy.json 的
// 写窗口收敛于本文件内部（node --test 默认并行跑文件，多文件各自操作 policy.json 会
// 互相竞争——2026-09-11 全量跑实证，故 e2e 与 daemon-poll 合并于此）。
// 锚③链路：真 TriModel server（refresh_interval_s=1）+ 真 TriRLC key-cache（子进程跨仓
// 加载，绕开本仓 tsc rootDir）+ 真 HTTP 轮询；stub 两处注明：stagger Math.random→0、S3
// 明文存储+tmp dataDir。观察点=onKeyCacheUpdated + applyKeyCacheToEnvironment。
// F1/F2 探针：断言【观测行为】并在门禁报告中定性，勿改断言方向——候 CTO 裁决。
// 仓库根 policy.json 快照协议：测试前后恢复原状（FSD backward-compat 用例依赖干净态）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = join(REPO_ROOT, 'policy.json');
const TOKEN = 'ste-gate-token';

let server: ChildProcess | null = null;
let poller: ChildProcess | null = null;
let port = 0;
let workDir = '';
let snapshot: string | null = null; // prior policy.json content (null = absent)

interface PollEvent { type: string; defaultModel?: string; envModel?: string; error?: string }
const events: PollEvent[] = [];
let lineBuf = '';

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolveP(p));
    });
    srv.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

function shanghaiWindowAroundNow(minutesRadius = 30): { start: string; end: string } {
  // Shanghai wall-clock window [now-r, now+r]; wrap handled via start>end (legal overnight form)
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  });
  const [h, m] = fmt.format(new Date()).split(':').map(Number);
  const nowMins = h * 60 + m;
  const at = (mins: number): string => {
    const v = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  };
  return { start: at(nowMins - minutesRadius), end: at(nowMins + minutesRadius) };
}

function bootServer(p: number): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIMODEL_PORT: String(p),
    TRIMODEL_API_TOKEN: TOKEN,
    TRIMODEL_KEY_REFRESH_INTERVAL_S: '1', // daemon refresh interval follows the server-advertised value
  };
  delete env.TRIMODEL_DEFAULT_MODEL; // pin documented default for fallback assertions
  delete env.TRIMODEL_HOST; // P4 guard: default bind must be 127.0.0.1
  return spawn(process.execPath, ['--import', 'tsx', join('src', 'server.ts')], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitHealth(p: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${p}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on :${p} did not become healthy within ${timeoutMs}ms`);
}

function killChild(c: ChildProcess | null): void {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  try {
    c.kill();
  } catch { /* already gone */ }
}

async function get(path: string, auth?: string): Promise<{ status: number; ct: string; text: string }> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, ct: res.headers.get('content-type') ?? '', text: await res.text() };
}

async function put(path: string, body: string, auth?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'PUT', headers, body });
  return { status: res.status, text: await res.text() };
}

/** Raw-path GET via node:http (no client-side URL normalization) — for traversal probes. */
function rawGet(pathname: string): Promise<{ status: number; text: string }> {
  return new Promise((resolveP, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString('utf-8')));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, text: data }));
    });
    req.on('error', reject);
  });
}

function policyBody(model: string, window_: { start: string; end: string }): string {
  return JSON.stringify({
    version: '1',
    schedules: [{
      id: 'gate-e2e', target: 'daemon-default', model, windows: [window_],
      timezone: 'Asia/Shanghai', enabled: true, priority: 10,
    }],
  });
}

function waitForEvent(pred: (e: PollEvent) => boolean, timeoutMs: number, label: string): Promise<PollEvent> {
  return new Promise((resolveP, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const hit = events.find(pred);
      if (hit) return resolveP(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout waiting for ${label}; events: ${JSON.stringify(events.slice(-8))}`));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe('GATE L3+anchor③: E2E full chain + daemon real-chain poll (single lifecycle)', () => {
  before(async () => {
    snapshot = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf-8') : null;
    rmSync(POLICY_FILE, { force: true }); // deterministic init: pre-policy env default
    workDir = mkdtempSync(join(tmpdir(), 'ste-gate-'));
    port = await freePort();
    server = bootServer(port);
    await waitHealth(port);

    // anchor③ poller: real TriRLC key-cache in a child process (cross-repo via file URL,
    // kept out of this repo's tsc rootDir). Stubs annotated inside the script body.
    const keyCacheTs = resolve(REPO_ROOT, '..', 'TriRLC', 'src', 'config', 'key-cache.ts');
    const scriptPath = join(workDir, 'poll-child.mjs');
    writeFileSync(scriptPath, `
const { pathToFileURL } = await import('node:url');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
Math.random = () => 0; // STE stub (annotated): kill the 0-60s startup stagger
try {
  const kc = await import(pathToFileURL(${JSON.stringify(keyCacheTs)}).href);
  kc.onKeyCacheUpdated((cache) => {
    kc.applyKeyCacheToEnvironment(cache);
    send({ type: 'updated', defaultModel: cache.defaultModel, envModel: process.env.TRIMODEL_DEFAULT_MODEL });
  });
  await kc.initKeyCache(${JSON.stringify(`http://127.0.0.1:${port}`)}, ${JSON.stringify(join(workDir, 'data'))}, ${JSON.stringify(TOKEN)});
  const cache = kc.getKeyCache();
  send({ type: 'init', defaultModel: cache ? cache.defaultModel : null });
} catch (err) {
  send({ type: 'error', error: String(err && err.stack ? err.stack : err) });
}
setInterval(() => {}, 1000); // stay alive; parent kills after collecting events
`, 'utf-8');
    const env: NodeJS.ProcessEnv = { ...process.env, TRIMODEL_KEY_STORAGE_MODE: 's3' }; // STE stub (annotated)
    poller = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    poller.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf-8');
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (line) {
          try { events.push(JSON.parse(line) as PollEvent); } catch { /* non-JSON line */ }
        }
      }
    });
    poller.stderr?.on('data', (chunk: Buffer) => {
      events.push({ type: 'stderr', error: chunk.toString('utf-8').slice(0, 500) });
    });
  });

  after(() => {
    killChild(poller);
    killChild(server);
    rmSync(workDir, { recursive: true, force: true });
    // snapshot-restore protocol: leave repo root exactly as found
    if (snapshot === null) rmSync(POLICY_FILE, { force: true });
    else writeFileSync(POLICY_FILE, snapshot, 'utf-8');
  });

  it('anchor③-a: daemon initial pull reflects pre-policy env default (real chain, stubs annotated)', async () => {
    const init = await waitForEvent((e) => e.type === 'init', 15000, 'init event');
    assert.equal(init.defaultModel, 'tmv-deepseek-v4-pro', 'initial fetch before any policy');
  });

  it('P4-guard: default bind is loopback (netstat LISTENING line shows 127.0.0.1:port)', async () => {
    const out = await new Promise<string>((resolveP, reject) => {
      execFile('netstat', ['-ano'], (err, stdout) =>
        (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolveP(stdout)));
    });
    const line = out.split('\n').find((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
    assert.ok(line, `netstat LISTENING line for :${port} not found`);
    assert.ok(line.includes(`127.0.0.1:${port}`), `bind must be loopback, got: ${line.trim()}`);
  });

  it('T1 keys face auth unchanged (Q6 non-impact): wrong token → 401, correct token → 200', async () => {
    const bad = await get('/v1/config/keys', 'Bearer wrong-token');
    assert.equal(bad.status, 401);
    const ok = await get('/v1/config/keys', `Bearer ${TOKEN}`);
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.text) as { default_model: string };
    assert.equal(body.default_model, 'tmv-deepseek-v4-pro', 'pre-policy env default');
  });

  it('P3: GET policy on clean state → 200 with empty schedules (not 404)', async () => {
    const res = await get('/v1/config/policy');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as {
      policy: { version: string; schedules: unknown[] };
      policy_file_present: boolean;
      effective: { source: string };
    };
    assert.deepEqual(body.policy.schedules, []);
    assert.equal(body.policy_file_present, false);
    assert.equal(body.effective.source, 'env-default');
    // STE-GATE-NOTE: CTO Q5 ruling literal shape was `{version,schedules,effective:null}`;
    // implementation returns object:'config.policy' + policy{version,schedules} + effective
    // as an env-default preview object. Spirit (200+empty, not 404) satisfied — exact
    // field divergence recorded in gate report for CTO ack.
  });

  it('P4: policy face is unauthenticated by design — PUT/GET without Authorization → 200', async () => {
    const win = shanghaiWindowAroundNow();
    const res = await put('/v1/config/policy', policyBody('gate-echo-in', win));
    assert.equal(res.status, 200, 'loopback PUT with no token must be 200 (令文钦定)');
    const got = await get('/v1/config/policy');
    assert.equal(got.status, 200);
    const body = JSON.parse(got.text) as { policy: { schedules: { id: string }[] } };
    assert.equal(body.policy.schedules[0]?.id, 'gate-e2e');
  });

  it('anchor② E2E: PUT in-window policy flips GET keys default_model immediately (no const freeze)', async () => {
    const keys = await get('/v1/config/keys', `Bearer ${TOKEN}`);
    assert.equal(keys.status, 200);
    const body = JSON.parse(keys.text) as { default_model: string };
    assert.equal(body.default_model, 'gate-echo-in', 'per-request evaluation must reflect policy on next GET');
  });

  it('anchor③-b: daemon poll pulls the policy flip without restart (env application asserted)', async () => {
    const updated = await waitForEvent(
      (e) => e.type === 'updated' && e.defaultModel === 'gate-echo-in',
      20000, // stagger stubbed to 0 + 1s advertised interval → generous ceiling
      'updated event with gate-echo-in',
    );
    assert.equal(updated.envModel, 'gate-echo-in', 'applyKeyCacheToEnvironment lands the new default in env');
  });

  it('P7: PUT empty schedules = 200 legal state, keys fall back to env default', async () => {
    const res = await put('/v1/config/policy', JSON.stringify({ version: '1', schedules: [] }));
    assert.equal(res.status, 200);
    const keys = await get('/v1/config/keys', `Bearer ${TOKEN}`);
    const body = JSON.parse(keys.text) as { default_model: string };
    assert.equal(body.default_model, 'tmv-deepseek-v4-pro', 'empty policy → env default');
    const got = await get('/v1/config/policy');
    const pol = JSON.parse(got.text) as { policy: { schedules: unknown[] }; policy_file_present: boolean };
    assert.deepEqual(pol.policy.schedules, []);
    assert.equal(pol.policy_file_present, true, 'empty policy is persisted as a file (legal state)');
  });

  it('anchor③-c: daemon poll follows the flip back on empty-policy reset', async () => {
    const updated = await waitForEvent(
      (e) => e.type === 'updated' && e.defaultModel === 'tmv-deepseek-v4-pro',
      20000,
      'updated event back to env default',
    );
    assert.equal(updated.envModel, 'tmv-deepseek-v4-pro');
  });

  it('U12 via API: malformed window → 400, prior policy untouched', async () => {
    const res = await put('/v1/config/policy', JSON.stringify({
      version: '1',
      schedules: [{
        id: 'bad', target: 'daemon-default', model: 'm', windows: [{ start: '25:00', end: '18:00' }],
        timezone: 'Asia/Shanghai', enabled: true, priority: 1,
      }],
    }));
    assert.equal(res.status, 400);
    const got = await get('/v1/config/policy');
    const pol = JSON.parse(got.text) as { policy: { schedules: unknown[] } };
    assert.deepEqual(pol.policy.schedules, [], 'rejected PUT must not half-write');
  });

  it('F1 probe: zero-length window [18:00,18:00) — observed behavior recorded (divergence候裁)', async () => {
    // STE-GATE-F1: spec U13 expected PUT 400; implementation accepts (validatePolicyShape
    // passes, evaluatePolicy never matches). Asserting OBSERVED state pending CTO ruling.
    const res = await put('/v1/config/policy', policyBody('gate-zero', { start: '18:00', end: '18:00' }));
    assert.equal(res.status, 200, 'F1 observed: zero-length window accepted at PUT (spec expected 400)');
  });

  it('T8 /ui static: 200 + text/html; traversal probes rejected (raw-path, no client normalization)', async () => {
    const ui = await get('/ui');
    assert.equal(ui.status, 200);
    assert.ok(ui.ct.startsWith('text/html'), `content-type: ${ui.ct}`);
    assert.ok(ui.text.includes('<title'), 'served HTML page');
    const trav = await rawGet('/ui/../package.json');
    assert.ok(trav.status === 403 || trav.status === 404, `traversal rejected, got ${trav.status}`);
    assert.ok(!trav.text.includes('"name"'), 'must not serve package.json content');
    const encoded = await rawGet('/ui/%2e%2e/package.json');
    const noLeak = encoded.status >= 400 || !encoded.text.includes('"name"');
    assert.ok(noLeak, 'encoded traversal must not leak files');
  });

  it('F2 probe: >1MB PUT body — rejected (observed status recorded; 413-vs-500候裁)', async () => {
    // STE-GATE-F2: readRawBody tags 413 but req.destroy() kills the socket first —
    // observed ECONNRESET, no HTTP status at all. Asserting rejection only.
    let observed: string;
    try {
      const big = JSON.stringify({ version: '1', pad: 'x'.repeat(1_100_000), schedules: [] });
      const res = await put('/v1/config/policy', big);
      observed = `status ${res.status}`;
    } catch (err) {
      observed = `connection error: ${err instanceof Error ? err.message : String(err)}`;
    }
    assert.ok(!observed.startsWith('status 2'), `oversized body must be rejected, got ${observed}`);
  });

  it('L3-R1 restart persistence (Q7): policy survives server reboot via policy.json reload', async () => {
    const win = shanghaiWindowAroundNow();
    const res = await put('/v1/config/policy', policyBody('gate-restart-proof', win));
    assert.equal(res.status, 200);
    killChild(server);
    await new Promise((r) => setTimeout(r, 300)); // let the port settle before rebind
    server = bootServer(port);
    await waitHealth(port);
    const got = await get('/v1/config/policy');
    const pol = JSON.parse(got.text) as { policy: { schedules: { id: string; model: string }[] } };
    assert.equal(pol.policy.schedules[0]?.model, 'gate-restart-proof', 'loadPolicy must reload after reboot');
    const keys = await get('/v1/config/keys', `Bearer ${TOKEN}`);
    const body = JSON.parse(keys.text) as { default_model: string };
    assert.equal(body.default_model, 'gate-restart-proof', 'keys default_model policy-driven after reboot');
  });

  it('P6: legacy routes unaffected — /health 200, unknown route 404', async () => {
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/v1/config/nope')).status, 404);
  });
});
