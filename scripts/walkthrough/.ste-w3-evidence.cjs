// STE W3 three-values evidence pack for FSD triage (temp)
// 检查点：T0 连接后基线 / T1 条目+规则保存后(重载前) / T2 重载后
// 三值=sel.value + sel.options.length + (可达面)服务端卡 rules/entries；网络 GET/PUT 全序。
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
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
  const netSeq = [];
  page.on('response', (r) => { if (r.url().includes('/v1/')) netSeq.push(r.request().method() + ' ' + r.url().split('/v1')[1].split('?')[0] + ' → ' + r.status()); });
  const grab = async (label) => {
    const ui = await page.evaluate(() => {
      const sel = document.querySelector('#tc-r-entry');
      const mirrorExposed = typeof window.tcMirror !== 'undefined' ? Object.keys(window.tcMirror) : 'not-on-window';
      return {
        sel_value: sel ? sel.value : null,
        sel_options: sel ? Array.from(sel.options).map((o) => o.value) : null,
        sel_disabled: sel ? sel.disabled : null,
        fixed_active_hidden: document.querySelector('#tc-fixed-active')?.hidden,
        entry_rows: document.querySelectorAll('#tc-entry-body tr').length,
        entry_ids_dom: Array.from(document.querySelectorAll('#tc-entry-body tr')).map((tr) => (tr.textContent || '').trim().slice(0, 20)),
        tcMirror_keys: mirrorExposed,
      };
    });
    const card = await (await fetch('http://127.0.0.1:' + port + '/v1/config/trimmc-card', { headers: { authorization: 'Bearer a1' } })).json();
    const snap = {
      checkpoint: label,
      ui,
      server: {
        provider_entry_ids: Object.keys(card.card?.provider_entries ?? {}),
        rules: card.card?.rules ?? null,
        status: card.card?.status?.state ?? null,
      },
      net_so_far: netSeq.slice(),
    };
    console.log('=== ' + label + ' ===');
    console.log(JSON.stringify(snap, null, 1));
    return snap;
  };
  await page.goto('http://127.0.0.1:' + port + '/ui', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.fill('#token', 't1');
  await page.fill('#adminToken', 'a1');
  await page.click('#conn-save');
  await page.waitForTimeout(1500);
  await page.fill('#tc-conn', 'triage-machine'); // S10 必填：不填则 tc-save 被校验拦=无 PUT（假 W3 态）
  const t0 = await grab('T0-post-connect');
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
  await addEntry('triage-ds', 'deepseek', 'deepseek-v4-pro', 'sk-triage-ds-0001');
  await addEntry('triage-glm', 'glm', 'GLM-5.3', 'sk-triage-glm-0002');
  // 固定规则选择 w-glm（=W3 场景）
  await page.waitForFunction(() => { const el = document.querySelector('#tc-r-entry'); return el && el.options.length >= 2; }, { timeout: 8000 }).catch(() => {});
  const glmVal = await page.$eval('#tc-r-entry', (el) => { const o = Array.from(el.options).map((x) => x.value); return o.find((v) => v.includes('glm')) ?? o[o.length - 1] ?? ''; });
  await page.selectOption('#tc-r-entry', glmVal);
  await page.click('#tc-save');
  await page.waitForTimeout(1000);
  const t1 = await grab('T1-post-save-pre-reload (sel=' + glmVal + ')');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const t2 = await grab('T2-post-reload (期望=sel 保持 ' + glmVal + ')');
  const pack = { t0, t1, t2, netSeq };
  writeFileSync('D:/Code/ai/TriModel/.ste-f1-out/w3-three-values.json', JSON.stringify(pack, null, 1));
  console.log('PACK SAVED: .ste-f1-out/w3-three-values.json');
  await browser.close();
  c.kill();
  process.exit(0);
})().catch((e) => { console.error('ABORT', e.message); process.exit(1); });
