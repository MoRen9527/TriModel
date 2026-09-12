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

const ENABLED = process.env.TRICOMPANY_ENABLE_TRIMODEL_UI_E2E === '1';

describe('E10: cross-reload persistence of fixed-rule selection (W3)', () => {
  it('save entry+fixed selection → page.reload() → selector still shows last choice', { skip: !ENABLED && 'set TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 with local Chrome' }, async () => {
    const { chromium } = await import('playwright-core');
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-e10-'));
    const cardPath = join(dir, 'trimmc-card.json');
    const uiPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
    const { handlePutTrimmcCard, handleGetTrimmcCard } = await import('../src/api/trimmc-card.js');

    let server: import('node:http').Server | undefined;
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

      const browser = await chromium.launch({ channel: 'chrome' });
      const page = await browser.newPage();
      await page.goto(`${base}/ui`);

      // 连接（双令牌）→探针通过
      await page.fill('#token', 'tk-e10');
      await page.fill('#adminToken', 'admin-e10');
      await page.click('#conn-save');
      await page.waitForFunction(() => (document.getElementById('tc-r-entry') as HTMLSelectElement | null) !== null);

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
      await browser.close().catch(() => {});
    } finally {
      if (server) {
        const closing = server;
        await new Promise<void>((r) => closing.close(() => r()));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
