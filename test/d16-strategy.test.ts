// ── LG-035 增补件5: strategy entity persistence + validation tests ──
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { handlePutTrimmcCard, handleGetTrimmcCard } from '../src/api/trimmc-card.js';

const ADMIN = 'Bearer d16-secret';
process.env.TRIMODEL_ADMIN_TOKEN = 'd16-secret';

function makeCard(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2, machine: { name: 'm' }, connection: { name: 'c' },
    provider_entries: {}, rules: [], deleted_entry_ids: [],
    strategies: {
      s1: { name: '策略一', purpose: '测试', models: ['deepseek-v4-pro'], rules: [{ type: 'window', windows: [{ start: '09:00', end: '18:00' }], model: 'deepseek-v4-pro', priority: 10, enabled: true }], default_model: 'deepseek-v4-pro', enabled: true, created_at: 'x', updated_at: 'x' },
    },
    active_strategy_id: 's1',
    deleted_strategy_ids: [],
    status: { state: 'pending', at: 'x' },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
    ...overrides,
  });
}

describe('增补件5: strategy entity persistence + validation', () => {
  let dir: string;
  const setup = () => { dir = mkdtempSync(join(tmpdir(), 'trimodel-d16-')); };
  const teardown = () => { rmSync(dir, { recursive: true, force: true }); };

  it('①PUT 带策略→GET 读回策略在', async () => {
    setup();
    const cardPath = join(dir, 'c.json');
    const put = handlePutTrimmcCard(ADMIN, makeCard(), { cardPath });
    assert.equal(put.statusCode, 200);
    const get = handleGetTrimmcCard(ADMIN, { cardPath });
    const body = get.body as { card: { strategies: Record<string, { name: string }>, active_strategy_id: string | null } };
    assert.ok(body.card.strategies.s1, '策略 s1 必须在盘');
    assert.equal(body.card.active_strategy_id, 's1');
    teardown();
  });

  it('②active_strategy_id 悬挂→400 人话', async () => {
    setup();
    const cardPath = join(dir, 'c.json');
    const doc = JSON.parse(makeCard());
    doc.active_strategy_id = 'ghost';
    const put = handlePutTrimmcCard(ADMIN, JSON.stringify(doc), { cardPath });
    assert.equal(put.statusCode, 400);
    assert.ok(JSON.stringify(put.body).includes('引用的策略不存在'));
    teardown();
  });

  it('③deleted_strategy_ids 含 active→400 人话', async () => {
    setup();
    const cardPath = join(dir, 'c.json');
    const doc = JSON.parse(makeCard());
    doc.deleted_strategy_ids = ['s1'];
    const put = handlePutTrimmcCard(ADMIN, JSON.stringify(doc), { cardPath });
    assert.equal(put.statusCode, 400);
    assert.ok(JSON.stringify(put.body).includes('当前策略不可删除'));
    teardown();
  });
});
