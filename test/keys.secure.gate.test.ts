// ── LG-035 P2 STE gate: secure key plane (B) + transition detector (A local half) ──
// STE 小柯门禁（spec: TriCompany/docs/test/lg-035-p2-trimodel-gate-spec.md v0.2→执行）。
// 三态鉴权（KB5）=进程内 handler 实测：repo-root .env 经 dotenv 注入 TRIMODEL_ADMIN_TOKEN，
// 子进程 env 删不净（override:false），fail-closed 503 态只有进程内可控——2026-09-11 实证。
// E2E 单 boot（admin token 由 env 显式设置，dotenv 不覆盖已有值）：密文落盘/overlay/无读回/
// status masked/跃迁记录白名单+KB6 全文零泄漏/损坏 fail-safe/KB3 掩码形态观测。
// 教训沿用（P1 T1）：仓库根运行态三件（keys.enc/model-transitions.jsonl/policy.json）快照协议。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { handlePutSecureKeys } from '../src/api/keys.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_ENC = join(REPO_ROOT, 'keys.enc');
const TRANS_LOG = join(REPO_ROOT, 'model-transitions.jsonl');
const POLICY_FILE = join(REPO_ROOT, 'policy.json');
const ADMIN_TOKEN = 'ste-admin-token';
const API_TOKEN = 'ste-gate-token';
const ENV_KEY = 'sk-env-deepseek-base-value';
const ENC_KEY = 'sk-gate-enc-value-9876';

let server: ChildProcess | null = null;
let port = 0;
let workDir = '';
const snap = { enc: null as string | null, log: null as string | null, policy: null as string | null };

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolveP(p));
    });
    srv.on('error', reject);
  });
}

async function killAndWait(c: ChildProcess | null): Promise<void> {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const done = new Promise<void>((res) => c.once('exit', () => res()));
  c.kill();
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
}

async function waitHealth(timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server :${port} not healthy in ${timeoutMs}ms`);
}

async function get(path: string, auth?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, text: await res.text() };
}

async function put(path: string, body: string, auth?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'PUT', headers, body });
  return { status: res.status, text: await res.text() };
}

function shanghaiWindowAroundNow(minutesRadius = 30): { start: string; end: string } {
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

describe('GATE P2-B in-process: three-state auth matrix (env-controlled, tmp keystore)', () => {
  const savedAdmin = process.env.TRIMODEL_ADMIN_TOKEN;

  after(() => {
    if (savedAdmin === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN;
    else process.env.TRIMODEL_ADMIN_TOKEN = savedAdmin;
  });

  it('KB5-a fail-closed: TRIMODEL_ADMIN_TOKEN unset → 503 disabled, nothing written', () => {
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    const tmp = join(mkdtempSync(join(tmpdir(), 'ste-kb5-')), 'k.enc');
    const res = handlePutSecureKeys('Bearer whatever', JSON.stringify({ provider: 'deepseek', api_key: ENC_KEY }), { keystorePath: tmp });
    assert.equal(res.statusCode, 503, 'write plane disabled by default (fail-closed)');
    assert.ok(!existsSync(tmp), '503 must not create a keystore');
  });

  it('KB5-b/c: token set → no/wrong creds 401; correct creds 200 (tmp keystore); unknown provider 400', () => {
    process.env.TRIMODEL_ADMIN_TOKEN = ADMIN_TOKEN;
    const tmp = join(mkdtempSync(join(tmpdir(), 'ste-kb5-')), 'k.enc');
    const body = JSON.stringify({ provider: 'deepseek', api_key: ENC_KEY });
    assert.equal(handlePutSecureKeys(undefined, body, { keystorePath: tmp }).statusCode, 401);
    assert.equal(handlePutSecureKeys("Bearer wrong", body, { keystorePath: tmp }).statusCode, 401);
    const ok = handlePutSecureKeys(`Bearer ${ADMIN_TOKEN}`, body, { keystorePath: tmp });
    assert.equal(ok.statusCode, 200);
    const okBody = JSON.parse(JSON.stringify(ok.body)) as { masked: string };
    assert.equal(okBody.masked, `****${ENC_KEY.slice(-4)}`);
    assert.ok(!JSON.stringify(ok.body).includes(ENC_KEY), 'response must not echo plaintext');
    assert.equal(handlePutSecureKeys(`Bearer ${ADMIN_TOKEN}`, JSON.stringify({ provider: 'nope', api_key: 'x' }), { keystorePath: tmp }).statusCode, 400);
    rmSync(join(tmp, '..'), { recursive: true, force: true });
  });
});

describe('GATE P2-B/A E2E: single-boot server (admin token via env)', () => {
  before(async () => {
    snap.enc = existsSync(KEYS_ENC) ? readFileSync(KEYS_ENC).toString('base64') : null;
    snap.log = existsSync(TRANS_LOG) ? readFileSync(TRANS_LOG, 'utf-8') : null;
    snap.policy = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf-8') : null;
    rmSync(KEYS_ENC, { force: true });
    rmSync(TRANS_LOG, { force: true });
    rmSync(POLICY_FILE, { force: true });
    workDir = mkdtempSync(join(tmpdir(), 'ste-gate-p2-'));
    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRIMODEL_PORT: String(port),
      TRIMODEL_API_TOKEN: API_TOKEN,
      TRIMODEL_ADMIN_TOKEN: ADMIN_TOKEN, // env wins over dotenv(override:false) .env injection
      TRIMODEL_DEFAULT_MODEL: 'tmv-deepseek-v4-pro', // pin baseline for transition asserts
      DEEPSEEK_API_KEY: ENV_KEY,
    };
    server = spawn(process.execPath, ['--import', 'tsx', join('src', 'server.ts')], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth();
  });

  after(async () => {
    await killAndWait(server);
    rmSync(workDir, { recursive: true, force: true });
    if (snap.enc === null) rmSync(KEYS_ENC, { force: true });
    else writeFileSync(KEYS_ENC, Buffer.from(snap.enc, 'base64'));
    if (snap.log === null) rmSync(TRANS_LOG, { force: true });
    else writeFileSync(TRANS_LOG, snap.log, 'utf-8');
    if (snap.policy === null) rmSync(POLICY_FILE, { force: true });
    else writeFileSync(POLICY_FILE, snap.policy, 'utf-8');
  });

  it('KB1: PUT secure → 200 masked-only echo; keys.enc ciphertext at rest; overlay overrides env key', async () => {
    const res = await put('/v1/config/keys/secure', JSON.stringify({ provider: 'deepseek', api_key: ENC_KEY }), `Bearer ${ADMIN_TOKEN}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(ENC_KEY), 'response must not echo plaintext key material');

    assert.ok(existsSync(KEYS_ENC), 'keys.enc persisted');
    assert.ok(!readFileSync(KEYS_ENC).includes(ENC_KEY, 'utf-8'), 'keys.enc bytes contain zero plaintext');

    const keys = await get('/v1/config/keys', `Bearer ${API_TOKEN}`);
    const kb = JSON.parse(keys.text) as { keys: { deepseek: { api_key: string } } };
    assert.equal(kb.keys.deepseek?.api_key, ENC_KEY, 'keys.enc overlay must override env L1 key');
  });

  it('no read-back endpoint + status masked-only (admin Bearer protected)', async () => {
    assert.equal((await get('/v1/config/keys/secure')).status, 404);
    assert.equal((await get('/v1/config/keys/secure/status', 'Bearer wrong')).status, 401);
    const st = await get('/v1/config/keys/secure/status', `Bearer ${ADMIN_TOKEN}`);
    assert.equal(st.status, 200);
    assert.ok(st.text.includes(`****${ENC_KEY.slice(-4)}`));
    assert.ok(!st.text.includes(ENC_KEY), 'status must not leak plaintext');
  });

  it('A local half: policy flip → whitelisted transition record; KB6 whole-log zero-secret scan', async () => {
    await get('/v1/config/keys', `Bearer ${API_TOKEN}`); // pin lastReported = env default
    const res = await put('/v1/config/policy', JSON.stringify({
      version: '1',
      schedules: [{
        id: 'gate-p2-flip', target: 'daemon-default', model: 'gate-p2-flip', windows: [shanghaiWindowAroundNow()],
        timezone: 'Asia/Shanghai', enabled: true, priority: 10,
      }],
    }));
    assert.equal(res.status, 200);
    const keys = await get('/v1/config/keys', `Bearer ${API_TOKEN}`);
    const kb = JSON.parse(keys.text) as { default_model: string };
    assert.equal(kb.default_model, 'gate-p2-flip', 'flip active on next GET');

    assert.ok(existsSync(TRANS_LOG), 'transition log must exist after flip+GET');
    const lines = readFileSync(TRANS_LOG, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length >= 1);
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    assert.equal(last.from, 'tmv-deepseek-v4-pro');
    assert.equal(last.to, 'gate-p2-flip');
    assert.equal(last.source, 'policy');

    const ALLOWED = new Set(['at', 'from', 'to', 'source', 'matched_schedule_id']);
    for (const line of lines) {
      const rec = JSON.parse(line) as Record<string, unknown>;
      for (const k of Object.keys(rec)) assert.ok(ALLOWED.has(k), `field '${k}' outside SEC whitelist`);
    }
    const whole = readFileSync(TRANS_LOG, 'utf-8');
    assert.ok(!whole.includes('api_key') && !whole.includes('apiKey'));
    assert.ok(!/sk-[A-Za-z0-9]{4,}/.test(whole), 'no sk-prefixed material in log');
    assert.ok(!whole.includes(ENC_KEY) && !whole.includes(ENV_KEY));
  });

  it('KB4 corruption fail-safe: garbage keys.enc → env fallback, server alive', async () => {
    writeFileSync(KEYS_ENC, Buffer.from('this is not ciphertext at all'));
    assert.equal((await get('/health')).status, 200);
    const keys = await get('/v1/config/keys', `Bearer ${API_TOKEN}`);
    const kb = JSON.parse(keys.text) as { keys: { deepseek: { api_key: string } } };
    assert.equal(kb.keys.deepseek?.api_key, ENV_KEY, 'corrupt keys.enc degrades to env bootstrap key');
  });

  it('KB3 adjudicated: masked-pattern api_key → PUT 400 (server-side second gate, 99f78ca)', async () => {
    // STE-GATE-KB3 resolved (CTO 16:04 ruling): the server rejects any masked-looking
    // value (contains '*') with 400 — echo-pollution defense-in-depth over the
    // UI-layer guard (F1-P2 fixed).
    const res = await put('/v1/config/keys/secure', JSON.stringify({ provider: 'anthropic', api_key: 'sk-ab****' }), `Bearer ${ADMIN_TOKEN}`);
    assert.equal(res.status, 400, 'masked-pattern value must be rejected server-side (F1-P2 fixed in 99f78ca)');
    assert.ok(!existsSync(KEYS_ENC) || !readFileSync(KEYS_ENC).includes('sk-ab****', 'utf-8'), 'rejected value must not be stored');
  });
});
