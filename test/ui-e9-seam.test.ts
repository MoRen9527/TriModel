// ── LG-035 E9: UI → trimmc-card.json 接缝 E2E（playwright, env-gated）──
// COS 点名第三型盲区补测：真浏览器驱动 UI 表单填两条目→点保存→读盘断言
// 完整对象落盘（provider/model/api_key_encrypted/enabled 四字段齐全）。
// Gate: TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 才执行（需本机 Chrome）；
// 默认 skip（CI 无浏览器二进制时零负担）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { createServer } from 'node:http';

const ENABLED = process.env.TRICOMPANY_ENABLE_TRIMODEL_UI_E2E === '1';

describe('E9: UI form → trimmc-card.json seam (playwright, env-gated)', () => {
  it('two entries submitted via the real UI land as complete encrypted objects', { skip: !ENABLED && 'set TRICOMPANY_ENABLE_TRIMODEL_UI_E2E=1 with local Chrome' }, async () => {
    const { chromium } = await import('playwright-core');
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-e9-'));
    const cardPath = join(dir, 'trimmc-card.json');
    let browser: import("playwright-core").Browser | undefined;
    let server: import("node:http").Server | undefined;
    try {
      // Minimal config-plane: serves the real UI + handles the card PUT.
      const uiPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
      server = createServer((req, res) => {
        const url = req.url ?? '/';
        if (req.method === 'GET' && (url === '/ui' || url === '/ui/' || url === '/ui/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(readFileSync(uiPath));
          return;
        }
        if (req.method === 'PUT' && url === '/v1/config/trimmc-card') {
          // Real handler semantics exercised in unit suite; here serve the
          // seam by delegating to the same code path via in-process import.
          void req;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'GET' && url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'GLM-5.3-Flash' }, { id: 'GLM-5.3' }, { id: 'TMV' }] }));
          return;
        }
        if (req.method === 'GET' && url?.startsWith('/v1/config/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'x', policy: { version: '1', schedules: [] }, effective: { model: 'deepseek-v4-pro', source: 'env-default', matched_schedule_id: null }, card_file_present: false, card: null, entries_masked: {}, message: '' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
      // Route the card PUT through the REAL handler (assertion = handler output)
      server.on('request', () => { /* no-op, handler replaced below */ });
      const listenServer = server;
      if (!listenServer) throw new Error('server not created');
      await new Promise<void>((r) => listenServer.listen(0, '127.0.0.1', r));
      const port = (listenServer.address() as { port: number }).port;

      // Swap in the real card PUT handler (seam = real code, not a stub)
      const { handlePutTrimmcCard } = await import('../src/api/trimmc-card.js');
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        const url = req.url ?? '';
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const auth = req.headers.authorization;
          if (req.method === 'PUT' && url === '/v1/config/trimmc-card') {
            const out = handlePutTrimmcCard(auth, body, { cardPath });
            res.writeHead(out.statusCode, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body));
            return;
          }
          if (req.method === 'GET' && (url === '/ui' || url === '/ui/')) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(readFileSync(uiPath));
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });

      browser = await chromium.launch({ channel: 'chrome' });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/ui`);
      // 连接设置：填双令牌→连接
      await page.fill('#token', 'tk-e9');
      await page.fill('#adminToken', 'admin-e9');
      await page.click('#conn-save');
      // 卡片：名称+两条目
      await page.fill('#tc-conn', 'e9-machine');
      await page.click('#tc-open-add');
      await page.fill('#tc-e-id', 'f34-ds');
      await page.selectOption('#tc-e-provider', 'deepseek');
      await page.fill('#tc-e-key', 'sk-e9-deepseek-key-0001');
      await page.click('#tc-e-save');
      await page.click('#tc-open-add');
      await page.fill('#tc-e-id', 'f34-glm');
      await page.selectOption('#tc-e-provider', 'glm');
      await page.fill('#tc-e-key', 'sk-e9-glm-key-00000002');
      await page.click('#tc-e-save');
      await page.click('#tc-save');
      await page.waitForTimeout(300);

      assert.ok(existsSync(cardPath), 'card file must land');
      const doc = JSON.parse(readFileSync(cardPath, 'utf-8'));
      const e1 = doc.provider_entries['f34-ds'];
      const e2 = doc.provider_entries['f34-glm'];
      for (const [label, entry] of [['f34-ds', e1], ['f34-glm', e2]] as const) {
        assert.ok(entry, `${label} must exist`);
        assert.equal(typeof entry.provider, 'string');
        assert.equal(typeof entry.model, 'string');
        assert.equal(typeof entry.api_key_encrypted, 'string');
        assert.equal(typeof entry.enabled, 'boolean');
        assert.ok(!JSON.stringify(entry).includes('sk-e9'), 'plaintext must never land');
      }
      assert.equal((e1 as { model: string }).model, 'deepseek-v4-pro');
      assert.equal((e2 as { model: string }).model, 'GLM-5.3');
    } finally {
      if (browser) await browser.close().catch(() => {});
      const closing = server;
      if (closing) await new Promise<void>((r) => closing.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
