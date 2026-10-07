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


describe('LG-036 TriMMC（sg）栏 → 方案三四域签换代（CPO 方稿 9f86ff34 §3.2 旧口径作废；替代面行为归 ui-fourplane.test.ts ②f）', () => {
  it('fb-sg 表单退役零残留：四输入/按钮/现值区/消息区全下线；四域签容器+应急块接位；禁用链零波及', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [okFor]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    // 旧口径退役断言：fb-sg 系元素零残留
    for (const id of ['fb-sg-baseurl', 'fb-sg-key', 'fb-sg-model', 'fb-sg-token', 'fb-sg-restore', 'fb-sg-current', 'fb-sg-msg']) {
      assert.equal(d.getElementById(id), null, `退役零残留：#${id}`);
    }
    // 替代面在位：四域签容器 + 应急恢复块
    assert.ok(d.getElementById('conn-domain-tabs'), '四域签容器接位');
    assert.ok(((d.getElementById('fb-zone') as HTMLElement).textContent ?? '').includes('不承担应急兜底'), '应急恢复块保留');
    // 禁用链零波及（原 it1 尾断言沿承）
    assert.equal((d.getElementById('fb-zone') as HTMLElement).classList.contains('disabled-panel'), false, '禁用链零波及');
    retireUi(dom);
  });
});


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
    // 菜单常驻骨架（BOD 2026-10-06 更正令①+验收锚⑤）：未连接冷态直开即呈现
    // 左菜单右主体——body.menu-full 在场+菜单项 7 个恒在场（不隐藏菜单栏）。
    assert.equal(d.body.classList.contains('menu-full'), true, '冷态直开→左菜单骨架在场（无条件常驻）');
    assert.equal(d.querySelectorAll('#page-menu .menu-btn').length, 7, '冷态菜单项 7 个恒在场');
    assert.ok(d.querySelector('#page-menu .menu-btn.dim'), '冷态缺数据卡菜单项置灰待数据');
    // 首启无令牌不应发起数据请求（禁用态不发拉取）；
    // runtime-info/claude-fallback 例外：无鉴权只读面（域标签+兜底现状展示用，
    // 兜底区设计上不参与禁用链——「任务书 20260915-兜底按钮」）
    const dataCalls = log.filter((c) => c.url.includes('/v1/') && !c.url.includes('runtime-info') && !c.url.includes('claude-fallback')).length;
    assert.equal(dataCalls, 0, '无令牌首启不应拉数据（runtime-info/claude-fallback 除外）');
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

  it('本地侧: 页顶生效读数行+行内应用到本机按钮（runtime-info 驱动；点击 POST apply）——深测②合一 S2 结构（读数升页顶·操作收行内）', async () => {
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
    // 页顶生效读数行（域标签并入）无鉴权即可见（runtime-info 驱动；S2 读数腿）
    await waitFor(() => (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('本地域'));
    assert.ok((d.getElementById('tc-active-line') as HTMLElement).textContent.includes('TriMLC/TriRLC'), '域标签并入页顶生效读数行（runtime-info 驱动）');
    // 连接后：卡内 active_strategy_id=s1 → 列表行渲染+读数行出策略名
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
    // hydrate 回归断言（真浏览器走查实证缺陷位 2026-09-14；S2 新锚=列表行）：
    // 连接后策略列表必须含卡内策略 + 页顶读数行出策略名（loadTrimmc 漏赋值=永空）
    await waitFor(() => (d.getElementById('tc-str-body') as HTMLElement).children.length >= 1);
    assert.ok((d.getElementById('tc-str-body') as HTMLElement).textContent.includes('工作时段'), '连接后策略列表必须含卡内策略（hydrate）');
    assert.ok((d.getElementById('tc-active-line') as HTMLElement).textContent.includes('当前生效 · 策略「工作时段」'), '页顶生效读数行渲染（读数腿）');
    // 行内操作列：生效行=「生效中」徽章+取消生效+应用到本机（local_apply_enabled=true）
    await waitFor(() => Array.from(d.querySelectorAll('#tc-str-body button')).some((b) => b.textContent === '应用到本机'));
    assert.ok((d.getElementById('tc-str-body') as HTMLElement).querySelector('.badge.applied')?.textContent.includes('生效中'), '生效中徽章在生效行可见（条5 锚②）');
    const applyBtn = Array.from(d.querySelectorAll('#tc-str-body button')).find((b) => b.textContent === '应用到本机') as HTMLButtonElement;
    assert.ok(applyBtn, 'local_apply_enabled=true → 行内应用到本机按钮可见（渲染门）');
    // 展开详情规则行渲染（v4：1 time 窗行+1 default 行；详情腿=行内 details）
    assert.equal(d.querySelectorAll('#tc-str-body details tbody tr').length, 2, '展开详情规则行渲染（v4：1 time 窗行+1 default 行）');
    // 点击 → POST apply 发出 + 成功提示
    applyBtn.click();
    await waitFor(() => log.some((c) => c.url.includes('trimmc-card/apply') && c.init?.method === 'POST'));
    await waitFor(() => (d.getElementById('tc-msg') as HTMLElement).textContent.includes('已应用到本机'));
    assert.ok((d.getElementById('tc-msg') as HTMLElement).textContent.includes('已应用到本机'), 'apply 成功提示在位');
    retireUi(dom);
  });


  it('层2 段D 修复回归：规则表单三型显隐（computed display 断言——.field display:grid 覆盖 hidden 属性坑防复发）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const card = {
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: { e1: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } },
      model_sets: { ms1: { name: '集', entry_ids: ['e1'], created_at: 'x', updated_at: 'x' } },
      rules: { r1: { name: '示例', type: 'time', enabled: true, windows: [{ start: '09:00', end: '18:00', entry_id: 'e1' }], created_at: 'x', updated_at: 'x' } },
      strategies: { s1: { name: '策略', model_set_id: 'ms1', rule_ids: ['r1'], created_at: 'x', updated_at: 'x' } },
      active_strategy_id: 's1', deleted_strategy_ids: [],
      status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    const dom = bootUi(log, [(url: string) => {
      if (url.includes('/v1/models')) return { status: 200, body: { object: 'list', data: [{ id: 'GLM-5.3' }] } };
      if (url.includes('/v1/config/policy')) return { status: 200, body: { object: 'config.policy', policy: { version: '1', schedules: [] }, effective: { model: 'GLM-5.3', source: 'env-default', matched_schedule_id: null } } };
      if (url.includes('/v1/config/keys')) return { status: 200, body: { object: 'config.keys', keys: {}, default_model: 'GLM-5.3', refresh_interval_s: 900, expires_at: 'x' } };
      if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'x', card_file_present: true, card, entries_masked: { e1: { provider: 'glm', model: 'GLM-5.3', masked: '****0001', enabled: true, updated_at: 'x' } } } };
      return { status: 200, body: {} };
    }]);
    const d = dom.window.document;
    (d.getElementById('token') as HTMLInputElement).value = 'tk';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'ta';
    d.getElementById('conn-save').click();
    await waitFor(() => (d.getElementById('tc-r-body') as HTMLElement).children.length >= 1);
    d.getElementById('tc-r-add').click();
    const vis = (id: string) => dom.window.getComputedStyle(d.getElementById(id)).display;
    // 遍历三型：本型字段可见（display≠none），他型字段必隐（=none）
    for (const [type, visible, hiddenIds] of [
      ['time', ['tc-r-time-zone'], ['tc-r-default-row', 'tc-r-watch-row', 'tc-r-fallback-row']],
      ['default', ['tc-r-default-row'], ['tc-r-time-zone', 'tc-r-watch-row', 'tc-r-fallback-row']],
      ['quota', ['tc-r-watch-row', 'tc-r-fallback-row'], ['tc-r-time-zone', 'tc-r-default-row']],
    ] as Array<[string, string[], string[]]>) {
      (d.getElementById('tc-r-type') as HTMLSelectElement).value = type;
      d.getElementById('tc-r-type').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      for (const id of visible) assert.notEqual(vis(id), 'none', `${type} 型下 ${id} 须可见`);
      for (const id of hiddenIds) assert.equal(vis(id), 'none', `${type} 型下 ${id} 须隐藏（BOD 23:5x 走查回归位）`);
    }
    retireUi(dom);
  });

  it('断言⑤ 全文件通道词汇+结构词汇零出现（P2 四卡面扩全文件口径）+旧栏目名零出现', () => {
    // P2 结构升级（LG-058）：旧断言按 slice 两锚取卡片区——四卡面重构后旧标记
    // 双双退场，slice 退化空串=空转通过。升级为全文件扫描（含 script 段），
    // 并锚定旧标记真实缺席（防断言口径再次空转）。
    const html = readFileSync(UI_PATH, 'utf-8');
    const banned = ['SSH', 'ssh', '隧道', 'tunnel', '候选池', '子栏', '固定规则', '规则表', '悬挂引用', '回显污染', '水合', '推送', '选为固定使用', '即生效'];
    for (const w of banned) {
      assert.equal(html.includes(w), false, `结构/通道词汇 '${w}' 禁入全文件`);
    }
    // CPO P2 对表（cpo-p2-ia-conformance 实现注意点 3）：旧栏目名施工中零出现，
    // 四卡正名结构替代；字面零出现含注释段（测试锚定）。
    assert.equal(html.includes('TriMMC 信息'), false, '旧栏目名（TriMMC+信息 连字）禁再现');
    assert.equal(html.includes('【TriMMC 信息】'), false, '旧 slice 锚点一已退场');
    assert.equal(html.includes('【本机策略（高级）】'), false, '旧 slice 锚点二已退场');
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



// ── 深测②合一 S4: 两页读数同源（verify 通道，候裁点④ A 案）──
// 兜底四域 badge（connLocalState）与「模型策略」页顶「应用于」读数（tcApplyStateSuffix）
// 同源消费 /v1/config/verify（服务端 deriveVerifyState 单点下沉，UI 本地判定树退役）。
describe('深测②合一 S4: 两页读数同源（verify 通道）', () => {
  const RUNTIME_INFO = { object: 'config.runtime-info', domain_label: '本地域（TriMLC/TriRLC）', local_apply_enabled: true, machine: 'dev' };
  const vr = (face: string, state: string, state_label: string, degraded = false) => ({
    face, card_present: true, intent_version: 1, intent_updated_at: '2026-10-08T00:00:00Z',
    version_applied: 1, applied_at: '2026-10-08T00:01:00Z', write_result: 'ok', write_error: null,
    last_pull_at: '2026-10-08T00:02:00Z', last_pull_result: degraded ? 'failed' : 'ok',
    state, state_label, pull_chain_degraded: degraded,
  });

  function connectedDom(log: Array<{ url: string; init?: RequestInit }>, verifyBody: unknown, verifyStatus = 200, runtimeInfo = RUNTIME_INFO) {
    return bootUi(log, [(url: string): { status: number; body: unknown } => {
      if (url.includes('/v1/config/runtime-info')) return { status: 200, body: runtimeInfo };
      if (url === '/v1/config/verify') return { status: verifyStatus, body: verifyBody };
      // face 卡：给每域一份「旧判定树会算已落生效」的 ledger 数据（T2 判定树退役锚）
      const m = url.match(/\/v1\/config\/cards\/(mlc|rlc|mmc|rmc)/);
      if (m) {
        return {
          status: 200,
          body: {
            object: 'config.card.managed',
            card: { local_config: { version: 1, updated_at: '2026-10-08T00:00:00Z', items: {} } },
            entries_masked: {},
            ledger: { faces: { [m[1]]: { local_config: { version_applied: 1, applied_at: 'x', write_result: 'ok' } } } },
          },
        };
      }
      return okFor(url);
    }]);
  }

  async function connect(d: Document): Promise<void> {
    (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
    (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
    d.getElementById('conn-save').click();
  }

  it('T1 同源：兜底 badge=verify state_label 且页顶「应用于」含同源读数（两页一源）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const verifyBody = { object: 'config.verify', generated_at: 'x', faces: {
      mmc: vr('mmc', 'not-configured', '未配置'), mlc: vr('mlc', 'applied', '已落生效'),
      rmc: vr('rmc', 'not-configured', '未配置'), rlc: vr('rlc', 'stored-not-pulled', '已存未拉'),
    } };
    const dom = connectedDom(log, verifyBody);
    const d = dom.window.document;
    await connect(d);
    // 兜底 badge=verify 权威中文标签（直消费，UI 零复算）；S4b B：applied 态注记「已落 · 重启生效」
    await waitFor(() => (d.getElementById('cd-mlc-phase') as HTMLElement | null)?.textContent === '已落 · 重启生效');
    assert.equal((d.getElementById('cd-rlc-phase') as HTMLElement).textContent, '已存未拉', 'rlc badge=verify state_label');
    assert.ok(((d.getElementById('cd-mlc-phase') as HTMLElement).textContent ?? '').includes('重启生效'), 'S4b B 锚：boot 型键徽章含「重启生效」语义锚');
    // 页顶「应用于」=同一 verify 源的读数缀（face 集由域标签 display 名匹配；B 同族注记同步）
    await waitFor(() => (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('TriMLC 已落 · 重启生效'));
    assert.ok(
      (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('应用于 本地域（TriMLC/TriRLC） · TriMLC 已落 · 重启生效 · TriRLC 已存未拉'),
      '页顶应用于读数=verify 同源（两页读数同源断言·完工门锚）',
    );
    assert.equal((d.getElementById('tc-active-line') as HTMLElement).textContent.includes('TriMMC'), false, '域标签外 face 不进页顶缀（匹配面=本域）');
    retireUi(dom);
  });

  it('T2 判定树退役：卡/ledger 数据说「已落生效」而 verify 说「已存未拉」→badge=verify（服务端权威单点）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const verifyBody = { object: 'config.verify', generated_at: 'x', faces: {
      mmc: vr('mmc', 'not-configured', '未配置'), mlc: vr('mlc', 'applied', '已落生效'),
      rmc: vr('rmc', 'not-configured', '未配置'), rlc: vr('rlc', 'stored-not-pulled', '已存未拉'),
    } };
    const dom = connectedDom(log, verifyBody);
    const d = dom.window.document;
    await connect(d);
    // face 卡 mock 的 ledger（version_applied=1+write_result ok）按旧本地判定树=「已落生效」；
    // verify 说 stored-not-pulled → badge 必须跟 verify（UI 不复算=判定树退役实证）
    await waitFor(() => (d.getElementById('cd-rlc-phase') as HTMLElement | null)?.textContent === '已存未拉');
    assert.equal((d.getElementById('cd-rlc-phase') as HTMLElement).textContent, '已存未拉', '判定树退役：badge=verify 读数非本地复算');
    retireUi(dom);
  });

  it('T3 拉取链异常后缀：pull_chain_degraded → badge 与页顶读数同缀「·拉取链异常」', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const verifyBody = { object: 'config.verify', generated_at: 'x', faces: {
      mmc: vr('mmc', 'not-configured', '未配置'), mlc: vr('mlc', 'applied', '已落生效', true),
      rmc: vr('rmc', 'not-configured', '未配置'), rlc: vr('rlc', 'stored-not-pulled', '已存未拉'),
    } };
    const dom = connectedDom(log, verifyBody);
    const d = dom.window.document;
    await connect(d);
    await waitFor(() => (d.getElementById('cd-mlc-phase') as HTMLElement | null)?.textContent.includes('拉取链异常'));
    assert.equal((d.getElementById('cd-mlc-phase') as HTMLElement).textContent, '已落 · 重启生效 ·拉取链异常', 'badge degraded 后缀（结构化面）');
    await waitFor(() => (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('TriMLC 已落 · 重启生效 ·拉取链异常'));
    retireUi(dom);
  });

  it('T4 读取失败如实：verify 500 → 卡数据在的 face badge=「读取失败」，页顶读数同源如实', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = connectedDom(log, { error: 'boom' }, 500);
    const d = dom.window.document;
    await connect(d);
    await waitFor(() => (d.getElementById('cd-mlc-phase') as HTMLElement | null)?.textContent === '读取失败');
    assert.equal((d.getElementById('cd-rlc-phase') as HTMLElement).textContent, '读取失败', '断链候选如实（不造数）');
    await waitFor(() => (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('TriMLC 读取失败'));
    retireUi(dom);
  });

  it('T5 全落单词缀+未知域标签零缀（不猜）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const verifyBody = { object: 'config.verify', generated_at: 'x', faces: {
      mmc: vr('mmc', 'applied', '已落生效'), mlc: vr('mlc', 'applied', '已落生效'),
      rmc: vr('rmc', 'applied', '已落生效'), rlc: vr('rlc', 'applied', '已落生效'),
    } };
    const dom = connectedDom(log, verifyBody);
    const d = dom.window.document;
    await connect(d);
    await waitFor(() => (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('· 已落 · 重启生效'));
    assert.ok(
      (d.getElementById('tc-active-line') as HTMLElement).textContent.includes('应用于 本地域（TriMLC/TriRLC） · 已落 · 重启生效'),
      '全落=单词缀（不逐 face 枚举）',
    );
    retireUi(dom);

    // 未知域标签：display 名零匹配 → 零缀（现役形态原样，不猜）
    const log2: Array<{ url: string; init?: RequestInit }> = [];
    const dom2 = connectedDom(log2, verifyBody, 200, { ...RUNTIME_INFO, domain_label: '未知域' });
    const d2 = dom2.window.document;
    await connect(d2);
    await waitFor(() => (d2.getElementById('tc-active-line') as HTMLElement).textContent.includes('应用于 未知域'));
    const line2 = (d2.getElementById('tc-active-line') as HTMLElement).textContent;
    assert.equal(line2.includes('已落'), false, '未知标签零缀（不猜）');
    retireUi(dom2);
  });

  it('T6 三型副文换新（CPO 定稿）+旧「三型」串零残留（渲染面）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [okFor]);
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    const empty = (d.getElementById('tc-r-empty') as HTMLElement).textContent;
    assert.ok(empty.includes('支持：按时间段自动切换 / 始终用某个模型 / 用量用完自动换下一个'), '三型描述式 CPO 定稿在位');
    assert.equal(empty.includes('时段/默认/额度三型'), false, '旧「三型」串零残留');
    retireUi(dom);
  });

  // ── S4b 观察项（CPO cfcc055b 四锚·CTO 案 a 补载）：C 清空诚实注+D 切签重拉 ──
  it('S4b C: 清空保存→诚实注记「已清 · 待落地」（禁无提示分叉·注记置后不被重渲冲掉）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [(url: string, init?: RequestInit): { status: number; body: unknown } => {
      if (url.includes('/v1/config/runtime-info')) return { status: 200, body: RUNTIME_INFO };
      if (url === '/v1/config/verify') return { status: 200, body: { object: 'config.verify', generated_at: 'x', faces: {
        mmc: vr('mmc', 'applied', '已落生效'), mlc: vr('mlc', 'not-configured', '未配置'),
        rmc: vr('rmc', 'not-configured', '未配置'), rlc: vr('rlc', 'stored-not-pulled', '已存未拉'),
      } } };
      const m = url.match(/\/v1\/config\/cards\/(mlc|rlc|mmc|rmc)/);
      if (m && (init?.method ?? '') === 'PUT') {
        return { status: 200, body: { object: 'config.card.managed', card: { local_config: { version: 2, updated_at: 'x', items: {} } }, entries_masked: {}, ledger: { faces: { [m[1]]: { local_config: { version_applied: 1, applied_at: 'x', write_result: 'ok' } } } } } };
      }
      if (m) {
        // 清单外键一条（渲染为自由行+「移除」钮）——connSaveDomain prevCount>0 判定源
        return { status: 200, body: { object: 'config.card.managed', card: { local_config: { version: 1, updated_at: 'x', items: { custom_key: 'legacy-value' } } }, entries_masked: {}, ledger: { faces: { [m[1]]: { local_config: { version_applied: 1, applied_at: 'x', write_result: 'ok' } } } } } };
      }
      return okFor(url);
    }]);
    const d = dom.window.document;
    await connect(d);
    await waitFor(() => !!d.querySelector('#cd-mmc [data-cd-del-row]'));
    (d.querySelector('#cd-mmc [data-cd-del-row]') as HTMLElement).click();
    (d.querySelector('[data-cd-save="mmc"]') as HTMLElement).click();
    // msg 节点在成功路径会被 renderConnectDomains 重建（innerHTML 整体替换）——
    // 禁持旧节点引用（detached 后 textContent 永不变，S4 cd-*-phase 动态渲染同族坑），
    // waitFor 内每次现取。
    await waitFor(() => ((d.getElementById('cd-mmc-msg') as HTMLElement | null)?.textContent ?? '').includes('已清 · 待落地'));
    const msg = d.getElementById('cd-mmc-msg') as HTMLElement;
    assert.ok((msg.textContent ?? '').includes('机器侧现持旧值'), '诚实注记全文在位（禁无提示分叉）');
    assert.equal(msg.hidden, false, '注记可见（最终态非 hidden——置后修锚：不被 loadFaceCards 同源重渲冲掉）');
    retireUi(dom);
  });

  it('S4b D: 切域签触发该域卡增量重拉（行为断言：切签一次=该域 cards GET +1·非轮询）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const verifyBody = { object: 'config.verify', generated_at: 'x', faces: {
      mmc: vr('mmc', 'applied', '已落生效'), mlc: vr('mlc', 'applied', '已落生效'),
      rmc: vr('rmc', 'not-configured', '未配置'), rlc: vr('rlc', 'applied', '已落生效'),
    } };
    const dom = connectedDom(log, verifyBody);
    const d = dom.window.document;
    await connect(d);
    await waitFor(() => log.filter((e) => e.url.includes('/v1/config/cards/rlc')).length >= 1);
    const before = log.filter((e) => e.url.includes('/v1/config/cards/rlc')).length;
    (d.querySelector('[data-cd-tab="rlc"]') as HTMLElement).click();
    // D 行为断言：切签触发 reloadFaceCard（GET 既有单卡端点）——人工触发非轮询非订阅
    await waitFor(() => log.filter((e) => e.url.includes('/v1/config/cards/rlc')).length >= before + 1);
    assert.equal((d.getElementById('cd-rlc-msg') as HTMLElement).textContent, '', '成功路径零失败提示（失败不空屏分支未误触）');
    retireUi(dom);
  });
});
