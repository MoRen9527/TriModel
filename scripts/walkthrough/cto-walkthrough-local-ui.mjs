// ── CTO 非作者走查（LG-035 本地侧 web UI；W38 lg-035-local-ui-spec.md I1-I9）──
// 独立脚本：token 从 .env 自读注入（零聊天窗传递）；输出 findings JSON+screenshots。
// 运行：node scripts/cto-walkthrough-local-ui.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.cto-walkthrough');
mkdirSync(OUT, { recursive: true });

// 1. Read tokens from .env (never printed)
const envText = readFileSync(join(HERE, '..', '.env'), 'utf-8');
const envGet = (key) => {
  const m = envText.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
};
const API_TOKEN = envGet('TRIMODEL_API_TOKEN');
const ADMIN_TOKEN = envGet('TRIMODEL_ADMIN_TOKEN');
const findings = { tokens_loaded: { api: !!API_TOKEN, admin: !!ADMIN_TOKEN } };

const { chromium } = await import('playwright-core');

async function launch() {
  // Prefer full chromium cache (1228), fallback to channel: chrome
  const cacheRoot = join(process.env.LOCALAPPDATA, 'ms-playwright');
  const candidates = ['chromium-1228', 'chromium-1200', 'chromium-1194'];
  for (const c of candidates) {
    const p = join(cacheRoot, c, 'chrome-win', 'chrome.exe');
    try { readFileSync(p); return await chromium.launch({ executablePath: p, headless: true }); } catch { /* next */ }
  }
  return await chromium.launch({ channel: 'chrome', headless: true });
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  // I1: first launch — no tokens → connection expanded + guide + domain label visible
  await page.goto('http://127.0.0.1:3333/ui', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  findings.I1 = {
    conn_details_open: await page.evaluate(() => document.querySelector('details')?.open ?? null),
    guide_visible: await page.evaluate(() => {
      const g = document.getElementById('conn-guide');
      return g ? !g.hidden : null;
    }),
    domain_label: await page.evaluate(() => document.getElementById('tc-domain-label')?.textContent?.trim() ?? null),
    panels_disabled: await page.evaluate(() => document.querySelectorAll('.disabled-panel').length),
  };
  await page.screenshot({ path: join(OUT, 'I1-first-launch.png') });

  // I2: connect with real tokens
  await page.fill('#token', API_TOKEN);
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#conn-save');
  await page.waitForTimeout(1500);
  findings.I2 = {
    conn_label: await page.evaluate(() => document.getElementById('conn-label')?.textContent?.trim() ?? null),
    conn_dot_class: await page.evaluate(() => document.getElementById('conn-dot')?.className ?? null),
    panels_disabled_after: await page.evaluate(() => document.querySelectorAll('.disabled-panel').length),
  };
  await page.screenshot({ path: join(OUT, 'I2-connected.png'), fullPage: true });

  // I4-I8: strategy section, domain label, apply button
  findings.I4_I8 = {
    domain_label: await page.evaluate(() => document.getElementById('tc-domain-label')?.textContent?.trim() ?? null),
    strategy_selector_options: await page.evaluate(() => {
      const sel = document.getElementById('tc-strategy-sel');
      return sel ? Array.from(sel.options).map((o) => o.textContent) : null;
    }),
    add_strategy_btn: await page.evaluate(() => !!document.getElementById('tc-str-add')),
    apply_btn_visible: await page.evaluate(() => {
      const b = document.getElementById('tc-apply');
      if (!b) return 'absent';
      return b.hidden ? 'hidden' : 'visible';
    }),
    strategy_table_rows: await page.evaluate(() => document.querySelectorAll('#tc-str-body tr').length),
    entries_rows: await page.evaluate(() => document.querySelectorAll('#tc-entry-body tr').length),
  };

  // I8 full flow: select strategy → switch → save card → apply → verify local.json
  const applyVisible = await page.evaluate(() => {
    const b = document.getElementById('tc-apply');
    return b && !b.hidden;
  });
  if (applyVisible) {
    // 1. select strategy + switch
    const opts = await page.evaluate(() => Array.from(document.getElementById('tc-strategy-sel').options).map((o) => o.value).filter(Boolean));
    if (opts.length > 0) {
      await page.selectOption('#tc-strategy-sel', opts[0]);
      await page.click('#tc-str-switch');
      await page.waitForTimeout(500);
      findings.I8_apply = { switch_msg: await page.evaluate(() => document.getElementById('tc-msg')?.textContent ?? null) };
      // 2. save card
      const connName = await page.evaluate(() => document.getElementById('tc-conn')?.value ?? '');
      if (connName) {
        await page.click('#tc-save');
        await page.waitForTimeout(1500);
        findings.I8_apply.save_msg = await page.evaluate(() => document.getElementById('tc-msg')?.textContent ?? null);
      } else {
        findings.I8_apply.save_msg = 'skipped: no connection name';
      }
    } else {
      findings.I8_apply = { switch_skipped: 'no strategy options' };
    }
    const msgBefore = await page.evaluate(() => document.getElementById('tc-msg')?.textContent ?? '');
    await page.click('#tc-apply');
    await page.waitForTimeout(1500);
    findings.I8_apply = {
      msg_before: msgBefore,
      msg_after: await page.evaluate(() => document.getElementById('tc-msg')?.textContent ?? null),
      apply_btn_text: await page.evaluate(() => document.getElementById('tc-apply')?.textContent?.trim() ?? null),
    };
    // 落盘核：apply 后 policies/local.json 应在（同进程内立即读）
    const { existsSync: ex } = await import('node:fs');
    const polPath = join(HERE, '..', 'policies', 'local.json');
    findings.I8_apply.policy_file_exists = ex(polPath);
    if (ex(polPath)) {
      const { readFileSync: rf } = await import('node:fs');
      findings.I8_apply.policy_schedules = JSON.parse(rf(polPath, 'utf-8')).schedules?.length ?? 0;
    }
  } else {
    findings.I8_apply = { skipped: 'apply button not visible (no active strategy or disabled)' };
  }

  await page.screenshot({ path: join(OUT, 'I8-apply.png'), fullPage: true });
  findings.page_errors = errors;
} catch (err) {
  findings.error = String(err);
} finally {
  await browser.close();
}

writeFileSync(join(OUT, 'findings.json'), JSON.stringify(findings, null, 2), 'utf-8');
console.log(JSON.stringify(findings, null, 2));
