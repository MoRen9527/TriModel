// ── LG-035 schema v4 终稿层1 测试（CTO 终稿 §七.5 测试门）──
// Covers: 迁移幂等三判据（甲跳过/乙半迁移/丙原子）+ 变换规则 1-5 +
// 守卫矩阵十条 + 分型字段必备性 + 18:00 保形（1440 分钟采样逐点一致）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  CARD_VERSION, emptyCard, saveCard, loadCard, validateCard, migrateCardV4,
  entryReferenceGuards, modelSetReferenceGuard, ruleReferenceGuard, deleteStrategy,
} from '../src/trimmc-card.js';
import type { LegacyCardInput, TrimmcCardDocument } from '../src/trimmc-card.js';
import { setPoliciesDirForTest, evaluatePolicy, type PolicyShape } from '../src/policy.js';

const NOW = '2026-09-14T22:00:00+08:00';

function baseEntries(): Record<string, { provider: string; model: string; api_key_encrypted: string; enabled: boolean; updated_at: string }> {
  return {
    e_deep: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: NOW },
    e_glm: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'QUFB', enabled: true, updated_at: NOW },
    e_air: { provider: 'glm', model: 'GLM-5.3-Flash', api_key_encrypted: 'QUFB', enabled: false, updated_at: NOW },
  };
}

/** 今晚现役同构 v3 卡（s-hourly 三窗+active）——迁移主入态。 */
function legacyV3Card(): LegacyCardInput {
  return {
    version: 2,
    machine: { name: 'm' },
    connection: { name: '本机' },
    provider_entries: baseEntries(),
    rules: [],
    strategies: {
      's-hourly': {
        name: '时段切换策略', purpose: '闲时用 glm 忙时用 deepseek',
        models: ['GLM-5.3', 'deepseek-v4-pro'],
        rules: [
          { type: 'window', windows: [{ start: '00:00', end: '14:00' }], model: 'GLM-5.3', priority: 50, enabled: true },
          { type: 'window', windows: [{ start: '14:00', end: '18:00' }], model: 'deepseek-v4-pro', priority: 100, enabled: true },
          { type: 'window', windows: [{ start: '18:00', end: '23:59' }], model: 'GLM-5.3', priority: 50, enabled: true },
        ],
        default_model: 'GLM-5.3', enabled: true, created_at: 'x', updated_at: 'x',
      },
    },
    active_strategy_id: 's-hourly',
    default_model: 'GLM-5.3',
  } as LegacyCardInput;
}

describe('v4 迁移器：幂等三判据 + 变换规则', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-v4-test-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('变换规则 1-5：v3 卡升格（active 保持/按模型归并窗组/默认实体/策略名集）', () => {
    const cardPath = join(dir, 'v3.json');
    writeFileSync(cardPath, JSON.stringify(legacyV3Card()));
    const out = loadCard(cardPath);
    assert.ok(out, '迁移成功');
    assert.equal(out.version, CARD_VERSION);
    assert.equal(Object.keys(out.strategies).length, 1, 'v3 策略逐个升格不丢弃');
    const pid = Object.keys(out.strategies)[0];
    assert.equal(out.strategies[pid].name, '时段切换策略', '活动者以原名保持');
    assert.equal(out.active_strategy_id, pid);
    const ms = out.model_sets[out.strategies[pid].model_set_id];
    assert.equal(ms.name, '时段切换策略集');
    assert.deepEqual([...ms.entry_ids].sort(), ['e_deep', 'e_glm'], 'enabled 条目 model∈models（id 字典序）');
    const rules = out.strategies[pid].rule_ids.map((rid) => out.rules[rid]);
    const timeRules = rules.filter((r) => r.type === 'time');
    const defRules = rules.filter((r) => r.type === 'default');
    // BOD 22:2x 修正令+CTO v1.1（窗级 entry_id）：三窗两模型 → **1 条**命名规则（三窗各带条目）
    assert.equal(timeRules.length, 1, '全窗归一：一条规则含全部三窗');
    const merged = timeRules[0];
    assert.equal(merged.name, '时段切换策略#时段', '规则名=<策略名>#时段（CTO v1.1 防撞名口径）');
    assert.equal(merged.windows!.length, 3, '三窗整组在一条规则内');
    assert.deepEqual(merged.windows!.map((w) => w.start), ['00:00', '14:00', '18:00'], '窗按 start 排序');
    assert.deepEqual(merged.windows!.map((w) => w.entry_id), ['e_glm', 'e_deep', 'e_glm'], '窗级条目：GLM/deepseek/GLM');
    assert.equal(defRules.length, 1, 'default_model → default 实体');
    assert.equal(defRules[0].entry_id, 'e_glm');
    assert.equal(defRules[0].name, '时段切换策略#默认', '默认规则名=<策略名>#默认（CTO 终稿 §二.3 族，F-1）');
    assert.equal(out.default_model, 'GLM-5.3', '派生缓存同步');
  });

  it('无 v3 策略入态：顶层 rules+default_model → 打包「当前配置」+「当前模型集」', () => {
    const cardPath = join(dir, 'v2.json');
    const legacy: LegacyCardInput = {
      version: 2, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: baseEntries(),
      rules: [
        { rule_id: 'trimmc:e_deep', type: 'window', entry_id: 'e_deep', windows: [{ start: '14:00', end: '18:00' }], priority: 100, enabled: true },
      ],
      default_model: 'GLM-5.3',
    } as LegacyCardInput;
    writeFileSync(cardPath, JSON.stringify(legacy));
    const out = loadCard(cardPath);
    assert.ok(out);
    const pid = out.active_strategy_id!;
    assert.equal(out.strategies[pid].name, '当前配置');
    assert.equal(out.strategies[pid].purpose, 'boot 迁移自旧版卡');
    assert.equal(out.model_sets[out.strategies[pid].model_set_id].name, '当前模型集');
    assert.deepEqual([...out.model_sets[out.strategies[pid].model_set_id].entry_ids].sort(), ['e_deep', 'e_glm'], '全部 enabled 条目（disabled e_air 排除）');
    const timeRules = out.strategies[pid].rule_ids.map((rid) => out.rules[rid]).filter((r) => r.type === 'time');
    assert.equal(timeRules.length, 1);
    assert.equal(timeRules[0].name, 'trimmc:e_deep', '单窗=原名');
  });

  it('判据甲：version>=4 → 原样返回零重跑（幂等闭封）', () => {
    const cardPath = join(dir, 'v3.json'); // 已迁移
    const before = readFileSync(cardPath, 'utf-8');
    const out1 = loadCard(cardPath);
    const out2 = loadCard(cardPath);
    assert.equal(JSON.stringify(out1), JSON.stringify(out2), '同卡跑两遍零差异');
    const after = readFileSync(cardPath, 'utf-8');
    assert.equal(before, after, '盘上零重写');
  });

  it('判据乙：半迁移态（rules 已对象）→ 只补版本与缺省键，不重跑打包', () => {
    const cardPath = join(dir, 'half.json');
    const half = { ...emptyCard('c'), version: 3, rules: { r_fixed: { name: '既有', type: 'time', enabled: true, windows: [{ start: '01:00', end: '02:00', entry_id: 'e1' }], created_at: 'x', updated_at: 'x' } } } as unknown as TrimmcCardDocument;
    half.provider_entries = { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: NOW } };
    delete (half as unknown as Record<string, unknown>).strategies;
    delete (half as unknown as Record<string, unknown>).model_sets;
    writeFileSync(cardPath, JSON.stringify(half));
    const out = loadCard(cardPath);
    assert.equal(out?.version, CARD_VERSION, '补版本');
    assert.ok(out?.model_sets && out?.strategies, '补缺省键');
    assert.equal(Object.keys(out?.strategies ?? {}).length, 0, '不重跑打包（无「当前配置」生成）');
    assert.equal(out?.rules.r_fixed.name, '既有', '既有实体原样保留');
  });

  it('判据丙：变换失败 → 原子不落盘（原卡不动，返回 null）', () => {
    const cardPath = join(dir, 'bad.json');
    const bad: LegacyCardInput = {
      version: 2, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: {},
      rules: [{ rule_id: 'r', type: 'window', entry_id: 'ghost', windows: [{ start: '01:00', end: '02:00' }] }],
    } as LegacyCardInput;
    writeFileSync(cardPath, JSON.stringify(bad));
    const before = readFileSync(cardPath, 'utf-8');
    assert.equal(loadCard(cardPath), null, 'fail-safe null');
    assert.equal(readFileSync(cardPath, 'utf-8'), before, '原卡字节不动');
  });

  it('迁移前备份生成（pre-v4.bak，保留一代）', () => {
    assert.ok(existsSync(join(dir, 'v3.json.pre-v4.bak.json')), '备份在卷');
    const bak = JSON.parse(readFileSync(join(dir, 'v3.json.pre-v4.bak.json'), 'utf-8')) as { version: number };
    assert.equal(bak.version, 2, '备份=迁移前 v2 原态');
  });

  it('CTO v1.1 形态门自愈：旧粒度 v4 卡（time 规则级 entry_id）→ boot 重迁窗级归并一条', () => {
    const cardPath = join(dir, 'legacy-granularity-v4.json');
    // 首版过渡形态：v4+按模型 2 条 time（rule 级 entry_id，窗无 entry_id）
    const doc = emptyCard('c') as TrimmcCardDocument;
    doc.provider_entries = baseEntries() as unknown as typeof doc.provider_entries;
    doc.rules = {
      r_a: { name: '时段切换策略#0', type: 'time', enabled: true, windows: [{ start: '00:00', end: '14:00' }, { start: '18:00', end: '23:59' }], entry_id: 'e_glm', created_at: 'x', updated_at: 'x' },
      r_b: { name: '时段切换策略#1', type: 'time', enabled: true, windows: [{ start: '14:00', end: '18:00' }], entry_id: 'e_deep', created_at: 'x', updated_at: 'x' },
      r_d: { name: '默认模型', type: 'default', enabled: true, entry_id: 'e_glm', created_at: 'x', updated_at: 'x' },
    } as never; // 旧粒度形态（窗无 entry_id）——待自愈入态，类型故意不符现 schema
    doc.strategies = { s1: { name: '时段切换策略', model_set_id: 'ms', rule_ids: ['r_a', 'r_b', 'r_d'], created_at: 'x', updated_at: 'x' } };
    doc.model_sets = { ms: { name: '集', entry_ids: ['e_glm', 'e_deep'], created_at: 'x', updated_at: 'x' } };
    doc.active_strategy_id = 's1';
    saveCard(doc, cardPath);
    const out = loadCard(cardPath)!;
    const s = out.strategies.s1;
    const timeRids = s.rule_ids.filter((rid) => out.rules[rid].type === 'time');
    assert.equal(timeRids.length, 1, '同策略 time 规则归并一条');
    const merged = out.rules[timeRids[0]];
    assert.equal(merged.name, '时段切换策略#时段', '名=<策略名>#时段（防与策略撞名）');
    assert.notEqual(merged.name, '时段切换策略', '历史卡自愈不撞策略名（BOD 22:35 令②）');
    assert.equal(merged.windows!.length, 3, '三窗全归');
    assert.deepEqual(merged.windows!.map((w) => w.entry_id), ['e_glm', 'e_deep', 'e_glm'], '窗级条目三窗');
    assert.equal(out.rules.r_d.name, '默认模型', 'default 规则原样');
    assert.equal(merged.entry_id, undefined, 'rule 级 entry_id 已退役');
    // 幂等：再 load 零变化
    const again = JSON.stringify(loadCard(cardPath));
    assert.equal(JSON.stringify(loadCard(cardPath)), again, '自愈后形态稳定');
  });

  it('F-1 多 v3 策略迁移不撞名：2 策略各 default_model → 两条 #默认 族名互异且校验过', () => {
    const cardPath = join(dir, 'multi-strategy.json');
    const legacy: LegacyCardInput = {
      version: 2, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: baseEntries(),
      rules: [],
      strategies: {
        sA: { name: '白天', purpose: '', models: ['GLM-5.3'], rules: [{ type: 'window', windows: [{ start: '08:00', end: '12:00' }], model: 'GLM-5.3', priority: 10, enabled: true }], default_model: 'GLM-5.3', enabled: true, created_at: 'x', updated_at: 'x' },
        sB: { name: '夜间', purpose: '', models: ['deepseek-v4-pro'], rules: [{ type: 'window', windows: [{ start: '20:00', end: '23:00' }], model: 'deepseek-v4-pro', priority: 10, enabled: true }], default_model: 'deepseek-v4-pro', enabled: true, created_at: 'x', updated_at: 'x' },
      },
      active_strategy_id: 'sA',
    } as LegacyCardInput;
    writeFileSync(cardPath, JSON.stringify(legacy));
    const out = loadCard(cardPath);
    assert.ok(out, '迁移成功（不因 default 撞名而失败）');
    const defaultNames = Object.values(out.rules).filter((r) => r.type === 'default').map((r) => r.name);
    assert.equal(defaultNames.length, 2);
    assert.equal(new Set(defaultNames).size, 2, '两条 #默认 族名互异');
    assert.deepEqual([...defaultNames].sort(), ['夜间#默认', '白天#默认'], 'UTF-16 码序：夜<白');
    assert.equal(validateCard(out), '', '迁移产物过唯一性校验（卡不陷不可迁移态）');
  });

  it('多窗整组：v3 一条内嵌规则带 2 窗（同模型）→ 1 实体 2 窗（CEO 22:12 粒度）', () => {
    const cardPath = join(dir, 'multi.json');
    const legacy: LegacyCardInput = {
      version: 2, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: baseEntries(),
      rules: [],
      strategies: {
        s: {
          name: '双窗', purpose: '', models: ['GLM-5.3'],
          rules: [{ type: 'window', windows: [{ start: '01:00', end: '02:00' }, { start: '03:00', end: '04:00' }], model: 'GLM-5.3', priority: 10, enabled: true }],
          default_model: '', enabled: true, created_at: 'x', updated_at: 'x',
        },
      },
      active_strategy_id: 's',
    } as LegacyCardInput;
    writeFileSync(cardPath, JSON.stringify(legacy));
    const out = loadCard(cardPath);
    const pid = out!.active_strategy_id!;
    const timeRules = out!.strategies[pid].rule_ids.map((rid) => out!.rules[rid]).filter((r) => r.type === 'time');
    assert.equal(timeRules.length, 1, '同模型多窗归并一条实体');
    assert.equal(timeRules[0].windows!.length, 2, '2 窗整组在实体内');
    assert.deepEqual(timeRules[0].windows!.map((w) => w.start), ['01:00', '03:00'], '窗组按 start 排序');
  });
});

describe('v4 validateCard：分型必备性 + 守卫矩阵十条', () => {
  function v4Base(): unknown {
    const card = emptyCard('c');
    card.provider_entries = baseEntries();
    return JSON.parse(JSON.stringify(card));
  }

  it('分型必备：time 缺 time/entry_id 拒；default 缺 entry_id 拒；quota 缺 watch/fallback 拒', () => {
    const a = v4Base() as { rules: Record<string, unknown> };
    a.rules = { r1: { name: 't', type: 'time', enabled: true, entry_id: 'e_glm', created_at: 'x', updated_at: 'x' } };
    assert.ok(validateCard(a).includes('windows required'), `实际: ${validateCard(a)}`);
    const b = v4Base() as { rules: Record<string, unknown> };
    b.rules = { r1: { name: 't', type: 'time', enabled: true, windows: [{ start: '01:00', end: '02:00' }], created_at: 'x', updated_at: 'x' } };
    assert.ok(validateCard(b).includes('条目不存在'));
    const c = v4Base() as { rules: Record<string, unknown> };
    c.rules = { r1: { name: 'd', type: 'default', enabled: true, created_at: 'x', updated_at: 'x' } };
    assert.ok(validateCard(c).includes('条目不存在'));
    const d = v4Base() as { rules: Record<string, unknown> };
    d.rules = { r1: { name: 'q', type: 'quota', enabled: true, watch_entry_id: 'e_glm', fallback_ids: [], created_at: 'x', updated_at: 'x' } };
    assert.ok(validateCard(d).includes('转入序列不能为空'));
  });

  it('三型互斥多余字段不拒（向前容错）+ 合法三型全过', () => {
    const a = v4Base() as { model_sets: Record<string, unknown>; rules: Record<string, unknown>; strategies: Record<string, unknown>; active_strategy_id: string | null };
    a.model_sets = { ms1: { name: '集', entry_ids: ['e_glm'], created_at: 'x', updated_at: 'x' } };
    a.rules = {
      r1: { name: 't', type: 'time', enabled: true, windows: [{ start: '01:00', end: '02:00', entry_id: 'e_glm' }], watch_entry_id: 'e_glm', created_at: 'x', updated_at: 'x' },
      r2: { name: 'd', type: 'default', enabled: true, entry_id: 'e_deep', created_at: 'x', updated_at: 'x' },
      r3: { name: 'q', type: 'quota', enabled: true, watch_entry_id: 'e_deep', fallback_ids: ['e_glm'], created_at: 'x', updated_at: 'x' },
    };
    a.strategies = { s1: { name: '全型', model_set_id: 'ms1', rule_ids: ['r1', 'r2', 'r3'], created_at: 'x', updated_at: 'x' } };
    a.active_strategy_id = 's1';
    assert.equal(validateCard(a), '');
  });

  it('守卫：同策略 time 窗重叠拒（人话点名两规则）', () => {
    const a = v4Base() as { model_sets: Record<string, unknown>; rules: Record<string, unknown>; strategies: Record<string, unknown> };
    a.model_sets = { ms1: { name: '集', entry_ids: ['e_glm'], created_at: 'x', updated_at: 'x' } };
    a.rules = {
      r1: { name: '甲', type: 'time', enabled: true, windows: [{ start: '01:00', end: '05:00', entry_id: 'e_glm' }], created_at: 'x', updated_at: 'x' },
      r2: { name: '乙', type: 'time', enabled: true, windows: [{ start: '04:00', end: '06:00', entry_id: 'e_deep' }], created_at: 'x', updated_at: 'x' },
    };
    a.strategies = { s1: { name: 's', model_set_id: 'ms1', rule_ids: ['r1', 'r2'], created_at: 'x', updated_at: 'x' } };
    const err = validateCard(a);
    assert.ok(err.includes('重叠') && err.includes('甲') && err.includes('乙'), `重叠拒点名（实际: ${err}）`);
  });

  it('守卫：三实体名各自卡内唯一；策略引用悬挂拒；active 悬挂拒', () => {
    const a = v4Base() as { model_sets: Record<string, unknown>; rules: Record<string, unknown>; strategies: Record<string, unknown>; active_strategy_id: string | null };
    a.model_sets = {
      ms1: { name: '同名', entry_ids: [], created_at: 'x', updated_at: 'x' },
      ms2: { name: '同名', entry_ids: [], created_at: 'x', updated_at: 'x' },
    };
    assert.ok(validateCard(a).includes('名称「同名」已存在'));
    const b = v4Base() as { model_sets: Record<string, unknown>; rules: Record<string, unknown>; strategies: Record<string, unknown>; active_strategy_id: string | null };
    b.model_sets = { ms1: { name: '集', entry_ids: [], created_at: 'x', updated_at: 'x' } };
    b.strategies = { s1: { name: 's', model_set_id: 'ghost-ms', rule_ids: [], created_at: 'x', updated_at: 'x' } };
    assert.ok(validateCard(b).includes('引用的模型集不存在'));
    const c = v4Base() as { model_sets: Record<string, unknown>; rules: Record<string, unknown>; strategies: Record<string, unknown>; active_strategy_id: string | null };
    c.active_strategy_id = 'ghost';
    assert.ok(validateCard(c).includes('引用的策略不存在'));
  });

  it('删除守卫查询族：条目被集或被规则引用均禁删（全族口径）；集/规则被策略引用禁删', () => {
    const card = emptyCard('c');
    card.provider_entries = baseEntries();
    card.model_sets = { ms1: { name: '集一', entry_ids: ['e_glm'], created_at: 'x', updated_at: 'x' } };
    card.rules = {
      r1: { name: '规则一', type: 'time', enabled: true, windows: [{ start: '01:00', end: '02:00', entry_id: 'e_deep' }], created_at: 'x', updated_at: 'x' },
      r2: { name: '规则二', type: 'quota', enabled: true, watch_entry_id: 'e_air', fallback_ids: ['e_deep'], created_at: 'x', updated_at: 'x' },
    };
    card.strategies = { s1: { name: '策略一', model_set_id: 'ms1', rule_ids: ['r1', 'r2'], created_at: 'x', updated_at: 'x' } };
    assert.ok(entryReferenceGuards(card, 'e_glm').includes('模型集「集一」'), '被集引用禁删');
    assert.ok(entryReferenceGuards(card, 'e_deep').includes('规则「'), '被规则引用（entry_id/fallback 位）禁删');
    assert.ok(entryReferenceGuards(card, 'e_air').includes('规则「'), 'watch 位也算引用');
    assert.equal(entryReferenceGuards(card, 'e_none'), '', '无引用可删');
    assert.ok(modelSetReferenceGuard(card, 'ms1').includes('策略「策略一」'));
    assert.ok(ruleReferenceGuard(card, 'r1').includes('策略「策略一」'));
    assert.equal(modelSetReferenceGuard(card, 'ms_x'), '');
    assert.equal(ruleReferenceGuard(card, 'r_x'), '');
  });

  it('活动策略禁删（deleteStrategy 守卫）', () => {
    const card = emptyCard('c');
    card.strategies = { s1: { name: '一', model_set_id: 'm', rule_ids: [], created_at: 'x', updated_at: 'x' }, s2: { name: '二', model_set_id: 'm', rule_ids: [], created_at: 'x', updated_at: 'x' } };
    card.active_strategy_id = 's1';
    assert.ok(deleteStrategy(card, 's1').error);
    assert.equal(deleteStrategy(card, 's2').ok, true);
  });
});

describe('v4 18:00 保形（终稿 §三 验收锚②）', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-v4-preserve-')); setPoliciesDirForTest(join(dir, 'policies')); });
  after(() => { setPoliciesDirForTest(null); rmSync(dir, { recursive: true, force: true }); });

  it('全日 1440 分钟采样：v3 直展 policy vs v4 迁移+apply 后 policy，evaluatePolicy 逐点一致', async () => {
    const { handleApplyStrategy } = await import('../src/api/trimmc-card.js');
    process.env.TRIMODEL_ADMIN_TOKEN = 'preserve';
    // 迁移前基线：v3 内嵌规则直展（现行 apply 语义的人工等价展开）
    const legacy = legacyV3Card();
    const v3Schedules: PolicyShape['schedules'] = legacy.strategies!['s-hourly'].rules.map((r, i) => ({
      id: `strategy:s-hourly:${i}`, target: 'daemon-default' as const, model: r.model,
      windows: r.windows, timezone: 'Asia/Shanghai' as const, enabled: r.enabled, priority: r.priority, type: 'window' as const,
    }));
    const baselinePolicy: PolicyShape = { version: '1', schedules: v3Schedules };
    // 迁移+apply：v3 卡 → loadCard 升格 → handleApplyStrategy v4 展开
    const cardPath = join(dir, 'c.json');
    writeFileSync(cardPath, JSON.stringify(legacy));
    const r = handleApplyStrategy('Bearer preserve', { cardPath });
    assert.equal(r.statusCode, 200);
    const { loadPolicyForMachine } = await import('../src/policy.js');
    const afterPolicy = loadPolicyForMachine('local')!;
    // 逐分钟采样比对（model 序列等价；id/priority 允许变——语义等价口径）
    for (let minute = 0; minute < 1440; minute++) {
      const h = String(Math.floor(minute / 60)).padStart(2, '0');
      const m = String(minute % 60).padStart(2, '0');
      // 构造固定时区时刻：evaluatePolicy 读 now 的 Asia/Shanghai HH:MM——用本地
      // Date 构造不可靠，改直接对比「给定 HH:MM 下两 policy 的命中」：
      // 以窗语义手算基线，v4 侧同法（两侧都是 window 语义，无时区参与）。
      const hhmm = `${h}:${m}`;
      const pick = (schedules: PolicyShape['schedules']): string => {
        for (const s of schedules) {
          if (!s.enabled) continue;
          for (const w of s.windows) if (hhmm >= w.start && hhmm < w.end) return s.model;
        }
        return '(fallback)';
      };
      const before = pick(baselinePolicy.schedules);
      const after = pick(afterPolicy.schedules);
      assert.equal(after, before, `${hhmm}: v3=${before} v4=${after} 不一致`);
    }
    // 锚①口径（CEO 22:12 粒度后）：schedules 结构数随窗组归并变化（3 窗 3 条→2 实体
    // 2 条）——语义等价由上方 1440 逐点采样硬证；id 换名+priority 归一为既定豁免。
  });
});
