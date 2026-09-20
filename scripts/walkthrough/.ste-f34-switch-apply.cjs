// STE F3/F4 final: UI intent card → apply-equivalent write-back (policy API + status applied,
// = COS 运维通道等价，CTO 23:09 裁定) → 3334 real-call honors switched model → daemon -p real call.
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const net = require('node:net');

const TRIROOT = 'D:/Code/ai/TriModel';
const CARD = join(TRIROOT, 'trimmc-card.json');
const POLICY_LOCAL = join(TRIROOT, 'policies', 'local.json');
const OUT = join(TRIROOT, '.ste-f1-out');
const API_TOKEN = 'ste-f34-token';
const ADMIN_TOKEN = 'ste-f34-admin';
mkdirSync(OUT, { recursive: true });
const log = [];
const say = (s) => { log.push(s); console.log(s); };

function readEnvKey(file, key) {
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, 'utf-8').split('\n').find((l) => l.startsWith(key + '='));
  return m ? m.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
}
const realApi = readEnvKey('D:/Code/ai/.env', 'TRIMODEL_API_TOKEN');
const realAdmin = readEnvKey(join(TRIROOT, '.env'), 'TRIMODEL_ADMIN_TOKEN');

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

async function bootServers(port, proxyPort) {
  const env = { ...process.env, TRIMODEL_PORT: String(port), TRIMODEL_PROXY_PORT: String(proxyPort), TRIMODEL_PROXY_MACHINE: 'local', TRIMODEL_API_TOKEN: API_TOKEN, TRIMODEL_ADMIN_TOKEN: ADMIN_TOKEN, TRIMODEL_DEFAULT_MODEL: 'deepseek-v4-pro' };
  delete env.TRIMODEL_HOST;
  const c = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: TRIROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/proxy-server.ts'], { cwd: TRIROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const u of ['http://127.0.0.1:' + port + '/health', 'http://127.0.0.1:' + proxyPort + '/proxy/health']) {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(u); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  }
  return { c, p };
}

async function proxy3334Call(proxyPort, tag, label) {
  const res = await fetch('http://127.0.0.1:' + proxyPort + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer cc-placeholder', 'x-api-key': 'cc-placeholder', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', max_tokens: 20, messages: [{ role: 'user', content: '只回复两个字：OK' }] }),
  });
  const text = await res.text();
  let wire = '(unparsed)';
  try { wire = JSON.parse(text).model ?? '(no model)'; } catch { wire = '(non-JSON ' + res.status + ': ' + text.slice(0, 80) + ')'; }
  const real = res.status === 200 && text.length > 10 && !text.includes('error');
  say('F3-3334[' + tag + '/' + label + ']: HTTP ' + res.status + ' wire.model=' + wire + ' ' + (real ? '✓真实上游回复' : '✗'));
  return { status: res.status, wire, real };
}

(async () => {
  const snapCard = existsSync(CARD) ? readFileSync(CARD, 'utf-8') : null;
  const snapPolicy = existsSync(POLICY_LOCAL) ? readFileSync(POLICY_LOCAL, 'utf-8') : null;
  rmSync(CARD, { force: true });
  rmSync(POLICY_LOCAL, { force: true });

  const runTrack = async (base, api, admin, tag, boot) => {
    let c = null, p = null, proxyPort = 0;
    if (boot) { const port = await freePort(); proxyPort = await freePort(); const r = await bootServers(port, proxyPort); c = r.c; p = r.p; base = 'http://127.0.0.1:' + port; }
    try {
      const browser = await chromium.launch({ executablePath: process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
      const page = await (await browser.newContext()).newPage();
      await page.goto(base + '/ui', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      await page.fill('#token', api);
      await page.fill('#adminToken', admin);
      await page.click('#conn-save');
      await page.waitForFunction(() => document.querySelector('#conn-dot')?.className.includes('ok'), { timeout: 8000 });
      await page.fill('#tc-conn', 'f34-' + tag);
      const addEntry = async (id, provider, model, key) => {
        await page.click('#tc-open-add');
        await page.selectOption('#tc-e-provider', provider);
        await page.waitForFunction((v) => { const el = document.querySelector('#tc-e-model'); return el && Array.from(el.options).some((o) => o.value === v); }, model, { timeout: 8000 }).catch(() => {});
        await page.fill('#tc-e-id', id);
        await page.selectOption('#tc-e-model', model);
        await page.fill('#tc-e-key', key);
        await page.click('#tc-e-save');
        await page.waitForTimeout(250);
      };
      await addEntry('f34-ds', 'deepseek', 'deepseek-v4-pro', 'sk-f34-ds-key-0001');
      await addEntry('f34-glm', 'glm', 'GLM-5.3', 'sk-f34-glm-key-0002');
      await page.waitForFunction(() => { const el = document.querySelector('#tc-r-entry'); return el && el.options && el.options.length >= 2; }, { timeout: 6000 }).catch(() => {});
      const glmVal = (await page.$eval('#tc-r-entry', (el) => Array.from(el.options).map((o) => o.value))).find((v) => v.includes('glm'));
      await page.selectOption('#tc-r-entry', glmVal);
      await page.click('#tc-save'); // 意图卡：fixed rule 随卡待应用
      await page.waitForTimeout(700);
      const cardGet = await (await fetch(base + '/v1/config/trimmc-card', { headers: { authorization: 'Bearer ' + admin } })).json();
      say('F3[' + tag + '] card.rules after save: ' + JSON.stringify(cardGet.card?.rules ?? null) + ' status=' + JSON.stringify(cardGet.card?.status ?? null).slice(0, 60));

      // ── apply-equivalent write-back (COS 运维通道等价)：分发 fixed GLM 策略 + status applied ──
      const put1 = await fetch(base + '/v1/config/policy', {
        method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin },
        body: JSON.stringify({ version: '1', schedules: [{ id: 'f34-fixed', target: 'daemon-default', model: 'GLM-5.3', type: 'fixed', timezone: 'Asia/Shanghai', enabled: true, priority: 10 }] }),
      });
      const put2 = await fetch(base + '/v1/config/trimmc-card/status', {
        method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin },
        body: JSON.stringify({ state: 'applied' }),
      });
      say('F4[' + tag + '] apply write-back: policy PUT=' + put1.status + ' status PUT=' + put2.status);
      await page.click('#tc-reload');
      await page.waitForTimeout(800);
      say('F4[' + tag + '] badge after apply: ' + (await page.locator('#tc-badge').textContent()));

      // ── F3 core: 3334 实调目标模型（切换后 GLM）──
      await proxy3334Call(proxyPort, tag, 'switched-GLM');
      // switch back to deepseek (UI 意图 + apply 等价回写)
      await page.waitForFunction(() => { const el = document.querySelector('#tc-r-entry'); return el && el.options && el.options.length >= 2; }, { timeout: 6000 }).catch(() => {});
      const dsVal = (await page.$eval('#tc-r-entry', (el) => Array.from(el.options).map((o) => o.value))).find((v) => v.includes('ds'));
      await page.selectOption('#tc-r-entry', dsVal);
      await page.click('#tc-save');
      await page.waitForTimeout(600);
      await fetch(base + '/v1/config/policy', {
        method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin },
        body: JSON.stringify({ version: '1', schedules: [{ id: 'f34-fixed-ds', target: 'daemon-default', model: 'deepseek-v4-pro', type: 'fixed', timezone: 'Asia/Shanghai', enabled: true, priority: 10 }] }),
      });
      await proxy3334Call(proxyPort, tag, 'switched-back-DS');
      await browser.close();
    } finally {
      if (c) c.kill();
      if (p) p.kill();
    }
  };

  say('── Track A (isolated test server + 3334) ──');
  await runTrack('http://127.0.0.1:0', API_TOKEN, ADMIN_TOKEN, 'trackA', true);

  say('── Track B (real 3333/3334-fresh, snapshot-restore) ──');
  if (!realApi || !realAdmin) say('TrackB SKIPPED: real tokens missing');
  else {
    const snapC = existsSync(CARD) ? readFileSync(CARD, 'utf-8') : null;
    const snapP = existsSync(POLICY_LOCAL) ? readFileSync(POLICY_LOCAL, 'utf-8') : null;
    rmSync(CARD, { force: true });
    rmSync(POLICY_LOCAL, { force: true });
    try {
      await runTrack('http://127.0.0.1:3333', realApi, realAdmin, 'trackB', true);
      // daemon-leg real model validation (F4 second evidence)
      say('F4 daemon-leg: trilc chat -p real one-shot...');
      const out = execSync('node dist/cli.js chat -p "只回复两个字：OK" --permission-mode dontAsk', { cwd: 'D:/Code/ai/TriRLC', encoding: 'utf-8', timeout: 90000 });
      say('F4 trilc -p tail: ' + String(out).trim().split('\n').slice(-2).join(' | ').slice(0, 200));
    } finally {
      if (snapC === null) rmSync(CARD, { force: true }); else writeFileSync(CARD, snapC);
      if (snapP === null) rmSync(POLICY_LOCAL, { force: true }); else writeFileSync(POLICY_LOCAL, snapP);
      say('TrackB restored');
    }
  }

  writeFileSync(join(OUT, 'f34-log.json'), JSON.stringify(log, null, 1));
  console.log('F3/F4 DONE');
  process.exit(0);
})().catch((e) => { console.error('F3/F4 ABORT:', e.message); process.exit(1); });
