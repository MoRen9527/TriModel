// STE F2 entry-fill flow runner (dual-track per CTO 23:03): Track A = isolated test server
// (snapshot protocol); Track B = one real-card round with snapshot-restore. Readings + defects.
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const net = require('node:net');

const TRIROOT = 'D:/Code/ai/TriModel';
const CARD = join(TRIROOT, 'trimmc-card.json');
const OUT = join(TRIROOT, '.ste-f1-out');
const API_TOKEN = 'ste-f2-token';
const ADMIN_TOKEN = 'ste-f2-admin';
mkdirSync(OUT, { recursive: true });

function readEnvKey(file, key) {
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, 'utf-8').split('\n').find((l) => l.startsWith(key + '='));
  return m ? m.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
}
const realApi = readEnvKey('D:/Code/ai/.env', 'TRIMODEL_API_TOKEN');
const realAdmin = readEnvKey(join(TRIROOT, '.env'), 'TRIMODEL_ADMIN_TOKEN');
const log = [];
const say = (s) => { log.push(s); console.log(s); };

function freePort() {
  return new Promise((res, rej) => {
    const s = require('node:net').createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

async function bootServer(port) {
  const env = { ...process.env, TRIMODEL_PORT: String(port), TRIMODEL_API_TOKEN: API_TOKEN, TRIMODEL_ADMIN_TOKEN: ADMIN_TOKEN, TRIMODEL_DEFAULT_MODEL: 'deepseek-v4-pro' };
  delete env.TRIMODEL_HOST;
  const c = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: TRIROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) return c; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('test server not healthy');
}

async function connect(page, api, admin) {
  await page.fill('#token', api);
  await page.fill('#adminToken', admin);
  await page.click('#conn-save');
  await page.waitForFunction(() => document.querySelector('#conn-dot')?.className.includes('ok'), { timeout: 8000 });
}

/** Entry-fill flow on a given base. Returns observations. mode: 'valid' | 'masked-key' | 'dangling-save' */
async function entryFlow(base, api, admin, tag, entryId) {
  const browser = await chromium.launch({ executablePath: process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + '/ui', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await connect(page, api, admin);
  await page.fill('#tc-conn', 'f2-machine-' + tag);

  // add valid entry
  await page.click('#tc-open-add');
  // robust wait: poll until the target option exists in the model select (cascade may filter/rebuild)
  const waitModelOption = async (sel, val) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await page.$eval(sel, (el, v) => Array.from(el.options).some((o) => o.value === v), val).catch(() => false);
      if (found) return;
      await page.waitForTimeout(200);
    }
    const opts = await page.$eval(sel, (el) => Array.from(el.options).map((o) => o.value)).catch(() => []);
    throw new Error('model option "' + val + '" not found after 8s; current options=' + JSON.stringify(opts));
  };
  await waitModelOption('#tc-e-model', 'deepseek-v4-pro');
  await page.fill('#tc-e-id', entryId);
  await page.selectOption('#tc-e-provider', 'deepseek');
  await page.selectOption('#tc-e-model', 'deepseek-v4-pro');
  await page.fill('#tc-e-key', 'sk-f2-entry-key-0001');
  await page.click('#tc-e-save');
  await page.waitForTimeout(300);
  const rows = await page.locator('#tc-entry-body tr').count();

  // inline enable toggle (S2 行内启用开关)
  let toggleObservation = '(toggle control not found)';
  const toggle = page.locator('#tc-entry-body input[type="checkbox"]').first();
  if (await toggle.count()) {
    const before = await toggle.isChecked();
    await toggle.click();
    await page.waitForTimeout(200);
    const after = await toggle.isChecked();
    toggleObservation = 'before=' + before + ' after=' + after + (before !== after ? ' (翻转生效)' : ' (⚠点击无效果)');
    await toggle.click(); // restore enabled for save
    await page.waitForTimeout(200);
  }

  // edit prefill (编辑预填无覆盖)
  let editPrefill = '(edit control not found)';
  const editBtn = page.locator('#tc-entry-body button', { hasText: /编辑/ }).first();
  if (await editBtn.count()) {
    await editBtn.click();
    await page.waitForTimeout(300);
    const pre = await page.evaluate(() => ({
      id: document.querySelector('#tc-e-id')?.value,
      model: document.querySelector('#tc-e-model')?.value,
      keyMasked: (document.querySelector('#tc-e-key')?.value || '').slice(0, 6),
    }));
    editPrefill = JSON.stringify(pre);
    await page.click('#tc-e-cancel');
  }

  // masked-key rejection at save (provider first: cascade filters models by vendor)
  await page.click('#tc-open-add');
  await page.selectOption('#tc-e-provider', 'glm');
  await waitModelOption('#tc-e-model', 'GLM-5.3');
  await page.fill('#tc-e-id', entryId + '-masked');
  await page.selectOption('#tc-e-model', 'GLM-5.3');
  await page.fill('#tc-e-key', 'sk-ab****');
  await page.click('#tc-e-save');
  await page.waitForTimeout(300);
  const maskedMsg = await page.evaluate(() => (document.querySelector('#tc-msg')?.textContent || '').slice(0, 110));
  await page.click('#tc-e-cancel');

  // save card → server
  await page.click('#tc-save');
  await page.waitForTimeout(700);
  const msgAfterSave = await page.evaluate(() => (document.querySelector('#tc-msg')?.textContent || '').slice(0, 110));
  const badge = await page.locator('#tc-badge').textContent();
  await page.screenshot({ path: join(OUT, 'f2-' + tag + '.png'), fullPage: true });

  const out = { rows, toggleObservation, editPrefill, maskedMsg, msgAfterSave, badge };
  say('F2[' + tag + ']: ' + JSON.stringify(out, null, 1));
  await browser.close();
  return out;
}

(async () => {
  // ── daemon security-state assertion (CTO 补针: fail-closed 现态即有效测试) ──
  const noHdr = await fetch('http://127.0.0.1:8711/internal/v1/init/chain/status');
  const body = await noHdr.text();
  say('DAEMON security-state: /internal/* no-header → ' + noHdr.status + ' ' + (body.includes('internal_auth_disabled') ? 'internal_auth_disabled ✓ (fail-closed 现态断言通过)' : body.slice(0, 60)));

  // ── Track A: isolated test server ──
  say('── TRACK A (isolated test server) ──');
  const snapCard = existsSync(CARD) ? readFileSync(CARD, 'utf-8') : null;
  rmSync(CARD, { force: true });
  const port = await freePort();
  const c = await bootServer(port);
  try {
    await entryFlow('http://127.0.0.1:' + port, API_TOKEN, ADMIN_TOKEN, 'trackA', 'f2-a-e1');
    const disk = existsSync(CARD) ? readFileSync(CARD, 'utf-8') : '(absent)';
    say('TrackA disk: plaintext-leak=' + disk.includes('sk-f2-entry-key-0001') + ' cardPresent=' + existsSync(CARD));
    const srv = await fetch('http://127.0.0.1:' + port + '/v1/config/trimmc-card', { headers: { authorization: 'Bearer ' + ADMIN_TOKEN } });
    const sj = await srv.json();
    const entries = sj.card?.provider_entries ?? {};
    say('TrackA server entries: ' + JSON.stringify(Object.keys(entries)) + ' enabled=' + JSON.stringify(Object.values(entries).map((e) => e.enabled)));
  } finally {
    c.kill();
    if (snapCard === null) rmSync(CARD, { force: true }); else writeFileSync(CARD, snapCard);
  }

  // ── Track B: one real-card round with snapshot-restore ──
  say('── TRACK B (real 3333, snapshot-restore) ──');
  if (!realApi || !realAdmin) { say('TrackB SKIPPED: real tokens missing'); }
  else {
    const snapB = existsSync(CARD) ? readFileSync(CARD, 'utf-8') : null;
    rmSync(CARD, { force: true }); // isolate real card for the round
    try {
      await entryFlow('http://127.0.0.1:3333', realApi, realAdmin, 'trackB', 'f2-b-e1');
      const srv = await fetch('http://127.0.0.1:3333/v1/config/trimmc-card', { headers: { authorization: 'Bearer ' + realAdmin } });
      const sj = await srv.json();
      const entries = sj.card?.provider_entries ?? {};
      say('TrackB server entries: ' + JSON.stringify(Object.keys(entries)));
    } finally {
      if (snapB === null) rmSync(CARD, { force: true }); else writeFileSync(CARD, snapB);
      say('TrackB real card restored: ' + (snapB === null ? '(was absent → cleaned)' : 'snapshot restored'));
    }
  }

  writeFileSync(join(OUT, 'f2-log.json'), JSON.stringify(log, null, 1));
  console.log('F2 DONE');
  process.exit(0);
})().catch((e) => { console.error('F2 ABORT:', e.message); process.exit(1); });
