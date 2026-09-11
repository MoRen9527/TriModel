// ── LG-035 STE gate: secure key plane 410 退役对表 + TriMMC 卡片 key 语义（S5 存储归并）──
// STE 小柯门禁（1de9fe5 退役落地对表）：secure 写面=410 Gone+人话指引（无条件，先于
// 鉴权面）；三态鉴权族迁移到卡片端点（PUT trimmc-card 503/401/200 同构）；KB 族迁移：
// KB1 密文落盘→卡片条目/KB2 活源链→key-source（card entries→env 回落）/KB3 masked 拒
// →卡片前置/KB4 fail-safe→卡片损坏回落/KB6 SEC 零泄漏扫描保留。
// keys.enc boot 自动迁移 .migrated 语义归 FSD ui-boot 族（9/9 在卷），本席不重复。
// 仓库根运行态快照协议：policy.json + trimmc-card.json。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { handlePutSecureKeys, handleSecureKeysStatus } from '../src/api/keys.js';
import { handlePutTrimmcCard } from '../src/api/trimmc-card.js';
import { emptyCard } from '../src/trimmc-card.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = join(REPO_ROOT, 'policy.json');
const CARD_FILE = join(REPO_ROOT, 'trimmc-card.json');
const TRANS_LOG = join(REPO_ROOT, 'model-transitions.jsonl');
const ADMIN_TOKEN = 'ste-admin-token';
const API_TOKEN = 'ste-gate-token';
const ENV_KEY = 'sk-env-deepseek-base-value';
const CARD_KEY = 'sk-gate-card-value-4242';

let server: ChildProcess | null = null;
let port = 0;
let workDir = '';
const snap = { card: null as string | null, policy: null as string | null, log: null as string | null };

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

function cardBody(entryKey: string): string {
  // wire shape: PUT accepts plaintext api_key (pre-hydration); stored CardEntry
  // carries api_key_encrypted — so build the wire doc loosely, not via the
  // typed CardEntry (which would reject the api_key field).
  const doc = emptyCard('ste-gate-machine') as unknown as Record<string, unknown>;
  doc.provider_entries = {
    'gate-e2e': {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      api_key: entryKey,
      enabled: true,
      updated_at: new Date().toISOString(),
    },
  };
  return JSON.stringify(doc);
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

describe('GATE S5 in-process: secure write plane retired (410) + card three-state auth matrix', () => {
  const savedAdmin = process.env.TRIMODEL_ADMIN_TOKEN;

  after(() => {
    if (savedAdmin === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN;
    else process.env.TRIMODEL_ADMIN_TOKEN = savedAdmin;
  });

  it('KB5-410: PUT /v1/config/keys/secure → 410 Gone + 人话指引（有/无令牌皆然，先于鉴权面）', () => {
    const tmp = join(mkdtempSync(join(tmpdir(), 'ste-kb510-')), 'k.enc');
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    const noTok = handlePutSecureKeys(undefined, JSON.stringify({ provider: 'deepseek', api_key: CARD_KEY }), { keystorePath: tmp });
    assert.equal(noTok.statusCode, 410, 'retired plane answers 410 even without token');
    assert.ok(/已升级|条目/.test(String(noTok.body.error)), '人话指引必须出现（旧密钥已自动迁移语义）');
    process.env.TRIMODEL_ADMIN_TOKEN = ADMIN_TOKEN;
    const withTok = handlePutSecureKeys(`Bearer ${ADMIN_TOKEN}`, '{}', { keystorePath: tmp });
    assert.equal(withTok.statusCode, 410, 'retirement overrides the auth plane');
    assert.ok(!existsSync(tmp), '410 must not create any keystore');
  });

  it('KB5-card 三态迁移: card PUT 503(未配置)/401(错令牌)/200(凭据对)+status 端点同族', () => {
    const tmp = join(mkdtempSync(join(tmpdir(), 'ste-kb5c-')), 'trimmc-card.json');
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    assert.equal(handlePutTrimmcCard('Bearer x', cardBody(CARD_KEY), { cardPath: tmp }).statusCode, 503, 'fail-closed 缺省禁用');
    assert.equal(handleSecureKeysStatus(undefined, { cardPath: tmp }).statusCode, 503);
    process.env.TRIMODEL_ADMIN_TOKEN = ADMIN_TOKEN;
    assert.equal(handlePutTrimmcCard(undefined, cardBody(CARD_KEY), { cardPath: tmp }).statusCode, 401);
    assert.equal(handlePutTrimmcCard('Bearer wrong', cardBody(CARD_KEY), { cardPath: tmp }).statusCode, 401);
    const ok = handlePutTrimmcCard(`Bearer ${ADMIN_TOKEN}`, cardBody(CARD_KEY), { cardPath: tmp });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.body as { status: { state: string } }).status.state, 'pending', '保存语义=待应用');
    rmSync(tmp, { force: true });
  });
});

describe('GATE S5 E2E: card-key live chain over real HTTP server (single boot)', () => {
  before(async () => {
    snap.card = existsSync(CARD_FILE) ? readFileSync(CARD_FILE, 'utf-8') : null;
    snap.policy = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf-8') : null;
    snap.log = existsSync(TRANS_LOG) ? readFileSync(TRANS_LOG, 'utf-8') : null;
    rmSync(CARD_FILE, { force: true });
    rmSync(POLICY_FILE, { force: true });
    rmSync(TRANS_LOG, { force: true });
    workDir = mkdtempSync(join(tmpdir(), 'ste-gate-s5-'));
    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRIMODEL_PORT: String(port),
      TRIMODEL_API_TOKEN: API_TOKEN,
      TRIMODEL_ADMIN_TOKEN: ADMIN_TOKEN,
      TRIMODEL_DEFAULT_MODEL: 'deepseek-v4-pro', // pin baseline for transition asserts
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
    if (snap.card === null) rmSync(CARD_FILE, { force: true });
    else writeFileSync(CARD_FILE, snap.card, 'utf-8');
    if (snap.policy === null) rmSync(POLICY_FILE, { force: true });
    else writeFileSync(POLICY_FILE, snap.policy, 'utf-8');
    if (snap.log === null) rmSync(TRANS_LOG, { force: true });
    else writeFileSync(TRANS_LOG, snap.log, 'utf-8');
  });

  it('E2E-410 + no-read-back: retired PUT answers 410 with 人话; GET secure stays 404', async () => {
    const res = await put('/v1/config/keys/secure', JSON.stringify({ provider: 'deepseek', api_key: CARD_KEY }), `Bearer ${ADMIN_TOKEN}`);
    assert.equal(res.status, 410);
    assert.ok(/已升级|条目/.test(res.text), '人话指引 over HTTP');
    assert.equal((await get('/v1/config/keys/secure')).status, 404);
  });

  it('KB1-card: card PUT → 200 pending; disk zero plaintext; status=migration indicator; GET plane masked-only', async () => {
    const res = await put('/v1/config/trimmc-card', cardBody(CARD_KEY), `Bearer ${ADMIN_TOKEN}`);
    assert.equal(res.status, 200);
    assert.ok(existsSync(CARD_FILE), '卡片落盘');
    assert.ok(!readFileSync(CARD_FILE).includes(CARD_KEY, 'utf-8'), '卡片磁盘字节零明文（SEC 不回退）');
    // S5: status endpoint = legacy migration indicator (masked tails moved to card GET plane)
    const st = await get('/v1/config/keys/secure/status', `Bearer ${ADMIN_TOKEN}`);
    assert.equal(st.status, 200);
    const stBody = JSON.parse(st.text) as { card_present: boolean; message: string };
    assert.equal(stBody.card_present, true);
    assert.ok(stBody.message.length > 5, '人话迁移指示在位');
    assert.ok(!st.text.includes(CARD_KEY), 'status must not leak plaintext');
    // card GET plane: decrypted entries for COS channel; masked view never carries full key
    const cardGet = await get('/v1/config/trimmc-card', `Bearer ${ADMIN_TOKEN}`);
    assert.equal(cardGet.status, 200);
    const cardBodyParsed = JSON.parse(cardGet.text) as {
      entries_decrypted: Record<string, { api_key: string }>;
      entries_masked: Record<string, { masked?: string }>;
    };
    assert.equal(cardBodyParsed.entries_decrypted['gate-e2e']?.api_key, CARD_KEY, 'GET 解密面=COS 通道语义');
    const maskedText = JSON.stringify(cardBodyParsed.entries_masked);
    assert.ok(!maskedText.includes(CARD_KEY), 'masked view must not contain full key');
    assert.ok(maskedText.includes('****'), 'masked view carries tail-4');
  });

  it('KB2-keysource: enabled card entry overrides env in GET /v1/config/keys (card→env chain)', async () => {
    const keys = await get('/v1/config/keys', `Bearer ${API_TOKEN}`);
    const kb = JSON.parse(keys.text) as { keys: { deepseek: { api_key: string } } };
    assert.equal(kb.keys.deepseek?.api_key, CARD_KEY, '卡片条目=唯一活源，覆盖 env 引导值');
  });

  it('KB3-masked: card PUT rejects masked-pattern api_key → 400 (pre-hydration guard)', async () => {
    const res = await put('/v1/config/trimmc-card', cardBody('sk-ab****'), `Bearer ${ADMIN_TOKEN}`);
    assert.equal(res.status, 400, 'masked 形态值卡片前置拒收');
  });

  it('A local half: policy flip → whitelisted transition record; KB6 whole-log zero-secret scan', async () => {
    await get('/v1/config/keys', `Bearer ${API_TOKEN}`); // pin lastReported = env default
    const res = await put('/v1/config/policy', JSON.stringify({
      version: '1',
      schedules: [{
        id: 'gate-p2-flip', target: 'daemon-default', model: 'GLM-5.3', windows: [shanghaiWindowAroundNow()],
        timezone: 'Asia/Shanghai', enabled: true, priority: 10,
      }],
    }));
    assert.equal(res.status, 200);
    const keys = await get('/v1/config/keys', `Bearer ${API_TOKEN}`);
    const kb = JSON.parse(keys.text) as { default_model: string };
    assert.equal(kb.default_model, 'GLM-5.3', 'flip active on next GET');

    const lines = readFileSync(TRANS_LOG, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    const logText = readFileSync(TRANS_LOG, 'utf-8');
    const recs = lines;
    assert.ok(recs.length >= 1, '至少一条跃迁记录');
    const last = JSON.parse(recs[recs.length - 1]) as Record<string, unknown>;
    assert.equal(last.from, 'deepseek-v4-pro');
    assert.equal(last.to, 'GLM-5.3');
    assert.equal(last.source, 'policy');
    const ALLOWED = new Set(['at', 'from', 'to', 'source', 'matched_schedule_id']);
    for (const line of recs) {
      const rec = JSON.parse(line) as Record<string, unknown>;
      for (const k of Object.keys(rec)) assert.ok(ALLOWED.has(k), `field '${k}' outside SEC whitelist`);
    }
    assert.ok(!logText.includes('api_key') && !logText.includes('apiKey'));
    assert.ok(!logText.includes(CARD_KEY) && !logText.includes(ENV_KEY));
  });

  it('KB4 fail-safe: corrupt trimmc-card.json → env fallback, server alive', async () => {
    writeFileSync(CARD_FILE, Buffer.from('not a card at all'));
    assert.equal((await get('/health')).status, 200);
    const keys = await get('/v1/config/keys', `Bearer ${API_TOKEN}`);
    const kb = JSON.parse(keys.text) as { keys: { deepseek: { api_key: string } } };
    assert.equal(kb.keys.deepseek?.api_key, ENV_KEY, '损坏卡片回落 env 引导值');
  });
});
