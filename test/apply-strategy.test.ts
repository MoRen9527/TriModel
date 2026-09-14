// ── LG-035 本地侧 (2026-09-14): 应用到本机 handler tests（v4 三实体形态）──
// Covers: no-card 404 / no-active-strategy 400 / ghost-strategy 400 /
// 纯 quota 不可应用 400 / happy path（time→schedules + default→卡缓存同步 +
// quota 计数不进 schedules）/ 幂等 / 鉴权 / v3 卡迁移入态自动升格链。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { handleApplyStrategy } from '../src/api/trimmc-card.js';
import { loadCard, emptyCard, saveCard } from '../src/trimmc-card.js';
import { setPoliciesDirForTest, DEFAULT_MACHINE, policyPathForMachine } from '../src/policy.js';

const ADMIN = 'Bearer local-apply-secret';
process.env.TRIMODEL_ADMIN_TOKEN = 'local-apply-secret';

/** v4 种子卡：三实体引用式（2 time + 1 default + 1 quota，混合策略）。 */
function seedCardV4(cardPath: string, overrides: Record<string, unknown> = {}): void {
  const card = {
    ...emptyCard('本机'),
    provider_entries: {
      eds: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' },
      eglm: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' },
    },
    model_sets: {
      ms1: { name: '主集', entry_ids: ['eds', 'eglm'], created_at: 'x', updated_at: 'x' },
    },
    rules: {
      r_day: { name: '白天', type: 'time', enabled: true, windows: [{ start: '14:00', end: '18:00', entry_id: 'eds' }], created_at: 'x', updated_at: 'x' },
      r_eve: { name: '晚间', type: 'time', enabled: true, windows: [{ start: '18:00', end: '23:59', entry_id: 'eglm' }, { start: '00:00', end: '06:00', entry_id: 'eglm' }], created_at: 'x', updated_at: 'x' },
      r_def: { name: '默认', type: 'default', enabled: true, entry_id: 'eglm', created_at: 'x', updated_at: 'x' },
      r_q: { name: '额度兜底', type: 'quota', enabled: true, watch_entry_id: 'eds', fallback_ids: ['eglm'], created_at: 'x', updated_at: 'x' },
    },
    strategies: {
      s1: { name: '工作时段', purpose: '闲时用 glm 忙时用 deepseek', model_set_id: 'ms1', rule_ids: ['r_day', 'r_eve', 'r_def', 'r_q'], created_at: 'x', updated_at: 'x' },
    },
    active_strategy_id: 's1',
    ...overrides,
  };
  saveCard(card as never, cardPath);
}

describe('本地侧: 应用到本机 (handleApplyStrategy, v4)', () => {
  let dir: string;
  let policiesDir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'trimodel-apply-test-'));
    policiesDir = join(dir, 'policies');
    setPoliciesDirForTest(policiesDir);
  });
  after(() => {
    setPoliciesDirForTest(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('无卡 → 404 人话', () => {
    const r = handleApplyStrategy(ADMIN, { cardPath: join(dir, 'missing', 'c.json') });
    assert.equal(r.statusCode, 404);
    assert.ok(JSON.stringify(r.body).includes('暂无卡片配置'));
  });

  it('有卡无活动策略 → 400 人话', () => {
    const cardPath = join(dir, 'no-active.json');
    seedCardV4(cardPath, { active_strategy_id: null });
    const r = handleApplyStrategy(ADMIN, { cardPath });
    assert.equal(r.statusCode, 400);
    assert.ok(JSON.stringify(r.body).includes('未选择活动策略'));
  });

  it('活动策略悬挂 → 400 人话', () => {
    const cardPath = join(dir, 'ghost.json');
    seedCardV4(cardPath, { active_strategy_id: 'ghost' });
    const r = handleApplyStrategy(ADMIN, { cardPath });
    assert.equal(r.statusCode, 400);
    assert.ok(JSON.stringify(r.body).includes('活动策略不存在'));
  });

  it('纯 quota 策略不可应用 → 400 人话（硬门：≥1 time 或 default）', () => {
    const cardPath = join(dir, 'quota-only.json');
    seedCardV4(cardPath, { strategies: { s1: { name: '纯额度', model_set_id: 'ms1', rule_ids: ['r_q'], created_at: 'x', updated_at: 'x' } } });
    const r = handleApplyStrategy(ADMIN, { cardPath });
    assert.equal(r.statusCode, 400);
    assert.ok(JSON.stringify(r.body).includes('暂无可应用的规则'));
  });

  it('正常路径：time→schedules（id=strategy:<pid>:<rid>、priority 归一）+ default→卡缓存 + quota 计数不进 schedules', () => {
    const cardPath = join(dir, 'happy.json');
    seedCardV4(cardPath);
    const r = handleApplyStrategy(ADMIN, { cardPath });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
    const applied = (r.body as { applied: { schedules: number; default_model: string | null; quota_rules: number } }).applied;
    assert.equal(applied.schedules, 3, '窗级展开：r_day 1 窗+r_eve 2 窗 → 3 schedules（每窗一条）');
    assert.equal(applied.default_model, 'GLM-5.3', 'default 实体 → 模型名');
    assert.equal(applied.quota_rules, 1, 'quota 计数=1');

    const policyPath = policyPathForMachine(DEFAULT_MACHINE);
    assert.equal(policyPath, join(policiesDir, 'local.json'));
    assert.ok(existsSync(policyPath), 'policies/local.json 必须落盘');
    const doc = JSON.parse(readFileSync(policyPath, 'utf-8')) as { version: string; schedules: Array<{ id: string; model: string; windows: Array<{ start: string; end: string }>; priority: number; type: string; enabled: boolean }> };
    assert.equal(doc.schedules.length, 3);
    assert.ok(doc.schedules.every((s) => /^strategy:s1:r_\w+:\d+$/.test(s.id)), `id 形态=strategy:<pid>:<rid>（实际 ${doc.schedules.map((s) => s.id).join(',')}）`);
    assert.ok(doc.schedules.every((s) => s.priority === 100), 'priority 归一 100');
    const day = doc.schedules.find((s) => s.model === 'deepseek-v4-pro')!;
    assert.equal(day.windows.length, 1);
    assert.equal(day.windows[0].start, '14:00');
    assert.equal(day.windows[0].end, '18:00');
    assert.equal(doc.schedules.filter((s) => s.model === 'GLM-5.3').length, 2, '窗级展开：r_eve 2 窗 → 2 个各 1 窗的 schedules');

    // 卡 default_model 派生缓存同步（default 实体 eglm→GLM-5.3）
    const card = loadCard(cardPath);
    assert.equal(card?.default_model, 'GLM-5.3');
  });

  it('v3 卡迁移入态：loadCard 自动升格 v4 → apply 可用（迁移+应用直通链）', () => {
    const cardPath = join(dir, 'v3-in.json');
    const legacy = {
      version: 2,
      machine: { name: 'm' },
      connection: { name: '本机' },
      provider_entries: {
        eds: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' },
        eglm: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' },
      },
      rules: [],
      strategies: {
        sold: {
          name: '旧策略', purpose: '', models: ['deepseek-v4-pro', 'GLM-5.3'],
          rules: [
            { type: 'window', windows: [{ start: '14:00', end: '18:00' }], model: 'deepseek-v4-pro', priority: 100, enabled: true },
            { type: 'window', windows: [{ start: '18:00', end: '23:59' }], model: 'GLM-5.3', priority: 50, enabled: true },
          ],
          default_model: 'GLM-5.3', enabled: true, created_at: 'x', updated_at: 'x',
        },
      },
      active_strategy_id: 'sold',
      status: { state: 'applied', at: 'x' },
      reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
    saveCard(legacy as never, cardPath);
    const r = handleApplyStrategy(ADMIN, { cardPath });
    assert.equal(r.statusCode, 200);
    const applied = (r.body as { applied: { schedules: number; default_model: string | null } }).applied;
    assert.equal(applied.schedules, 2, 'v3 两窗内嵌 → 1 条 time 实体（全窗归一）→ 2 schedules（每窗一条）');
    assert.equal(applied.default_model, 'GLM-5.3');
    const migrated = loadCard(cardPath);
    assert.equal(migrated?.version, 4, '迁移后盘上卡=v4');
  });

  it('幂等：重复 apply 结果一致', () => {
    const cardPath = join(dir, 'idem.json');
    seedCardV4(cardPath);
    const r1 = handleApplyStrategy(ADMIN, { cardPath });
    const r2 = handleApplyStrategy(ADMIN, { cardPath });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    const doc = JSON.parse(readFileSync(policyPathForMachine(DEFAULT_MACHINE), 'utf-8')) as { schedules: unknown[] };
    assert.equal(doc.schedules.length, 3);
  });

  it('鉴权：错 token → 401', () => {
    const cardPath = join(dir, 'auth.json');
    seedCardV4(cardPath);
    assert.equal(handleApplyStrategy('Bearer wrong', { cardPath }).statusCode, 401);
  });
});
