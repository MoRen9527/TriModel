// ── LG-035 E10: 跨 reload 持久性（W3 真链复刻面升维）──
// 真浏览器 + 真服务端 handler + page.reload()：条目+fixed 规则保存→reload→
// 选择器必须回显最后选择（W3 实锤位）。全真链：真实 fetch+鉴权头+页面全
// 状态重置+加载序——jsdom stub fetch 复刻不了的接缝面。
// Gate: TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 + 本机 Chrome。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

const ENABLED = process.env.TRICOMPANY_ENABLE_TRIMODEL_UI_E2E === '1';

// ── 件A selector 随版修（CTO 裁 2026-09-29 午窗批）：P2 单页架构下策略卡元素全在
// 隐藏 #panel-strategy（ui/index.html 缺省 hidden）内——fill/click 要求可见即挂。
// 修=操作前经菜单切视图（先例=ui.e2e.gate.test.ts gotoStrategy L153-156，加幂等预查
// 防 toggle 语义下二次点击反关面板）。旧测直 fill=随版漂移非产品缺陷（CTO 定性）。═══
async function gotoStrategy(page: import('playwright-core').Page): Promise<void> {
  const hidden = await page.$eval('#panel-strategy', (el) => (el as HTMLElement).hidden).catch(() => true);
  if (!hidden) return;
  await page.click('#page-menu .menu-btn[data-view="strategy"]');
  await page.waitForFunction(() => !(document.querySelector('#panel-strategy') as HTMLElement | null)?.hidden, undefined, { timeout: 8000 });
}

// ── 件A teardown 健壮性（CTO 裁 21fe08d6 §六.4）：close 套 15s 超时兜底+超时
// taskkill 强杀进程树；吞错防 teardown 异常遮蔽原断言——零挂全量跑=clean 读数前提。═══
async function closeBrowserRobust(browser: import('playwright-core').Browser | undefined): Promise<void> {
  if (!browser) return;
  let timedOut = false;
  // playwright-core 此版本类型面无 Browser.process——运行时 launch 体必有，显式形态读取
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

describe('E10: cross-reload persistence of fixed-rule selection (W3)', () => {
  it('save entry+fixed selection → page.reload() → selector still shows last choice', { skip: !ENABLED && 'set TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 with local Chrome' }, async () => {
    const { chromium } = await import('playwright-core');
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-e10-'));
    const cardPath = join(dir, 'trimmc-card.json');
    const uiPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
    const { handlePutTrimmcCard, handleGetTrimmcCard } = await import('../src/api/trimmc-card.js');

    let server: import('node:http').Server | undefined;
    let browser: import('playwright-core').Browser | undefined; // 件A：提声明至 try 外——finally closeBrowserRobust 作用域可达
    let putCount = 0;
    let lastPutBody = '';
    try {
      server = createServer((req, res) => {
        const url = req.url ?? '';
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const auth = req.headers.authorization;
          if (req.method === 'PUT' && url === '/v1/config/trimmc-card') {
            putCount += 1;
            lastPutBody = body;
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
            res.end(readFileSync(uiPath));
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
      const srv: import('node:http').Server = server;
      if (!srv) throw new Error('server not created');
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const port = (srv.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      browser = await chromium.launch({ channel: 'chrome' });
      const page = await browser.newPage();
      await page.goto(`${base}/ui`);

      // 连接（双令牌）→探针通过
      await page.fill('#token', 'tk-e10');
      await page.fill('#adminToken', 'admin-e10');
      await page.click('#conn-save');
      await page.waitForFunction(() => (document.getElementById('tc-r-entry') as HTMLSelectElement | null) !== null);

      // 件A：切视图前置——#tc-conn 在隐藏 #panel-strategy 内，fill 要求可见
      await gotoStrategy(page);

      // 名称 + 条目 w3a
      await page.fill('#tc-conn', 'e10-machine');
      await page.click('#tc-open-add');
      await page.fill('#tc-e-id', 'w3a');
      await page.fill('#tc-e-key', 'sk-e10-w3a-key-00001');
      await page.click('#tc-e-save');
      // 当前使用 → entry:w3a
      await page.selectOption('#tc-r-entry', 'entry:w3a');
      // 保存卡片
      await page.click('#tc-save');
      await page.waitForFunction(() => (document.getElementById('tc-msg') as HTMLElement).textContent?.includes('卡片已保存'), undefined, { timeout: 5000 });

      // ═══ W3 实锤位：page.reload()（页面全状态重置+真实 boot 链）═══
      await page.reload();
      await page.waitForFunction(() => {
        const sel = document.getElementById('tc-r-entry') as HTMLSelectElement | null;
        return !!sel && sel.options.length >= 1;
      }, undefined, { timeout: 8000 });
      const selVal = await page.$eval('#tc-r-entry', (el) => (el as HTMLSelectElement).value);
      const optCount = await page.$eval('#tc-r-entry', (el) => (el as HTMLSelectElement).options.length);

      assert.equal(optCount, 1, 'reload 后选择器必须恰一选项（w3a）');
      assert.equal(selVal, 'entry:w3a', 'W3 实锤：reload 后选择器必须回显最后选择');
      assert.ok(existsSync(cardPath), 'card must persist');
      const disk = JSON.parse(readFileSync(cardPath, 'utf-8'));
      assert.equal(disk.rules.filter((r: { type: string }) => r.type === 'fixed').length, 1, '恰一条 fixed');
      assert.equal(disk.rules.find((r: { type: string }) => r.type === 'fixed').entry_id, 'w3a');
      assert.ok(putCount >= 1 && lastPutBody.includes('w3a'), 'PUT chain sanity');
      await closeBrowserRobust(browser);
    } finally {
      await closeBrowserRobust(browser);
      if (server) {
        const closing = server;
        closing.closeAllConnections?.(); // keep-alive 挂连接是 server.close 挂起主因
        await Promise.race([
          new Promise<void>((r) => closing.close(() => r())),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
