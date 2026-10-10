// ── LG-058 P2：四域面卡 UI 骨架 jsdom 族（导航层/一致面八项模板/诚实三态/折叠自适应）──
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- DOM typing noise; runtime asserted by the suite itself
// @ts-nocheck
// 覆盖（对 P2 执行单 A1/A5 与 CPO IA 方案）：
// ① 导航层 7 项+单页面板切换+hash 路由（不嵌套二级页）
// ② 一致面八项 id 族 per face+模板序锁死（特有项追加在 CLI 对照行后）
// ③ 无令牌诚实态（未连接×4+零卡面请求）
// ④ 有令牌 managed 拉取（view=managed URL 断言）+诚实三态徽标+不造数注记
// ⑤ 菜单常驻骨架（BOD 2026-10-06 更正令①②③）：左菜单右主体无条件默认形态，
//    按数折叠/条件展开门已废；缺数据卡菜单项置灰待数据；顶部细条退役
// ⑤b menu-full 左右布局真回归门（LG-058 P1 回炉门禁附款：结构宿主+几何分左右双断言）
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
    assert.ok((d.getElementById('cf-mmc-special') as HTMLElement).textContent.includes('「模型策略」页同一份'), 'mmc 特有：同卡双源指引（深测②合一 S4·CPO 搭车② special 清洗后锚跟随）');
    assert.ok((d.getElementById('cf-rmc-special') as HTMLElement).textContent.includes('禁跨机复制'), 'rmc 特有：域锚约束');
    assert.ok(d.querySelector('#panel-card-mmc [data-goto="connect"]'), 'mmc 模板槽=指路连接配置（通道不重复）');
    retireUi(dom);
  });

  it('②b LG-058 N2 真按钮在位：rlc/rmc 模板/备份四件套+候建文字态清除（mmc 候建如实维持）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => (d.getElementById('panel-overview') as HTMLElement).hidden === false);
    for (const f of ['rlc', 'rmc']) {
      const panel = d.getElementById('panel-card-' + f);
      assert.ok(panel.querySelector(`[data-card-tpl-load="${f}"]`), `${f} 读取模板按钮在位`);
      assert.ok(panel.querySelector(`[data-card-bak-load="${f}"]`), `${f} 读取备份清单按钮在位`);
      assert.ok(d.getElementById(`cf-${f}-tpl-sel`), `${f} 模板下拉在位`);
      assert.ok(d.getElementById(`cf-${f}-tpl-apply`), `${f} 应用模板按钮在位`);
      assert.ok(d.getElementById(`cf-${f}-bak-box`), `${f} 备份清单容器在位`);
      const html = (panel as HTMLElement).innerHTML;
      assert.ok(!html.includes('候建——模板切换入口'), `${f} 模板槽候建文字态已清除`);
      assert.ok(!html.includes('候建——备份与回滚入口'), `${f} 备份槽候建文字态已清除`);
      assert.ok(html.includes('整卡替换'), `${f} 模板切换语义标注（整卡替换）在位`);
    }
    // M 面两卡暂缓（BOD 白窗令）：mmc bak 槽候建文字态如实维持；mlc 静态正形不动
    const mmcBak = (d.getElementById('cf-mmc-bak') as HTMLElement).innerHTML;
    assert.ok(mmcBak.includes('候建——备份与回滚入口'), 'mmc 备份槽候建如实维持（M 面暂缓）');
    assert.ok(d.querySelector('#panel-card-mlc #fb-bak-list'), 'mlc 静态 fb 栏备份钮原位（零动）');
    retireUi(dom);
  });

  it('②c LG-058 N5 方案一正名：卡名零机器位词（角色+实例二级——卡名答是谁，实例行答在哪）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => (d.getElementById('panel-overview') as HTMLElement).hidden === false);
    const forbidden = ['·本机', '·sg', '·河源'];
    // 导航 label（卡名=角色）
    const labels = Array.from(d.querySelectorAll('#page-menu .menu-btn')).map((b) => b.textContent ?? '');
    for (const suf of forbidden) {
      assert.ok(labels.every((l) => !l.includes(suf)), `导航 label 零「${suf}」后缀：${JSON.stringify(labels)}`);
    }
    // 四卡卡头 h2 首段（badge 前）=纯角色名；实例行（.sub）保留机位=合法面
    for (const f of FACES) {
      const h2 = d.querySelector(`#panel-card-${f} h2`);
      assert.ok(h2, `${f} 卡头在位`);
      const h2Clone = h2.cloneNode(true) as HTMLElement;
      h2Clone.querySelector('.sub')?.remove(); // 实例行不在卡名判定域
      const headText = h2Clone.textContent ?? '';
      for (const suf of forbidden) {
        assert.ok(!headText.includes(suf), `${f} 卡名零「${suf}」（headText=${headText.trim()}）`);
      }
      const inst = h2.querySelector('.sub');
      assert.ok(inst && inst.textContent!.includes('·'), `${f} 实例行在位（机位信息归实例行）`);
    }
    retireUi(dom);
  });

  it('②d LG-058 N5 方案二联席骨架：四卡 entry-actions/entry-form/rules 三件在位（mlc 静态同构）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => d.querySelectorAll('#page-menu .menu-btn').length === 7);
    for (const f of FACES) {
      assert.ok(d.getElementById(`cf-${f}-entry-actions`), `${f} 联席操作行在位`);
      assert.ok(d.querySelector(`[data-face-add-entry="${f}"]`), `${f} 新增条目按钮在位`);
      assert.ok(d.getElementById(`cf-${f}-entry-form`), `${f} 条目表单容器在位`);
      assert.ok(d.getElementById(`cf-${f}-rules`), `${f} 本域适用规则行在位`);
    }
    // 引用模型集带出钮初始隐藏（菜单空态诚实——有模型集后才显形）
    assert.equal((d.querySelector('[data-face-bring-set="rlc"]') as HTMLElement).hidden, true, '带出钮初始隐藏（菜单空）');
    retireUi(dom);
  });

  it('②e LG-058 N5 方案二联席渲染：溯源标注+规则勾选态+模型集下拉（策略卡数据驱动）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const base = faceResponder({ rlc: { present: true } });
    const responder = (url: string): Resp => {
      if (url.includes('/v1/config/trimmc-card')) {
        return {
          status: 200,
          body: {
            object: 'config.trimmc-card', card_file_present: true,
            card: {
              default_model: 'GLM-5.3',
              status: { state: 'applied', at: 'x' },
              model_sets: { s1: { name: '主力集', entry_ids: ['e1'] } },
              rules: { r1: { name: '默认规则', type: 'default', entry_id: 'e1' } },
            },
            entries_masked: { e1: { provider: 'glm', model: 'GLM-5.3', masked: '****0001', enabled: true, updated_at: 'x' } },
          },
        };
      }
      if (url.includes('/v1/config/cards/rlc')) {
        // 域卡现役 rules.r1 —— 勾选态断言的数据面
        const b = base(url).body as { card: Record<string, unknown> };
        return {
          status: 200,
          body: { ...b, card: { ...b.card, rules: { r1: { name: '默认规则', type: 'default', entry_id: 'e1' } } } },
        };
      }
      return base(url);
    };
    const dom = bootUi(log, responder);
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('#cf-rlc-entries tbody tr').length > 0, 4000);
    // 验收锚①：菜单条目溯源标注=集合名（点菜从菜单点，来源可辨）
    const modelCell = d.querySelector('#cf-rlc-entries tbody tr td:nth-child(2)') as HTMLElement;
    const mcText = modelCell.textContent ?? '';
    assert.ok(mcText.includes('GLM-5.3'), '模型值在位');
    assert.ok(mcText.includes('来自模型策略·主力集'), `溯源标注=集合名（批 A 正名词面；got=${mcText.trim()}）`);
    // 规则适用勾选：菜单规则 r1 在列+勾选态=本域现役 rules（两边互相可见）
    const ruleChk = d.querySelector('#cf-rlc-rules input[data-face-rule]') as HTMLInputElement;
    assert.ok(ruleChk, '规则勾选框在位');
    assert.equal(ruleChk.dataset.ruleId, 'r1', '勾选框绑定菜单规则 id');
    assert.equal(ruleChk.checked, true, '本域现役 rules.r1 → 勾选态同步');
    // 模型集下拉显形（有集合才显——引用带出入口）
    const setSel = d.getElementById('cf-rlc-set-sel') as HTMLSelectElement;
    assert.equal(setSel.hidden, false, '有模型集 → 下拉显形');
    assert.ok((setSel.textContent ?? '').includes('主力集'), '下拉含集合名');
    assert.equal((d.querySelector('[data-face-bring-set="rlc"]') as HTMLElement).hidden, false, '带出钮显形');
    // 未连接卡（mmc）：规则行=暂无诚实态
    assert.ok(((d.getElementById('cf-mmc-rules') as HTMLElement).textContent ?? '').includes('暂无'), '未连接卡规则行诚实态');
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
    // LG-058 N3：来源二分列——表头「来源」+tier1 条目=远程拉取配置（本地配置 vs 远程拉取配置二分，零「直连/中转」编造概念）
    const mlcEntries = d.getElementById('cf-mlc-entries') as HTMLElement;
    assert.ok((mlcEntries.textContent ?? '').includes('来源'), 'entries 表头含来源列');
    assert.ok((mlcEntries.textContent ?? '').includes('远程拉取配置'), 'mlc tier1 → 条目来源=远程拉取配置');
    assert.equal((mlcEntries.textContent ?? '').includes('直连'), false, '零「直连」编造概念残留');
    assert.equal((mlcEntries.textContent ?? '').includes('中转'), false, '零「中转」编造概念残留');
    // 总览行=一行一卡
    const ovRows = d.querySelectorAll('#ov-body tr');
    assert.equal(ovRows.length, 4, '总览一行一卡');
    assert.ok((ovRows[0] as HTMLElement).textContent.includes('TriMLC'), '总览首行=TriMLC');
    retireUi(dom);
  });

  it('⑤ 菜单常驻骨架：4/4 与 3/4 均 menu-full 左菜单（无条件默认，BOD 更正令①②）+缺卡项置灰+顶部细条退役', async () => {
    // case A：四卡全实数据 → 左菜单（骨架不因数据变化）
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
    // 全数据卡菜单项不置灰（dim 零命中）
    assert.equal(dA.querySelectorAll('#page-menu .menu-btn.dim').length, 0, '4/4 无置灰菜单项');
    retireUi(domA);
    // case B：三卡实数据（mmc 缺席）→ 左菜单仍常驻（不折叠回顶部细条——条件展开门废除）
    const logB: Array<{ url: string; init?: RequestInit }> = [];
    const domB = bootUi(logB, faceResponder({
      mlc: { present: true, state: 'applied' }, rlc: { present: true, state: 'applied' },
      mmc: { present: false }, rmc: { present: true, state: 'applied' },
    }));
    const dB = domB.window.document;
    connect(domB);
    await waitFor(() => dB.querySelectorAll('#ov-body tr').length === 4);
    assert.equal(dB.body.classList.contains('menu-full'), true, '3/4 实数据→左菜单仍常驻（骨架不退）');
    const noteB = (dB.getElementById('ov-menu-note') as HTMLElement).textContent ?? '';
    assert.ok(noteB.includes('左侧菜单'), '菜单形态注记=左侧菜单');
    assert.ok(noteB.includes('3/4'), '计数读数 3/4');
    assert.equal(noteB.includes('自动展开'), false, '条件展开话术零残留（更正令②）');
    assert.equal(noteB.includes('顶部细条'), false, '顶部细条话术零残留（更正令③）');
    // 缺数据卡菜单项置灰（mmc dim 在场，仍可点击不禁用）；满数据卡不置灰
    const mmcBtn = dB.querySelector('#page-menu .menu-btn[data-view="card-mmc"]') as HTMLElement;
    assert.ok(mmcBtn.classList.contains('dim'), '缺数据卡菜单项置灰（待数据）');
    assert.ok((mmcBtn.title ?? '').includes('待数据'), '置灰项 title 待数据提示');
    const mlcBtn = dB.querySelector('#page-menu .menu-btn[data-view="card-mlc"]') as HTMLElement;
    assert.equal(mlcBtn.classList.contains('dim'), false, '有数据卡菜单项不置灰');
    assert.equal(dB.querySelectorAll('#page-menu .menu-btn').length, 7, '菜单项 7 个恒在场（不隐藏菜单栏）');
    retireUi(domB);
  });

  // 最小 flex 形态模型桩：menu-full 态布局形态自 DOM 层级+CSS 锚值派生
  // （nav∈#app-layout → flex row：menu 210px 侧栏、main 左缘=其右缘+gap14；
  //   否则 → 块流：menu 占满行宽、main 起新行左缘 0）。锚值=ui/index.html body.menu-full 三条规则。
  function menuFullRects(d: Document): { menuRight: number; mainLeft: number } {
    const layout = d.getElementById('app-layout');
    const nav = d.getElementById('page-menu');
    const main = d.getElementById('page-main');
    if (layout && nav && main && nav.parentElement === layout) {
      return { menuRight: 210, mainLeft: 210 + 14 };
    }
    return { menuRight: 960, mainLeft: 0 };
  }

  // ── LG-058 P1 回炉门禁附款（BOD 裁 2026-10-06，CTO 定谳案一双断言）──
  // 事故形态：nav 系 #app-layout 前置兄弟节点→body.menu-full flex 宿主不含 menu→210px 侧栏永不兑现。
  // 附款①=结构（nav 宿主）；附款②=几何（menu 右缘不越 main 左缘，「分左右」真回归门）。
  // jsdom 无布局引擎（getBoundingClientRect 恒零矩形，几何断言直接跑恒真无信息）——
  // 几何经最小 flex 形态模型桩派生：输入=DOM 层级真值+CSS 锚值（桩前提由 CSS 在位断言钉住）；
  // 层级漂移（回归事故形态）必翻块流→门红，判别力由本 it 内反例注入自证。
  it('⑤b menu-full 左右布局真回归门：nav 宿主=#app-layout（结构）+分左右几何（P1 附款双断言）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({
      mlc: { present: true, state: 'applied' }, rlc: { present: true, state: 'applied' },
      mmc: { present: true, state: 'pending' }, rmc: { present: true, state: 'applied' },
    }));
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('#ov-body tr').length === 4);
    assert.equal(d.body.classList.contains('menu-full'), true, 'menu-full 态前置（4/4 实数据）');
    // 附款① 结构：nav 宿主=#app-layout（容器外则 flex 宿主不含 menu，侧栏永不兑现）
    const layout = d.getElementById('app-layout');
    const nav = d.getElementById('page-menu');
    assert.ok(layout && nav, '布局容器与导航节点在位');
    assert.equal(nav.parentElement, layout, '附款① 结构：nav.parentElement===#app-layout');
    // CSS 锚在位断言（桩模型 210/14 两值的前提锚，防桩与 CSS 漂移）
    const html = readFileSync(UI_PATH, 'utf-8');
    assert.ok(/body\.menu-full #app-layout\s*\{[^}]*display:\s*flex/.test(html), 'CSS 锚：menu-full 容器 flex 规则在位');
    assert.ok(/body\.menu-full #page-menu\s*\{[^}]*flex:\s*0 0 210px/.test(html), 'CSS 锚：menu 侧栏 210px（桩宽值锚）');
    assert.ok(/body\.menu-full #app-layout\s*\{[^}]*gap:\s*14px/.test(html), 'CSS 锚：容器 gap 14px（桩 gap 值锚）');
    // 附款② 几何：menu-full 宽视口下 menu 右缘不越 main 左缘
    const rectsIn = menuFullRects(d);
    assert.ok(rectsIn.menuRight <= rectsIn.mainLeft,
      `附款② 几何：分左右（menu.right=${String(rectsIn.menuRight)} <= main.left=${String(rectsIn.mainLeft)}）`);
    // 门判别力自证：nav 移出容器（回归事故形态注入）→模型判块流→门条件必不成立
    nav.remove();
    const rectsOut = menuFullRects(d);
    assert.ok(rectsOut.menuRight > rectsOut.mainLeft,
      `判别力自证：nav 出容器→块流形态（menu.right=${String(rectsOut.menuRight)} > main.left=${String(rectsOut.mainLeft)}）→门红`);
    retireUi(dom);
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
    const connText = (d.getElementById('panel-connect') as HTMLElement).textContent ?? '';
    assert.ok(connText.includes('M 面 · 服务域'), '连接配置页=四域签（N5 方案三：M 面 · 服务域三段式在位）');
    assert.ok(connText.includes('诚实三态'), '三态语义在页（已存未拉/已拉未落/已落生效）');
    retireUi(dom);
  });

  it('⑦ 模型策略页正名（批 A 改名+S2 砍后缀）+页副文待应用语义（S3 条 8 清洗）+面板隐藏不破策略页功能', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    await waitFor(() => (d.getElementById('panel-overview') as HTMLElement).hidden === false);
    const strategyH2 = (d.querySelector('#panel-strategy h2') as HTMLElement).textContent;
    // 批 A 19 处改名（策略卡→模型策略）+深测②合一 S2 条 2 页名砍后缀——
    // 测试锚随批跟改（原锚『TriModel 策略卡』『本机过渡位实例』双双退役，
    // 退役面反向锚定防回退）。
    assert.ok(strategyH2.includes('模型策略'), '模型策略页名（批 A 正名）');
    assert.equal(strategyH2.includes('本机过渡位实例'), false, '过渡位实例后缀已砍（S2 条 2）');
    assert.equal(strategyH2.includes('策略卡'), false, '旧名『策略卡』零残留（批 A 断言面）');
    assert.ok(((d.getElementById('panel-strategy') as HTMLElement).textContent ?? '').includes('保存后待应用'), '页副文（S3 条 8 清洗后：运维态词退役，仅存待应用语义）');
    // 面板隐藏（display:none!important）不改变元素本位显隐语义：三型字段锚仍可切换
    (Array.from(d.querySelectorAll('#page-menu .menu-btn')) as HTMLElement[]).find((b) => b.dataset.view === 'strategy').click();
    await waitFor(() => (d.getElementById('panel-strategy') as HTMLElement).hidden === false);
    assert.equal((d.getElementById('panel-strategy') as HTMLElement).hidden, false, '策略卡面板可达');
    retireUi(dom);
  });

  it('②f LG-058 N5 方案三四域直改面：四域签齐+诚实三态派生+保存载荷形（空条目搭载）', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const base = faceResponder({ mmc: { present: true }, rlc: { present: true }, rmc: { present: true } });
    const responder = (url: string): Resp => {
      // 深测②合一 S4：badge 驱动源=/v1/config/verify（判定树退役·服务端单点）——
      // 本 mock 与下方三域三态数据面对齐（mmc=已存未拉/rlc=已落生效/rmc=已拉未落）
      if (url === '/v1/config/verify') {
        const lbl = { 'not-configured': '未配置', 'stored-not-pulled': '已存未拉', 'pulled-not-applied': '已拉未落', 'applied': '已落生效' } as Record<string, string>;
        const mk = (face: string, state: string) => ({ face, state, state_label: lbl[state], pull_chain_degraded: false });
        return { status: 200, body: { object: 'config.verify', generated_at: 'x', faces: {
          mmc: mk('mmc', 'stored-not-pulled'), mlc: mk('mlc', 'not-configured'),
          rmc: mk('rmc', 'pulled-not-applied'), rlc: mk('rlc', 'applied'),
        } } };
      }
      const m = url.match(/\/v1\/config\/cards\/(mlc|rlc|mmc|rmc)/);
      if (m && !url.includes('view=pull')) {
        // 三域三态数据面：mmc=已存未拉（拉取时点早于存盘时点）/rlc=已落生效/rmc=已拉未落
        const lc = {
          mmc: { version: 2, updated_at: '2026-09-29T05:00:00Z', items: { local_port: '8710' } },
          rlc: { version: 1, updated_at: '2026-09-29T03:00:00Z', items: {} },
          rmc: { version: 3, updated_at: '2026-09-29T03:00:00Z', items: { cron_enabled: 'true' } },
        }[m[1] as 'mmc' | 'rlc' | 'rmc'];
        const ledgerLc = m[1] === 'rlc'
          ? { version_applied: 1, applied_at: '2026-09-29T04:00:00Z', write_result: 'ok', file: 'settings.json' }
          : undefined;
        const b = base(url).body as { card: Record<string, unknown>; ledger: { faces: Record<string, Record<string, unknown>> } };
        b.card = { ...b.card, local_config: lc };
        if (ledgerLc) b.ledger.faces[m[1]] = { ...b.ledger.faces[m[1]], local_config: ledgerLc };
        return { status: 200, body: b };
      }
      return base(url);
    };
    const dom = bootUi(log, responder);
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('[data-cd-tab]').length === 4, 4000);
    // 验收锚①：四域签齐（CPO §3.3 序，零缺席域）
    const tabLabels = Array.from(d.querySelectorAll('[data-cd-tab]')).map((b) => b.textContent ?? '').join('|');
    assert.ok(tabLabels.includes('M 面 · 服务域') && tabLabels.includes('M 面 · 本地域') && tabLabels.includes('R 面 · 服务域') && tabLabels.includes('R 面 · 本地域'), `四域签齐·三段式全格式（got=${tabLabels}）`);
    // 三行状态在位（配置版本/上次下发/落盘结果）
    for (const f of ['mmc', 'mlc', 'rmc', 'rlc']) {
      const stateKv = d.getElementById(`cd-${f}-state`)?.textContent ?? '';
      assert.ok(stateKv.includes('配置版本') && stateKv.includes('上次下发') && stateKv.includes('落盘结果'), `${f} 三行状态齐`);
    }
    // 诚实三态派生（3.6：最后一格不绿不算完）
    assert.equal(d.getElementById('cd-mmc-phase')?.textContent, '已存未拉', 'mmc：拉取时点早于存盘=已存未拉');
    assert.equal(d.getElementById('cd-rlc-phase')?.textContent, '已落 · 重启生效', 'rlc：applied 态+S4b B 注记（boot 型键「重启生效」语义锚）');
    assert.equal(d.getElementById('cd-rmc-phase')?.textContent, '已拉未落', 'rmc：拉取晚于存盘但零落地回写=已拉未落');
    // 切签：mlc 签显形、mmc 签让位
    (d.querySelector('[data-cd-tab="mlc"]') as HTMLElement).click();
    assert.equal(d.getElementById('cd-mlc')?.hidden, false, 'mlc 签显形');
    assert.equal(d.getElementById('cd-mmc')?.hidden, true, 'mmc 签让位（单签语义）');
    // 保存载荷形：UI connSaveDomain 发 {provider_entries:{}, local_config:{items}}（P1 候修①空搭载）
    (d.querySelector('[data-cd-tab="rmc"]') as HTMLElement).click();
    (d.querySelector('[data-cd-save="rmc"]') as HTMLElement).click();
    await waitFor(() => log.some((e) => e.url.includes('/v1/config/cards/rmc') && e.init?.method === 'PUT'), 4000);
    const saveEntry = log.find((e) => e.url.includes('/v1/config/cards/rmc') && e.init?.method === 'PUT');
    const saveBody = JSON.parse(String(saveEntry?.init?.body ?? '{}')) as { provider_entries: Record<string, unknown>; local_config?: { items: Record<string, string> } };
    assert.deepEqual(saveBody.provider_entries, {}, '空 provider_entries 搭载（守卫形，本次不改条目）');
    assert.deepEqual(saveBody.local_config?.items, { cron_enabled: 'true' }, '本域 items 全量提交（整表替换语义）');
    retireUi(dom);
  });

  it('②g 机器位三段式正名（CEO 2026-10-06 21:22 令）：压缩形四签/「河源」/裸 sg 渲染面清零+全格式在位', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, faceResponder({}));
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('[data-cd-tab]').length === 4, 4000);
    const pageText = d.body.textContent ?? '';
    for (const cmp of ['M 服务域', 'M 本地域', 'R 服务域', 'R 本地域']) {
      assert.equal(pageText.includes(cmp), false, `压缩形「${cmp}」渲染面零残留`);
    }
    assert.equal(pageText.includes('河源'), false, '机器位「河源」渲染面零残留（正名=R-HY）');
    assert.equal(/\bsg\b/.test(pageText), false, '裸 sg（词边界）渲染面零残留（正名=M-SG；代码标识符不进 textContent）');
    const tabLabels = Array.from(d.querySelectorAll('[data-cd-tab]')).map((b) => b.textContent ?? '').join('|');
    assert.ok(tabLabels.includes('M 面 · 服务域') && tabLabels.includes('M 面 · 本地域') && tabLabels.includes('R 面 · 服务域') && tabLabels.includes('R 面 · 本地域'), `三段式全格式四签在位（got=${tabLabels}）`);
    // 四签端口对等（BOD 复验 21:44 打回钉）：四卡头实例行各含自己端口值（8710/8713/8710/8711）逐一在场
    for (const [f, port] of [['mmc', 'M-SG 8710'], ['mlc', '本机 8713'], ['rmc', 'R-HY 8710'], ['rlc', '本机 8711']] as const) {
      const paneText = d.getElementById(`cd-${f}`)?.textContent ?? '';
      assert.ok(paneText.includes(port), `四签端口对等：${f} 卡头实例行含「${port}」`);
    }
    retireUi(dom);
  });

  it('②h 连接配置表单化组织（CEO 2026-10-06 22:36 形态+22:41 批·BOD r4 v2）：主平铺+高级选项折叠+16 键承接+存量分流+预览联动+密钥不放', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const base = faceResponder({});
    const responder = (url: string): Resp => {
      const m = url.match(/\/v1\/config\/cards\/(mlc|rlc|mmc|rmc)/);
      if (m && !url.includes('view=pull')) {
        // 存量分流 mock：清单内键 ANTHROPIC_MODEL（灌表单）+清单外 legacy_key（走自由行）
        const b = base(url).body as { card: Record<string, unknown>; ledger: { faces: Record<string, Record<string, unknown>> } };
        b.card = { ...b.card, local_config: { version: 1, updated_at: '2026-10-06T00:00:00Z', items: { ANTHROPIC_MODEL: 'glm-x', legacy_key: 'v1' } } };
        return { status: 200, body: b };
      }
      return base(url);
    };
    const dom = bootUi(log, responder);
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('[data-cd-tab]').length === 4, 4000);
    const expectKeys = [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
      'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
      'CLAUDE_CODE_USE_POWERSHELL_TOOL', 'crossSessionInbound',
    ];
    for (const f of ['mmc', 'mlc', 'rmc', 'rlc'] as const) {
      const pane = d.getElementById(`cd-${f}`);
      assert.ok(pane, `${f} pane 在场`);
      const formKeys = Array.from(pane.querySelectorAll('[data-cd-form-row] [data-cd-key]')).map((i) => i.value);
      assert.deepEqual([...formKeys].sort(), [...expectKeys].sort(), `${f} 表单承接 16 键（真源=settings.json，禁再扩）`);
      assert.equal(formKeys.some((k) => k.includes('AUTH_TOKEN') || k.includes('API_KEY')), false, `${f} 无固定键名承接密钥（r5 密钥行走认证字段动态键，②i 承接）`);
      const adv = pane.querySelector('[data-cd-advanced]') as HTMLDetailsElement;
      assert.ok(adv, `${f} 高级选项折叠容器`);
      assert.equal(adv.open, false, `${f} 高级选项默认收起`);
      assert.ok(pane.querySelector('[data-cd-custom]'), `${f} 自定义项兜底折叠位`);
      assert.ok(pane.querySelector('[data-cd-add-custom]'), `${f} 添加自定义项入口`);
      assert.ok(pane.querySelector('[data-cd-preview]'), `${f} 配置预览折叠位（所见即落盘）`);
      // 存量分流：清单内键值灌表单、清单外走自由行（键唯一零冲突）
      const modelVal = Array.from(pane.querySelectorAll('[data-cd-form-row]')).find((r) => r.querySelector('[data-cd-key]')?.value === 'ANTHROPIC_MODEL')?.querySelector('[data-cd-val]');
      assert.equal(modelVal?.value, 'glm-x', `${f} 清单内存量值灌入主模型表单`);
      const freeRows = Array.from(pane.querySelectorAll('[data-cd-row]:not([data-cd-form-row])'));
      assert.equal(freeRows.length, 1, `${f} 清单外存量恰一行自由行`);
      assert.equal(freeRows[0]?.querySelector('[data-cd-key]')?.value, 'legacy_key', `${f} 自由行承接清单外键`);
    }
    // 预览实时联动：mmc 主模型改值→input→预览 pre 即刷
    const pane = d.getElementById('cd-mmc');
    assert.ok(pane, 'mmc pane 在场');
    const modelRow = Array.from(pane.querySelectorAll('[data-cd-form-row]')).find((r) => r.querySelector('[data-cd-key]')?.value === 'ANTHROPIC_MODEL');
    assert.ok(modelRow, '主模型表单行在场');
    const modelVal = modelRow.querySelector('[data-cd-val]') as HTMLInputElement;
    modelVal.value = 'glm-5.3-flash';
    modelVal.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const pre = pane.querySelector('[data-cd-preview-pre]')?.textContent ?? '';
    assert.ok(pre.includes('ANTHROPIC_MODEL') && pre.includes('glm-5.3-flash'), '预览实时联动（键值在预）');
    assert.ok(pre.includes('legacy_key'), '清单外自由行照进预览');
    // 保存载荷：表单值+存量自由行合并整表提交；空值键不设（所见即落盘）
    (d.querySelector('[data-cd-save="mmc"]') as HTMLElement).click();
    await waitFor(() => log.some((e) => e.url.includes('/v1/config/cards/mmc') && e.init?.method === 'PUT'), 4000);
    const saveEntry = log.find((e) => e.url.includes('/v1/config/cards/mmc') && e.init?.method === 'PUT');
    const saveBody = JSON.parse(String(saveEntry?.init?.body ?? '{}')) as { provider_entries: Record<string, unknown>; local_config?: { items: Record<string, string> } };
    assert.deepEqual(saveBody.provider_entries, {}, '空 provider_entries 搭载（守卫形照旧）');
    assert.equal(saveBody.local_config?.items['ANTHROPIC_MODEL'], 'glm-5.3-flash', '保存载荷=表单值');
    assert.equal(saveBody.local_config?.items['legacy_key'], 'v1', '保存载荷=存量自由行合并（整表替换语义）');
    assert.equal('ANTHROPIC_BASE_URL' in (saveBody.local_config?.items ?? {}), false, '表单空值键不设（清空即删除，所见即落盘）');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in (saveBody.local_config?.items ?? {}), false, '密钥框空=键不设（r5 密钥行同表单行语义）');
    retireUi(dom);
  });

  it('②i 连接表单 r5 增补（CEO 23:31 打回三缺口+23:41 批·裁 A）：密钥行+认证字段+API 格式不落盘+1M 尾缀联动', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const base = faceResponder({});
    const responder = (url: string): Resp => {
      const m = url.match(/\/v1\/config\/cards\/(mlc|rlc|mmc|rmc)/);
      if (m && !url.includes('view=pull')) {
        // r5 存量 mock：AUTH_TOKEN 密钥存量（灌密钥框+select 跟随）+清单内/外键照 ②h
        const b = base(url).body as { card: Record<string, unknown>; ledger: { faces: Record<string, Record<string, unknown>> } };
        b.card = { ...b.card, local_config: { version: 1, updated_at: '2026-10-06T00:00:00Z', items: { ANTHROPIC_AUTH_TOKEN: 'sk-test-stock-fsd', ANTHROPIC_MODEL: 'glm-x', legacy_key: 'v1' } } };
        return { status: 200, body: b };
      }
      return base(url);
    };
    const dom = bootUi(log, responder);
    const d = dom.window.document;
    connect(dom);
    await waitFor(() => d.querySelectorAll('[data-cd-tab]').length === 4, 4000);
    // 五件渲染×4 卡（textContent 面防折叠假象——password/input 属性+select/checkbox 元素在场断言）
    for (const f of ['mmc', 'mlc', 'rmc', 'rlc'] as const) {
      const pane = d.getElementById(`cd-${f}`);
      assert.ok(pane, `${f} pane 在场`);
      const keyRow = pane.querySelector('[data-cd-keyref]');
      assert.ok(keyRow, `${f} 密钥行（keyref）在场`);
      const keyInput = keyRow?.querySelector('[data-cd-val]');
      assert.ok(keyInput instanceof dom.window.HTMLInputElement || (keyInput as HTMLInputElement | null)?.type !== undefined, `${f} 密钥框 input 在场`);
      assert.equal((keyInput as HTMLInputElement).type, 'password', `${f} 密钥框 password 态`);
      assert.ok(keyRow?.querySelector('[data-cd-eye]'), `${f} 显隐眼睛钮在场`);
      assert.ok(pane.querySelector('[data-cd-authfield]'), `${f} 认证字段下拉在场`);
      const fmtSel = pane.querySelector('[data-cd-apifmt]');
      assert.ok(fmtSel, `${f} API 格式下拉在场`);
      assert.equal((fmtSel as HTMLSelectElement).options.length, 4, `${f} API 格式四选项（cc-switch 手册照录）`);
      assert.equal(pane.querySelectorAll('[data-cd-1m]').length, 4, `${f} 1M 行级开关×4`);
      assert.ok(pane.querySelector('[data-cd-apifmt-warn]'), `${f} 非原生警示位在场`);
      // 密钥存量分流：AUTH_TOKEN 灌密钥框+select 跟随；两密钥键不再落自由行
      assert.equal((keyInput as HTMLInputElement).value, 'sk-test-stock-fsd', `${f} 密钥存量灌入密钥框`);
      assert.equal((pane.querySelector('[data-cd-authfield]') as HTMLSelectElement).value, 'ANTHROPIC_AUTH_TOKEN', `${f} 认证字段默认 AUTH_TOKEN`);
      const freeRows = Array.from(pane.querySelectorAll('[data-cd-row]:not([data-cd-form-row])'));
      assert.equal(freeRows.length, 1, `${f} 密钥键入表单后自由行仍恰 legacy_key 一行`);
      assert.equal(freeRows[0]?.querySelector('[data-cd-key]')?.value, 'legacy_key', `${f} 自由行承接清单外键`);
    }
    // 眼睛显隐切换（mmc）
    const pane = d.getElementById('cd-mmc');
    assert.ok(pane, 'mmc pane 在场');
    const keyRow = pane.querySelector('[data-cd-keyref]');
    assert.ok(keyRow, 'mmc 密钥行在场');
    const eye = keyRow.querySelector('[data-cd-eye]');
    assert.ok(eye, '眼睛钮在场');
    const keyInput = keyRow.querySelector('[data-cd-val]') as HTMLInputElement;
    (eye as HTMLElement).click();
    assert.equal(keyInput.type, 'text', '眼睛一次：显形');
    assert.equal((eye as HTMLElement).textContent, '隐藏', '钮文随态切换');
    (eye as HTMLElement).click();
    assert.equal(keyInput.type, 'password', '眼睛二次：复隐');
    // 认证字段切换→预览键名跟随（Key 值落所选键）
    const authSel = pane.querySelector('[data-cd-authfield]') as HTMLSelectElement;
    keyInput.value = 'sk-test-live-fsd';
    keyInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const pre1 = pane.querySelector('[data-cd-preview-pre]')?.textContent ?? '';
    assert.ok(pre1.includes('"ANTHROPIC_AUTH_TOKEN"') && pre1.includes('sk-test-live-fsd'), '预览 Key 落 AUTH_TOKEN 键（默认）');
    authSel.value = 'ANTHROPIC_API_KEY';
    authSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const pre2 = pane.querySelector('[data-cd-preview-pre]')?.textContent ?? '';
    assert.ok(pre2.includes('"ANTHROPIC_API_KEY"') && pre2.includes('sk-test-live-fsd'), '认证字段切换→预览键名跟随');
    assert.equal(pre2.includes('"ANTHROPIC_AUTH_TOKEN"'), false, '原键随落点语义从预览消失');
    // API 格式：非原生→警示现；预览零格式键（裁 A：格式不落盘不进预览）
    const warn = pane.querySelector('[data-cd-apifmt-warn]');
    assert.ok(warn, '警示位在场');
    assert.equal((warn as HTMLElement).hidden, true, '默认原生警示隐');
    const fmtSel = pane.querySelector('[data-cd-apifmt]') as HTMLSelectElement;
    fmtSel.value = 'openai-chat';
    fmtSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal((warn as HTMLElement).hidden, false, '非原生选值警示现');
    assert.equal((pane.querySelector('[data-cd-preview-pre]')?.textContent ?? '').includes('需本地路由'), false, '警示文案不进预览');
    // 1M 行级开关：开→尾缀 [1m] 实时联动；关→尾缀移除
    const sonnetRow = Array.from(pane.querySelectorAll('[data-cd-form-row]')).find((r) => r.querySelector('[data-cd-key]')?.value === 'ANTHROPIC_DEFAULT_SONNET_MODEL');
    assert.ok(sonnetRow, 'Sonnet 映射行在场');
    const sonnetVal = sonnetRow.querySelector('[data-cd-val]') as HTMLInputElement;
    sonnetVal.value = 'glm-5.3-flash';
    sonnetVal.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const chk1m = sonnetRow.querySelector('[data-cd-1m]') as HTMLInputElement;
    chk1m.checked = true;
    chk1m.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(sonnetVal.value, 'glm-5.3-flash[1m]', '1M 开→模型值尾缀 [1m]');
    assert.ok((pane.querySelector('[data-cd-preview-pre]')?.textContent ?? '').includes('glm-5.3-flash[1m]'), '预览实时联动尾缀');
    chk1m.checked = false;
    chk1m.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(sonnetVal.value, 'glm-5.3-flash', '1M 关→尾缀移除');
    // 保存载荷：密钥落所选键+1M 态入值+裁 A 格式键零出现
    (d.querySelector('[data-cd-save="mmc"]') as HTMLElement).click();
    await waitFor(() => log.some((e) => e.url.includes('/v1/config/cards/mmc') && e.init?.method === 'PUT'), 4000);
    const saveEntry = log.find((e) => e.url.includes('/v1/config/cards/mmc') && e.init?.method === 'PUT');
    const saveBody = JSON.parse(String(saveEntry?.init?.body ?? '{}')) as { local_config?: { items: Record<string, string> } };
    const items = saveBody.local_config?.items ?? {};
    assert.equal(items['ANTHROPIC_API_KEY'], 'sk-test-live-fsd', '密钥落所选认证字段键');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in items, false, '原键随落点语义替换（单活动 Key 形）');
    assert.equal(items['ANTHROPIC_DEFAULT_SONNET_MODEL'], 'glm-5.3-flash', '1M 关后模型值无尾缀');
    assert.equal(Object.keys(items).some((k) => k.toLowerCase().includes('apifmt') || k.includes('上游格式') || k.includes('格式')), false, '裁 A：API 格式键零落盘');
    assert.equal(Object.values(items).some((v) => v.includes('需开启路由') || v.includes('需本地路由')), false, '裁 A：格式文案值零出现');
    // 放弃清场：重建后 password 回归+存量回填+格式回默认
    (d.querySelector('[data-cd-reload="mmc"]') as HTMLElement).click();
    const pane2 = d.getElementById('cd-mmc');
    assert.ok(pane2, '放弃重建后 mmc pane 在场');
    const keyInput2 = pane2.querySelector('[data-cd-keyref] [data-cd-val]');
    assert.ok(keyInput2, '重建后密钥框在场');
    assert.equal((keyInput2 as HTMLInputElement).type, 'password', '放弃后密钥框复隐');
    assert.equal((keyInput2 as HTMLInputElement).value, 'sk-test-stock-fsd', '放弃后存量回填');
    assert.equal((pane2.querySelector('[data-cd-apifmt]') as HTMLSelectElement).value, 'anthropic', '放弃后格式回默认原生');
    assert.equal((pane2.querySelector('[data-cd-apifmt-warn]') as HTMLElement).hidden, true, '放弃后警示复位');
    retireUi(dom);
  });
});
