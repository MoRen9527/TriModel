// ── LG-058 P0 泛化卡面端点族·STE 增补案（3 案）──
// 测试方案 §九 收敛的 L1 增补面（FSD config-cards.test.ts 22 案主面之外的缺口）：
//   ① status 回写 `failed` 合法值（值域全覆盖：applied|failed 外拒之 failed 侧）
//   ② pull 坏密文条目：跳过+warnings+skipped 计数（decrypt_failed 行为面形态）
//   ③ apply 无卡：404+零 apply 审计行（apply_rejected 行为面形态）
// 沙箱纪律同 FSD 卷（T7 活体生产面零接触）：三钉位 env 钉 mkdtemp。
// 注：案②③固化「两归因码无 emit 点」行为面。CTO 裁 1（de6d49f8）已下：
// (乙) decrypt_failed server 侧**不补不降维**→案②断言为定案形态（勘正确认
// pull_denied 在役有 emit，本卷口径即两码）；(甲) status/apply 非 200 补 emit
// 归 FSD N3-N5——届时案③断言随裁更新（apply_rejected 事件断言加入）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { dispatch } from '../src/api/routes.js';
import { buildEntry, emptyCard, saveCard, setActiveStrategy, upsertStrategy } from '../src/trimmc-card.js';
import { faceCardPath, readFaceLedger, faceEventsPath } from '../src/card-faces.js';
import type { TrimmcCardDocument } from '../src/trimmc-card.js';
import type { ModelClient } from '../src/client.js';

const CLIENT = null as unknown as ModelClient;
const ADMIN = 'test-admin-token-lg058-ste';
const API_TOKEN = 'test-api-token-lg058-ste';

let dir: string;
const prevEnv: Record<string, string | undefined> = {};

function pinEnv(key: string, value: string | undefined): void {
  if (!(key in prevEnv)) prevEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'trimodel-config-cards-ste-test-'));
  pinEnv('TRIMODEL_DATA_DIR', dir);
  pinEnv('TRIMODEL_CARDS_DIR', dir);
  pinEnv('TRIMODEL_POLICIES_DIR', dir);
  pinEnv('TRIMODEL_ADMIN_TOKEN', ADMIN);
  pinEnv('TRIMODEL_API_TOKEN', API_TOKEN);
  pinEnv('TRIMODEL_FACE_TOKENS', undefined);
  pinEnv('TRIMODEL_CARD_FILE', undefined);
});

after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 沙箱清理尽力 */ }
});

/** 布景一张带策略链的沙箱卡（saveCard 引擎直写；返回物理路径）。 */
function seedCard(face: 'mmc' | 'mlc' | 'rmc' | 'rlc'): string {
  const cardPath = faceCardPath(face);
  const doc: TrimmcCardDocument = emptyCard('sandbox');
  const entry = buildEntry('deepseek', 'deepseek-v4-pro', 'sk-test-sandbox-key-000000', true);
  doc.provider_entries['e1'] = entry;
  doc.rules['r1'] = { name: '默认规则', type: 'default', entry_id: 'e1', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  upsertStrategy(doc, 's1', { name: '沙箱策略', model_set_id: 'ms-sandbox', rule_ids: ['r1'], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  setActiveStrategy(doc, 's1');
  doc.default_model = 'deepseek-v4-pro';
  saveCard(doc, cardPath);
  return cardPath;
}

async function req(method: string, url: string, auth?: string, body?: string) {
  return dispatch(CLIENT, method, url, auth ? { authorization: auth } : {}, body);
}

function readEvents(): Array<Record<string, unknown>> {
  const p = faceEventsPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('LG-058 STE 增补案：status 值域 failed 侧', () => {
  it('status 回写 state=failed：200+台账 applied_state 同步+审计行', async () => {
    seedCard('mlc');
    const r = await req('PUT', '/v1/config/cards/mlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'failed' }));
    assert.equal(r.statusCode, 200);
    assert.equal(readFaceLedger().faces.mlc?.applied_state, 'failed');
    const evt = readEvents().filter((e) => e.etype === 'status' && e.face === 'mlc');
    assert.ok(evt.some((e) => e.result === 'ok' && String(e.detail).includes('state=failed')));
  });
});

describe('LG-058 STE 增补案：pull 坏密文条目（decrypt_failed 行为面）', () => {
  it('坏密文启用条目：跳过+warnings 恰一条+skipped=1 入 detail；好条目不受累', async () => {
    const cardPath = seedCard('rmc');
    const doc = JSON.parse(readFileSync(cardPath, 'utf-8')) as TrimmcCardDocument;
    // 布景坏密文：'AAAA'=有效 base64 非法密文（3B——decrypt 的 iv subarray(0,12)
    // 短字节→createDecipheriv 必 throw；key-encryptor.ts L59-67）。saveCard 原样
    // 序列化不重加密，post-edit 安全。
    doc.provider_entries['e2'] = { ...buildEntry('kimi', 'kimi-model', 'sk-bad-cipher-0000000', true), api_key_encrypted: 'AAAA' };
    saveCard(doc, cardPath);

    const r = await req('GET', '/v1/config/cards/rmc?view=pull', `Bearer ${API_TOKEN}`);
    assert.equal(r.statusCode, 200);
    const body = r.body as { card_present: boolean; entries: Record<string, { api_key: string }>; warnings: string[] };
    assert.equal(body.card_present, true);
    assert.equal(body.entries['e2'], undefined, '坏密文条目不进载荷');
    assert.equal(body.entries['e1']?.api_key, 'sk-test-sandbox-key-000000', '好条目明文不受累');
    assert.equal(body.warnings.length, 1, `warnings 恰一条：${JSON.stringify(body.warnings)}`);
    assert.match(body.warnings[0], /entry 'e2' undecryptable in server domain/);

    // 行为面形态固化（现势：审计 result=ok+skipped 计数入 detail；无 reason=
    // decrypt_failed 事件——候 CTO 裁后随裁更新本断言）。
    const evt = readEvents().filter((e) => e.etype === 'pull' && e.face === 'rmc' && e.result === 'ok');
    assert.ok(evt.some((e) => String(e.detail).includes('skipped=1')), `skipped=1 入 detail：${JSON.stringify(evt.at(-1))}`);
    assert.ok(!readEvents().some((e) => e.reason === 'decrypt_failed'), '现势无 decrypt_failed 事件（emit 点缺——§九 对表发现固化）');
  });
});

describe('LG-058 STE 增补案：apply 无卡（apply_rejected 行为面）', () => {
  it('卡缺席 apply：404+零 apply 审计行（现势无 apply_rejected 事件）', async () => {
    const before = readEvents().filter((e) => e.etype === 'apply').length;
    const r = await req('POST', '/v1/config/cards/rlc/apply', `Bearer ${ADMIN}`);
    assert.equal(r.statusCode, 404);
    const afterN = readEvents().filter((e) => e.etype === 'apply').length;
    assert.equal(afterN, before, 'apply 失败不落审计行');
    assert.ok(!readEvents().some((e) => e.reason === 'apply_rejected'), '现势无 apply_rejected 事件（emit 点缺——§九 对表发现固化）');
  });
});
