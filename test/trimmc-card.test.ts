// ── LG-035 TriMMC 栏 tests ──
// Covers: card state machine (save→pending / status write-back applied|failed
// / invalid state 400 / no-card 404), fixed-rule engine semantics (always-match
// + priority over window), quota whitelist rejection, dangling-reference 400,
// ciphertext-at-rest (no plaintext on disk), admin token tri-state, and the
// UI channel-vocabulary absence assertion (卡片区域零出现).
// All disk writes via pathOverride into mkdtemp dirs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { evaluatePolicy, validatePolicyShape } from '../src/policy.js';
import { emptyCard, validateCard, loadCard, cardExists } from '../src/trimmc-card.js';
import type { TrimmcCardDocument } from '../src/trimmc-card.js';

function shanghaiInstant(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
}

describe('T2: fixed-rule engine semantics (零双轨 — same evaluatePolicy)', () => {
  it('fixed always matches (any time of day) and outranks lower-priority window rules', () => {
    const policy = {
      version: '1',
      schedules: [
        { id: 'win-low', target: 'daemon-default' as const, model: 'GLM-5.3', windows: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' as const, enabled: true, priority: 10 },
        { id: 'trimmc:e1', target: 'daemon-default' as const, model: 'deepseek-v4-pro', windows: [], timezone: 'Asia/Shanghai' as const, enabled: true, priority: 100, type: 'fixed' as const },
      ],
    };
    for (const hhmm of ['03:17', '14:00', '23:59', '00:00']) {
      const hit = evaluatePolicy(shanghaiInstant(hhmm), policy);
      assert.equal(hit?.matched_schedule_id, 'trimmc:e1', `fixed must win at ${hhmm}`);
      assert.equal(hit?.model, 'deepseek-v4-pro');
    }
  });

  it('higher-priority window still beats a lower-priority fixed inside the window; fixed takes over outside', () => {
    const policy = {
      version: '1',
      schedules: [
        { id: 'win-high', target: 'daemon-default' as const, model: 'GLM-5.3', windows: [{ start: '14:00', end: '18:00' }], timezone: 'Asia/Shanghai' as const, enabled: true, priority: 50 },
        { id: 'trimmc:e1', target: 'daemon-default' as const, model: 'deepseek-v4-pro', windows: [], timezone: 'Asia/Shanghai' as const, enabled: true, priority: 10, type: 'fixed' as const },
      ],
    };
    assert.equal(evaluatePolicy(shanghaiInstant('15:00'), policy)?.matched_schedule_id, 'win-high');
    assert.equal(evaluatePolicy(shanghaiInstant('20:00'), policy)?.matched_schedule_id, 'trimmc:e1');
    assert.equal(evaluatePolicy(shanghaiInstant('09:00'), policy)?.matched_schedule_id, 'trimmc:e1');
  });

  it('absent type defaults to window semantics (P1 back-compat)', () => {
    const policy = {
      version: '1',
      schedules: [
        { id: 'legacy', target: 'daemon-default' as const, model: 'deepseek-v4-pro', windows: [{ start: '14:00', end: '18:00' }], timezone: 'Asia/Shanghai' as const, enabled: true, priority: 1 },
      ],
    };
    assert.equal(evaluatePolicy(shanghaiInstant('15:00'), policy)?.matched_schedule_id, 'legacy');
    assert.equal(evaluatePolicy(shanghaiInstant('20:00'), policy), null);
  });

  it('quota whitelist: type=quota rejected at validation (schema-reserved, runtime 400)', async () => {
    const bad = { version: '1', schedules: [{ id: 'q', target: 'daemon-default', model: 'GLM-5.3', windows: [], timezone: 'Asia/Shanghai', enabled: true, priority: 1, type: 'quota' }] };
    assert.ok(validatePolicyShape(bad), 'shape validation must reject quota');
    const { handlePutPolicy } = await import('../src/api/policy.js');
    assert.equal(handlePutPolicy(JSON.stringify(bad)).statusCode, 400);
  });
});

describe('T1: card store — ciphertext at rest + structural validation', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-trimmc-test-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('PUT (plaintext api_key) → server encrypts → disk holds ciphertext only', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-tc';
    const { handlePutTrimmcCard } = await import('../src/api/trimmc-card.js');
    const cardPath = join(dir, 'trimmc-card.json');
    const doc = {
      ...emptyCard('本机连接'),
      provider_entries: {
        e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: 'sk-plain-visible-9999', enabled: true, updated_at: new Date().toISOString() },
      },
      rules: [{ rule_id: 'trimmc:e1', type: 'fixed', entry_id: 'e1' }],
    };
    const put = handlePutTrimmcCard('Bearer admin-tc', JSON.stringify(doc), { cardPath });
    assert.equal(put.statusCode, 200);
    assert.equal((put.body as { status: { state: string } }).status.state, 'pending', 'save semantics: status resets to pending');
    // Zero plaintext at rest
    assert.ok(existsSync(cardPath));
    const raw = readFileSync(cardPath, 'utf-8');
    assert.equal(raw.includes('sk-plain-visible-9999'), false, 'plaintext api_key must never hit the disk');
    // Encrypted entry decrypts back via the GET plane
    const { handleGetTrimmcCard } = await import('../src/api/trimmc-card.js');
    const get = handleGetTrimmcCard('Bearer admin-tc', { cardPath });
    assert.equal(get.statusCode, 200);
    const dec = (get.body as { entries_decrypted: Record<string, { api_key: string }> }).entries_decrypted.e1;
    assert.equal(dec.api_key, 'sk-plain-visible-9999');
    // Masked view never contains the full key
    const maskedText = JSON.stringify((get.body as { entries_masked: unknown }).entries_masked);
    assert.equal(maskedText.includes('sk-plain-visible-9999'), false);
    assert.ok(maskedText.includes('****9999'));
  });

  it('dangling rule reference → 400 (悬挂引用防删除漏洞同族)', () => {
    const doc = {
      ...emptyCard('c'),
      provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'AAAA', enabled: true, updated_at: 'x' } },
      rules: [{ rule_id: 'r', type: 'fixed' as const, entry_id: 'ghost-entry' }],
    };
    assert.ok(validateCard(doc).includes('does not reference an existing entry'));
  });

  it('catalog enforcement: entry model outside five-name catalog → 400', () => {
    const doc = {
      ...emptyCard('c'),
      provider_entries: { e1: { provider: 'deepseek', model: 'tmv-deepseek-v4-pro', api_key_encrypted: 'AAAA', enabled: true, updated_at: 'x' } },
      rules: [],
    };
    assert.ok(validateCard(doc).includes('official catalog'));
  });

  it('connection.name required (名称必填); rule type enum enforced', () => {
    const base = { version: 2, machine: { name: 'm' }, provider_entries: {}, rules: [], status: { state: 'pending', at: 'x' } };
    assert.ok(validateCard({ ...base, connection: {} }).includes('名称必填'));
    assert.ok(validateCard({ ...base, connection: { name: 'c' }, rules: [{ rule_id: 'r', type: 'quota', entry_id: 'x' }] }).includes("'fixed'|'window'"));
  });
});

describe('T1: card endpoints — admin tri-state + status write-back machine', () => {
  const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-trimmc-api-test-')); });
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
    rmSync(dir, { recursive: true, force: true });
  });

  const doc = (): TrimmcCardDocument => ({
    ...emptyCard('连接A'),
    provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } },
    rules: [],
  });

  it('tri-state: unset token → 503; wrong token → 401; correct → 200', async () => {
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    const m = await import('../src/api/trimmc-card.js');
    assert.equal(m.handleGetTrimmcCard('Bearer x', { cardPath: join(dir, 'c.json') }).statusCode, 503);
    process.env.TRIMODEL_ADMIN_TOKEN = 'tc-secret';
    assert.equal(m.handleGetTrimmcCard('Bearer wrong', { cardPath: join(dir, 'c.json') }).statusCode, 401);
    assert.equal(m.handleGetTrimmcCard('Bearer tc-secret', { cardPath: join(dir, 'c.json') }).statusCode, 200);
  });

  it('state machine: save→pending; applied write-back; failed write-back with error; invalid state 400; no-card 404', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'tc-secret';
    const m = await import('../src/api/trimmc-card.js');
    const cardPath = join(dir, 'c.json');
    const auth = 'Bearer tc-secret';

    const put = m.handlePutTrimmcCard(auth, JSON.stringify(doc()), { cardPath });
    assert.equal(put.statusCode, 200);
    assert.equal((put.body as { status: { state: string } }).status.state, 'pending');

    const applied = m.handlePutTrimmcCardStatus(auth, JSON.stringify({ state: 'applied' }), { cardPath });
    assert.equal(applied.statusCode, 200);
    const appliedState = (applied.body as { status: { state: string; at: string } }).status;
    assert.equal(appliedState.state, 'applied');
    assert.ok(appliedState.at);

    const failed = m.handlePutTrimmcCardStatus(auth, JSON.stringify({ state: 'failed', error: 'apply boom' }), { cardPath });
    assert.equal(failed.statusCode, 200);
    const failedState = (failed.body as { status: { state: string; error?: string } }).status;
    assert.equal(failedState.state, 'failed');
    assert.equal(failedState.error, 'apply boom');

    assert.equal(m.handlePutTrimmcCardStatus(auth, JSON.stringify({ state: 'pending' }), { cardPath }).statusCode, 400, 'pending is save-only');
    assert.equal(m.handlePutTrimmcCardStatus(auth, JSON.stringify({ state: 'weird' }), { cardPath }).statusCode, 400);
    assert.equal(m.handlePutTrimmcCardStatus(auth, JSON.stringify({ state: 'applied' }), { cardPath: join(dir, 'nope.json') }).statusCode, 404);
  });

  it('routes wired: GET card / PUT card / PUT status through dispatch', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'tc-secret';
    const { dispatch } = await import('../src/api/routes.js');
    const auth = { authorization: 'Bearer tc-secret' };
    assert.equal((await dispatch({} as never, 'GET', '/v1/config/trimmc-card', auth)).statusCode, 200);
    assert.equal((await dispatch({} as never, 'PUT', '/v1/config/trimmc-card/status', auth, JSON.stringify({ state: 'applied' }))).statusCode, 404, 'no card yet at repo root → 404');
    assert.equal((await dispatch({} as never, 'DELETE', '/v1/config/trimmc-card', auth)).statusCode, 404, 'dispatch fallback (routes.ts 现役兜底 404，零行为变更)');
  });
});

describe('T3: UI — card DOM channel-vocabulary absence (通道词汇零出现)', () => {
  it('ui/index.html TriMMC section contains no channel vocabulary and no push/apply button', () => {
    const uiPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
    const html = readFileSync(uiPath, 'utf-8');
    for (const banned of ['SSH', 'ssh', '隧道', 'tunnel', '推送卡', 'apply-to-machine']) {
      assert.equal(html.includes(banned), false, `channel vocabulary '${banned}' must not appear in the card UI`);
    }
    // Card section has no apply/push button (保存卡片=COS 拉取语义，非推送)
    const cardSection = html.slice(html.indexOf('TriMMC 机器栏'), html.indexOf('密钥管理（keys.enc'));
    assert.equal(cardSection.includes('id="tc-push"'), false);
    assert.ok(cardSection.includes('按时段/额度自动切换将于后续版本提供'), 'reserved-capability copy must be present');
  });
});
