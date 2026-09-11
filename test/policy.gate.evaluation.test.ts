// ── LG-035 P1 STE gate: independent evaluation-family retests ──
// STE 小柯门禁（spec: TriCompany/docs/test/lg-035-p1-trimodel-policy-gate-spec.md v0.4）
// 与 FSD test/policy.test.ts 相互独立：本件为第二方法交叉验证。
// U14 注记：本机宿主=UTC+8 与 Asia/Shanghai 同相，宿主污染检测上限=UTC 构造瞬时
// 映射断言（若实现误读宿主墙钟，本机无法区分）——跨宿主增强建议候 sg 复跑。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { evaluatePolicy, loadPolicy, savePolicy, envDefaultModel } from '../src/policy.js';
import type { PolicyShape, PolicySchedule } from '../src/policy.js';

function schedule(partial: Partial<PolicySchedule>): PolicySchedule {
  return {
    id: 'gate-s1',
    target: 'daemon-default',
    model: 'gate-model-a',
    windows: [{ start: '18:00', end: '22:00' }],
    timezone: 'Asia/Shanghai',
    enabled: true,
    priority: 10,
    ...partial,
  };
}

describe('GATE L1: boundary family (independent re-assert)', () => {
  const DAY = '2026-09-11';

  it('U3 [start,end) adjudication: 18:00 exactly hits the [18:00,22:00) window', () => {
    const policy: PolicyShape = { version: '1', schedules: [schedule({})] };
    const hit = evaluatePolicy(new Date(`${DAY}T18:00:00+08:00`), policy);
    assert.ok(hit, 'start-inclusive (CTO Q3 ruling) must match at 18:00');
    assert.equal(hit.model, 'gate-model-a');
  });

  it('U5-U8 overnight window [22:00,06:00): 23:30/00:30/05:59 in, 06:00 out', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [schedule({ model: 'gate-night', windows: [{ start: '22:00', end: '06:00' }] })],
    };
    assert.equal(evaluatePolicy(new Date(`${DAY}T23:30:00+08:00`), policy)?.model, 'gate-night', 'U5');
    assert.equal(evaluatePolicy(new Date(`${DAY}T00:30:00+08:00`), policy)?.model, 'gate-night', 'U6');
    assert.equal(evaluatePolicy(new Date(`${DAY}T05:59:00+08:00`), policy)?.model, 'gate-night', 'U7');
    assert.equal(evaluatePolicy(new Date(`${DAY}T06:00:00+08:00`), policy), null, 'U8 end-exclusive');
  });

  it('U9 higher priority wins overlap', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [
        schedule({ id: 'low', model: 'gate-low', windows: [{ start: '00:00', end: '23:59' }], priority: 1 }),
        schedule({ id: 'high', model: 'gate-high', windows: [{ start: '12:00', end: '20:00' }], priority: 99 }),
      ],
    };
    assert.equal(evaluatePolicy(new Date(`${DAY}T15:00:00+08:00`), policy)?.matched_schedule_id, 'high');
    assert.equal(evaluatePolicy(new Date(`${DAY}T21:00:00+08:00`), policy)?.matched_schedule_id, 'low');
  });

  it('U10 equal priority: array order wins (first declared, CTO Q4a ruling)', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [
        schedule({ id: 'first', model: 'gate-first', windows: [{ start: '14:00', end: '18:00' }], priority: 5 }),
        schedule({ id: 'second', model: 'gate-second', windows: [{ start: '15:00', end: '20:00' }], priority: 5 }),
      ],
    };
    assert.equal(evaluatePolicy(new Date(`${DAY}T16:00:00+08:00`), policy)?.matched_schedule_id, 'first');
  });

  it('U11 no/null policy evaluates to null (env fallback is caller-side)', () => {
    assert.equal(evaluatePolicy(new Date(`${DAY}T12:00:00+08:00`), null), null);
    assert.equal(evaluatePolicy(new Date(`${DAY}T12:00:00+08:00`), undefined), null);
    assert.equal(evaluatePolicy(new Date(`${DAY}T12:00:00+08:00`), { version: '1', schedules: [] }), null);
    assert.equal(envDefaultModel(), 'tmv-deepseek-v4-pro');
  });
});

describe('GATE L1: U14 timezone — UTC-constructed instants map to Shanghai wall clock', () => {
  const win = (start: string, end: string): PolicyShape => ({
    version: '1',
    schedules: [schedule({ model: 'gate-tz', windows: [{ start, end }] })],
  });

  it('18:00 seam via UTC instants (09:59Z=17:59 out, 10:00Z=18:00 in, 10:01Z=18:01 in)', () => {
    const policy = win('18:00', '22:00');
    assert.equal(evaluatePolicy(new Date('2026-09-11T09:59:00Z'), policy), null, '09:59Z=17:59 Shanghai');
    assert.ok(evaluatePolicy(new Date('2026-09-11T10:00:00Z'), policy), '10:00Z=18:00 Shanghai, start-inclusive');
    assert.ok(evaluatePolicy(new Date('2026-09-11T10:01:00Z'), policy), '10:01Z=18:01 Shanghai');
  });

  it('midnight seam via UTC instants (overnight [18:00,06:00))', () => {
    const policy = win('18:00', '06:00');
    assert.ok(evaluatePolicy(new Date('2026-09-11T15:59:00Z'), policy), '15:59Z=23:59 Shanghai');
    assert.ok(evaluatePolicy(new Date('2026-09-11T16:00:00Z'), policy), '16:00Z=00:00 Shanghai next day');
    assert.equal(evaluatePolicy(new Date('2026-09-11T22:00:00Z'), policy), null, '22:00Z=06:00 Shanghai, end-exclusive');
  });

  it('non-Shanghai timezone schedules are skipped (P1 single-TZ)', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [schedule({ id: 'utc', model: 'gate-utc', windows: [{ start: '00:00', end: '23:59' }], timezone: 'UTC' as never })],
    };
    assert.equal(evaluatePolicy(new Date('2026-09-11T10:00:00Z'), policy), null);
  });
});

describe('GATE L1: U15 loadPolicy fail-safe (Q4b: corrupt file must never throw)', () => {
  let dir: string;
  const originalDefaultModel = process.env.TRIMODEL_DEFAULT_MODEL;

  it('corrupt/absent/shape-invalid files all yield null without throwing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ste-gate-u15-'));
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{ truncated json', 'utf-8');
    assert.equal(loadPolicy(badJson), null, 'unparsable JSON → null');
    const badShape = join(dir, 'badshape.json');
    writeFileSync(badShape, JSON.stringify({ version: '1', schedules: [{ id: 'x' }] }), 'utf-8');
    assert.equal(loadPolicy(badShape), null, 'shape-invalid → null');
    assert.equal(loadPolicy(join(dir, 'absent.json')), null, 'absent → null');
    assert.equal(loadPolicy(dir), null, 'directory path → null (read error swallowed)');
  });

  it('savePolicy is atomic on disk (no .tmp leftover) and roundtrips', () => {
    const path = join(dir, 'atomic.json');
    savePolicy({ version: '1', schedules: [schedule({})] }, path);
    assert.ok(!existsSync(`${path}.tmp`), 'tmp must be renamed away');
    assert.equal(loadPolicy(path)?.schedules[0]?.id, 'gate-s1');
    rmSync(dir, { recursive: true, force: true });
    if (originalDefaultModel === undefined) delete process.env.TRIMODEL_DEFAULT_MODEL;
    else process.env.TRIMODEL_DEFAULT_MODEL = originalDefaultModel;
  });
});
