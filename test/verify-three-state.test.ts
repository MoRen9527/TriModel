// ── 深测②合一窗 S1：GET /v1/config/verify 诚实三态读数端点 tests ──
// A 族 = deriveVerifyState 判定树全分支注入（五态 + pull_chain_degraded +
//   优先序与空态边界）；B 族 = handleGetConfigVerify 沙箱端到端（鉴权三态 /
//   四 face 值面对照 / 零健康字段语义边界硬断言）。
// 语义边界真源：CPO 卷 §4.5（5d175a26）——本端点答「配置到没到位」，
// 非健康检查（健康答「服务活不活」）；响应体禁塞健康/存活字段，B 族以
// 键集合等值断言为硬门。
// 沙箱布景沿用 test/config-cards.test.ts 同款（TRIMODEL_DATA_DIR /
// TRIMODEL_CARDS_DIR / TRIMODEL_POLICIES_DIR 钉 mkdtemp；活体生产面零接触）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { dispatch } from '../src/api/routes.js';
import { deriveVerifyState, VERIFY_STATE_LABELS } from '../src/api/verify.js';
import type { VerifyFaceInput } from '../src/api/verify.js';
import { FACE_IDS, faceCardPath, updateFaceLedger } from '../src/card-faces.js';
import type { FaceId, FaceLedgerEntry } from '../src/card-faces.js';
import { emptyCard, saveCard } from '../src/trimmc-card.js';
import type { TrimmcCardDocument } from '../src/trimmc-card.js';
import type { ModelClient } from '../src/client.js';

const CLIENT = null as unknown as ModelClient;
const ADMIN = 'test-admin-token-verify-s1';

let dir: string;
const prevEnv: Record<string, string | undefined> = {};

function pinEnv(key: string, value: string | undefined): void {
  if (!(key in prevEnv)) prevEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'trimodel-verify-test-'));
  pinEnv('TRIMODEL_DATA_DIR', dir);
  pinEnv('TRIMODEL_CARDS_DIR', dir);
  pinEnv('TRIMODEL_POLICIES_DIR', dir);
  pinEnv('TRIMODEL_ADMIN_TOKEN', ADMIN);
});

after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 沙箱清理尽力 */ }
});

// ── 沙箱布景 ──

/** 摆一张带下发意图（local_config）的沙箱卡。 */
function seedIntentCard(face: FaceId, version: number, updatedAt: string): void {
  const doc: TrimmcCardDocument = emptyCard('sandbox');
  doc.local_config = { version, updated_at: updatedAt, items: {} };
  saveCard(doc, faceCardPath(face));
}

/** 摆 face 台账条目（read-merge 单面 patch，走生产写径 updateFaceLedger）。 */
function seedLedger(face: FaceId, patch: Partial<FaceLedgerEntry>): void {
  updateFaceLedger(face, patch);
}

/** 基准输入：有卡+意图 v3@02:00+已落 v3 ok+已拉 ok@02:30 —— applied 态。 */
function baseInput(): VerifyFaceInput {
  return {
    card_present: true,
    local_config_version: 3,
    local_config_updated_at: '2026-10-08T02:00:00Z',
    version_applied: 3,
    applied_at: '2026-10-08T02:30:00Z',
    write_result: 'ok',
    last_pull_at: '2026-10-08T02:30:00Z',
    last_pull_result: 'ok',
  };
}

// ── A 族：deriveVerifyState 判定树全分支 ──

describe('deriveVerifyState 判定树', () => {
  it('无卡（即使有旧回写）→ not-configured', () => {
    const r = deriveVerifyState({ ...baseInput(), card_present: false });
    assert.equal(r.state, 'not-configured');
    assert.equal(r.state_label, '未配置');
  });

  it('有卡但无下发意图（version 0）→ not-configured', () => {
    const r = deriveVerifyState({ ...baseInput(), local_config_version: 0 });
    assert.equal(r.state, 'not-configured');
  });

  it('版本齐平且回写 ok → applied', () => {
    const r = deriveVerifyState(baseInput());
    assert.equal(r.state, 'applied');
    assert.equal(r.state_label, '已落生效');
  });

  it('回写 failed（版本即使齐平）→ apply-failed（失败态优先于 applied 判据）', () => {
    const r = deriveVerifyState({ ...baseInput(), write_result: 'failed' });
    assert.equal(r.state, 'apply-failed');
    assert.equal(r.state_label, '落盘失败');
  });

  it('未回写过（version_applied null）+ 已拉取 → pulled-not-applied', () => {
    const r = deriveVerifyState({ ...baseInput(), version_applied: null, applied_at: null, write_result: null });
    assert.equal(r.state, 'pulled-not-applied');
    assert.equal(r.state_label, '已拉未落');
  });

  it('意图更新后未再拉取（last_pull_at < updated_at）→ stored-not-pulled', () => {
    const r = deriveVerifyState({ ...baseInput(), version_applied: null, applied_at: null, write_result: null, last_pull_at: '2026-10-08T01:00:00Z' });
    assert.equal(r.state, 'stored-not-pulled');
    assert.equal(r.state_label, '已存未拉');
  });

  it('从未拉取（last_pull_at null）→ stored-not-pulled', () => {
    const r = deriveVerifyState({ ...baseInput(), version_applied: null, applied_at: null, write_result: null, last_pull_at: null, last_pull_result: null });
    assert.equal(r.state, 'stored-not-pulled');
  });

  it('拉取时刻与意图时刻相等（>= 边界）→ pulled-not-applied', () => {
    const r = deriveVerifyState({ ...baseInput(), version_applied: null, applied_at: null, write_result: null, last_pull_at: '2026-10-08T02:00:00Z' });
    assert.equal(r.state, 'pulled-not-applied');
  });

  it('拉取链 denied → pull_chain_degraded=true 且主态不变', () => {
    const r = deriveVerifyState({ ...baseInput(), version_applied: null, applied_at: null, write_result: null, last_pull_result: 'denied' });
    assert.equal(r.state, 'pulled-not-applied');
    assert.equal(r.pull_chain_degraded, true);
  });

  it('拉取链 failed → pull_chain_degraded=true 且主态不变', () => {
    const r = deriveVerifyState({ ...baseInput(), last_pull_result: 'failed' });
    assert.equal(r.state, 'applied');
    assert.equal(r.pull_chain_degraded, true);
  });

  it('拉取链 ok / 从未拉取 → pull_chain_degraded=false', () => {
    assert.equal(deriveVerifyState(baseInput()).pull_chain_degraded, false);
    assert.equal(deriveVerifyState({ ...baseInput(), last_pull_result: null, last_pull_at: null }).pull_chain_degraded, false);
  });

  it('五态标签表全量（UI 直消费面）', () => {
    assert.deepEqual(VERIFY_STATE_LABELS, {
      'not-configured': '未配置',
      'stored-not-pulled': '已存未拉',
      'pulled-not-applied': '已拉未落',
      'applied': '已落生效',
      'apply-failed': '落盘失败',
    });
  });
});

// ── B 族：handleGetConfigVerify 沙箱端到端（经 dispatch 走真路由） ──

describe('GET /v1/config/verify 端到端', () => {
  it('503 fail-closed：TRIMODEL_ADMIN_TOKEN 未配置', async () => {
    pinEnv('TRIMODEL_ADMIN_TOKEN', undefined);
    try {
      const res = await dispatch(CLIENT, 'GET', '/v1/config/verify', {});
      assert.equal(res.statusCode, 503);
      assert.ok(String((res.body as { error: string }).error).includes('fail-closed'));
    } finally {
      pinEnv('TRIMODEL_ADMIN_TOKEN', ADMIN);
    }
  });

  it('401：错 Bearer 拒读', async () => {
    const res = await dispatch(CLIENT, 'GET', '/v1/config/verify', { authorization: `Bearer wrong-${ADMIN}` });
    assert.equal(res.statusCode, 401);
  });

  it('200 + 四 face 值面对照 + 零健康字段硬门', async () => {
    // 布景四 face 各占一态：
    //   mlc = applied（卡 v3@02:00 + 台账 v3 ok + 拉取 ok@02:30）
    //   rlc = stored-not-pulled（卡 v2@03:00 新意图，台账空）
    //   rmc = apply-failed（卡 v5@01:00 + 台账 write_result failed）
    //   mmc = not-configured（无卡）
    seedIntentCard('mlc', 3, '2026-10-08T02:00:00Z');
    seedLedger('mlc', {
      last_pull_at: '2026-10-08T02:30:00Z', last_pull_result: 'ok', last_pull_from: 'remote',
      local_config: { version_applied: 3, applied_at: '2026-10-08T02:30:00Z', write_result: 'ok' },
    });
    seedIntentCard('rlc', 2, '2026-10-08T03:00:00Z');
    seedIntentCard('rmc', 5, '2026-10-08T01:00:00Z');
    seedLedger('rmc', {
      last_pull_at: '2026-10-08T01:30:00Z', last_pull_result: 'ok', last_pull_from: 'remote',
      local_config: { version_applied: 4, applied_at: '2026-10-08T01:30:00Z', write_result: 'failed', write_error: 'EACCES sandbox' },
    });

    const res = await dispatch(CLIENT, 'GET', '/v1/config/verify', { authorization: `Bearer ${ADMIN}` });
    assert.equal(res.statusCode, 200);
    const body = res.body as { object: string; faces: Record<string, Record<string, unknown>>; generated_at: string };

    assert.equal(body.object, 'config.verify');
    assert.ok(body.generated_at, 'generated_at 在卷');
    // 顶层键集合等值=零夹带（无健康/存活字段的第一道门）
    assert.deepEqual(Object.keys(body).sort(), ['faces', 'generated_at', 'object']);
    assert.deepEqual(Object.keys(body.faces).sort(), [...FACE_IDS].sort(), '四 face 全量在卷');

    // 每 face 条目键集合等值白名单（零健康字段硬门：语义边界 CPO §4.5）
    const WHITELIST = [
      'face', 'card_present',
      'intent_version', 'intent_updated_at',
      'version_applied', 'applied_at', 'write_result', 'write_error',
      'last_pull_at', 'last_pull_result',
      'state', 'state_label', 'pull_chain_degraded',
    ].sort();
    for (const face of FACE_IDS) {
      assert.deepEqual(Object.keys(body.faces[face]).sort(), WHITELIST, `face ${face} 键集合恰等白名单`);
    }
    // 全键名面扫尾（纵深）：禁 health/alive/uptime/latency/heartbeat 子串
    const keyNames = Object.keys(body).concat(Object.keys(body.faces.mlc)).join(',').toLowerCase();
    for (const banned of ['health', 'alive', 'uptime', 'latency', 'heartbeat']) {
      assert.ok(!keyNames.includes(banned), `响应键名面禁含健康语义子串: ${banned}`);
    }

    // 四态值面对照
    const mlc = body.faces.mlc as { state: string; state_label: string; intent_version: number; version_applied: number; pull_chain_degraded: boolean };
    assert.equal(mlc.state, 'applied');
    assert.equal(mlc.state_label, '已落生效');
    assert.equal(mlc.intent_version, 3);
    assert.equal(mlc.version_applied, 3);
    assert.equal(mlc.pull_chain_degraded, false);

    const rlc = body.faces.rlc as { state: string; state_label: string; card_present: boolean; intent_version: number; version_applied: null };
    assert.equal(rlc.state, 'stored-not-pulled');
    assert.equal(rlc.state_label, '已存未拉');
    assert.equal(rlc.card_present, true);
    assert.equal(rlc.intent_version, 2);
    assert.equal(rlc.version_applied, null);

    const rmc = body.faces.rmc as { state: string; state_label: string; write_error: string };
    assert.equal(rmc.state, 'apply-failed');
    assert.equal(rmc.state_label, '落盘失败');
    assert.equal(rmc.write_error, 'EACCES sandbox');

    const mmc = body.faces.mmc as { state: string; state_label: string; card_present: boolean };
    assert.equal(mmc.state, 'not-configured');
    assert.equal(mmc.state_label, '未配置');
    assert.equal(mmc.card_present, false);
  });

  it('有卡但无 local_config 意图 → not-configured（空态如实，不推断旧回写仍生效）', async () => {
    const doc: TrimmcCardDocument = emptyCard('sandbox-no-intent');
    saveCard(doc, faceCardPath('mmc'));
    seedLedger('mmc', {
      local_config: { version_applied: 9, applied_at: '2026-10-07T09:00:00Z', write_result: 'ok' },
    });
    const res = await dispatch(CLIENT, 'GET', '/v1/config/verify', { authorization: `Bearer ${ADMIN}` });
    const mmc = (res.body as { faces: Record<string, { state: string; card_present: boolean }> }).faces.mmc;
    assert.equal(mmc.card_present, true);
    assert.equal(mmc.state, 'not-configured');
  });
});
