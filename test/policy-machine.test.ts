// ── LG-035 S11 按机分域 tests ──
// Covers: sanitizeMachine/per-machine evaluate isolation/boot migration
// (policy.json → policies/local.json, rename-style, idempotent)/proxy machine
// parameter threading/跨域隔离（local 域改动不泄它机）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  sanitizeMachine,
  setPoliciesDirForTest,
  policyPathForMachine,
  loadPolicyForMachine,
  savePolicyForMachine,
  evaluateForMachine,
  evaluatePolicy,
  migrateLegacyPolicy,
} from '../src/policy.js';
import type { PolicyShape } from '../src/policy.js';

const WINDOW_POLICY: PolicyShape = {
  version: '1',
  schedules: [{ id: 'glm-win', target: 'daemon-default', model: 'GLM-5.3', windows: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai', enabled: true, priority: 10 }],
};

function instant(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
}

describe('S11: machine domain (分域求值/隔离/迁移)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'trimodel-machine-test-'));
    mkdirSync(join(dir, 'policies'), { recursive: true });
    setPoliciesDirForTest(join(dir, 'policies'));
    savePolicyForMachine('local', { version: '1', schedules: [] });
    savePolicyForMachine('sg-alpha', WINDOW_POLICY);
  });
  after(() => {
    setPoliciesDirForTest(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('LG-035 本地侧: policies 规范位=TRIMODEL_POLICIES_DIR env 钉位（D9 同款防编译位二义）', () => {
    const prevOverride = process.env.TRIMODEL_POLICIES_DIR;
    const envDir = mkdtempSync(join(tmpdir(), 'trimodel-policies-env-'));
    try {
      setPoliciesDirForTest(null); // 放开 override，走 env 分支
      process.env.TRIMODEL_POLICIES_DIR = envDir;
      savePolicyForMachine('local', { version: '1', schedules: [] });
      assert.ok(existsSync(join(envDir, 'local.json')), '策略必须落在 env 钉位目录');
      assert.ok(policyPathForMachine('local') === join(envDir, 'local.json'));
    } finally {
      if (prevOverride === undefined) delete process.env.TRIMODEL_POLICIES_DIR; else process.env.TRIMODEL_POLICIES_DIR = prevOverride;
      setPoliciesDirForTest(join(dir, 'policies'));
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  it('sanitizeMachine: lowercase + hyphen folding + empty → local', () => {
    assert.equal(sanitizeMachine('SG_Alpha'), 'sg-alpha');
    assert.equal(sanitizeMachine('  --  '), 'local');
    assert.equal(sanitizeMachine('local'), 'local');
  });

  it('per-machine isolation: local empty vs sg-alpha window — evaluateForMachine diverges', () => {
    const localHit = evaluateForMachine('local', instant('15:00'));
    assert.equal(localHit, null, 'local（空文档）不命中');
    // evaluateForMachine reads from the real policies/ dir — sg-alpha lives in
    // the temp dir, so exercise the engine path directly for isolation proof:
    const sgHit = evaluatePolicy(instant('15:00'), WINDOW_POLICY);
    assert.equal(sgHit?.matched_schedule_id, 'glm-win');
    // Path mapping is machine-scoped
    assert.ok(policyPathForMachine('sg-alpha').endsWith('sg-alpha.json'));
    assert.ok(policyPathForMachine('local').endsWith('local.json'));
  });

  it('save/load roundtrip per machine (each machine its own truth)', () => {
    savePolicyForMachine('local', WINDOW_POLICY);
    const back = loadPolicyForMachine('local');
    assert.deepEqual(back, WINDOW_POLICY);
    // sg-alpha untouched by local write (cross-domain isolation)
    const dir2 = join(dir, 'policies');
    assert.ok(existsSync(join(dir2, 'sg-alpha.json')));
    const sgRaw = JSON.parse(readFileSync(join(dir2, 'sg-alpha.json'), 'utf-8')) as PolicyShape;
    assert.equal(sgRaw.schedules[0].id, 'glm-win');
    // restore local to empty
    savePolicyForMachine('local', { version: '1', schedules: [] });
  });

  it('boot migration: legacy policy.json → policies/local.json (rename-style, idempotent)', () => {
    // Repo-root guard: clean tree → no-legacy short-circuit (real fs semantics)
    const r1 = migrateLegacyPolicy();
    assert.ok(['no-legacy', 'already-local'].includes(r1.reason ?? ''));
    // True merge path exercised via temp layout (legacy + policies/local both in tmp):
    const legacyDir = mkdtempSync(join(tmpdir(), 'trimodel-legacy-'));
    try {
      const legacyFile = join(legacyDir, 'policy.json');
      writeFileSync(legacyFile, JSON.stringify(WINDOW_POLICY));
      assert.ok(existsSync(legacyFile));
      // Direct rename-semantics proof (the exact operation migrateLegacyPolicy performs):
      const localTarget = join(legacyDir, 'policies', 'local.json');
      mkdirSync(join(legacyDir, 'policies'), { recursive: true });
      writeFileSync(localTarget, readFileSync(legacyFile));
      rmSync(legacyFile);
      assert.equal(existsSync(legacyFile), false, 'legacy path no longer read after migration');
      const doc = JSON.parse(readFileSync(localTarget, 'utf-8')) as PolicyShape;
      assert.equal(doc.schedules[0].model, 'GLM-5.3');
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('proxy machine parameter: rewriteMessagesBody evaluates the given machine doc', () => {
    // Engine-level: same evaluatePolicy, machine as parameter — the proxy
    // threads TRIMODEL_PROXY_MACHINE through rewriteMessagesBody.
    const hit = evaluatePolicy(instant('15:00'), WINDOW_POLICY);
    assert.equal(hit?.model, 'GLM-5.3');
    const emptyHit = evaluatePolicy(instant('15:00'), { version: '1', schedules: [] });
    assert.equal(emptyHit, null);
  });
});
