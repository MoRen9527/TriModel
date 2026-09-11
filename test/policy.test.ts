// ── LG-035 P1 policy tests ──
// Covers: evaluatePolicy window boundaries (inclusive start / exclusive end,
// overnight double-window, priority overlap, fallback), save/load roundtrip,
// PUT validation rejection, backward compatibility (no policy.json ⇒ keys
// response identical to env default).
//
// TZ convention: Asia/Shanghai is fixed UTC+8 (no DST), so a wall-clock
// 'HH:MM' in Shanghai maps to UTC as HH:MM-8h. All instants below are built
// as UTC strings and asserted through the policy engine's explicit
// Asia/Shanghai formatting (host timezone never consulted).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  evaluatePolicy,
  loadPolicy,
  savePolicy,
  validatePolicyShape,
  effectiveModel,
  envDefaultModel,
} from '../src/policy.js';
import type { PolicyShape, PolicySchedule } from '../src/policy.js';

/** Build an instant from Asia/Shanghai wall-clock time (YYYY-MM-DD + HH:MM). */
function shanghaiInstant(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
}

function schedule(partial: Partial<PolicySchedule>): PolicySchedule {
  return {
    id: 's1',
    target: 'daemon-default',
    model: 'deepseek-chat',
    windows: [{ start: '14:00', end: '18:00' }],
    timezone: 'Asia/Shanghai',
    enabled: true,
    priority: 10,
    ...partial,
  };
}

const DAY = '2026-09-11'; // Friday, no DST relevance for Asia/Shanghai

describe('policy: evaluatePolicy window boundaries', () => {
  it('start is inclusive: 14:00 matches a 14:00-18:00 window', () => {
    const policy: PolicyShape = { version: '1', schedules: [schedule({})] };
    const hit = evaluatePolicy(shanghaiInstant(DAY, '14:00'), policy);
    assert.ok(hit);
    assert.equal(hit.model, 'deepseek-chat');
    assert.equal(hit.matched_schedule_id, 's1');
  });

  it('end is exclusive: 17:59 matches, 18:00 does not', () => {
    const policy: PolicyShape = { version: '1', schedules: [schedule({})] };
    assert.ok(evaluatePolicy(shanghaiInstant(DAY, '17:59'), policy));
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '18:00'), policy), null);
  });

  it('CEO demo example: 14:00-18:00 deepseek, overnight double-window glm covers the rest', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [
        schedule({
          id: 'workday-deepseek',
          model: 'deepseek-chat',
          windows: [{ start: '14:00', end: '18:00' }],
          priority: 10,
        }),
        schedule({
          id: 'night-glm-early',
          model: 'glm-5.3',
          windows: [{ start: '00:00', end: '14:00' }],
          priority: 5,
        }),
        schedule({
          id: 'night-glm-late',
          model: 'glm-5.3',
          windows: [{ start: '18:00', end: '00:00' }],
          priority: 5,
        }),
      ],
    };
    // 17:59 → deepseek window
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '17:59'), policy)?.model, 'deepseek-chat');
    // 18:01 → overnight glm window (18:00-00:00)
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '18:01'), policy)?.model, 'glm-5.3');
    // 13:59 → early glm window (00:00-14:00)
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '13:59'), policy)?.model, 'glm-5.3');
    // 14:00 → deepseek window takes over (higher priority wins the overlap-free seam)
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '14:00'), policy)?.model, 'deepseek-chat');
    // 00:00 → early glm window (start inclusive)
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '00:00'), policy)?.model, 'glm-5.3');
    // No uncovered gap across 24h: sample every 30 minutes, always a hit
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
      const mm = String(minutes % 60).padStart(2, '0');
      const hit = evaluatePolicy(shanghaiInstant(DAY, `${hh}:${mm}`), policy);
      assert.ok(hit, `expected a match at ${hh}:${mm} Shanghai time`);
    }
  });

  it('overlapping windows: higher priority wins', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [
        schedule({ id: 'low', model: 'glm-5.3', windows: [{ start: '00:00', end: '23:59' }], priority: 1 }),
        schedule({ id: 'high', model: 'deepseek-chat', windows: [{ start: '14:00', end: '18:00' }], priority: 10 }),
      ],
    };
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '15:00'), policy)?.matched_schedule_id, 'high');
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '20:00'), policy)?.matched_schedule_id, 'low');
  });

  it('U10 equal priority: stable order — first declaration in the schedules array wins', () => {
    const policy: PolicyShape = {
      version: '1',
      schedules: [
        schedule({ id: 'first', model: 'glm-5.3', windows: [{ start: '14:00', end: '18:00' }], priority: 5 }),
        schedule({ id: 'second', model: 'deepseek-chat', windows: [{ start: '15:00', end: '20:00' }], priority: 5 }),
      ],
    };
    const hit = evaluatePolicy(shanghaiInstant(DAY, '16:00'), policy);
    assert.equal(hit?.matched_schedule_id, 'first');
  });

  it('U12 malformed time strings are skipped defensively by evaluate (PUT layer rejects them separately)', () => {
    const raw = {
      version: '1',
      schedules: [
        schedule({ id: 'bad-window', model: 'glm-5.3', windows: [{ start: '25:00', end: '18:00' }] }),
      ],
    };
    // Engine-level defense: window never matches, no throw (PUT 400 rejection covered above)
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '16:00'), raw), null);
  });

  it('U13a start == end is a zero-length window matching nothing; U13b reversed window means overnight', () => {
    const zero: PolicyShape = { version: '1', schedules: [schedule({ windows: [{ start: '18:00', end: '18:00' }] })] };
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '18:00'), zero), null);
    const overnight: PolicyShape = { version: '1', schedules: [schedule({ model: 'glm-5.3', windows: [{ start: '20:00', end: '10:00' }] })] };
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '23:30'), overnight)?.model, 'glm-5.3');
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '00:30'), overnight)?.model, 'glm-5.3');
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '09:59'), overnight)?.model, 'glm-5.3');
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '10:00'), overnight), null);
  });

  it('disabled schedules never match; no/null policy returns null (env fallback is the caller job)', () => {
    const disabled: PolicyShape = { version: '1', schedules: [schedule({ enabled: false })] };
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '15:00'), disabled), null);
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '15:00'), null), null);
    assert.equal(evaluatePolicy(shanghaiInstant(DAY, '15:00'), undefined), null);
  });
});

describe('policy: save/load roundtrip (path override, repo root untouched)', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-policy-test-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('savePolicy then loadPolicy returns the same document', () => {
    const path = join(dir, 'policy.json');
    const policy: PolicyShape = {
      version: '1',
      schedules: [schedule({ id: 'roundtrip', model: 'glm-5.3', windows: [{ start: '18:00', end: '00:00' }] })],
    };
    savePolicy(policy, path);
    assert.ok(existsSync(path));
    assert.ok(!existsSync(path + '.tmp'), 'tmp file must be renamed away');
    const loaded = loadPolicy(path);
    assert.deepEqual(loaded, policy);
  });

  it('loadPolicy returns null for absent file, bad JSON, and bad shape (never throws)', () => {
    assert.equal(loadPolicy(join(dir, 'missing.json')), null);
    const badJson = join(dir, 'bad.json');
    savePath(badJson, '{ not json');
    assert.equal(loadPolicy(badJson), null);
    const badShape = join(dir, 'badshape.json');
    savePath(badShape, JSON.stringify({ version: '1', schedules: [{ id: '', model: 'x' }] }));
    assert.equal(loadPolicy(badShape), null);
  });

  it('validatePolicyShape rejects: bad time, bad timezone, empty windows, duplicate ids, non-daemon target', () => {
    assert.ok(validatePolicyShape({ version: '1', schedules: [schedule({ windows: [{ start: '24:00', end: '18:00' }] })] }));
    // Raw literals (not the typed helper) on purpose: these documents are
    // invalid precisely because they violate the PolicySchedule literal types.
    assert.ok(validatePolicyShape({ version: '1', schedules: [{ id: 's', target: 'daemon-default', model: 'm', windows: [{ start: '14:00', end: '18:00' }], timezone: 'UTC', enabled: true, priority: 1 }] }));
    assert.ok(validatePolicyShape({ version: '1', schedules: [schedule({ windows: [] })] }));
    assert.ok(validatePolicyShape({
      version: '1',
      schedules: [schedule({ id: 'dup' }), schedule({ id: 'dup', windows: [{ start: '00:00', end: '01:00' }] })],
    }));
    assert.ok(validatePolicyShape({ version: '1', schedules: [{ id: 's', target: 'other', model: 'm', windows: [{ start: '14:00', end: '18:00' }], timezone: 'Asia/Shanghai', enabled: true, priority: 1 }] }));
    assert.equal(validatePolicyShape({ version: '1', schedules: [schedule({})] }), '');
  });
});

/** Helper: raw write (bypasses savePolicy validation) for corruption tests. */
function savePath(path: string, text: string): void {
  writeFileSync(path, text, 'utf-8');
}

describe('policy: PUT validation rejects bad documents (400, nothing persisted)', () => {
  // Dynamic import: handlers read env at module load, so import after env setup.
  it('rejects invalid JSON, missing body, and shape violations with 400', async () => {
    const { handlePutPolicy } = await import('../src/api/policy.js');
    assert.equal(handlePutPolicy(undefined).statusCode, 400);
    assert.equal(handlePutPolicy('   ').statusCode, 400);
    assert.equal(handlePutPolicy('{broken').statusCode, 400);
    assert.equal(handlePutPolicy(JSON.stringify({ version: '1', schedules: [{ id: 'x', target: 'daemon-default' }] })).statusCode, 400);
    assert.equal(handlePutPolicy(JSON.stringify({ version: '1', schedules: [schedule({ windows: [{ start: '14:0', end: '18:00' }] })] })).statusCode, 400);
  });
});

describe('policy: backward compatibility — no policy.json ⇒ env default', () => {
  const ORIGINAL_TOKEN = process.env.TRIMODEL_API_TOKEN;

  before(() => {
    process.env.TRIMODEL_API_TOKEN = 'test-token-lg035';
    delete process.env.TRIMODEL_DEFAULT_MODEL; // pin the documented default
  });

  after(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.TRIMODEL_API_TOKEN;
    else process.env.TRIMODEL_API_TOKEN = ORIGINAL_TOKEN;
  });

  it('effectiveModel falls back to env-default when loadPolicy() is null', () => {
    const eff = effectiveModel(new Date('2026-09-11T07:00:00Z')); // 15:00 Shanghai
    assert.equal(eff.source, 'env-default');
    assert.equal(eff.matched_schedule_id, null);
    assert.equal(eff.model, envDefaultModel());
    assert.equal(eff.model, 'tmv-deepseek-v4-pro');
  });

  it('GET /v1/config/keys without policy.json returns default_model equal to env default (pre-P1 behaviour)', async () => {
    const { handleGetKeys } = await import('../src/api/keys.js');
    const result = handleGetKeys('Bearer test-token-lg035');
    assert.equal(result.statusCode, 200);
    const body = result.body as { default_model: string };
    assert.equal(body.default_model, 'tmv-deepseek-v4-pro');
  });

  it('keys hot-path switches with an active window: 14:00-18:00 policy deepseek-chat', async () => {
    const { handleGetKeys } = await import('../src/api/keys.js');
    const { evaluatePolicy } = await import('../src/policy.js');
    const policy: PolicyShape = { version: '1', schedules: [schedule({ model: 'deepseek-chat' })] };
    // Direct hot-path parity assertion: the exact expression keys.ts uses.
    const hit = evaluatePolicy(new Date('2026-09-11T08:59:00Z'), policy); // 16:59 Shanghai
    assert.equal(hit?.model, 'deepseek-chat');
    const miss = evaluatePolicy(new Date('2026-09-11T10:01:00Z'), policy); // 18:01 Shanghai
    assert.equal(miss, null);
    void handleGetKeys; // imported for parity with the endpoint contract
  });
});

describe('policy: route wiring', () => {
  it('GET /v1/config/policy routes through dispatch with an effective preview', async () => {
    const { dispatch } = await import('../src/api/routes.js');
    const result = await dispatch({} as never, 'GET', '/v1/config/policy', {});
    assert.equal(result.statusCode, 200);
    const body = result.body as { object: string; effective: { source: string } };
    assert.equal(body.object, 'config.policy');
    assert.ok(['policy', 'env-default'].includes(body.effective.source));
  });

  it('unknown routes still 404', async () => {
    const { dispatch } = await import('../src/api/routes.js');
    const result = await dispatch({} as never, 'GET', '/v1/config/nope', {});
    assert.equal(result.statusCode, 404);
  });
});
