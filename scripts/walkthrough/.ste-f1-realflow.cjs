// STE F1 real-credential connection flow runner (exploratory, NOT in npm test)
// 真实 3333 活体 + 真实令牌（进程内自 .env 读取，零回显零落盘）；CEO 八问题定向观测。
// 只读流：不保存卡片/策略，不改动真实状态。
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const TRIROOT = 'D:/Code/ai/TriModel';
const BASE = 'http://127.0.0.1:3333';
const OUT = 'D:/Code/ai/TriModel/.ste-f1-out';

function readEnvKey(file, key) {
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, 'utf-8').split('\n').find((l) => l.startsWith(key + '='));
  return m ? m.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
}

const apiToken = readEnvKey('D:/Code/ai/.env', 'TRIMODEL_API_TOKEN') ?? readEnvKey(join(TRIROOT, '.env'), 'TRIMODEL_API_TOKEN');
const adminToken = readEnvKey(join(TRIROOT, '.env'), 'TRIMODEL_ADMIN_TOKEN');
const trilcToken = readEnvKey('D:/Code/ai/.env', 'TRILC_INTERNAL_TOKEN');
const log = [];
const say = (s) => { log.push(s); console.log(s); };

(async () => {
  mkdirSync(OUT, { recursive: true });
  say('F1 tokens present: api=' + Boolean(apiToken) + ' admin=' + Boolean(adminToken) + ' trilc=' + Boolean(trilcToken));

  // daemon internal-token self-verify (200=right / 401=wrong; /health = no-auth baseline)
  const health = await fetch(BASE + '/health');
  say('TriModel /health → ' + health.status);
  const dh = await fetch('http://127.0.0.1:8711/health');
  say('daemon /health (no auth) → ' + dh.status);
  if (trilcToken) {
    const internal = await fetch('http://127.0.0.1:8711/internal/v1/init/chain/status', {
      headers: { 'X-Internal-Token': trilcToken },
    });
    say('daemon /internal/v1/init/chain/status (TRILC token) → ' + internal.status + ' (200=取对/401=取错)');
  } else {
    say('daemon internal probe SKIPPED (TRILC_INTERNAL_TOKEN not found)');
  }

  const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const netLog = [];
  page.on('response', (r) => { if (r.url().includes('/v1/')) netLog.push(r.request().method() + ' ' + r.url().split('/v1')[1] + ' → ' + r.status()); });

  // ── S1: empty-state on real server ──
  await page.goto(BASE + '/ui', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const s1 = await page.evaluate(() => ({
    settingsOpen: document.querySelector('#conn-settings')?.open,
    guideHidden: document.querySelector('#conn-guide')?.hidden,
    dot: document.querySelector('#conn-dot')?.className,
    label: document.querySelector('#conn-label')?.textContent,
  }));
  say('S1 empty-state: ' + JSON.stringify(s1));

  // ── S2: real dual-token connect ──
  await page.fill('#token', apiToken || 'MISSING');
  await page.fill('#adminToken', adminToken || 'MISSING');
  await page.click('#conn-save');
  await page.waitForTimeout(1800);
  const s2 = await page.evaluate(() => ({
    dot: document.querySelector('#conn-dot')?.className,
    label: document.querySelector('#conn-label')?.textContent,
    effective: (document.querySelector('#effective')?.textContent || '').slice(0, 200),
    badge: document.querySelector('#tc-badge')?.textContent,
    tcHead: (document.querySelector('#tc-head')?.textContent || '').slice(0, 200),
    errStatus: document.querySelector('#error-status')?.hidden === false ? (document.querySelector('#error-status')?.textContent || '').slice(0, 120) : '(hidden)',
    errCard: document.querySelector('#error-card')?.hidden === false ? (document.querySelector('#error-card')?.textContent || '').slice(0, 120) : '(hidden)',
    fallbackTip: document.querySelector('#tc-fallback-tip')?.hidden === false ? (document.querySelector('#tc-fallback-tip')?.textContent || '').slice(0, 150) : '(hidden)',
    entryRows: document.querySelectorAll('#tc-entry-body tr').length,
  }));
  say('S2 connected: ' + JSON.stringify(s2, null, 1));
  say('S2 network: ' + JSON.stringify(netLog));
  await page.screenshot({ path: join(OUT, 'f1-s2-connected.png'), fullPage: true });

  // ── S3: single-token states (CEO 双令牌矛盾 observation) ──
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(BASE + '/ui', { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(500);
  await p3.fill('#token', apiToken || 'MISSING');
  await p3.click('#conn-save');
  await p3.waitForTimeout(1000);
  const s3api = await p3.evaluate(() => ({
    dot: document.querySelector('#conn-dot')?.className,
    label: document.querySelector('#conn-label')?.textContent,
    guide: document.querySelector('#conn-guide')?.hidden === false ? (document.querySelector('#conn-guide')?.textContent || '').slice(0, 80) : '(hidden)',
  }));
  say('S3a api-only: ' + JSON.stringify(s3api));
  await p3.fill('#token', '');
  await p3.evaluate(() => { document.querySelector('#conn-settings').open = true; }); // warn 态下 details 可能已收起，重开再填
  await p3.fill('#adminToken', adminToken || 'MISSING');
  await p3.click('#conn-save');
  await p3.waitForTimeout(1000);
  const s3admin = await p3.evaluate(() => ({
    dot: document.querySelector('#conn-dot')?.className,
    label: document.querySelector('#conn-label')?.textContent,
  }));
  say('S3b admin-only: ' + JSON.stringify(s3admin));
  await ctx3.close();

  // ── S4: cascade filter + key validation (add-entry form) ──
  await page.click('#tc-open-add');
  await page.waitForTimeout(400);
  const providers = await page.$eval('#tc-e-provider', (el) => Array.from(el.options).map((o) => o.value));
  const allModels = await page.$eval('#tc-e-model', (el) => Array.from(el.options).map((o) => o.value));
  await page.selectOption('#tc-e-provider', 'glm');
  await page.waitForTimeout(300);
  const glmModels = await page.$eval('#tc-e-model', (el) => Array.from(el.options).map((o) => o.value));
  say('S4 provider options: ' + JSON.stringify(providers));
  say('S4 models(all): ' + JSON.stringify(allModels) + ' → after glm: ' + JSON.stringify(glmModels) + (JSON.stringify(allModels) === JSON.stringify(glmModels) ? ' WARN-cascade-not-filtering' : ' (级联过滤生效)'));

  // key validation: short key
  await page.fill('#tc-e-id', 'f1-probe');
  await page.fill('#tc-e-key', 'sk');
  await page.click('#tc-e-save');
  await page.waitForTimeout(400);
  const kv = await page.evaluate(() => ({
    formStillOpen: !document.querySelector('#tc-form')?.hidden,
    modelErr: (document.querySelector('#tc-model-error')?.textContent || '').slice(0, 100),
    msg: (document.querySelector('#tc-msg')?.textContent || '').slice(0, 100),
  }));
  say('S4 short-key validation: ' + JSON.stringify(kv));
  await page.click('#tc-e-cancel');
  await page.screenshot({ path: join(OUT, 'f1-s4-form.png'), fullPage: false });

  // ── S5: policy zone display (策略展示错乱 observation, read-only) ──
  const policyZone = await page.evaluate(() => {
    const zone = document.querySelector('#local-zone');
    const rows = Array.from(document.querySelectorAll('#policy-body tr')).map((tr) => (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90));
    return { zoneOpen: zone?.open, zoneExists: !!zone, rows };
  });
  say('S5 policy zone: ' + JSON.stringify(policyZone, null, 1));

  // fallback duplication check: re-render (reload) then count occurrences of 回落 copy
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const dup = await page.evaluate(() => {
    const t = document.body.innerText;
    const count = (s) => (t.split(s).length - 1);
    return { fallbackTipCount: count('回落'), refreshBtnCount: count('刷新'), reservedCount: count('按时段/额度自动切换') };
  });
  say('S6 duplication counts after reload: ' + JSON.stringify(dup));

  writeFileSync(join(OUT, 'f1-log.json'), JSON.stringify(log, null, 1));
  await browser.close();
  console.log('F1 DONE — artifacts in ' + OUT);
  process.exit(0);
})().catch((e) => { console.error('F1 ABORT:', e.message); process.exit(1); });
