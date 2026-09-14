// ── D16→层2 段A: 默认模型编辑面退役回归（v4：default_model=派生缓存，归 default 规则实体）──
// 原案（下拉回填）随编辑面退役销项：终稿 §一「default_model 派生缓存：apply 时自
// 活动策略 default 规则同步；真源=规则实体，无编辑面」。本件断言退役零残留。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_PATH = resolve(HERE, '..', 'ui', 'index.html');

describe('层2 段A: 默认模型编辑面退役回归', () => {
  it('UI 零 #tc-default-model / #tc-s-default 编辑面（v4 派生缓存无编辑面）', () => {
    const html = readFileSync(UI_PATH, 'utf-8');
    assert.equal(html.includes('id="tc-default-model"'), false, '默认模型下拉（策略区）已退役');
    assert.equal(html.includes('id="tc-s-default"'), false, '默认模型下拉（表单内）已退役');
    assert.equal(html.includes('tcFillDefaultModelSelect'), false, '填充函数零残留');
  });

  it('boot 对无卡/v4 卡均不因退役字段崩（jsdom 冒烟）', async () => {
    const html = readFileSync(UI_PATH, 'utf-8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:3333/ui',
      runScripts: 'dangerously',
      beforeParse(window) {
        window.localStorage.setItem('trimodel_ui_token', 'tk-api');
        window.localStorage.setItem('trimodel_ui_admin_token', 'tk-admin');
        const card = { version: 4, machine: { name: 'm' }, connection: { name: 'c' }, provider_entries: {}, model_sets: {}, rules: {}, strategies: {}, active_strategy_id: null, default_model: 'GLM-5.3', status: { state: 'applied', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null } };
        window.fetch = (async (url: string) => {
          let body: Record<string, unknown> = {};
          if (url.includes('/v1/models')) body = { object: 'list', data: [] };
          else if (url.includes('/v1/config/policy')) body = { object: 'config.policy', policy: { version: '1', schedules: [] }, effective: { model: 'deepseek-v4-pro', source: 'env-default', matched_schedule_id: null } };
          else if (url.includes('/v1/config/keys')) body = { object: 'config.keys', keys: {}, default_model: 'deepseek-v4-pro', refresh_interval_s: 900, expires_at: 'x' };
          else if (url.includes('/trimmc-card')) body = { object: 'x', card_file_present: true, card, entries_masked: {} };
          return { status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() } as unknown as Response;
        }) as typeof window.fetch;
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    const d = dom.window.document;
    assert.ok(d.getElementById('tc-conn'), '页面存活（boot 链无崩）');
    assert.equal((d.getElementById('tc-conn') as HTMLInputElement).value, 'c', '连接名回填（v4 卡正常读取）');
    dom.window.close();
  });
});
