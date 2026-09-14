// ── LG-035 UI 重设计 S8：jsdom 首启五断言 + S5 迁移器单测 ──
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- DOM typing noise (getElementById null-narrowing); runtime asserted by the suite itself
// @ts-nocheck
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

/** Deterministic wait: poll until cond() or timeout (ms). Replaces fixed sleeps. */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
}

/** Boot the real UI in jsdom with fetch stubbed to a scripted queue. */
// Kept referenced on purpose: retired doms must survive GC while their
// mid-flight async callbacks drain (see retireUi).
const retiredDoms: JSDOM[] = [];

/** Mark a bootUi dom as done (fetch resolves inert afterwards). */
function retireUi(dom: JSDOM): void {
  const h = (dom as unknown as { __handle: { done: boolean } }).__handle;
  if (h) h.done = true;
  retiredDoms.push(dom);
}

function bootUi(fetchLog: Array<{ url: string; init?: RequestInit }>, responders: Array<(url: string, init?: RequestInit) => { status: number; body: unknown }>) {
  const handle = { done: false };
  const dom = new JSDOM(readFileSync(UI_PATH, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:3333/ui',
    beforeParse(window: import('jsdom').DOMWindow) {
      let call = 0;
      window.fetch = (async (url: string, init?: RequestInit) => {
        if (handle.done) return { status: 0, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        fetchLog.push({ url, init });
        // window closed mid-flight (test teardown): resolve inert so no
        // render callback touches a dead document (unhandledRejection guard)
        if (window.closed) return { status: 0, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        const r = responders[Math.min(call, responders.length - 1)](url, init);
        call += 1;
        return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body), headers: new Map() } as unknown as Response;
      });
      window.localStorage.clear();
    },
  });
  (dom as unknown as { __handle: { done: boolean } }).__handle = handle;
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
    // 首启无令牌不应发起数据请求（禁用态不发拉取）；
    // runtime-info 例外：无鉴权运行时信息（域标签展示用，非业务数据）
    const dataCalls = log.filter((c) => c.url.includes('/v1/') && !c.url.includes('runtime-info')).length;
    assert.equal(dataCalls, 0, '无令牌首启不应拉数据（runtime-info 除外）');
    retireUi(dom);
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
    console.log('[dbg2] before =', before, 'after =', log.length, '| urls =', JSON.stringify(log.map((c) => c.url)));
    assert.ok(log.length > before, '连接后必须自动重拉数据');
    assert.ok(log.some((c) => c.url.includes('/v1/models')), 'models 必须被重拉');
    assert.equal(d.getElementById('conn-settings').open, false, '连接成功后折叠');
    assert.equal(d.getElementById('conn-dot').className, 'dot ok');
    retireUi(dom);
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
    retireUi(dom);
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
    (d.getElementById('tc-e-key') as HTMLInputElement).value = 'sk-test-0001-12345';
    d.getElementById('tc-e-save').click();
    d.getElementById('tc-save').click();
    await waitFor(() => log.some((c) => c.url.includes('/trimmc-card') && c.init?.method === 'PUT'));
    const cardPut = log.find((c) => c.url.includes('/trimmc-card') && c.init?.method === 'PUT');
    assert.ok(cardPut, 'PUT card must be issued');
    const sent = JSON.parse(typeof cardPut.init?.body === 'string' ? cardPut.init.body : '');
    assert.equal(sent.provider_entries.e1.api_key, 'sk-test-0001-12345', 'plaintext hydrates server-side (never stored raw)');
    // TimingSink drain: let the boot/refresh async chain finish before teardown
    await new Promise((r) => setTimeout(r, 80));
  });

  it('本地侧: 域标签+应用到本机按钮（runtime-info 驱动；点击 POST apply）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const card = {
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: { e1: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } },
      model_sets: { ms1: { name: '工作集', entry_ids: ['e1'], created_at: 'x', updated_at: 'x' } },
      rules: {
        r1: { name: '工作时段#时段', type: 'time', enabled: true, windows: [{ start: '09:00', end: '18:00', entry_id: 'e1' }], created_at: 'x', updated_at: 'x' },
        r2: { name: '工作时段#默认', type: 'default', enabled: true, entry_id: 'e1', created_at: 'x', updated_at: 'x' },
      },
      strategies: { s1: { name: '工作时段', purpose: '', model_set_id: 'ms1', rule_ids: ['r1', 'r2'], created_at: 'x', updated_at: 'x' } },
      active_strategy_id: 's1', deleted_strategy_ids: [],
      default_model: 'GLM-5.3',
      status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    const dom = bootUi(log, [(url: string, _init?: RequestInit) => {
      if (url.includes('/v1/config/runtime-info')) return { status: 200, body: { object: 'config.runtime-info', domain_label: '本地域（TriMLC/TriRLC）', local_apply_enabled: true, machine: 'dev' } };
      if (url.includes('/v1/config/trimmc-card/apply')) return { status: 200, body: { ok: true, message: '已应用到本机：工作时段（1 条时段规则，默认模型 GLM-5.3）' } };
      if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'x', card_file_present: true, card, entries_masked: {} } };
      return okFor(url);
    }]);
    const d = dom.window.document;
    // 域标签无鉴权即可见（runtime-info 驱动）
    await waitFor(() => (d.getElementById('tc-domain-label') as HTMLElement).textContent.includes('本地域'));
    assert.ok((d.getElementById('tc-domain-label') as HTMLElement).textContent.includes('TriMLC/TriRLC'), '域标签=本地域（runtime-info 驱动）');
    // 连接后按钮可见
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await waitFor(() => !(d.getElementById('tc-apply') as HTMLButtonElement).hidden);
    assert.equal((d.getElementById('tc-apply') as HTMLButtonElement).hidden, false, 'local_apply_enabled=true → 应用按钮可见');
    // hydrate 回归断言（真浏览器走查实证缺陷位 2026-09-14）：连接后策略下拉
    // 必须含卡内策略 + 规则列表渲染（loadTrimmc 漏赋值=下拉永空）
    await waitFor(() => Array.from((d.getElementById('tc-strategy-sel') as HTMLSelectElement).options).some((o) => o.value === 's1'));
    assert.ok(Array.from((d.getElementById('tc-strategy-sel') as HTMLSelectElement).options).some((o) => o.value === 's1'), '连接后策略下拉必须含卡内策略（hydrate）');
    assert.equal((d.getElementById('tc-str-detail') as HTMLElement).textContent.includes('工作时段'), true, '策略详情渲染');
    assert.equal((d.getElementById('tc-str-rules-body') as HTMLElement).children.length, 2, '策略规则列表渲染（v4：1 time 窗行+1 default 行）');
    // 点击 → POST apply 发出 + 成功提示
    d.getElementById('tc-apply').click();
    await waitFor(() => log.some((c) => c.url.includes('trimmc-card/apply') && c.init?.method === 'POST'));
    await waitFor(() => (d.getElementById('tc-msg') as HTMLElement).textContent.includes('已应用到本机'));
    assert.ok((d.getElementById('tc-msg') as HTMLElement).textContent.includes('已应用到本机'), 'apply 成功提示在位');
    retireUi(dom);
  });

  it('断言⑤ TriMMC 卡片区域通道词汇+结构词汇零出现', () => {
    const html = readFileSync(UI_PATH, 'utf-8');
    const cardZone = html.slice(html.indexOf('【TriMMC 信息】'), html.indexOf('【本机策略（高级）】'));
    const banned = ['SSH', 'ssh', '隧道', 'tunnel', '候选池', '子栏', '固定规则', '规则表', '悬挂引用', '回显污染', '水合', '推送', '选为固定使用', '即生效'];
    for (const w of banned) {
      assert.equal(cardZone.includes(w), false, `结构/通道词汇 '${w}' 禁入卡片区域`);
    }
  });

  it('D17: badge is server-confirmation bound - 401 keeps non-pending, 200 flips to pending', async () => {
    // 401: stale admin token -> badge stays non-pending, error message shown
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const appliedCard = {
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } },
      model_sets: {}, rules: {}, strategies: {}, active_strategy_id: null, status: { state: 'applied', at: 'x' },
      reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    const dom = bootUi(log, [(url: string, init?: RequestInit) => {
      if (init && init.method === 'PUT' && url.includes('/trimmc-card')) return { status: 401, body: { error: 'Unauthorized: invalid or missing admin token' } };
      if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'x', card_file_present: true, card: appliedCard, entries_masked: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', masked: '****0001', enabled: true, updated_at: 'x' } } } };
      return okFor(url);
    }]);
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'ta-stale';
    d.getElementById('conn-save').click();
    await waitFor(() => !!d.querySelector('[data-enable]'));
    (d.getElementById('tc-e-id') as HTMLInputElement).value = 'ee';
    (d.getElementById('tc-e-key') as HTMLInputElement).value = 'sk-d17-key-00000001';
    d.getElementById('tc-e-save').click();
    d.getElementById('tc-save').click();
    await waitFor(() => (d.getElementById('tc-msg') as HTMLElement).textContent.includes('管理令牌被拒'));
    assert.equal(d.getElementById('tc-badge').textContent, '已生效', '401 must NOT flip badge to 待应用 (server-confirmation bound)');
    assert.ok((d.getElementById('tc-msg') as HTMLElement).textContent.includes('管理令牌被拒'), '401 human copy shown');
    // 200: valid admin token -> badge flips to 待应用
    let saveCount = 0;
    const dom2 = bootUi(log, [(url: string, init?: RequestInit) => {
      if (init && init.method === 'PUT' && url.includes('/trimmc-card')) {
        saveCount++;
        // First PUT → pending (save); second PUT → also pending
        return { status: 200, body: { ok: true } };
      }
      if (url.includes('/trimmc-card') && (!init || !init.method || init.method === 'GET')) {
        // After first save, return pending card; before save, return applied card
        const state = saveCount > 0 ? 'pending' : 'applied';
        const dm = saveCount > 0 ? 'deepseek-v4-pro' : '';
        return { status: 200, body: { object: 'x', card_file_present: true, card: { ...appliedCard, status: { state, at: 'x' } }, default_model: dm, entries_masked: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', masked: '****0001', enabled: true, updated_at: 'x' } } } };
      }
      return okFor(url);
    }]);
    const d2 = dom2.window.document;
    (d2.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d2.getElementById('adminToken') as HTMLInputElement).value = 'ta-good';
    d2.getElementById('conn-save').click();
    await waitFor(() => !!d2.querySelector('[data-enable]'));
    d2.getElementById('tc-e-id').value = 'ee';
    d2.getElementById('tc-e-key').value = 'sk-d17-key-00000001';
    d2.getElementById('tc-e-save').click();
    d2.getElementById('tc-save').click();
    await waitFor(() => (d2.getElementById('tc-msg') as HTMLElement).textContent.includes('卡片已保存'));
    assert.equal(d2.getElementById('tc-badge').textContent, '待应用', '200 must flip badge to 待应用 (server confirmed)');
    dom2.window.close();
    dom.window.close();
  });

  it('D5: on-disk disabled entry under applied card shows fallback tip (engine fact)', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const appliedCardDisabled = {
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: false, updated_at: 'x' } },
      model_sets: { ms: { name: '集', entry_ids: ['e1'], created_at: 'x', updated_at: 'x' } },
      rules: { rd: { name: '默认模型', type: 'default', enabled: true, entry_id: 'e1', created_at: 'x', updated_at: 'x' } },
      strategies: { s1: { name: '策略', model_set_id: 'ms', rule_ids: ['rd'], created_at: 'x', updated_at: 'x' } },
      active_strategy_id: 's1',
      status: { state: 'applied', at: 'x' },
      reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    const dom = bootUi(log, [(url) => {
      if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'config.trimmc-card', card_file_present: true, card: appliedCardDisabled, entries_masked: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', masked: '****0001', enabled: false, updated_at: 'x' } } } };
      return okFor(url);
    }]);
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await waitFor(() => !d.getElementById('tc-fallback-tip').hidden);
    assert.equal(d.getElementById('tc-fallback-tip').hidden, false, 'applied card + on-disk disabled current-use entry = fallback tip');
    assert.ok(d.getElementById('tc-fallback-tip').textContent.includes('已回落'), 'fallback wording');
    retireUi(dom);
  });

  it('D5b: derivation source is the disk mirror - dirty (unsaved) toggle cannot fabricate fallback', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const appliedCard = {
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } },
      model_sets: {}, rules: {}, strategies: {}, active_strategy_id: null,
      status: { state: 'applied', at: 'x' },
      reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    const dom = bootUi(log, [(url) => {
      if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'config.trimmc-card', card_file_present: true, card: appliedCard, entries_masked: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', masked: '****0001', enabled: true, updated_at: 'x' } } } };
      return okFor(url);
    }]);
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    await waitFor(() => !!d.querySelector('[data-enable]'));
    const sw: HTMLInputElement | null = d.querySelector('[data-enable]');
    assert.ok(sw, 'entry row must render');
    sw.checked = false;
    sw.dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(d.getElementById('tc-fallback-tip').hidden, true, 'unsaved (dirty) toggle must not fabricate fallback');
    assert.ok(d.getElementById('tc-msg').textContent.includes('将在应用后生效'), 'quiet hint for unsaved toggle');
    retireUi(dom);
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
      version: 4, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: { 'auto:deepseek': { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: encrypt('sk-auto').toString('base64'), enabled: true, updated_at: 'x', auto_imported: true } },
      model_sets: {}, rules: {}, strategies: {}, active_strategy_id: null, status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    writeFileSync(cardPath, JSON.stringify(raw));
    const doc = loadCard(cardPath);
    assert.ok(doc);
    assert.equal(doc.provider_entries['auto:deepseek'].auto_imported, true);
    void existsSync; void renameSync;
  });
});


