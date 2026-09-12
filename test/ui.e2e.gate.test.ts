// ── LG-035 STE gate: TriModel UI E2E (E1-E8, real browser via playwright-core) ──
// CTO 裁定（2026-09-11 21:20）：playwright-core 装包采纳（devDep-only）；护栏=
// ①env-gate 族：chromium 缺席机器显式 SKIP 禁静默绿 ②devDep-only ③executablePath
// 钉死+TRIMODEL_E2E_CHROMIUM 覆写+回退发现路径文档化 ④串行进门（npm test glob 继承）。
// 目标 UI=88ecedd2 重设计实现（FSD 工作树在飞版，选择器随落库对表）。
// 相位：E1=空令牌首启（boot() 源码语义：conn-settings open+guide 显+面板禁用）；
// E2-E8=连接相位（conn-save 后 dot ok+数据拉取）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Browser, Page } from 'playwright-core';

// ①env-gate 延伸：驱动包本身缺失（如干净 npm ci 后）也显式 SKIP，禁静默红
const pw = await import('playwright-core').then((m) => m).catch(() => null);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = join(REPO_ROOT, 'policy.json');
const POLICY_LOCAL = join(REPO_ROOT, 'policies', 'local.json'); // S11 runtime file
const CARD_FILE = join(REPO_ROOT, 'trimmc-card.json'); // E4 writes it via 保存卡片
const API_TOKEN = 'ste-gate-token';
const ADMIN_TOKEN = 'ste-admin-token';
const CATALOG_SUBSETS: Record<string, string[]> = {
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  glm: ['GLM-5.3-Flash', 'GLM-5.3'],
  trimetaverse: ['TMV'],
};
// E5 denylist：与 FSD trimmc-card.test.ts T3 源级清单同源（浏览器渲染面超集扫描）
const BANNED_VOCABULARY = ['SSH', 'ssh', '隧道', 'tunnel', '推送卡', 'apply-to-machine'];

/** ③ executablePath：TRIMODEL_E2E_CHROMIUM 覆写 → 缓存回退发现（文档化路径）。 */
function discoverChromium(): string | null {
  const override = process.env.TRIMODEL_E2E_CHROMIUM;
  if (override) return existsSync(override) ? override : null;
  const root = process.env.LOCALAPPDATA;
  if (!root) return null;
  const cache = join(root, 'ms-playwright');
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = join(cache, d, sub, 'chrome.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const CHROMIUM = discoverChromium();
const SKIP_REASON = !pw
  ? 'SKIP (env-gate): playwright-core not installed (devDep) — npm i -D playwright-core'
  : CHROMIUM
    ? false
    : `SKIP (env-gate): chromium unavailable — tried TRIMODEL_E2E_CHROMIUM override then ${join(process.env.LOCALAPPDATA ?? '<LOCALAPPDATA unset>', 'ms-playwright')}/chromium-*/chrome-win(64)/chrome.exe; install via npx playwright install chromium`;

let server: ChildProcess | null = null;
let snapLocal: string | null = null; // S11 policies/local.json
let browser: Browser | null = null;
let port = 0;
let workDir = '';
const snap = { policy: null as string | null, card: null as string | null, local: null as string | null };

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

function bootServer(withAdmin: boolean): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIMODEL_PORT: String(port),
    TRIMODEL_API_TOKEN: API_TOKEN,
    TRIMODEL_DEFAULT_MODEL: 'deepseek-v4-pro',
  };
  delete env.TRIMODEL_HOST;
  if (withAdmin) env.TRIMODEL_ADMIN_TOKEN = ADMIN_TOKEN;
  else delete env.TRIMODEL_ADMIN_TOKEN;
  return spawn(process.execPath, ['--import', 'tsx', join('src', 'server.ts')], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
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

describe('GATE UI E2E (E1-E8): real browser, env-gated, two-phase', { skip: SKIP_REASON }, () => {
  before(async () => {
    snap.policy = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf-8') : null;
    snapLocal = existsSync(POLICY_LOCAL) ? readFileSync(POLICY_LOCAL, 'utf-8') : null;
    snap.card = existsSync(CARD_FILE) ? readFileSync(CARD_FILE, 'utf-8') : null;
    rmSync(POLICY_FILE, { force: true });
    rmSync(POLICY_LOCAL, { force: true });
    rmSync(CARD_FILE, { force: true });
    workDir = mkdtempSync(join(tmpdir(), 'ste-ui-e2e-'));
    port = await freePort();
    server = bootServer(false); // phase 1: E1 first-launch (empty-token) surface
    await waitHealth();
    if (!pw || !CHROMIUM) throw new Error('precondition skipped — describe guard should have skipped this suite');
    browser = await pw.chromium.launch({ executablePath: CHROMIUM, headless: true });
  });

  after(async () => {
    await browser?.close();
    await killAndWait(server);
    rmSync(workDir, { recursive: true, force: true });
    if (snap.policy === null) rmSync(POLICY_FILE, { force: true });
    else writeFileSync(POLICY_FILE, snap.policy, 'utf-8');
    if (snapLocal === null) rmSync(POLICY_LOCAL, { force: true });
    else writeFileSync(POLICY_LOCAL, snapLocal, 'utf-8');
    if (snap.card === null) rmSync(CARD_FILE, { force: true });
    else writeFileSync(CARD_FILE, snap.card, 'utf-8');
  });

  async function freshPage(waitMs = 600): Promise<Page> {
    if (!browser) throw new Error('browser not initialised');
    const ctx = await browser.newContext(); // fresh localStorage per scenario
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
    return page;
  }

  it('E1 (empty-token first launch): settings auto-expanded + guide visible + data panels disabled + idle dot', async () => {
    const page = await freshPage(800);
    assert.equal(await page.$eval('#conn-settings', (el) => (el as HTMLDetailsElement).open), true, '连接设置自动展开（boot 源码语义①）');
    assert.equal(await page.$eval('#conn-guide', (el) => (el as HTMLElement).hidden), false, '引导可见');
    const guide = await page.locator('#conn-guide').textContent();
    assert.ok(/首次使用/.test(guide ?? ''), '引导文案内容在位');
    assert.ok(((await page.locator('#conn-dot').getAttribute('class')) ?? '').includes('idle'), '连接点=idle');
    const label = await page.locator('#conn-label').textContent();
    assert.equal(label, '未连接');
    assert.ok(await page.locator('#tc-empty-entries').isVisible(), '卡片空态指引可见=数据面板禁用态');
    await page.context().close();
  });

  it('E2 (phase-2): 连接 → dot flips ok/已连接 + data re-pull lands', async () => {
    await killAndWait(server);
    server = bootServer(true); // phase 2: admin surface live
    await waitHealth();
    const page = await freshPage();
    await page.fill('#token', API_TOKEN);
    await page.fill('#adminToken', ADMIN_TOKEN);
    await page.click('#conn-save');
    await page.waitForFunction(() => document.querySelector('#conn-dot')?.className.includes('ok'), { timeout: 6000 });
    assert.equal(await page.locator('#conn-label').textContent(), '已连接');
    await page.waitForFunction(() => (document.querySelector('#effective')?.textContent ?? '').length > 0, { timeout: 6000 });
    const stored = await page.evaluate(() => ({
      t: localStorage.getItem('trimodel_ui_token'),
      a: localStorage.getItem('trimodel_ui_admin_token'),
    }));
    assert.equal(stored.t, API_TOKEN);
    assert.equal(stored.a, ADMIN_TOKEN);
    await page.context().close();
  });

  it('E3: cascade subset byte-for-byte per provider (CEO 裁定行为——全五名平铺断言退役)', async () => {
    const page = await freshPage();
    await page.fill('#token', API_TOKEN);
    await page.fill('#adminToken', ADMIN_TOKEN);
    await page.click('#conn-save');
    await page.waitForFunction(() => document.querySelector('#conn-dot')?.className.includes('ok'), { timeout: 6000 });
    await page.click('#tc-open-add');
    const subsets: Record<string, string[]> = CATALOG_SUBSETS;
    for (const [provider, expected] of Object.entries(subsets)) {
      await page.selectOption('#tc-e-provider', provider);
      await page.waitForFunction(
        (v) => { const el = document.querySelector('#tc-e-model'); return el && JSON.stringify(Array.from((el as HTMLSelectElement).options).map((o) => o.value)) === JSON.stringify(v); },
        expected,
        { timeout: 6000 },
      );
      const opts = await page.$eval('#tc-e-model', (el) => Array.from((el as HTMLSelectElement).options).map((o) => o.value));
      assert.deepEqual(opts, expected, `provider=${provider} 级联子集须逐字节一致`);
    }
    await page.context().close();
  });

  it('E4: card entry submit reachable — 保存卡片 PUT lands server-side', async () => {
    const page = await freshPage();
    await page.fill('#token', API_TOKEN);
    await page.fill('#adminToken', ADMIN_TOKEN);
    await page.click('#conn-save');
    await page.waitForFunction(() => document.querySelector('#conn-dot')?.className.includes('ok'), { timeout: 6000 });
    await page.fill('#tc-conn', 'ste-gate-machine'); // 机器名称必填（保存前置校验，探针实证）
    await page.click('#tc-open-add');
    await page.fill('#tc-e-id', 'gate-ui-e2e');
    await page.selectOption('#tc-e-provider', 'glm'); // cascade: provider first, then model options rebuild
    await page.waitForFunction(
      () => { const el = document.querySelector('#tc-e-model'); return el && Array.from((el as HTMLSelectElement).options).some((o) => o.value === 'GLM-5.3'); },
      { timeout: 6000 },
    );
    await page.selectOption('#tc-e-model', 'GLM-5.3');
    await page.fill('#tc-e-baseurl', 'https://open.bigmodel.cn/api/anthropic'); // S10: 服务地址必填前置（①⑤生效证据）
    await page.fill('#tc-e-key', 'sk-gate-ui-e2e-key');
    await page.click('#tc-e-save'); // entry into local table
    await page.click('#tc-save'); // 保存卡片 → PUT /v1/config/trimmc-card
    await page.waitForTimeout(600);
    const res = await fetch(`http://127.0.0.1:${port}/v1/config/trimmc-card`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { card?: { provider_entries?: Record<string, { model?: string; base_url?: string }> } };
    const entries = body.card?.provider_entries ?? {};
    assert.ok(entries['gate-ui-e2e'], 'UI submit must persist the card entry server-side');
    assert.equal(entries['gate-ui-e2e']?.model, 'GLM-5.3');
    assert.ok(entries['gate-ui-e2e']?.base_url, '服务地址随条目落库');
    await page.context().close();
  });

  it('E5: rendered DOM carries zero channel vocabulary (superset of source-level scan)', async () => {
    const page = await freshPage();
    const content = await page.content();
    for (const banned of BANNED_VOCABULARY) {
      assert.equal(content.includes(banned), false, `channel vocabulary '${banned}' must not appear in rendered DOM`);
    }
    assert.equal(await page.locator('#tc-push').count(), 0, 'no push/apply button');
    await page.context().close();
  });

  it('E6: eye toggle real click — password↔text + icon swap (P2 manual residual closed)', async () => {
    const page = await freshPage();
    await page.fill('#token', 'abc-test-value');
    const before = await page.$eval('#token', (el) => (el as HTMLInputElement).type);
    const iconBefore = await page.locator('#token-eye').textContent();
    await page.click('#token-eye');
    const mid = await page.$eval('#token', (el) => (el as HTMLInputElement).type);
    const iconMid = await page.locator('#token-eye').textContent();
    await page.click('#token-eye');
    const after = await page.$eval('#token', (el) => (el as HTMLInputElement).type);
    assert.equal(before, 'password');
    assert.equal(mid, 'text');
    assert.equal(iconMid, '🚫');
    assert.equal(after, 'password');
    assert.notEqual(iconBefore, iconMid);
    await page.context().close();
  });

  it('E7: wrong tokens → S10 real-validation state 已填入未验证 (never falsely 已连接 — anti-D2)', async () => {
    const page = await freshPage();
    await page.fill('#token', 'wrong-api');
    await page.fill('#adminToken', 'wrong-admin');
    await page.click('#conn-save');
    await page.waitForFunction(
      () => (document.querySelector('#conn-label')?.textContent || '').includes('未验证'),
      undefined,
      { timeout: 10000 },
    );
    const label = await page.locator('#conn-label').textContent();
    const dot = await page.locator('#conn-dot').getAttribute('class');
    assert.ok(/未验证/.test(label ?? ''), `wrong tokens must not read 已连接，实际: ${label}`);
    assert.ok((dot ?? '').includes('warn'), `dot=warn，实际: ${dot}`);
    await page.context().close();
  });

  it('E8: full-page screenshot evidence lands non-trivially', async () => {
    const page = await freshPage();
    const shot = join(workDir, 'e8-fullpage.png');
    await page.screenshot({ path: shot, fullPage: true });
    const size = statSync(shot).size;
    assert.ok(size > 10_000, `screenshot should be substantive, got ${size} bytes`);
    await page.context().close();
  });

  // ── 走查增补 W1-W5（D10 时段规则 UI，CEO 复走查八条返工增补件；CPO 正身辖域）──
  // 节奏纪律：选择器选项随卡片加载异步填充——每次 reload/保存后必须 waitForSelect，
  // 断言持久性一律走 reload 后读值。

  async function connectPage(page: Page, tag = 'w'): Promise<void> {
    await page.fill('#token', API_TOKEN);
    await page.fill('#adminToken', ADMIN_TOKEN);
    await page.click('#conn-save');
    await page.waitForFunction(() => document.querySelector('#conn-dot')?.className.includes('ok'), { timeout: 8000 });
    await page.fill('#tc-conn', 'ste-machine-' + tag); // S10 必填：连接解禁后填（面板先禁用）
    await page.waitForTimeout(500); // settle initial card fetches (async re-render guard)
  }

  async function waitSelectOptions(page: Page, sel: string, min: number): Promise<void> {
    await page.waitForFunction(
      ([s, m]) => { const el = document.querySelector(s); return el instanceof HTMLSelectElement && el.options.length >= m; },
      [sel, min] as const,
      { timeout: 8000 },
    );
  }

  async function addEntryViaUi(page: Page, id: string, provider: string, model: string, key: string): Promise<void> {
    await page.click('#tc-open-add');
    await page.selectOption('#tc-e-provider', provider);
    await waitModelOption(page, '#tc-e-model', model);
    await page.fill('#tc-e-id', id);
    await page.fill('#tc-e-baseurl', 'https://f2.example.com/v1');
    await page.fill('#tc-e-key', key);
    await page.click('#tc-e-save');
    await page.waitForTimeout(250);
  }

  const waitModelOption = async (page: Page, sel: string, val: string): Promise<void> => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await page.$eval(sel, (el, v) => Array.from((el as HTMLSelectElement).options).some((o) => o.value === v), val).catch(() => false);
      if (found) return;
      await page.waitForTimeout(200);
    }
    throw new Error('model option "' + val + '" not found within 8s');
  };

  it('W1 (①): fixed-use selector interaction — save entry pair, reload, select rule, persist across reload', async () => {
    const page = await freshPage();
    await connectPage(page);
    await addEntryViaUi(page, 'gate-ui-w2', 'glm', 'GLM-5.3', 'sk-gate-ui-w2-key');
    await page.click('#tc-save'); // card now carries both entries
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'domcontentloaded' }); // reload → selector rebuilds from saved card
    await page.waitForTimeout(900);
    await waitSelectOptions(page, '#tc-r-entry', 2);
    const opts = await page.$eval('#tc-r-entry', (el) => Array.from((el as HTMLSelectElement).options).map((o) => o.value));
    const glmVal = opts.find((v) => v.includes('gate-ui-w2')) ?? '';
    await page.selectOption('#tc-r-entry', glmVal);
    await page.click('#tc-save'); // fixed-rule intent rides the card
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await waitSelectOptions(page, '#tc-r-entry', 2);
    const afterReload = await page.$eval('#tc-r-entry', (el) => (el as HTMLSelectElement).value);
    assert.equal(afterReload, glmVal, '固定使用选择须随卡持久（reload 后保持）');
    await page.context().close();
  });

  it('W2 (②): time-window rules zone — five columns + add form with field defaults', async () => {
    const page = await freshPage();
    await connectPage(page);
    await waitSelectOptions(page, '#tc-w-entry', 1); // 目标条目下拉自卡片条目填充
    const heads = await page.$eval('#tc-wrules thead', (el) => Array.from(el.querySelectorAll('th')).map((th) => (th.textContent ?? '').trim()));
    assert.deepEqual(heads, ['时段', '目标条目', '优先级', '启用', '操作'], '五列正身');
    assert.equal(await page.locator('#tc-wr-empty').isVisible(), true, '空态指引在位');
    await page.click('#tc-wr-open-add');
    assert.equal(await page.$eval('#tc-wr-form', (el) => (el as HTMLFormElement).hidden), false, '添加表单展开');
    assert.equal(await page.$eval('#tc-w-start', (el) => (el as HTMLInputElement).value), '09:00', '开始默认 09:00');
    assert.equal(await page.$eval('#tc-w-end', (el) => (el as HTMLInputElement).value), '18:00', '结束默认 18:00');
    await page.click('#tc-w-cancel');
    await page.context().close();
  });

  it('W3 (③): conflict persistent hint — visible while fixed non-empty, hidden when cleared', async () => {
    const page = await freshPage();
    await connectPage(page);
    await page.waitForFunction(
      () => { const el = document.querySelector('#tc-fixed-active'); return Boolean(el) && !(el as HTMLElement).hidden; },
      undefined,
      { timeout: 8000 },
    );
    const hint = await page.locator('#tc-fixed-active').textContent();
    assert.ok(/固定使用生效中/.test(hint ?? ''), '冲突常驻提示人话文案在位');
    const opts = await page.$eval('#tc-r-entry', (el) => Array.from((el as HTMLSelectElement).options).map((o) => o.value));
    const noneVal = opts.find((v) => v === '' || v === 'none') ?? '';
    await page.selectOption('#tc-r-entry', noneVal);
    await page.click('#tc-save');
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const hidden = await page.$eval('#tc-fixed-active', (el) => el.hidden);
    assert.equal(hidden, true, '清除固定规则后提示应隐藏');
    await page.context().close();
  });

  it('W4 (④): start >= end rejected with 人话 copy, rule not added (跨午夜不暴露)', async () => {
    const page = await freshPage();
    await connectPage(page);
    await waitSelectOptions(page, '#tc-w-entry', 1);
    const rowsBefore = await page.locator('#tc-wr-body tr').count();
    await page.click('#tc-wr-open-add');
    await page.fill('#tc-w-start', '22:00');
    await page.fill('#tc-w-end', '06:00');
    await page.click('#tc-w-save');
    await page.waitForTimeout(300);
    const err = await page.locator('#tc-w-time-err').textContent();
    assert.ok(/结束时间需晚于开始时间/.test(err ?? ''), `人话拒收文案，实际: ${err}`);
    assert.equal(await page.$eval('#tc-wr-form', (el) => (el as HTMLFormElement).hidden), false, '拒收后表单保持（不静默吞）');
    const rowsAfter = await page.locator('#tc-wr-body tr').count();
    assert.equal(rowsAfter, rowsBefore, '拒收规则不得入表');
    await page.click('#tc-w-cancel');
    await page.context().close();
  });

  it('W5 (⑤): scope small-print in place — 以下策略应用于 TriMMC（sg）', async () => {
    const page = await freshPage();
    const body = await page.evaluate(() => document.body.innerText);
    assert.ok(body.includes('以下策略应用于 TriMMC（sg）'), '作用域小字在位');
    assert.ok(body.includes('时区：Asia/Shanghai'), '时区副注显式（D10 正身）');
    await page.context().close();
  });
});
