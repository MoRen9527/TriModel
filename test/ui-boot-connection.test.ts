// ── 连接配置页 v2 UI 测试（TASK-TRIMODEL-RECOVERY-LADDER-01 波①，2026-09-26 CTO 裁 a）──
// 契约代际：取代 ui-boot.test.ts 旧「直连兜底区」3 测+「CPO 警示句 verbatim×2」1 测
// （旧契约=09-15 三输入手填直写；v2=双签 joint-plan 问3 模板三件套：模板下拉+只填密钥+
//   预览门控写入+独立钥注入+备份回滚）。
// 硬条款：jsdom 首启链 save→reload→断言仍在（本文件「写入后重载」用例）。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- DOM typing noise; runtime asserted below
// @ts-nocheck
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const UI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
}

const retiredDoms: JSDOM[] = [];
function retireUi(dom: JSDOM): void {
  const h = (dom as unknown as { __handle: { done: boolean } }).__handle;
  if (h) h.done = true;
  retiredDoms.push(dom);
}

function bootUi(fetchLog: Array<{ url: string; init?: RequestInit }>, responder: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const handle = { done: false };
  const dom = new JSDOM(readFileSync(UI_PATH, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:3333/ui',
    beforeParse(window: import('jsdom').DOMWindow) {
      window.fetch = (async (url: string, init?: RequestInit) => {
        if (handle.done) return { status: 0, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        fetchLog.push({ url, init });
        if (window.closed) return { status: 0, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        const r = responder(url, init);
        return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body), headers: new Map() } as unknown as Response;
      });
      window.localStorage.clear();
    },
  });
  (dom as unknown as { __handle: { done: boolean } }).__handle = handle;
  return dom;
}

// 页面 boot 必发的其余端点（照 ui-boot.test.ts okFor 同族）
function baseOkFor(url: string): { status: number; body: unknown } {
  if (url.includes('/v1/models')) return { status: 200, body: { object: 'list', data: [{ id: 'deepseek-v4-pro' }] } };
  if (url.includes('/v1/config/policy')) return { status: 200, body: { object: 'config.policy', policy: { version: '1', schedules: [] }, effective: { model: 'deepseek-v4-pro', source: 'env-default', matched_schedule_id: null } } };
  if (url.includes('/v1/config/keys')) return { status: 200, body: { object: 'config.keys', keys: {}, default_model: 'deepseek-v4-pro', refresh_interval_s: 900, expires_at: 'x' } };
  if (url.includes('/trimmc-card')) return { status: 200, body: { object: 'config.trimmc-card', card_file_present: false, card: null, entries_masked: {} } };
  return { status: 200, body: {} };
}

const TEMPLATES_BODY = {
  object: 'config.claude-fallback.templates',
  templates: [
    { id: 'bigmodel', label: 'bigmodel 直连（glm）', base_url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3-flash', key_placeholder: '在 bigmodel 控制台生成的 API Key', deployed: true },
    { id: 'deepseek', label: 'deepseek 直连（候批模板）', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', key_placeholder: 'deepseek 平台 API Key', deployed: false },
  ],
};

function fbState(overrides: {
  get?: { status: number; body: unknown };
  templates?: { status: number; body: unknown };
  preview?: { status: number; body: unknown };
  restore?: { status: number; body: unknown };
  inject?: { status: number; body: unknown };
  backups?: { status: number; body: unknown };
  rollback?: { status: number; body: unknown };
} = {}) {
  const o = overrides;
  const get = o.get ?? { status: 200, body: { object: 'config.claude-fallback', file_present: true, readable: true, base_url: 'https://old.example.com/api', model: 'old-model' } };
  return (url: string, init?: RequestInit): { status: number; body: unknown } => {
    if (url.includes('/v1/config/claude-fallback/templates')) return o.templates ?? { status: 200, body: TEMPLATES_BODY };
    if (url.includes('/v1/config/claude-fallback/preview')) return o.preview ?? { status: 200, body: { ok: true, dry_run: true, diff: [{ key: 'ANTHROPIC_BASE_URL', changed: true, before: 'https://old.example.com/api', after: 'https://open.bigmodel.cn/api/anthropic' }], message: '预览（零写入）' } };
    if (url.includes('/v1/config/claude-fallback/restore')) return o.restore ?? { status: 200, body: { ok: true, message: '兜底直连已写入。重启会话后生效。' } };
    if (url.includes('/v1/config/claude-fallback/inject-key')) return o.inject ?? { status: 200, body: { ok: true, message: '已从独立钥文件写入。重启会话后生效。' } };
    if (url.includes('/v1/config/claude-fallback/backups')) return o.backups ?? { status: 200, body: { object: 'config.claude-fallback.backups', settings_file: '/x/settings.json', sentinel: false, keep: 5, backups: [{ file: 'settings.json.bak-2026', mtime: '2026-09-25T17:00:00.000Z', size: 123 }] } };
    if (url.includes('/v1/config/claude-fallback/rollback')) return o.rollback ?? { status: 200, body: { ok: true, rolled_back_to: 'settings.json.bak-2026', pre_rollback_backup: '/x/settings.json.bak-now', message: '已回滚到所选备份。重启会话后生效。' } };
    if (url.includes('/v1/config/claude-fallback')) return get;
    return baseOkFor(url);
  };
}

async function bootAndRendered(log: Array<{ url: string; init?: RequestInit }>, responder) {
  const dom = bootUi(log, responder);
  const d = dom.window.document;
  await waitFor(() => (d.getElementById('fb-current') as HTMLElement).textContent.includes('当前服务地址'));
  await waitFor(() => (d.getElementById('fb-tpl') as HTMLSelectElement).options.length >= 2);
  return { dom, d };
}

/** v2 写入前置：选模板+填密钥+预览通过（写入按钮解禁）。 */
async function primePreview(d: HTMLElement, doc: Document) {
  (doc.getElementById('fb-tpl') as HTMLSelectElement).value = 'bigmodel';
  (doc.getElementById('fb-key') as HTMLInputElement).value = 'sk-ui-token-abcdefghij';
  (doc.getElementById('fb-preview') as HTMLButtonElement).click();
  await waitFor(() => !(doc.getElementById('fb-restore') as HTMLButtonElement).disabled);
  void d;
}

describe('连接配置页 v2（波① TASK-TRIMODEL-RECOVERY-LADDER-01；CTO 裁 a 契约代际）', () => {
  after(() => { for (const dom of retiredDoms) { try { dom.window.close(); } catch { /* already closed */ } } });

  it('区块渲染+模板表+现状展示：模板下拉+密钥(password)+预览/写入(初始禁用)在位；GET 填充当前地址/模型；不参与禁用链', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, d } = await bootAndRendered(log, fbState());
    assert.ok(d.getElementById('fb-zone'), '区块容器在位');
    assert.ok(d.getElementById('fb-tpl'), '模板下拉在位（v2：目的地由模板供给）');
    const key = d.getElementById('fb-key') as HTMLInputElement;
    assert.ok(key, '密钥输入在位');
    assert.equal(key.type, 'password', '密钥默认遮蔽');
    assert.ok(d.getElementById('fb-preview'), '预览按钮在位（v2 写前预览门控）');
    const restore = d.getElementById('fb-restore') as HTMLButtonElement;
    assert.ok(restore, '写入按钮在位');
    assert.equal(restore.disabled, true, '未预览=写入禁用（v2 门控语义）');
    assert.ok((d.getElementById('fb-current') as HTMLElement).textContent.includes('old.example.com'), '当前地址展示');
    assert.ok((d.getElementById('fb-current') as HTMLElement).textContent.includes('old-model'), '当前模型展示');
    const tpl = d.getElementById('fb-tpl') as HTMLSelectElement;
    assert.ok(Array.from(tpl.options).some((o) => o.value === 'bigmodel' && !o.disabled), 'bigmodel 模板可选');
    assert.ok(Array.from(tpl.options).some((o) => o.value === 'deepseek' && o.disabled), 'deepseek 候批禁选');
    assert.equal((d.getElementById('fb-zone') as HTMLElement).classList.contains('disabled-panel'), false, '禁用链零波及');
    assert.equal((d.getElementById('fb-preview') as HTMLButtonElement).disabled, false, '预览恒可用');
    retireUi(dom);
  });

  it('预览门控：未选模板/缺密钥=行内拒零请求；通过后 POST preview 三键 verbatim（地址/模型来自模板）→diff 渲染+写入解禁', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, d } = await bootAndRendered(log, fbState());
    (d.getElementById('fb-preview') as HTMLButtonElement).click();
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('请先选择目的地模板'));
    assert.equal(log.some((c) => c.url.includes('/preview')), false, '未选模板零请求');
    (d.getElementById('fb-tpl') as HTMLSelectElement).value = 'bigmodel';
    (d.getElementById('fb-preview') as HTMLButtonElement).click();
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('请填写 API 密钥'));
    assert.equal(log.some((c) => c.url.includes('/preview')), false, '缺密钥零请求');
    await primePreview(null!, d);
    const call = log.find((c) => c.url.includes('/preview'))!;
    assert.equal(call.init?.method, 'POST', 'preview=POST');
    const sent = JSON.parse(String(call.init?.body));
    assert.equal(sent.base_url, 'https://open.bigmodel.cn/api/anthropic', '地址来自模板（门②服务端同源）');
    assert.equal(sent.model, 'glm-5.3-flash', '模型来自模板');
    assert.equal(sent.api_key, 'sk-ui-token-abcdefghij', '密钥 verbatim');
    assert.equal((d.getElementById('fb-diff-box') as HTMLElement).hidden, false, 'diff 表可见');
    assert.ok((d.getElementById('fb-diff') as HTMLElement).textContent.includes('ANTHROPIC_BASE_URL'), 'diff 行渲染');
    assert.equal((d.getElementById('fb-msg') as HTMLElement).textContent.includes('预览'), true, '预览反馈');
    retireUi(dom);
  });

  it('写入链：POST restore 三键 verbatim→成功文案含「重启会话后生效」+密钥框清空+回到未预览态+GET 重拉现状', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, d } = await bootAndRendered(log, fbState());
    await primePreview(null!, d);
    const getsBefore = log.filter((c) => c.url.includes('/v1/config/claude-fallback') && !c.url.includes('templates') && !['preview', 'restore', 'inject', 'backups', 'rollback'].some((s) => c.url.includes(s))).length;
    (d.getElementById('fb-restore') as HTMLButtonElement).click();
    await waitFor(() => (d.getElementById('fb-key') as HTMLInputElement).value === '');
    const call = log.find((c) => c.url.includes('/restore'))!;
    assert.equal(call.init?.method, 'POST');
    const sent = JSON.parse(String(call.init?.body));
    assert.equal(sent.api_key, 'sk-ui-token-abcdefghij', '密钥 verbatim 发出');
    assert.ok((d.getElementById('fb-msg') as HTMLElement).textContent.includes('重启会话后生效'), '成功文案');
    assert.equal((d.getElementById('fb-key') as HTMLInputElement).value, '', '写后密钥框清空（不回显）');
    assert.equal((d.getElementById('fb-restore') as HTMLButtonElement).disabled, true, '写入后回未预览态');
    await waitFor(() => log.filter((c) => c.url.includes('/v1/config/claude-fallback') && !c.url.includes('templates') && !['preview', 'restore', 'inject', 'backups', 'rollback'].some((s) => c.url.includes(s))).length > getsBefore, 'GET 重拉现状');
    retireUi(dom);
  });

  it('失败态人话：preview 401→令牌引导；restore 503→未启用引导；门③ 400 占位符→服务端人话透传', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, d } = await bootAndRendered(log, fbState({
      preview: { status: 401, body: { error: '令牌不正确' } },
      restore: { status: 503, body: { error: '未启用' } },
    }));
    await primePreview(null!, d);
    assert.ok((d.getElementById('fb-msg') as HTMLElement).textContent.includes('管理令牌不正确'), '401 人话引导');
    assert.equal((d.getElementById('fb-restore') as HTMLButtonElement).disabled, true, '预览失败=写入保持禁用');
    // 503：直接触发写入分支（预置解禁态绕过门控）
    (d.getElementById('fb-restore') as HTMLButtonElement).disabled = false;
    (d.getElementById('fb-restore') as HTMLButtonElement).click();
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('兜底写入未启用'));
    // 门③：preview 400 占位符
    (d.getElementById('fb-preview') as HTMLButtonElement).click === undefined; // noop 安抚
    retireUi(dom);
    const log2: Array<{ url: string; init?: RequestInit }> = [];
    const dom2 = bootUi(log2, fbState({ preview: { status: 400, body: { error: '检测到占位符（PLACEHOLDER 残留），请输入真实密钥' } } }));
    const d2 = dom2.window.document;
    await waitFor(() => (d2.getElementById('fb-tpl') as HTMLSelectElement).options.length >= 2);
    (d2.getElementById('fb-tpl') as HTMLSelectElement).value = 'bigmodel';
    (d2.getElementById('fb-key') as HTMLInputElement).value = 'sk-PLACEHOLDER-residual-0000';
    (d2.getElementById('fb-preview') as HTMLButtonElement).click();
    await waitFor(() => (d2.getElementById('fb-msg') as HTMLElement).textContent.includes('占位符'));
    retireUi(dom2);
  });

  it('独立钥注入：POST inject-key {template} 模板 id（钥值不经页面）→成功文案', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, d } = await bootAndRendered(log, fbState());
    (d.getElementById('fb-tpl') as HTMLSelectElement).value = 'bigmodel';
    (d.getElementById('fb-inject') as HTMLButtonElement).click();
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('独立钥文件'));
    const call = log.find((c) => c.url.includes('/inject-key'))!;
    assert.equal(call.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(call.init?.body)), { template: 'bigmodel' }, '只传模板 id');
    assert.equal(String(call.init?.body).includes('sk-'), false, '请求体零钥值');
    retireUi(dom);
  });

  it('备份清单+两击回滚：清单渲染（keep/sentinel）→首击 armed→次击 POST rollback→成功文案', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, d } = await bootAndRendered(log, fbState());
    (d.getElementById('fb-bak-list') as HTMLButtonElement).click();
    await waitFor(() => ((d.getElementById('fb-bak-box') as HTMLElement).textContent ?? '').includes('settings.json.bak-2026'));
    const box = d.getElementById('fb-bak-box') as HTMLElement;
    assert.ok(box.textContent.includes('保留近 5 份'), 'keep 展示');
    const btn = box.querySelector('button') as HTMLButtonElement;
    btn.click();
    assert.equal(btn.textContent, '确认回滚', '首击=armed 两击确认');
    assert.equal(log.some((c) => c.url.includes('/rollback')), false, 'armed 态零请求');
    btn.click();
    await waitFor(() => log.some((c) => c.url.includes('/rollback')));
    const call = log.find((c) => c.url.includes('/rollback'))!;
    assert.deepEqual(JSON.parse(String(call.init?.body)), { backup: 'settings.json.bak-2026' });
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('已回滚'));
    retireUi(dom);
  });

  it('首启链 save→reload→断言仍在（硬条款）：dom1 写入成功→新 dom 读到持久化新值+掩码尾位', async () => {
    // dom1：首启旧值→选模板+填密钥+预览+写入
    const log1: Array<{ url: string; init?: RequestInit }> = [];
    const { dom: dom1, d: d1 } = await bootAndRendered(log1, fbState());
    assert.ok((d1.getElementById('fb-current') as HTMLElement).textContent.includes('old.example.com'), '首启现状=旧值');
    await primePreview(null!, d1);
    (d1.getElementById('fb-restore') as HTMLButtonElement).click();
    await waitFor(() => (d1.getElementById('fb-key') as HTMLInputElement).value === '');
    retireUi(dom1);
    // dom2：reload——GET 读服务端落盘后的新值（持久化语义）
    const log2: Array<{ url: string; init?: RequestInit }> = [];
    const dom2 = bootUi(log2, fbState({
      get: { status: 200, body: { object: 'config.claude-fallback', file_present: true, readable: true, base_url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3-flash', api_key_masked: '****ghij' } },
    }));
    const d2 = dom2.window.document;
    await waitFor(() => (d2.getElementById('fb-current') as HTMLElement).textContent.includes('open.bigmodel.cn'));
    const cur = (d2.getElementById('fb-current') as HTMLElement).textContent ?? '';
    assert.ok(cur.includes('open.bigmodel.cn'), 'reload 后新地址仍在（save→reload→persist）');
    assert.ok(cur.includes('glm-5.3-flash'), 'reload 后新模型仍在');
    assert.ok(cur.includes('****ghij'), '管理态掩码尾位展示');
    assert.equal(cur.includes('sk-ui-token'), false, '全值零回显');
    retireUi(dom2);
  });

  it('CPO 警示句两栏在卷（P2 结构：本机句随本机栏并入 TriMLC 卡④槽，sg 句留连接配置页；verbatim 各×1）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, fbState());
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    const zone = ((d.getElementById('fb-zone') as HTMLElement).textContent ?? '');
    const LOCAL_WARN = '写入会把全部模型档位（含 HAIKU 小模型档）统一为所填模型；写入前自动备份原设置（保留近 5 份），写后自动校验失败即回滚';
    const SG_WARN = '写入会把全部模型档位（含 HAIKU 小模型档）统一为所填模型；写入前自动备份原设置，可回滚';
    // P2 四卡面（LG-058）：本机栏（模板切换+备份回滚+本机警示句）整体并入
    // TriMLC 卡槽位④/⑤（消双门）；fb-zone 收敛为 sg 栏+应急帮助（CPO IA §4.1）。
    assert.equal(zone.split(SG_WARN).length - 1, 1, 'sg 栏沿旧句 verbatim×1（连接配置页）');
    assert.equal(zone.includes(LOCAL_WARN), false, '本机句不再在连接配置页（防双栏重复）');
    assert.ok(zone.includes('不承担应急兜底'), '页头应急命令警示在卷');
    const mlc = ((d.getElementById('panel-card-mlc') as HTMLElement).textContent ?? '');
    assert.equal(mlc.split(LOCAL_WARN).length - 1, 1, '本机栏 v2 句 verbatim×1（TriMLC 卡槽位④）');
    assert.ok(d.querySelector('#panel-card-mlc #fb-current'), '本机栏现值区在 TriMLC 卡内（并入到位）');
    assert.ok(d.querySelector('#panel-card-mlc #fb-bak-list'), '备份清单钮在 TriMLC 卡内（槽位⑤）');
    retireUi(dom);
  });
});
