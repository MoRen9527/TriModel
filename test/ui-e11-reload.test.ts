// ── LG-035 D16: default-model load backfill assertions ──
// Covers: loadTrimmc backfills #tc-default-model from card.default_model;
// absent card → empty selection (回落引擎默认 placeholder visible).
// Uses jsdom with the real UI; fetch stubbed via the same harness pattern as
// test/ui-boot.test.ts (independent stub to keep this file self-contained).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
}

function bootUiWithCard(card: unknown | null): { dom: JSDOM; d: Document } {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => { /* drain */ });
  const dom = new JSDOM(readFileSync(UI_PATH, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:3333/ui',
    virtualConsole: vc,
    beforeParse(window: import("jsdom").DOMWindow) {
      window.localStorage.setItem('trimodel_ui_token', 'tk-d16');
      window.localStorage.setItem('trimodel_ui_admin_token', 'ta-d16');
      window.fetch = (async (url: string, _init?: string) => {
        const u = url;
        let body: Record<string, unknown> = {};
        if (u.includes('/v1/models')) {
          body = { object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'GLM-5.3-Flash' }, { id: 'GLM-5.3' }, { id: 'TMV' }] };
        } else if (u.includes('/v1/config/policy')) {
          body = { object: 'config.policy', policy: { version: '1', schedules: [] }, effective: { model: 'deepseek-v4-pro', source: 'env-default', matched_schedule_id: null } };
        } else if (u.includes('/v1/config/keys')) {
          body = { object: 'config.keys', keys: {}, default_model: 'deepseek-v4-pro', refresh_interval_s: 900, expires_at: 'x' };
        } else if (u.includes('/trimmc-card')) {
          body = { object: 'x', card_file_present: card !== null, card, entries_masked: {} };
        }
        return { status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() } as unknown as Response;
      }) as typeof window.fetch;
    },
  });
  return { dom, d: dom.window.document };
}

describe('D16: default-model load backfill', () => {
  it('card with default_model → dropdown selects it after load', async () => {
    const card = { version: 4, machine: { name: 'm' }, connection: { name: 'c' }, provider_entries: {}, model_sets: {}, rules: {}, strategies: {}, active_strategy_id: null, default_model: 'GLM-5.3', status: { state: 'applied', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null } };
    const { dom, d } = bootUiWithCard(card);
    // jsdom 异步加载时序：等待 boot+refreshAll 的 fetch 链 resolve（轮询条件化，
    // 禁固定 sleep——竞态确定性）
    await waitFor(() => (d.getElementById('tc-default-model') as HTMLSelectElement).value !== '', 3000);
    const sel = d.getElementById('tc-default-model') as HTMLSelectElement;
    console.log('[D16dbg] options =', sel.options.length, '| selectedValue =', JSON.stringify(sel.value), '| selectedIndex =', sel.selectedIndex, '| allValues =', JSON.stringify(Array.from(sel.options).map((o) => o.value)));
    assert.equal(sel.value, 'GLM-5.3', '载入后默认模型字段必须回填卡值');
    dom.window.close();
  });

  it('absent card → dropdown falls back to the empty selection (回落引擎默认)', async () => {
    const { dom, d } = bootUiWithCard(null);
    await new Promise((r) => setTimeout(r, 150));
    const sel = d.getElementById('tc-default-model') as HTMLSelectElement;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sel.value, '', '无卡时默认模型字段必须为空选');
    assert.ok((d.getElementById('tc-conn') as HTMLInputElement).value === '', '连接名同样不回填（无卡）');
    dom.window.close();
  });
});
