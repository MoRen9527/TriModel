// ── LG-058 P2：四域面卡 UI 骨架 jsdom 族（导航层/一致面八项模板/诚实三态/折叠自适应）──
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- DOM typing noise; runtime asserted by the suite itself
// @ts-nocheck
// 覆盖（对 P2 执行单 A1/A5 与 CPO IA 方案）：
// ① 导航层 7 项+单页面板切换+hash 路由（不嵌套二级页）
// ② 一致面八项 id 族 per face+模板序锁死（特有项追加在 CLI 对照行后）
// ③ 无令牌诚实态（未连接×4+零卡面请求）
// ④ 有令牌 managed 拉取（view=managed URL 断言）+诚实三态徽标+不造数注记
// ⑤ 折叠自适应=按「有实数据卡数」判（4→左菜单，3→顶部细条；CPO §4.2 情形1 按数判非按期判）
// ⑥ 卡内指路委托（mmc→连接配置页，通道不重复）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
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

type Resp = { status: number; body: unknown };
type FaceSpec = { present: boolean; state?: string };

function faceResponder(faces: Record<string, FaceSpec>) {
  return (url: string): Resp => {
    if (url.includes('/v1/models')) return { status: 200, body: { object: 'list', data: [{ id: 'GLM-5.3' }] } };
    if (url.includes('/v1/config/policy')) return { status: 200, body: { object: 'config.policy', policy: { version: '1', schedules: [] }, effective: { model: 'GLM-5.3', source: 'policy', matched_schedule_id: null } } };
    if (url.includes('/v1/config/keys')) return { status: 200, body: { object: 'config.keys', keys: {}, default_model: 'GLM-5.3', refresh_interval_s: 900, expires_at: 'x' } };
    if (url.includes('/v1/config/runtime-info')) return { status: 200, body: { object: 'config.runtime-info', domain_label: '本地域（TriMLC/TriRLC）', local_apply_enabled: false } };
    const m = url.match(/\/v1\/config\/cards\/(mlc|rlc|mmc|rmc)/);
    if (m) {
      const spec = faces[m[1]];
      if (!spec || !spec.present) {
        return { status: 200, body: { object: 'config.trimmc-card', card_file_present: false, card: null, entries_masked: {}, ledger: { faces: {} } } };
      }
      const state = spec.state ?? 'applied';
      return {
        status: 200,
        body: {
          object: 'config.trimmc-card', face: m[1], card_file_present: true,
          card: { default_model: 'GLM-5.3', status: { state, at: 'x' } },
          entries_masked: { e1: { provider: 'glm', model: 'GLM-5.3', masked: '****0001', enabled: true, updated_at: 'x' } },
          ledger: { faces: { [m[1]]: { last_pull_at: '2026-09-29T03:00:00Z', last_pull_from: 'remote', last_pull_result: 'ok', applied_state: state, applied_tier: 1 } } },
        },
      };
    }
    if (url.includes('/templates')) return { status: 200, body: { object: 'x', templates: [] } };
    if (url.includes('/v1/config/claude-fallback')) return { status: 200, body: { object: 'config.claude-fallback', file_present: false, readable: false } };
    if (url.includes('/v1/config/trimmc-card')) return { status: 200, body: { object: 'config.trimmc-card', card_file_present: false, card: null, entries_masked: {} } };
    return { status: 200, body: {} };
  };
}

function bootUi(fetchLog: Array<{ url: string; init?: RequestInit }>, responder: (url: string, init?: RequestInit) => Resp) {
  const handle = { done: false };
  const dom = new JSDOM(readFileSync(UI_PATH, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:3333/ui',
    beforeParse(window: import('jsdom').DOMWindow) {
      let call = 0;
      window.fetch = (async (url: string, init?: RequestInit) => {
        if (handle.done) return { status: 0, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        fetchLog.push({ url, init });
        if (window.closed) return { status: 0, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        const r = responder(url, init);
        call += 1;
        return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body), headers: new Map() } as unknown as Response;
      });
      window.localStorage.clear();
    },
  });
  (dom as unknown as { __handle: { done: boolean } }).__handle = handle;
  return dom;
}

const FACES = ['mlc', 'rlc', 'mmc', 'rmc'];
const PANELS = ['overview', 'card-mlc', 'card-rlc', 'card-mmc', 'card-rmc', 'strategy', 'connect'];

function connect(dom: JSDOM): void {
  const d = dom.window.document;
  (d.getElementById('token') as HTMLInputElement).value = 'tk-api';
  (d.getElementById('adminToken') as HTMLInputElement).value = 'tk-admin';
  d.getElementById('conn-save').click();
}

describe('LG-058 P2 四域面卡 UI 骨架', () => {
  it('① 导航层 7 项+默认总览+单页切换+hash 路由（不嵌套二级页）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => d.querySelectorAll('#ov-body tr').length >= 0 && d.querySelectorAll('#page-menu .menu-btn').length === 7);
    const btns = Array.from(d.querySelectorAll('#page-menu .menu-btn')) as HTMLElement[];
    assert.deepEqual(btns.map((b) => b.dataset.view), PANELS, '导航 7 项（总览+四卡+策略卡+连接配置）');
    assert.equal((d.getElementById('panel-overview') as HTMLElement).hidden, false, '默认视图=当前生效总览');
    for (const p of PANELS.slice(1)) assert.equal((d.getElementById('panel-' + p) as HTMLElement).hidden, true, `面板 ${p} 默认隐藏`);
    btns.find((b) => b.dataset.view === 'card-mmc').click();
    await waitFor(() => (d.getElementById('panel-card-mmc') as HTMLElement).hidden === false);
    assert.equal((d.getElementById('panel-overview') as HTMLElement).hidden, true, '总览让位（单页语义）');
    assert.equal(dom.window.location.hash, '#card-mmc', 'hash 路由在位');
    retireUi(dom);
  });

  it('② 一致面八项 id 族 per face+模板序锁死（特有项追加在 CLI 对照行后）+CLI 对照行四 bin', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => (d.getElementById('panel-overview') as HTMLElement).hidden === false);
    for (const f of FACES) {
      const panel = d.getElementById('panel-card-' + f);
      assert.ok(panel, `面板 ${f} 在位`);
      for (const slot of ['badge', 'pull', 'cfg', 'entries', 'audit']) {
        assert.ok(d.getElementById(`cf-${f}-${slot}`), `${f} 一致面槽位 ${slot} 在位`);
      }
      const html = panel.innerHTML;
      for (const head of ['拉取状态', '现役配置', '模板切换', '备份与回滚', '审计行', '不可用时', 'CLI 对照', '本域特有']) {
        assert.ok(html.includes(head), `${f} 八项区头「${head}」在位`);
      }
      assert.ok(html.indexOf('CLI 对照') < html.indexOf('本域特有'), `${f} 特有项追加在模板位之后（模板锁死）`);
      assert.ok(html.includes('自动用最近一次拉取的缓存'), `${f} 降级话术（人话）在位`);
    }
    const cliBins: Record<string, string> = { mlc: 'trimlc config', rlc: 'trirlc config', mmc: 'trimmc config', rmc: 'trirmc config' };
    for (const f of FACES) {
      assert.ok((d.getElementById('panel-card-' + f) as HTMLElement).textContent.includes(cliBins[f]), `${f} CLI 对照行 bin=${cliBins[f]}`);
    }
    // mlc=静态正形（fb 本机栏并入槽位④⑤）；rlc/mmc/rmc=模板渲染（tpl/bak 槽位）
    assert.ok(d.querySelector('#panel-card-mlc #fb-current'), 'mlc 本机栏现值区在卡内');
    assert.ok(d.querySelector('#panel-card-mlc #fb-bak-list'), 'mlc 备份清单钮在卡内');
    for (const f of ['rlc', 'mmc', 'rmc']) {
      assert.ok(d.getElementById(`cf-${f}-tpl`), `${f} 模板切换槽位在位`);
      assert.ok(d.getElementById(`cf-${f}-bak`), `${f} 备份回滚槽位在位`);
    }
    // 卡特有差异面（CPO §3.B 四行）
    assert.ok((d.getElementById('cf-rlc-special') as HTMLElement).textContent.includes('8711'), 'rlc 特有：8711 健康锚');
    assert.ok((d.getElementById('cf-mmc-special') as HTMLElement).textContent.includes('值席'), 'mmc 特有：值席面关联');
    assert.ok((d.getElementById('cf-rmc-special') as HTMLElement).textContent.includes('禁跨机复制'), 'rmc 特有：域锚约束');
    assert.ok(d.querySelector('#panel-card-mmc [data-goto="connect"]'), 'mmc 模板槽=指路连接配置（通道不重复）');
    retireUi(dom);
  });

  it('③ 无令牌诚实态：未连接×4+零卡面请求+首启引导', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await new Promise((r) => setTimeout(r, 150));
    const badges = FACES.map((f) => d.getElementById(`cf-${f}-badge`) as HTMLElement);
    assert.deepEqual(badges.map((b) => b.textContent), ['未连接', '未连接', '未连接', '未连接'], '无令牌=未连接诚实态×4');
    assert.equal(badges.every((b) => b.className.includes('none')), true, '徽标灰系（none）');
    assert.equal(log.filter((c) => c.url.includes('/v1/config/cards/')).length, 0, '无令牌零卡面请求（不发无效往返）');
    assert.equal((d.getElementById('conn-settings') as HTMLDetailsElement).open, true, '首启自动展开连接设置');
    assert.equal((d.getElementById('conn-guide') as HTMLElement).hidden, false, '首启引导可见');
    retireUi(dom);
  });

  it('④ 有令牌 managed 拉取：view=managed URL×4+诚实三态徽标+不造数注记+审计行台账摘要', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({
      mlc: { present: true, state: 'applied' },
      rlc: { present: true, state: 'pending' },
      rmc: { present: true, state: 'failed' },
      mmc: { present: false },
    }));
    const d = dom.window.document;
    connect(dom);
    // 等 POST-connect 真后置标记（mlc 徽标翻已生效=四卡拉取+渲染完成），
    // 禁用总览行数当门（无令牌早退分支也会渲染 4 行未连接行）
    await waitFor(() => ((d.getElementById('cf-mlc-badge') as HTMLElement).textContent === '已生效'));
    const cardCalls = log.filter((c) => c.url.includes('/v1/config/cards/'));
    assert.equal(cardCalls.length >= 4, true, '四卡面 managed GET 发出');
    for (const f of FACES) {
      assert.ok(cardCalls.some((c) => c.url === `/v1/config/cards/${f}?view=managed`), `${f} managed 视图 URL 正形`);
    }
    const badgeOf = (f: string) => (d.getElementById(`cf-${f}-badge`) as HTMLElement);
    assert.equal(badgeOf('mlc').textContent, '已生效', 'mlc applied→已生效');
    assert.equal(badgeOf('mlc').className.includes('applied'), true, 'mlc 绿系徽标');
    assert.equal(badgeOf('rlc').textContent, '待应用', 'rlc pending→待应用（降级态如实）');
    assert.equal(badgeOf('rlc').className.includes('pending'), true, 'rlc 黄系徽标');
    assert.equal(badgeOf('rmc').textContent, '失败', 'rmc failed→失败（降级态如实）');
    assert.equal(badgeOf('rmc').className.includes('failed'), true, 'rmc 红系徽标');
    assert.equal(badgeOf('mmc').textContent, '未配置', 'mmc 卡缺席→未配置（断链候选，如实）');
    assert.ok(((d.getElementById('cf-mmc-cfg') as HTMLElement).textContent ?? '').includes('不造数'), 'mmc 断链诚实注记（不造数）');
    assert.ok(((d.getElementById('cf-mlc-audit') as HTMLElement).textContent ?? '').includes('applied'), 'mlc 审计行消费 ledger 摘要面');
    assert.ok(((d.getElementById('cf-mlc-pull') as HTMLElement).textContent ?? '').includes('2026-09-29T03:00:00Z'), 'mlc 拉取状态行消费 ledger.last_pull_at');
    // LG-058 N1：配置层级行——消费 ledger.applied_tier（tier1=卡面拉取），非页面自编
    const mlcPull = (d.getElementById('cf-mlc-pull') as HTMLElement).textContent ?? '';
    assert.ok(mlcPull.includes('配置层级'), 'pull 行含配置层级行');
    assert.ok(mlcPull.includes('第1层·卡面拉取'), 'mlc 配置层级消费 applied_tier=1 → 第1层·卡面拉取');
    assert.ok(((d.getElementById('cf-mmc-pull') as HTMLElement).textContent ?? '').includes('暂无回写'), 'mmc 无台账 → 层级显「暂无回写」（不造数）');
    // 总览行=一行一卡
    const ovRows = d.querySelectorAll('#ov-body tr');
    assert.equal(ovRows.length, 4, '总览一行一卡');
    assert.ok((ovRows[0] as HTMLElement).textContent.includes('TriMLC'), '总览首行=TriMLC');
    retireUi(dom);
  });

  it('⑤ 折叠自适应=按有实数据卡数判：4/4→左菜单，3/4→顶部细条（按数判非按期判）', async () => {
    // case A：四卡全实数据 → body.menu-full（左菜单）
    const logA: Array<{ url: string; init?: RequestInit }> = [];
    const domA = bootUi(logA, faceResponder({
      mlc: { present: true, state: 'applied' }, rlc: { present: true, state: 'applied' },
      mmc: { present: true, state: 'pending' }, rmc: { present: true, state: 'applied' },
    }));
    const dA = domA.window.document;
    connect(domA);
    await waitFor(() => dA.querySelectorAll('#ov-body tr').length === 4);
    assert.equal(dA.body.classList.contains('menu-full'), true, '4/4 实数据→左菜单形态');
    assert.ok(((dA.getElementById('ov-menu-note') as HTMLElement).textContent ?? '').includes('左侧菜单'), '菜单形态注记=左侧菜单');
    assert.ok(((dA.getElementById('ov-menu-note') as HTMLElement).textContent ?? '').includes('4/4'), '计数读数 4/4');
    retireUi(domA);
    // case B：三卡实数据（mmc 缺席）→ 顶部细条
    const logB: Array<{ url: string; init?: RequestInit }> = [];
    const domB = bootUi(logB, faceResponder({
      mlc: { present: true, state: 'applied' }, rlc: { present: true, state: 'applied' },
      mmc: { present: false }, rmc: { present: true, state: 'applied' },
    }));
    const dB = domB.window.document;
    connect(domB);
    await waitFor(() => dB.querySelectorAll('#ov-body tr').length === 4);
    assert.equal(dB.body.classList.contains('menu-full'), false, '3/4 实数据→顶部细条（骨架期形态）');
    assert.ok(((dB.getElementById('ov-menu-note') as HTMLElement).textContent ?? '').includes('顶部细条'), '菜单形态注记=顶部细条');
    assert.ok(((dB.getElementById('ov-menu-note') as HTMLElement).textContent ?? '').includes('3/4'), '计数读数 3/4');
    retireUi(domB);
  });

  it('⑥ 卡内指路委托：mmc 卡 data-goto=connect 点击→连接配置页让位显形', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({ mmc: { present: true, state: 'pending' } }));
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('#ov-body tr').length === 4);
    (d.querySelector('#panel-card-mmc [data-goto="connect"]') as HTMLElement).click();
    await waitFor(() => (d.getElementById('panel-connect') as HTMLElement).hidden === false);
    assert.equal((d.getElementById('panel-card-mmc') as HTMLElement).hidden, true, 'mmc 卡让位（单页语义）');
    assert.ok(((d.getElementById('panel-connect') as HTMLElement).textContent ?? '').includes('TriMMC（sg）'), '连接配置页=sg 栏收敛位');
    retireUi(dom);
  });

  it('⑦ 策略卡参照层正名+常态只读标注+面板隐藏不破策略卡功能', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => (d.getElementById('panel-overview') as HTMLElement).hidden === false);
    const strategyH2 = (d.querySelector('#panel-strategy h2') as HTMLElement).textContent;
    assert.ok(strategyH2.includes('TriModel 策略卡'), '策略卡正名（参照层）');
    assert.ok(strategyH2.includes('本机过渡位实例'), '过渡位实例标注');
    assert.ok(((d.getElementById('panel-strategy') as HTMLElement).textContent ?? '').includes('常态只读'), '常态只读标注（编辑窗候 CEO 终验）');
    // 面板隐藏（display:none!important）不改变元素本位显隐语义：三型字段锚仍可切换
    (Array.from(d.querySelectorAll('#page-menu .menu-btn')) as HTMLElement[]).find((b) => b.dataset.view === 'strategy').click();
    await waitFor(() => (d.getElementById('panel-strategy') as HTMLElement).hidden === false);
    assert.equal((d.getElementById('panel-strategy') as HTMLElement).hidden, false, '策略卡面板可达');
    retireUi(dom);
  });
});
