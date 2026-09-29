// ── LG-058 P2 件C：四 face managed 真链 E2E（CTO R3 6bf7a596）──
// 案1 真链：UI 注入 admin 同值 → boot → loadFaceCards 四 face（mlc/rlc/mmc/rmc）
// 并发 GET /v1/config/cards/<face>?view=managed（真 handleGetConfigCard：requireAdmin
// +faceCardPath 沙箱钉位+200 body 扩 {face, ledger}）→ 三态徽标渲染断言。
// 案2 错 token：UI 填错值 → 探针/managed 双面 401 → UI 诚实态（不静默装成功）。
// 判据=LG-035 R3 原文；自足 createServer 零重启；TRIMODEL_CARDS_DIR/DATA_DIR 钉
// 沙箱（STE seam①/卡目录 seam：T7 活体生产面零接触）。
// Gate: TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 + 本机 Chrome。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

const ENABLED = process.env.TRICOMPANY_ENABLE_TRIMODEL_UI_E2E === '1';
const ADMIN = 'ste-e13-admin';

const REPO_UI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

// v4 精简卡（mlc face 用；status=applied → 徽标「已生效」态）
function seedCard() {
  const NOW = '2026-09-29T16:00:00.000Z';
  return {
    version: 4,
    machine: { name: 'ste-e13-machine' },
    connection: { name: 'ste-e13-conn' },
    provider_entries: {
      pe_0: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'ste-e13-fake-ciphertext', enabled: true, created_at: NOW, updated_at: NOW },
    },
    model_sets: {},
    rules: {},
    strategies: { st_0: { name: 'e13策略', model_set_id: '', rule_ids: [], created_at: NOW, updated_at: NOW } },
    active_strategy_id: 'st_0',
    default_model: null,
    status: { state: 'applied', at: NOW },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
}

interface Ctx {
  page: import('playwright-core').Page;
  browser: import('playwright-core').Browser;
  dir: string;
  server: import('node:http').Server;
  faceSeen: () => Record<string, string | undefined>; // face → Bearer 值（managed 请求观察面）
  probeStatuses: () => number[]; // conn-save 探针状态码序列
}

/** Boot harness：沙箱卡目录+真 managed handler+真 Chrome。Zero production touch. */
async function withHarness(adminInput: string, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const { chromium } = await import('playwright-core');
  const { handleGetConfigCard } = await import('../src/api/config-cards.js');
  const { handleGetTrimmcCard } = await import('../src/api/trimmc-card.js');
  const dir = mkdtempSync(join(tmpdir(), 'trimodel-e13-'));
  // 沙箱钉位（STE seam）：faceCardPath/dataDir 双 env → 活体生产面零接触
  process.env.TRIMODEL_ADMIN_TOKEN = ADMIN;
  process.env.TRIMODEL_CARDS_DIR = dir;
  process.env.TRIMODEL_DATA_DIR = dir;
  writeFileSync(join(dir, 'trimlc-card.json'), JSON.stringify(seedCard(), null, 2)); // mlc=已配置+applied；余三 face=未配置诚实态
  const seen: Record<string, string | undefined> = {};
  const probeStatuses: number[] = [];
  let browser: import('playwright-core').Browser | undefined;
  let server: import('node:http').Server | undefined;
  try {
    server = createServer((req, res) => {
      const url = req.url ?? '';
      const search = url.slice(url.indexOf('?'));
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const auth = req.headers.authorization;
        const m = url.match(/^\/v1\/config\/cards\/([a-z]+)(?:\?.*)?$/);
        if (req.method === 'GET' && m) {
          seen[m[1]] = auth;
          const out = handleGetConfigCard(auth, m[1], search);
          res.writeHead(out.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
          return;
        }
        if (req.method === 'GET' && url === '/v1/config/trimmc-card') {
          const out = handleGetTrimmcCard(auth, { cardPath: join(dir, 'trimmc-card.json') }); // conn-save 探针（mmc face 同名文件，未写=未配置 200 诚实态）
          probeStatuses.push(out.statusCode);
          res.writeHead(out.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
          return;
        }
        if (req.method === 'GET' && (url === '/ui' || url === '/ui/' || url === '/ui/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(readFileSync(REPO_UI));
          return;
        }
        if (req.method === 'GET' && url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'GLM-5.3' }, { id: 'deepseek-v4-pro' }] }));
          return;
        }
        if (req.method === 'GET' && url.startsWith('/v1/config/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'x', policy: { version: '1', schedules: [] }, effective: { model: 'GLM-5.3', source: 'env-default', matched_schedule_id: null }, message: '' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as { port: number }).port;

    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/ui`);
    await page.fill('#token', 'tk-e13');
    await page.fill('#adminToken', adminInput);
    await page.click('#conn-save');
    await fn({ page, browser, dir, server: server!, faceSeen: () => seen, probeStatuses: () => probeStatuses });
  } finally {
    // teardown 三件套（CTO 21fe08d6 §六.4 同套）
    if (browser) {
      let timedOut = false;
      const pid = (browser as unknown as { process?: () => { pid?: number } | null }).process?.()?.pid;
      try {
        await Promise.race([
          browser.close().catch(() => {}),
          new Promise((r) => setTimeout(() => { timedOut = true; r(null); }, 15000)),
        ]);
        if (timedOut && pid) {
          try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退不追 */ }
        }
      } catch { /* after-hook 吞错 */ }
    }
    if (server) {
      const closing = server as import('node:http').Server;
      closing.closeAllConnections?.();
      await Promise.race([
        new Promise<void>((r) => closing.close(() => r())),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('E13: 四 face managed 真链（件C·LG-058 P2）', () => {

  it('案1 真链：admin 同值连接→四 face managed 并发拉取（真 handler）→三态徽标渲染', { skip: !ENABLED && 'set TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 with local Chrome' }, async () => {
    await withHarness(ADMIN, async (ctx) => {
      const { page } = ctx;
      // boot 后 loadFaceCards 四拉完成：mlc 徽标离开「未连接」态即渲染稳态
      await page.waitForFunction(() => {
        const b = document.getElementById('cf-mlc-badge');
        return !!b && b.textContent !== '未连接';
      }, undefined, { timeout: 8000 });

      // 断言面1：四 face managed 请求全到（FACE_UI_IDS=mlc/rlc/mmc/rmc）且 auth 头=Bearer admin
      const seen = ctx.faceSeen();
      for (const f of ['mlc', 'rlc', 'mmc', 'rmc']) {
        assert.equal(seen[f], `Bearer ${ADMIN}`, `face ${f} managed 请求必带 admin auth 头`);
      }
      // 断言面2：mlc=已配置+applied → 「已生效」徽标（applied class）
      const mlcBadge = await page.$eval('#cf-mlc-badge', (el) => ({ text: el.textContent, cls: el.className }));
      assert.equal(mlcBadge.text, '已生效', `mlc 徽标文案: ${JSON.stringify(mlcBadge)}`);
      assert.ok(mlcBadge.cls.includes('applied'), `mlc 徽标 class: ${mlcBadge.cls}`);
      // 断言面3：rlc/mmc/rmc=未配置诚实态（card_file_present:false → none 徽标，不造数）
      for (const f of ['rlc', 'mmc', 'rmc']) {
        const badge = await page.$eval(`#cf-${f}-badge`, (el) => ({ text: el.textContent, cls: el.className }));
        assert.equal(badge.text, '未配置', `${f} 徽标文案: ${JSON.stringify(badge)}`);
        assert.ok(badge.cls.includes('none'), `${f} 徽标 class: ${badge.cls}`);
      }
      // 断言面4：台账/拉取摘要行渲染活（ledger 扩展面进 body+消费渲染）
      const audit = await page.$eval('#cf-mlc-audit', (el) => el.textContent ?? '');
      assert.ok(audit.includes('台账摘要'), `mlc 台账行: ${audit}`);
      const pull = await page.$eval('#cf-mlc-pull', (el) => el.textContent ?? '');
      assert.ok(pull.includes('拉取源'), `mlc 拉取行: ${pull}`);
    });
  });

  it('案2 错 token：401 → UI 诚实态（已填入未验证+徽标未连接，不静默装成功）', { skip: !ENABLED && 'set TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 with local Chrome' }, async () => {
    await withHarness('wrong-token-e13', async (ctx) => {
      const { page } = ctx;
      // 探针 401 → 黄「已填入未验证」（ui conn-save L542-546 诚实分支）
      await page.waitForFunction(() => (document.getElementById('conn-label') as HTMLElement | null)?.textContent === '已填入未验证', undefined, { timeout: 8000 });
      // server 侧实收 401（探针真链验证）
      const statuses = ctx.probeStatuses();
      assert.ok(statuses.length >= 1 && statuses.every((s) => s === 401), `探针状态码全 401: ${JSON.stringify(statuses)}`);
      // 徽标=未连接（managed 未拉/faceState null——诚实不造数，401 face 不装已连接）
      const badge = await page.$eval('#cf-mlc-badge', (el) => el.textContent);
      assert.equal(badge, '未连接', `错 token 下 mlc 徽标须诚实未连接: ${badge}`);
    });
  });
});
