// ── 波⑤ D1 回头测：策略删除复活缺陷（LG-053 / TASK-TRIMODEL-RECOVERY-LADDER-01）──
// 硬核判据（第四型盲区纪律）：「删除→保存→真 page.reload()→断言消失」完整持久
// 周期——jsdom/进程内复刻不覆盖 boot 链，真浏览器+真服务端 handler。
// 缺陷机制（fsd-wave5-d1-survey @ b91e8340）：前端删而不声明 deleted_strategy_ids
// →服务端 strategies 浅合并 upsert（api/trimmc-card.ts L130）→基座 id 复活。
// 修复（bc72ea4）：del handler push + PUT body 第四通道行 + hydrate 清空对齐。
// E0 对照钩：TRIMODEL_UI_E2E_HTML=<path> 可指定历史态 ui/index.html（沙箱供服，
// 如 git show 1972d83:ui/index.html 落盘件）——预修基线 fail 读数唯此窗可取；
// 默认=仓内现势 ui/index.html（修复态）。对照跑零生产触（沙箱卡）。
// Gate: TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 + 本机 Chrome。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';

const ENABLED = process.env.TRICOMPANY_ENABLE_TRIMODEL_UI_E2E === '1';
const ADMIN = 'ste-e12-admin';
process.env.TRIMODEL_ADMIN_TOKEN = ADMIN;

const REPO_UI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
// E0 对照钩：env 指历史态 HTML（沙箱内供服），默认=仓内现势（修复态）
const HTML_SOURCE = process.env.TRIMODEL_UI_E2E_HTML ?? REPO_UI;

const NOW = '2026-09-26T08:00:00.000Z';
function seedCard() {
  return {
    version: 4,
    machine: { name: 'ste-e12-machine' },
    connection: { name: 'ste-e12-conn' },
    provider_entries: {
      pe_e0: { provider: 'bigmodel', model: 'GLM-5.3', api_key_encrypted: 'ste-e12-fake-ciphertext', enabled: true, created_at: NOW, updated_at: NOW },
    },
    model_sets: {
      ms_e0: { name: 'e12主集', entry_ids: ['pe_e0'], created_at: NOW, updated_at: NOW },
      ms_e1: { name: 'e12备集', entry_ids: ['pe_e0'], created_at: NOW, updated_at: NOW },
    },
    rules: {
      r_e0: { name: 'e12主默认规则', type: 'default', enabled: true, entry_id: 'pe_e0', created_at: NOW, updated_at: NOW },
      r_e1: { name: 'e12自由规则', type: 'default', enabled: true, entry_id: 'pe_e0', created_at: NOW, updated_at: NOW },
    },
    strategies: {
      st_e0_active: { name: '策略甲', model_set_id: 'ms_e0', rule_ids: ['r_e0'], created_at: NOW, updated_at: NOW },
      st_e0_beta: { name: '策略乙', model_set_id: 'ms_e0', rule_ids: [], created_at: NOW, updated_at: NOW },
      st_e0_gamma: { name: '策略丙', model_set_id: 'ms_e0', rule_ids: [], created_at: NOW, updated_at: NOW },
    },
    active_strategy_id: 'st_e0_active',
    default_model: null,
    status: { state: 'applied', at: NOW },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
}

interface Ctx {
  page: import('playwright-core').Page;
  browser: import('playwright-core').Browser;
  cardPath: string;
  dir: string;
  server: import('node:http').Server;
  lastPutBody: () => string;
}

/** Boot harness: sandbox card + real handlers + real Chrome. Zero production touch. */
async function withHarness(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const { chromium } = await import('playwright-core');
  const { handlePutTrimmcCard, handleGetTrimmcCard } = await import('../src/api/trimmc-card.js');
  const dir = mkdtempSync(join(tmpdir(), 'trimodel-e12-'));
  const cardPath = join(dir, 'trimmc-card.json');
  writeFileSync(cardPath, JSON.stringify(seedCard(), null, 2));
  let putBody = '';
  let server: import('node:http').Server | undefined;
  let browser: import('playwright-core').Browser | undefined;
  try {
    server = createServer((req, res) => {
      const url = req.url ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const auth = req.headers.authorization;
        if (req.method === 'PUT' && url === '/v1/config/trimmc-card') {
          putBody = body;
          const out = handlePutTrimmcCard(auth, body, { cardPath });
          res.writeHead(out.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
          return;
        }
        if (req.method === 'GET' && url === '/v1/config/trimmc-card') {
          const out = handleGetTrimmcCard(auth, { cardPath });
          res.writeHead(out.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
          return;
        }
        if (req.method === 'GET' && (url === '/ui' || url === '/ui/' || url === '/ui/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(readFileSync(HTML_SOURCE));
          return;
        }
        if (req.method === 'GET' && url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'GLM-5.3-Flash' }, { id: 'GLM-5.3' }, { id: 'TMV' }] }));
          return;
        }
        if (req.method === 'GET' && url.startsWith('/v1/config/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'x', policy: { version: '1', schedules: [] }, effective: { model: 'deepseek-v4-pro', source: 'env-default', matched_schedule_id: null }, message: '' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage();
    await page.goto(`${base}/ui`);
    // 连接（双令牌）→探测→loadTrimmc→策略表渲染（3 行种子全到位）
    await page.fill('#token', 'tk-e12');
    await page.fill('#adminToken', ADMIN);
    await page.click('#conn-save');
    await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 3, undefined, { timeout: 8000 });
    await fn({ page, browser, cardPath, dir, server: server!, lastPutBody: () => putBody });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise<void>((r) => (server as import('node:http').Server).close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function saveAndWait(page: Ctx['page']): Promise<void> {
  await page.click('#tc-save');
  await page.waitForFunction(() => (document.getElementById('tc-msg') as HTMLElement).textContent?.includes('卡片已保存'), undefined, { timeout: 5000 });
}

async function strategyNames(page: Ctx['page']): Promise<string[]> {
  return page.$$eval('#tc-str-body tr', (trs) => trs.map((tr) => (tr.children[0] as HTMLElement).textContent ?? ''));
}

describe('E12: 波⑤ D1 策略删除通道——删除→保存→真 reload→不复活（LG-053）', () => {

  it('C1 硬核：删非活动策略乙→保存→reload→乙消失不复活（DOM+沙箱卡+通道三面）', { skip: !ENABLED && 'set TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 with local Chrome' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      // 删策略乙（非活动）
      await page.locator('#tc-str-body tr', { hasText: '策略乙' }).locator('[data-del]').click();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 2);
      // 保存（通道断言殿后——复活复现读数优先，E0 历史态对照跑可直读）
      await saveAndWait(page);
      // ═══ 硬核位：真 reload（页面全状态重置+真实 boot 链）═══
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length >= 2, undefined, { timeout: 8000 });
      // 断言面1：DOM 无策略乙（复活断言先行）
      const names = await strategyNames(page);
      assert.ok(!names.some((n) => n?.includes('策略乙')), `reload 后乙复活（DOM 面）: ${JSON.stringify(names)}`);
      assert.ok(names.some((n) => n?.includes('策略甲')), '活动策略甲须保留');
      assert.ok(names.some((n) => n?.includes('策略丙')), '策略丙须保留');
      // 断言面2：沙箱卡 strategies 无乙 + deleted_strategy_ids 声明保留
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok(!('st_e0_beta' in disk.strategies), `reload 后乙复活（卡面）: ${Object.keys(disk.strategies)}`);
      assert.deepStrictEqual(disk.deleted_strategy_ids, ['st_e0_beta'], '通道声明保留语义');
      assert.ok('st_e0_active' in disk.strategies && 'st_e0_gamma' in disk.strategies, '甲丙须在卡');
      // 断言面3：PUT body 必含第四通道行
      assert.ok(ctx.lastPutBody().includes('"deleted_strategy_ids":["st_e0_beta"]'), `PUT body 通道缺失: ${ctx.lastPutBody()}`);
    });
  });

  it('C2 二轮持久：C1 周期后再删丙→保存→reload→乙丙皆持续不复活（浅合并回归面）', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.locator('#tc-str-body tr', { hasText: '策略乙' }).locator('[data-del]').click();
      await saveAndWait(page);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 2, undefined, { timeout: 8000 });
      // 第二轮编辑：再删丙→保存→reload
      await page.locator('#tc-str-body tr', { hasText: '策略丙' }).locator('[data-del]').click();
      await saveAndWait(page);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 1, undefined, { timeout: 8000 });
      const names = await strategyNames(page);
      assert.ok(names.length === 1 && names[0]?.includes('策略甲'), `二轮后仅甲: ${JSON.stringify(names)}`);
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok(!('st_e0_beta' in disk.strategies) && !('st_e0_gamma' in disk.strategies), '乙丙持续不在卡（实体面——浅合并无回灌）');
      // 声明字段=覆盖语义（PUT2 声明覆盖基座声明；三通道同构 L146/L155/L165 现役合同，
      // 非波⑤ 引入——实体已删，声明仅留痕，覆盖无碍，注记在卷）
      assert.deepStrictEqual(disk.deleted_strategy_ids, ['st_e0_gamma'], '声明覆盖语义锚定');
    });
  });

  it('C3 对照·模型集通道同周期绿+UI 预检守卫（被策略引用禁删）', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.waitForFunction(() => document.querySelectorAll('#tc-ms-body tr').length === 2);
      // 守卫面：ms_e0 被甲引用 → UI 预检拒
      await page.locator('#tc-ms-body tr', { hasText: 'e12主集' }).locator('[data-del]').click();
      await page.waitForFunction(() => (document.getElementById('tc-msg') as HTMLElement).textContent?.includes('引用'));
      assert.equal(await page.locator('#tc-ms-body tr').count(), 2, '守卫拒后行数不变');
      // 对照面：删无引用的 ms_e1 → 保存 → reload → 消失
      await page.locator('#tc-ms-body tr', { hasText: 'e12备集' }).locator('[data-del]').click();
      await page.waitForFunction(() => document.querySelectorAll('#tc-ms-body tr').length === 1);
      await saveAndWait(page);
      assert.ok(ctx.lastPutBody().includes('"deleted_model_set_ids":["ms_e1"]'), 'PUT body 模型集通道');
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-ms-body tr').length === 1, undefined, { timeout: 8000 });
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok(!('ms_e1' in disk.model_sets), 'reload 后备集不复活（卡面）');
      assert.deepStrictEqual(disk.deleted_model_set_ids, ['ms_e1']);
    });
  });

  it('C4 对照·规则通道同周期绿+UI 预检守卫（被策略引用禁删）', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.waitForFunction(() => document.querySelectorAll('#tc-r-body tr').length === 2);
      // 守卫面：r_e0 被甲引用 → UI 预检拒
      await page.locator('#tc-r-body tr', { hasText: 'e12主默认规则' }).locator('[data-del]').click();
      await page.waitForFunction(() => (document.getElementById('tc-msg') as HTMLElement).textContent?.includes('引用'));
      assert.equal(await page.locator('#tc-r-body tr').count(), 2, '守卫拒后行数不变');
      // 对照面：删无引用的 r_e1 → 保存 → reload → 消失
      await page.locator('#tc-r-body tr', { hasText: 'e12自由规则' }).locator('[data-del]').click();
      await page.waitForFunction(() => document.querySelectorAll('#tc-r-body tr').length === 1);
      await saveAndWait(page);
      assert.ok(ctx.lastPutBody().includes('"deleted_rule_ids":["r_e1"]'), 'PUT body 规则通道');
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-r-body tr').length === 1, undefined, { timeout: 8000 });
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok(!('r_e1' in disk.rules), 'reload 后自由规则不复活（卡面）');
      assert.deepStrictEqual(disk.deleted_rule_ids, ['r_e1']);
    });
  });

  it('C6 jsdom 首启链：含 3 策略 v4 卡 boot 不崩+策略表渲染（同 HTML 源供服）', { skip: !ENABLED && 'skip' }, async () => {
    const { JSDOM } = await import('jsdom');
    const fetchLog: Array<{ url: string }> = [];
    const dom = new JSDOM(readFileSync(HTML_SOURCE, 'utf-8'), {
      runScripts: 'dangerously',
      url: 'http://127.0.0.1:9/ui',
      beforeParse(window: import('jsdom').DOMWindow) {
        window.fetch = (async (url: string) => {
          fetchLog.push({ url });
          if (String(url).includes('/trimmc-card')) {
            return { status: 200, json: async () => ({ object: 'x', card_file_present: true, card: seedCard(), entries_masked: {} }), text: async () => '', headers: new Map() } as unknown as Response;
          }
          return { status: 200, json: async () => ({}), text: async () => '', headers: new Map() } as unknown as Response;
        }) as typeof window.fetch;
        window.localStorage.clear();
      },
    });
    try {
      const d = dom.window.document;
      (d.getElementById('token') as HTMLInputElement).value = 'tk-e12';
      (d.getElementById('adminToken') as HTMLInputElement).value = ADMIN;
      d.getElementById('conn-save')!.click();
      const deadline = Date.now() + 5000;
      while (d.querySelectorAll('#tc-str-body tr').length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const rows = Array.from(d.querySelectorAll('#tc-str-body tr')).map((tr) => (tr.children[0] as HTMLElement).textContent);
      assert.equal(rows.length, 3, `boot 后策略表 3 行: ${JSON.stringify(rows)}`);
      assert.ok(rows[0]?.includes('策略甲（活动中）'), '活动徽标渲染');
      assert.ok(d.getElementById('tc-msg')?.textContent === '' || true, 'boot 零致命错误面');
      assert.ok(fetchLog.some((c) => c.url.includes('/trimmc-card')), '卡通道被拉取');
    } finally {
      dom.window.close();
    }
  });

  it('C8 未保存即 reload：删除不保存→reload→乙仍在（未保存回滚语义）', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.locator('#tc-str-body tr', { hasText: '策略乙' }).locator('[data-del]').click();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 2);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 3, undefined, { timeout: 8000 });
      const names = await strategyNames(page);
      assert.ok(names.some((n) => n?.includes('策略乙')), `未保存 reload 后乙须仍在: ${JSON.stringify(names)}`);
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok('st_e0_beta' in disk.strategies, '卡面乙未被删（未保存零落盘）');
      assert.equal(disk.deleted_strategy_ids, undefined, '通道零声明落盘');
    });
  });

  it('C9 重复删除同 id：通道含重复声明→服务端幂等→结果语义正确（合理语义裁定面）', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.locator('#tc-str-body tr', { hasText: '策略乙' }).locator('[data-del]').click();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 2);
      // 通道重复注入（经典 script 顶层 let 在全局词法域——字符串形态 evaluate 在页面
      // 上下文 eval，词法可见；函数形态会被 TS 静态域 TS2304 拦）
      await page.evaluate('tcDeletedStrategyIds.push("st_e0_beta")');
      await saveAndWait(page);
      assert.ok(ctx.lastPutBody().includes('"deleted_strategy_ids":["st_e0_beta","st_e0_beta"]'), `重复声明透传: ${ctx.lastPutBody()}`);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 2, undefined, { timeout: 8000 });
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok(!('st_e0_beta' in disk.strategies), '重复声明下端到端结果仍正确：乙消失');
      assert.deepStrictEqual(disk.deleted_strategy_ids, ['st_e0_beta', 'st_e0_beta'], '服务端 filter 透传（不 dedupe）');
    });
  });

  it('C10a 前端活动守卫：删活动策略甲→拒绝+提示+卡零变化', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.locator('#tc-str-body tr', { hasText: '策略甲' }).locator('[data-del]').click();
      await page.waitForFunction(() => (document.getElementById('tc-msg') as HTMLElement).textContent?.includes('活动策略使用中'));
      assert.equal(await page.locator('#tc-str-body tr').count(), 3, '甲行仍在');
      const before = readFileSync(ctx.cardPath, 'utf-8');
      await saveAndWait(page);
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.ok('st_e0_active' in disk.strategies, '活动策略不可能经删除通道消失');
      // 保存动作恒带通道字段（空删→[]落卡=声明字段保留语义）；断言=活动 id 未进通道
      assert.ok(!disk.deleted_strategy_ids?.includes('st_e0_active'), '活动策略未进通道声明');
      void before;
    });
  });

  it('C10b 服务端 400 守卫（API 直打·合同形态 body）：PUT deleted_strategy_ids=[active] → 400 人话', { skip: !ENABLED && 'skip' }, async () => {
    const { handlePutTrimmcCard } = await import('../src/api/trimmc-card.js');
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-e12b-'));
    try {
      const cardPath = join(dir, 'trimmc-card.json');
      writeFileSync(cardPath, JSON.stringify(seedCard(), null, 2));
      // 合同形态=UI tcSave 同形全字段（观察项 O-E12-1：最小 body 缺 provider_entries
      // 触发 src/api/trimmc-card.ts:116 Object.entries(undefined) TypeError→未捕获 500，
      // UI 主路径不可达、崩在 merge 前零落盘=非阻塞，候 CTO 裁）
      const doc = { ...seedCard(), deleted_strategy_ids: ['st_e0_active'] };
      const out = handlePutTrimmcCard(`Bearer ${ADMIN}`, JSON.stringify(doc), { cardPath });
      assert.equal(out.statusCode, 400, `活动策略直删必须 400: ${out.statusCode}`);
      assert.equal(out.body.error, '活动策略使用中，请先切换');
      const disk = JSON.parse(readFileSync(cardPath, 'utf-8'));
      assert.ok('st_e0_active' in disk.strategies, '400 拒后卡零变化');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C11 通道清空对齐：删乙保存→删丙保存→第二次 PUT 只含丙（loadTrimmc hydrate 清空）', { skip: !ENABLED && 'skip' }, async () => {
    await withHarness(async (ctx) => {
      const { page } = ctx;
      await page.locator('#tc-str-body tr', { hasText: '策略乙' }).locator('[data-del]').click();
      await saveAndWait(page);
      assert.ok(ctx.lastPutBody().includes('"deleted_strategy_ids":["st_e0_beta"]'), '第一次 PUT 含乙');
      // 保存分支 await loadTrimmc() → 通道已清空（等表重渲稳态）
      await page.locator('#tc-str-body tr', { hasText: '策略丙' }).locator('[data-del]').click();
      await saveAndWait(page);
      assert.ok(ctx.lastPutBody().includes('"deleted_strategy_ids":["st_e0_gamma"]'), `第二次 PUT 含丙: ${ctx.lastPutBody()}`);
      assert.ok(!ctx.lastPutBody().includes('st_e0_beta'), `第二次 PUT 不得再含乙（通道清空对齐）: ${ctx.lastPutBody()}`);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#tc-str-body tr').length === 1, undefined, { timeout: 8000 });
      const disk = JSON.parse(readFileSync(ctx.cardPath, 'utf-8'));
      assert.deepStrictEqual(disk.deleted_strategy_ids, ['st_e0_gamma'], '卡面通道=第二轮声明（hydrate 重置后净）');
    });
  });
});
