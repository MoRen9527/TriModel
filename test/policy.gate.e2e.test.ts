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
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = join(REPO_ROOT, 'policy.json');
const POLICY_LOCAL = join(REPO_ROOT, 'policies', 'local.json'); // S11 runtime file
const TRANS_LOG = join(REPO_ROOT, 'model-transitions.jsonl'); // P2 runtime file: this suite's GETs record transitions
const TOKEN = 'ste-gate-token';

let server: ChildProcess | null = null;
let poller: ChildProcess | null = null;
let port = 0;
let workDir = '';
let snapshot: string | null = null; // prior policy.json content (null = absent)
let snapLocal: string | null = null; // S11 policies/local.json
let savedDefaultModel: string | undefined; // 环境隔离：TRIMODEL_DEFAULT_MODEL 现势摘除前值
let cardStash: string | null = null; // 卡面隔离：repo 根真卡 stash 路径（null=原无卡）
const CARD_FILE_REPO = join(REPO_ROOT, 'trimmc-card.json');
let snapLog: string | null = null; // prior model-transitions.jsonl content (null = absent)

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
  // 卡面隔离（2026-09-14）：server main 注册卡默认层（registerCardDefaultModelFn
  // → loadCard → cwd 卡）——本机现役卡 default_model 会盖过「env 出厂默认」断言。
  env.TRIMODEL_CARD_FILE = join(workDir, 'gate-no-card.json');
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
    // 环境隔离（2026-09-14）：本机系统 env 携 TRIMODEL_DEFAULT_MODEL=GLM-5.3
    // （演示现势）会穿透「pre-policy env default=deepseek-v4-pro 出厂」断言——
    // 测试进程+poller 子进程（继承 process.env）一并摘除，出厂默认单源。
    savedDefaultModel = process.env.TRIMODEL_DEFAULT_MODEL;
    delete process.env.TRIMODEL_DEFAULT_MODEL;
    snapshot = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf-8') : null;
    snapLocal = existsSync(POLICY_LOCAL) ? readFileSync(POLICY_LOCAL, 'utf-8') : null;
    snapLog = existsSync(TRANS_LOG) ? readFileSync(TRANS_LOG, 'utf-8') : null;
    // 卡面隔离（2026-09-14 补强）：server main 的 migrateLegacyDistCard 会把
    // legacy 邻接位（tsx 下=repo 根真卡）rename 到 canonical——先主动搬开真卡
    // （stash 于 workDir），server 卡层（TRIMODEL_CARD_FILE 钉不存在路径）恒
    // null，after 原样放回。防真卡被测试搬走/被 v4 迁移改写。
    cardStash = existsSync(CARD_FILE_REPO) ? join(mkdtempSync(join(tmpdir(), 'ste-gate-card-')), 'trimmc-card.json') : null;
    if (cardStash) { copyFileSync(CARD_FILE_REPO, cardStash); rmSync(CARD_FILE_REPO); } // EXDEV：跨盘 rename 拒，copy+rm
    rmSync(POLICY_FILE, { force: true });
    rmSync(POLICY_LOCAL, { force: true }); // deterministic init: pre-policy env default
    rmSync(TRANS_LOG, { force: true });
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
    if (savedDefaultModel === undefined) delete process.env.TRIMODEL_DEFAULT_MODEL; else process.env.TRIMODEL_DEFAULT_MODEL = savedDefaultModel;
    if (cardStash) { try { copyFileSync(cardStash, CARD_FILE_REPO); } catch { /* stash restore best-effort */ } }
    killChild(poller);
    killChild(server);
    rmSync(workDir, { recursive: true, force: true });
    // snapshot-restore protocol: leave repo root exactly as found
    if (snapshot === null) rmSync(POLICY_FILE, { force: true });
    else writeFileSync(POLICY_FILE, snapshot, 'utf-8');
    if (snapLocal === null) rmSync(POLICY_LOCAL, { force: true });
    else writeFileSync(POLICY_LOCAL, snapLocal, 'utf-8');
    if (snapLog === null) rmSync(TRANS_LOG, { force: true });
    else writeFileSync(TRANS_LOG, snapLog, 'utf-8');
  });

  it('anchor③-a: daemon initial pull reflects pre-policy env default (real chain, stubs annotated)', async () => {
    const init = await waitForEvent((e) => e.type === 'init', 15000, 'init event');
    assert.equal(init.defaultModel, 'deepseek-v4-pro', 'initial fetch before any policy');
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
    assert.equal(body.default_model, 'deepseek-v4-pro', 'pre-policy env default');
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
    const res = await put('/v1/config/policy', policyBody('GLM-5.3', win));
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
    assert.equal(body.default_model, 'GLM-5.3', 'per-request evaluation must reflect policy on next GET');
  });

  it('anchor③-b: daemon poll pulls the policy flip without restart (env application asserted)', async () => {
    const updated = await waitForEvent(
      (e) => e.type === 'updated' && e.defaultModel === 'GLM-5.3',
      20000, // stagger stubbed to 0 + 1s advertised interval → generous ceiling
      'updated event with GLM-5.3',
    );
    assert.equal(updated.envModel, 'GLM-5.3', 'applyKeyCacheToEnvironment lands the new default in env');
  });

  it('P7: PUT empty schedules = 200 legal state, keys fall back to env default', async () => {
    const res = await put('/v1/config/policy', JSON.stringify({ version: '1', schedules: [] }));
    assert.equal(res.status, 200);
    const keys = await get('/v1/config/keys', `Bearer ${TOKEN}`);
    const body = JSON.parse(keys.text) as { default_model: string };
    assert.equal(body.default_model, 'deepseek-v4-pro', 'empty policy → env default');
    const got = await get('/v1/config/policy');
    const pol = JSON.parse(got.text) as { policy: { schedules: unknown[] }; policy_file_present: boolean };
    assert.deepEqual(pol.policy.schedules, []);
    assert.equal(pol.policy_file_present, true, 'empty policy is persisted as a file (legal state)');
  });

  it('anchor③-c: daemon poll follows the flip back on empty-policy reset', async () => {
    const updated = await waitForEvent(
      (e) => e.type === 'updated' && e.defaultModel === 'deepseek-v4-pro',
      20000,
      'updated event back to env default',
    );
    assert.equal(updated.envModel, 'deepseek-v4-pro');
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

  it('F1 adjudicated: zero-length window [18:00,18:00) → PUT 400 (CTO 14:42 ruling, f7f90c6)', async () => {
    // STE-GATE-F1 resolved: validatePolicyShape now rejects start==end at write time
    // (config semantics aligned with engine U13a zero-match). Was observed-200 pre-fix.
    const res = await put('/v1/config/policy', policyBody('deepseek-flash', { start: '18:00', end: '18:00' }));
    assert.equal(res.status, 400, 'zero-length window must be rejected at PUT (F1 fixed in f7f90c6)');
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

  it('F2 probe (adjudicated: connection-level defense, not spec 413): >1MB PUT body — rejected', async () => {
    // STE-GATE-F2 resolved (CTO 14:42 ruling: 改口): oversized body is killed at the
    // connection level (ECONNRESET, no HTTP status) — accepted as connection-level
    // defense, NOT a spec 413. Content-Length pre-check deferred to a later batch.
    // Assertion stays at rejection level.
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
    const res = await put('/v1/config/policy', policyBody('deepseek-flash', win));
    assert.equal(res.status, 200);
    killChild(server);
    await new Promise((r) => setTimeout(r, 300)); // let the port settle before rebind
    server = bootServer(port);
    await waitHealth(port);
    const got = await get('/v1/config/policy');
    const pol = JSON.parse(got.text) as { policy: { schedules: { id: string; model: string }[] } };
    assert.equal(pol.policy.schedules[0]?.model, 'deepseek-flash', 'loadPolicy must reload after reboot');
    const keys = await get('/v1/config/keys', `Bearer ${TOKEN}`);
    const body = JSON.parse(keys.text) as { default_model: string };
    assert.equal(body.default_model, 'deepseek-flash', 'keys default_model policy-driven after reboot');
  });

  it('P6: legacy routes unaffected — /health 200, unknown route 404', async () => {
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/v1/config/nope')).status, 404);
  });
});
