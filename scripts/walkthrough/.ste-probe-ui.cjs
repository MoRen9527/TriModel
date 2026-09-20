// STE probe: W1 race diagnosis — settle + reselect pattern (temp)
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const net = require('node:net');
const TRIROOT = 'D:/Code/ai/TriModel';
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
(async () => {
  const port = await freePort();
  const env = { ...process.env, TRIMODEL_PORT: String(port), TRIMODEL_API_TOKEN: 't1', TRIMODEL_ADMIN_TOKEN: 'a1', TRIMODEL_DEFAULT_MODEL: 'deepseek-v4-pro' };
  delete env.TRIMODEL_HOST;
  const c = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: TRIROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  const browser = await chromium.launch({ executablePath: process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://127.0.0.1:' + port + '/ui', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.fill('#token', 't1');
  await page.fill('#adminToken', 'a1');
  await page.click('#conn-save');
  await page.waitForTimeout(1500); // generous: let ALL initial card fetches settle
  await page.fill('#tc-conn', 'probe-machine'); // after connect: panels enabled
  const addEntry = async (id, provider, model, key) => {
    await page.click('#tc-open-add');
    await page.selectOption('#tc-e-provider', provider);
    await page.waitForTimeout(400);
    await page.fill('#tc-e-id', id);
    await page.selectOption('#tc-e-model', model);
    await page.fill('#tc-e-baseurl', 'https://x.example.com/v1');
    await page.fill('#tc-e-key', key);
    await page.click('#tc-e-save');
    await page.waitForTimeout(300);
  };
  await addEntry('w-ds', 'deepseek', 'deepseek-v4-pro', 'sk-a-1-2345-6789-0000');
  await addEntry('w-glm', 'glm', 'GLM-5.3', 'sk-b-2-2345-6789-0000');
  await page.click('#tc-save');
  await page.waitForTimeout(1000);
  console.log('SAVE1 msg:', await page.locator('#tc-msg').textContent());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800); // generous settle
  const opts = await page.$eval('#tc-r-entry', (el) => Array.from(el.options).map((o) => o.value));
  console.log('opts:', JSON.stringify(opts));
  const glmVal = opts.find((v) => v.includes('w-glm'));
  await page.selectOption('#tc-r-entry', glmVal);
  await page.waitForTimeout(600); // settle any async re-render
  const cur = await page.$eval('#tc-r-entry', (el) => el.value);
  if (cur !== glmVal) { console.log('RESELECT needed (was ' + cur + ')'); await page.selectOption('#tc-r-entry', glmVal); await page.waitForTimeout(300); }
  await page.click('#tc-save');
  await page.waitForTimeout(1000);
  console.log('SAVE2 msg:', await page.locator('#tc-msg').textContent());
  const card = await (await fetch('http://127.0.0.1:' + port + '/v1/config/trimmc-card', { headers: { authorization: 'Bearer a1' } })).json();
  console.log('CARD rules:', JSON.stringify(card.card?.rules ?? null));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  console.log('AFTER-RELOAD value:', await page.$eval('#tc-r-entry', (el) => el.value));
  await browser.close();
  c.kill();
  process.exit(0);
})().catch((e) => { console.error('ABORT', e.message); process.exit(1); });
