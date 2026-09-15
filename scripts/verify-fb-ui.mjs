// 兜底区真浏览器渲染验证（2026-09-15 任务书；作者自测件——非作者走查=BOD）
// 只读验证：渲染+现状展示+区块独立性。**不点击「还原兜底」**——真机按钮点击会写
// 实际 ~/.claude/settings.json（该动作属 BOD 真机走查面，带真实三值执行）。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.cto-walkthrough');
mkdirSync(OUT, { recursive: true });

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

const findings = {};
try {
  await page.goto('http://127.0.0.1:3333/ui', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  findings.zone_present = await page.locator('#fb-zone').count();
  findings.inputs = await page.evaluate(() => ({
    baseurl: !!document.getElementById('fb-baseurl'),
    key_type: document.getElementById('fb-key')?.type,
    model: !!document.getElementById('fb-model'),
    button: document.getElementById('fb-restore')?.textContent,
  }));
  findings.current_text = (await page.locator('#fb-current').textContent())?.trim();
  findings.zone_disabled = await page.evaluate(() => document.getElementById('fb-zone')?.classList.contains('disabled-panel'));
  findings.button_enabled = await page.evaluate(() => !document.getElementById('fb-restore')?.disabled);
  findings.page_errors = errors;
  await page.screenshot({ path: join(OUT, 'fb-zone-first-launch.png'), fullPage: true });
} catch (err) {
  findings.fatal = String(err);
} finally {
  writeFileSync(join(OUT, 'fb-zone-findings.json'), JSON.stringify(findings, null, 2));
  await browser.close();
}
console.log(JSON.stringify(findings, null, 2));
