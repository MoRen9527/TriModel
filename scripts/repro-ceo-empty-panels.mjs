// ── CEO 空显报障复现（2026-09-14 20:2x 诊断令）──
// 场景 A：空 localStorage（复现 CEO 首开形态）→ 两区读数+截图
// 场景 B：注入 .env 令牌连接（对照组）→ 两区读数+截图
// 判定：A 空 + B 实显 = 数据链健康，空显根因=浏览器令牌缺失+UI 静默不引导。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.cto-walkthrough');
mkdirSync(OUT, { recursive: true });

const envText = readFileSync(join(HERE, '..', '.env'), 'utf-8');
const envGet = (key) => {
  const m = envText.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
};
const API_TOKEN = envGet('TRIMODEL_API_TOKEN');
const ADMIN_TOKEN = envGet('TRIMODEL_ADMIN_TOKEN');

const { chromium } = await import('playwright-core');

async function launch() {
  const cacheRoot = join(process.env.LOCALAPPDATA, 'ms-playwright');
  for (const c of ['chromium-1228', 'chromium-1200', 'chromium-1194']) {
    const p = join(cacheRoot, c, 'chrome-win', 'chrome.exe');
    try { readFileSync(p); return await chromium.launch({ executablePath: p, headless: true }); } catch { /* next */ }
  }
  return await chromium.launch({ channel: 'chrome', headless: true });
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const panelReadings = () => page.evaluate(() => ({
  conn_label: document.getElementById('conn-label')?.textContent ?? null,
  entries_rows: document.querySelectorAll('#tc-entry-body tr').length,
  d10_window_rules_rows: document.querySelectorAll('#tc-wr-body tr').length,
  rules_empty_hint_visible: (() => { const n = document.getElementById('tc-wr-empty'); return n ? !n.hidden : null; })(),
  chips_text: (document.getElementById('tc-chips')?.textContent ?? '').trim().slice(0, 80),
  strategy_options: document.querySelectorAll('#tc-strategy-sel option').length,
  strategy_sel_value: document.getElementById('tc-strategy-sel')?.value ?? null,
  strategy_detail_text: (document.getElementById('tc-str-detail')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  strategy_rules_rows: document.querySelectorAll('#tc-str-rules-body tr').length,
  error_card_visible: (() => { const n = document.getElementById('error-card'); return n ? !n.hidden : null; })(),
  error_card_text: (document.getElementById('error-card')?.textContent ?? '').trim().slice(0, 120),
}));

const findings = {};

try {
  // ── 场景 A：CEO 形态（无令牌）──
  await page.goto('http://127.0.0.1:3333/ui', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  findings.A_no_token = await panelReadings();
  await page.screenshot({ path: join(OUT, 'ceo-repro-A-no-token.png'), fullPage: true });

  // ── 场景 A2：CEO 嫌疑形态（单空：API 令牌在、管理令牌空）──
  await page.evaluate((t) => localStorage.setItem('trimodel_ui_token', t), API_TOKEN);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  findings.A2_api_only = await panelReadings();
  findings.A2_boot_guide = await page.evaluate(() => ({
    conn_settings_open: document.getElementById('conn-settings')?.open ?? null,
    error_card_text_now: (document.getElementById('error-card')?.textContent ?? '').trim().slice(0, 120),
  }));
  await page.screenshot({ path: join(OUT, 'ceo-repro-A2-api-only.png'), fullPage: true });

  // ── 场景 B：注入令牌连接（对照）──
  await page.fill('#token', API_TOKEN);
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#conn-save');
  await page.waitForTimeout(1800);
  findings.B_with_token = await panelReadings();
  findings.B_wr_empty_text = await page.evaluate(() => (document.getElementById('tc-wr-empty')?.textContent ?? '').trim());
  await page.screenshot({ path: join(OUT, 'ceo-repro-B-with-token.png'), fullPage: true });

  findings.page_errors = errors;
} catch (err) {
  findings.fatal = String(err);
} finally {
  writeFileSync(join(OUT, 'ceo-repro-findings.json'), JSON.stringify(findings, null, 2));
  await browser.close();
}
console.log(JSON.stringify(findings, null, 2));
