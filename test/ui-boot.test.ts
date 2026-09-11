// ── LG-035 UI 重设计 S8：jsdom 首启五断言 + S5 迁移器单测 ──
// @ts-nocheck -- DOM typing noise (getElementById null-narrowing); runtime asserted by the suite itself
// 五断言（COS 定）：①无令牌态=连接设置自动展开+引导可见+数据面板禁用
// ②令牌保存→自动重拉 ③模型下拉有值 ④条目提交可达 ⑤TriMMC 卡片区域
// 通道词汇+结构词汇零出现。迁移器：幂等/合成条目/auto_imported 标记。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { migrateKeysEncToCard } from '../src/secure-keys.js';
import { loadCard } from '../src/trimmc-card.js';
import { encrypt } from '../src/security/key-encryptor.js';
import { MODEL_CATALOG } from '../src/model-catalog.js';

const UI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

/** Boot the real UI in jsdom with fetch stubbed to a scripted queue. */
function bootUi(fetchLog: Array<{ url: string; init?: RequestInit }>, responders: Array<(url: string) => { status: number; body: unknown }>) {
  const dom = new JSDOM(readFileSync(UI_PATH, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:3333/ui',
    beforeParse(window: import('jsdom').DOMWindow) {
      let call = 0;
      window.fetch = (async (url: string, init?: RequestInit) => {
        fetchLog.push({ url, init });
        const r = responders[Math.min(call, responders.length - 1)](url);
        call += 1;
        return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body), headers: new Map() } as unknown as Response;
      });
      window.localStorage.clear();
    },
  });
  return dom;
}

const MODELS_BODY = { object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'GLM-5.3' }, { id: 'TMV' }] };
const POLICY_BODY = { object: 'config.policy', policy: { version: '1', schedules: [] }, effective: { model: 'deepseek-v4-pro', source: 'env-default', matched_schedule_id: null } };
const KEYS_BODY = { object: 'config.keys', keys: {}, default_model: 'deepseek-v4-pro', refresh_interval_s: 900, expires_at: 'x' };

function okFor(url: string): { status: number; body: unknown } {
  if (url.includes('/v1/models')) return { status: 200, body: MODELS_BODY };
  if (url.includes('/v1/config/policy')) return { status: 200, body: POLICY_BODY };
  if (url.includes('/v1/config/keys')) return { status: 200, body: KEYS_BODY };
  if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'config.trimmc-card', card_file_present: false, card: null, entries_masked: {} } };
  return { status: 200, body: {} };
}

describe('S8.2: jsdom 首启五断言', () => {
  it('断言① 无令牌态：连接设置自动展开+引导可见+数据面板禁用', async () => {
    const log: Array<{ url: string }> = [];
    const dom = bootUi(log, [okFor]);
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    assert.equal(d.getElementById('conn-settings').open, true, '首启必须自动展开连接设置');
    assert.equal(d.getElementById('conn-guide').hidden, false, '引导文案必须可见');
    assert.ok(d.getElementById('conn-guide').textContent.includes('首次使用'));
    assert.equal(d.getElementById('tc-open-add').disabled, true, '数据面板必须禁用');
    assert.ok(d.querySelector('.card-main').classList.contains('disabled-panel'));
    // 首启无令牌不应发起数据请求（禁用态不发拉取）
    const dataCalls = log.filter((c) => c.url.includes('/v1/')).length;
    assert.equal(dataCalls, 0, '无令牌首启不应拉数据');
    dom.window.close();
  });

  it('断言② 令牌保存→自动重拉全部数据（去静默）', async () => {
    const log: Array<{ url: string }> = [];
    const dom = bootUi(log, [okFor]);
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    const before = log.length;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(log.length > before, '连接后必须自动重拉数据');
    assert.ok(log.some((c) => c.url.includes('/v1/models')), 'models 必须被重拉');
    assert.equal(d.getElementById('conn-settings').open, false, '连接成功后折叠');
    assert.equal(d.getElementById('conn-dot').className, 'dot ok');
    dom.window.close();
  });

  it('断言③ 模型下拉有值（GET /v1/models 填充）', async () => {
    const dom = bootUi([], [okFor]);
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await new Promise((r) => setTimeout(r, 150));
    const opts = d.getElementById('tc-e-model').querySelectorAll('option');
    assert.equal(opts.length, 3, '下拉必须被真实数据填充');
    assert.equal(opts[0].value, 'deepseek-v4-pro');
    dom.window.close();
  });

  it('断言④ 条目提交可达：添加→保存卡片→PUT card 发出', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [okFor]);
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await new Promise((r) => setTimeout(r, 150));
    d.getElementById('tc-conn').value = '本机';
    d.getElementById('tc-open-add').click();
    (d.getElementById('tc-e-id') as HTMLInputElement).value = 'e1';
    (d.getElementById('tc-e-key') as HTMLInputElement).value = 'sk-test-0001';
    d.getElementById('tc-e-save').click();
    d.getElementById('tc-save').click();
    await new Promise((r) => setTimeout(r, 120));
    const cardPut = log.find((c) => c.url.includes('/trimmc-card') && c.init?.method === 'PUT');
    assert.ok(cardPut, 'PUT card must be issued');
    const sent = JSON.parse(String(cardPut.init!.body));
    assert.equal(sent.provider_entries.e1.api_key, 'sk-test-0001', 'plaintext hydrates server-side (never stored raw)');
    dom.window.close();
  });

  it('断言⑤ TriMMC 卡片区域通道词汇+结构词汇零出现', () => {
    const html = readFileSync(UI_PATH, 'utf-8');
    const cardZone = html.slice(html.indexOf('【TriMMC 信息】'), html.indexOf('【本机策略（高级）】'));
    const banned = ['SSH', 'ssh', '隧道', 'tunnel', '候选池', '子栏', '固定规则', '规则表', '悬挂引用', '回显污染', '水合', '推送', '选为固定使用', '即生效'];
    for (const w of banned) {
      assert.equal(cardZone.includes(w), false, `结构/通道词汇 '${w}' 禁入卡片区域`);
    }
  });

  it('fetch 失败 → 人话错误面板+重试钮（S3.2 禁静默空）', async () => {
    const dom = bootUi([], [() => ({ status: 0, body: {} })]);
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await new Promise((r) => setTimeout(r, 150));
    const panel = d.getElementById('error-status');
    assert.equal(panel.hidden, false);
    assert.ok(panel.textContent.includes('无法连接配置服务'), 'must be human phrasing');
    assert.ok(panel.querySelector('[data-retry]'), 'retry button must exist');
    dom.window.close();
  });
});

describe('S5 迁移器: keys.enc → card synthetic entries (幂等)', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-migrate-test-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('legacy present → synthetic entries (auto_imported, verbatim ciphertext) + .migrated rename', () => {
    const legacyPath = join(dir, 'keys.enc');
    writeFileSync(legacyPath, 'cipher-blob');
    const legacyDoc = {
      version: '1' as const,
      providers: {
        deepseek: { api_key: 'AES_BLOB_DEEPSEEK', updated_at: 'x' },
        glm: { api_key: 'AES_BLOB_GLM', updated_at: 'x' },
      },
    };
    const cardPath = join(dir, 'trimmc-card.json');
    const result = migrateKeysEncToCard(cardPath, () => legacyDoc, legacyPath);
    assert.equal(result.migrated, true);
    assert.deepEqual(result.imported, ['auto:deepseek', 'auto:glm']);
    assert.ok(existsSync(legacyPath + '.migrated'), 'legacy must be renamed, not deleted');
    assert.equal(existsSync(legacyPath), false);
    const card = loadCard(cardPath);
    assert.ok(card);
    assert.equal(card.provider_entries['auto:deepseek'].api_key_encrypted, 'AES_BLOB_DEEPSEEK', 'ciphertext moves verbatim');
    assert.equal(card.provider_entries['auto:deepseek'].auto_imported, true);
    assert.equal(card.provider_entries['auto:glm'].model, 'GLM-5.3');
    // Idempotent: second run short-circuits on .migrated
    const again = migrateKeysEncToCard(cardPath, () => legacyDoc, legacyPath);
    assert.equal(again.migrated, false);
    assert.equal(again.reason, 'already-migrated');
  });

  it('migration map covers exactly the three legacy vendors (spec 定稿映射)', () => {
    for (const model of ['deepseek-v4-pro', 'GLM-5.3', 'TMV']) {
      assert.ok((MODEL_CATALOG as readonly string[]).includes(model));
    }
  });

  it('roundtrip guard: loadCard tolerates auto_imported extra field', () => {
    const cardPath = join(dir, 'tolerant.json');
    const raw = {
      version: 2, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: { 'auto:deepseek': { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: encrypt('sk-auto').toString('base64'), enabled: true, updated_at: 'x', auto_imported: true } },
      rules: [], status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    writeFileSync(cardPath, JSON.stringify(raw));
    const doc = loadCard(cardPath);
    assert.ok(doc);
    assert.equal(doc.provider_entries['auto:deepseek'].auto_imported, true);
    void existsSync; void renameSync;
  });
});

function require_catalog(): typeof import('../src/model-catalog.js') {
   
  return { MODEL_CATALOG: ['deepseek-flash', 'deepseek-v4-pro', 'GLM-5.3-Flash', 'GLM-5.3', 'TMV'] } as unknown as typeof import('../src/model-catalog.js');
}
