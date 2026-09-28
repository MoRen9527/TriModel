// ── LG-058 P0 泛化卡面端点族 tests ──
// Covers（STE 测试方案 §二 L1 对齐；seam①②④ 消费面）：
//   face registry 四值常量 / 归因码枚举导出 / face 不在册 404（防枚举 T3）/
//   view 非法 400 / managed 鉴权三态（503 fail-closed/401/200）/ pull 鉴权
//   （api-token fail-closed + P0 通配态 + FACE_TOKENS 绑定态）/ pull 载荷
//   （明文仅响应生命周期/禁用条目不进载荷/卡缺席 card_present=false）/
//   pull 台账+审计行 / PUT 守卫链（备份产生+write 审计）/ 备份唯一性后缀
//   同毫秒双写（T4 硬断言）/ keep=5 轮换 / FROZEN-BACKUPS 哨兵豁免 /
//   幂等短路 / 别名↔泛化 managed 逐字段等价 / status 回写台账同步 /
//   apply 审计行 / face-events len-only 值面扫描（A2 前置自证）。
// 全部写实弹在沙箱（TRIMODEL_DATA_DIR/TRIMODEL_CARDS_DIR/TRIMODEL_POLICIES_DIR
// 钉 mkdtemp；活体生产面零接触=T7——别名等价案同卡对表经 cardPath 注入，
// 不触 canonical 活卡路径）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { dispatch } from '../src/api/routes.js';
import { handleGetTrimmcCard } from '../src/api/trimmc-card.js';
import { effectiveModel } from '../src/policy.js';
import { FACES, FACE_IDS, ATTRIBUTION_CODES, isRegisteredFace, faceCardPath, readFaceLedger, faceEventsPath } from '../src/card-faces.js';
import { buildEntry, emptyCard, saveCard, setActiveStrategy, upsertStrategy } from '../src/trimmc-card.js';
import type { TrimmcCardDocument } from '../src/trimmc-card.js';
import type { ModelClient } from '../src/client.js';

const CLIENT = null as unknown as ModelClient;
const ADMIN = 'test-admin-token-lg058';
const API_TOKEN = 'test-api-token-lg058';

let dir: string;
const prevEnv: Record<string, string | undefined> = {};

function pinEnv(key: string, value: string | undefined): void {
  if (!(key in prevEnv)) prevEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'trimodel-config-cards-test-'));
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

// ── 沙箱布景 ──

/** 布景一张带策略链的沙箱卡（绕守卫直写）；返回物理路径。 */
function seedCard(face: 'mmc' | 'mlc' | 'rmc' | 'rlc'): string {
  const cardPath = faceCardPath(face);
  const doc: TrimmcCardDocument = emptyCard('sandbox');
  const entry = buildEntry('deepseek', 'deepseek-v4-pro', 'sk-test-sandbox-key-000000', true);
  doc.provider_entries['e1'] = entry;
  doc.rules['r1'] = { name: '默认规则', type: 'default', entry_id: 'e1', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  upsertStrategy(doc, 's1', { name: '沙箱策略', model_set_id: 'ms-sandbox', rule_ids: ['r1'], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  setActiveStrategy(doc, 's1');
  doc.default_model = 'deepseek-v4-pro'; // 模拟 apply 后派生缓存态
  saveCard(doc, cardPath);
  return cardPath;
}

function clearBaks(face: 'mmc' | 'mlc' | 'rmc' | 'rlc'): void {
  const prefix = `${FACES[face].card_file}.bak-`;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(prefix)) rmSync(join(dir, f));
  }
}

function baksOf(face: 'mmc' | 'mlc' | 'rmc' | 'rlc'): string[] {
  const prefix = `${FACES[face].card_file}.bak-`;
  return readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
}

async function req(method: string, url: string, auth?: string, body?: string) {
  return dispatch(CLIENT, method, url, auth ? { authorization: auth } : {}, body);
}

function readEvents(): Array<Record<string, unknown>> {
  const p = faceEventsPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** len-only 值面递归扫描：值面 sk- 前缀键材零命中（A2 同款断言）。 */
function scanLenOnly(obj: unknown, hits: string[] = []): string[] {
  if (typeof obj === 'string') {
    if (obj.startsWith('sk-')) hits.push(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) scanLenOnly(v, hits);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) scanLenOnly(v, hits);
  }
  return hits;
}

// ── seam②④：registry 与归因码常量 ──

describe('LG-058 face registry seam', () => {
  it('FACES 四值常量可 import（face_id/display/card_file/plane/domain 元组齐）', () => {
    assert.deepEqual([...FACE_IDS].sort(), ['mlc', 'mmc', 'rlc', 'rmc']);
    assert.equal(FACES.mmc.card_file, 'trimmc-card.json'); // mmc=现役文件名原位（别名保留文件面延伸）
    assert.equal(FACES.mlc.card_file, 'trimlc-card.json');
    assert.equal(FACES.rmc.card_file, 'trirmc-card.json');
    assert.equal(FACES.rlc.card_file, 'trirlc-card.json');
    for (const f of FACE_IDS) {
      assert.equal(FACES[f].face_id, f);
      assert.ok(FACES[f].display.length > 0);
      assert.ok(['service', 'local'].includes(FACES[f].plane));
      assert.ok(['M', 'R'].includes(FACES[f].domain));
    }
  });
  it('归因码枚举三值（seam④）+ isRegisteredFace 判定', () => {
    assert.deepEqual([...ATTRIBUTION_CODES], ['pull_denied', 'decrypt_failed', 'apply_rejected']);
    assert.equal(isRegisteredFace('mmc'), true);
    assert.equal(isRegisteredFace('MMC'), false); // 大小写敏感（防枚举）
    assert.equal(isRegisteredFace(''), false);
    assert.equal(isRegisteredFace('../etc'), false);
  });
});

// ── face 校验守卫（T3 防枚举）+ view 形态 ──

describe('LG-058 generalized endpoints: face guard + view', () => {
  it('不在册 face=404（大写/穿越/编码串均 404 非 401——防枚举语义）', async () => {
    for (const face of ['MMC', 'nope', '..%2Fetc%2Fpasswd', 'mmc%2f..']) {
      const r = await req('GET', `/v1/config/cards/${face}?view=pull`, `Bearer ${API_TOKEN}`);
      assert.equal(r.statusCode, 404, `face=${face}`);
    }
  });
  it('view 非法=400；view 缺省=managed 语义（admin 门）', async () => {
    const bad = await req('GET', '/v1/config/cards/mmc?view=nope', `Bearer ${ADMIN}`);
    assert.equal(bad.statusCode, 400);
    const def = await req('GET', '/v1/config/cards/mmc', `Bearer ${ADMIN}`);
    assert.equal(def.statusCode, 200);
    assert.equal((def.body as { object: string }).object, 'config.trimmc-card');
  });
  it('方法不匹配（POST 根/GET status）=404', async () => {
    assert.equal((await req('POST', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, '{}')).statusCode, 404);
    assert.equal((await req('GET', '/v1/config/cards/mmc/status')).statusCode, 404);
  });
});

// ── managed 视图鉴权三态（G3 写面 fail-closed 原样）──

describe('LG-058 managed view auth', () => {
  it('admin 未配=503 fail-closed；错 token=401；对 token=200', async () => {
    pinEnv('TRIMODEL_ADMIN_TOKEN', undefined);
    try {
      assert.equal((await req('GET', '/v1/config/cards/mlc?view=managed', 'Bearer x')).statusCode, 503);
    } finally {
      pinEnv('TRIMODEL_ADMIN_TOKEN', ADMIN);
    }
    assert.equal((await req('GET', '/v1/config/cards/mlc?view=managed', 'Bearer wrong')).statusCode, 401);
    assert.equal((await req('GET', '/v1/config/cards/mlc?view=managed', `Bearer ${ADMIN}`)).statusCode, 200);
  });
});

// ── pull 视图：鉴权+载荷+台账 ──

describe('LG-058 pull view', () => {
  it('api-token 未配=401 fail-closed（keys 同族）', async () => {
    pinEnv('TRIMODEL_API_TOKEN', undefined);
    try {
      const r = await req('GET', '/v1/config/cards/rlc?view=pull');
      assert.equal(r.statusCode, 401);
    } finally {
      pinEnv('TRIMODEL_API_TOKEN', API_TOKEN);
    }
  });
  it('P0 通配态：无 token=401+审计 denied+台账 denied；api-token 对=200（过渡态语义）', async () => {
    const denied = await req('GET', '/v1/config/cards/rlc?view=pull');
    assert.equal(denied.statusCode, 401);
    const evt = readEvents().filter((e) => e.etype === 'pull');
    assert.ok(evt.some((e) => e.result === 'denied' && e.face === 'rlc' && e.reason === 'pull_denied'));
    assert.equal(readFaceLedger().faces.rlc?.last_pull_result, 'denied');

    const ok = await req('GET', '/v1/config/cards/rlc?view=pull', `Bearer ${API_TOKEN}`);
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.body as { face: string }).face, 'rlc');
  });
  it('FACE_TOKENS 绑定态：face token 过/api-token 拒/未绑定 face 亦拒（收敛态语义）', async () => {
    pinEnv('TRIMODEL_FACE_TOKENS', 'mlc=face-tok-mlc,rlc=face-tok-rlc');
    try {
      assert.equal((await req('GET', '/v1/config/cards/mlc?view=pull', 'Bearer face-tok-mlc')).statusCode, 200);
      assert.equal((await req('GET', '/v1/config/cards/mlc?view=pull', `Bearer ${API_TOKEN}`)).statusCode, 401);
      assert.equal((await req('GET', '/v1/config/cards/mmc?view=pull', `Bearer ${API_TOKEN}`)).statusCode, 401);
    } finally {
      pinEnv('TRIMODEL_FACE_TOKENS', undefined);
    }
  });
  it('卡缺席=200 card_present:false；default_model=评估序投影照附（daemon 模型维中继）', async () => {
    const r = await req('GET', '/v1/config/cards/rmc?view=pull', `Bearer ${API_TOKEN}`);
    assert.equal(r.statusCode, 200);
    const body = r.body as { card_present: boolean; default_model: string; default_model_source: string; refresh_interval_s: number; entries: Record<string, unknown> };
    assert.equal(body.card_present, false);
    // 单真源对表（L32 基线：载荷 default_model=评估序投影，非卡静态值；
    // 生产 policy.json 在场也不破断言）
    assert.equal(body.default_model, effectiveModel().model);
    assert.equal(body.default_model_source, effectiveModel().source);
    assert.ok(Number.isFinite(body.refresh_interval_s) && body.refresh_interval_s > 0);
    assert.deepEqual(body.entries, {});
  });
  it('卡在：受控载荷=启用条目明文+default_model+策略摘要；禁用条目不进载荷', async () => {
    const cardPath = seedCard('rlc');
    const doc = JSON.parse(readFileSync(cardPath, 'utf-8')) as TrimmcCardDocument;
    doc.provider_entries['e2'] = buildEntry('kimi', 'kimi-model', 'sk-disabled-key-0000000', false);
    saveCard(doc, cardPath);

    const r = await req('GET', '/v1/config/cards/rlc?view=pull', `Bearer ${API_TOKEN}`);
    assert.equal(r.statusCode, 200);
    const body = r.body as { card_present: boolean; entries: Record<string, { api_key: string }>; default_model: string; default_model_source: string; refresh_interval_s: number; strategy: { id: string; name: string } | null; warnings: string[] };
    assert.equal(body.card_present, true);
    assert.ok(body.entries['e1'], '启用条目在载荷');
    assert.equal(body.entries['e1'].api_key, 'sk-test-sandbox-key-000000'); // 明文仅响应生命周期
    assert.equal(body.entries['e2'], undefined, '禁用条目不进载荷');
    // default_model=评估序投影（卡在分支同基线；卡 default_model 经评估序中
    // 间层仍可达——窗口未命中时 source=card-default）
    assert.equal(body.default_model, effectiveModel().model);
    assert.equal(body.default_model_source, effectiveModel().source);
    assert.ok(Number.isFinite(body.refresh_interval_s) && body.refresh_interval_s > 0);
    assert.equal(body.strategy?.id, 's1');
    assert.equal(body.strategy?.name, '沙箱策略');
  });
  it('face-ledger：pull 后 last_pull 更新（from=loopback 缺省）', async () => {
    await req('GET', '/v1/config/cards/mlc?view=pull', `Bearer ${API_TOKEN}`);
    const ledger = readFaceLedger();
    assert.equal(ledger.faces.mlc?.last_pull_result, 'ok');
    assert.equal(ledger.faces.mlc?.last_pull_from, 'loopback');
    assert.ok(ledger.faces.mlc?.last_pull_at);
  });
  it('pull face-events 行 len-only（值面 sk- 零命中）', async () => {
    const hits = scanLenOnly(readEvents().filter((e) => e.etype === 'pull'));
    assert.equal(hits.length, 0, `len-only 违规：${JSON.stringify(hits)}`);
  });
});

// ── 写路径守卫链（G5：备份先行/唯一性/轮换/哨兵/短路/审计）──

describe('LG-058 card write guard (saveCard engine-level)', () => {
  it('PUT 写生效+备份产生（唯一性后缀形态）+write 审计行', async () => {
    clearBaks('mlc');
    const cardPath = faceCardPath('mlc');
    if (existsSync(cardPath)) rmSync(cardPath);
    const put = await req('PUT', '/v1/config/cards/mlc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('first')));
    assert.equal(put.statusCode, 200);
    assert.ok(existsSync(cardPath), '卡落盘');
    assert.equal(baksOf('mlc').length, 0, '首存无备份（无 prior 文件）');
    const put2 = await req('PUT', '/v1/config/cards/mlc', `Bearer ${ADMIN}`, JSON.stringify({ ...emptyCard('gen1'), machine: { name: 'second' } }));
    assert.equal(put2.statusCode, 200);
    const baks = baksOf('mlc');
    assert.equal(baks.length, 1, `更新写产生 1 备份：${baks.join(',')}`);
    assert.ok(/\.bak-\d{8}T\d{6}Z-\d+-\d+$/.test(baks[0]), `唯一性后缀形态：${baks[0]}`);
    assert.ok(readEvents().filter((e) => e.etype === 'write' && e.face === 'mlc').length >= 2);
  });
  it('T4 同毫秒双写：备份名唯一零覆盖', async () => {
    clearBaks('rmc');
    const cardPath = faceCardPath('rmc');
    saveCard({ ...emptyCard('seed'), machine: { name: 'seed' } }, cardPath); // 首存
    saveCard({ ...emptyCard('gen-a'), machine: { name: 'a' } }, cardPath);   // 备份1
    saveCard({ ...emptyCard('gen-b'), machine: { name: 'b' } }, cardPath);   // 备份2（同毫秒内）
    const baks = baksOf('rmc');
    assert.equal(baks.length, 2, '双写=两备份');
    assert.equal(new Set(baks).size, baks.length, '备份名唯一（后缀无碰撞）');
  });
  it('keep=5 轮换：6 连写→5 份备份', async () => {
    clearBaks('rlc');
    const cardPath = faceCardPath('rlc');
    if (existsSync(cardPath)) rmSync(cardPath);
    for (let i = 0; i < 6; i++) {
      saveCard({ ...emptyCard(`gen${i}`), machine: { name: `v${i}` } }, cardPath);
    }
    assert.equal(baksOf('rlc').length, 5);
  });
  it('FROZEN-BACKUPS 哨兵豁免：哨兵在→备份仍产生但零轮换删除', async () => {
    clearBaks('mmc');
    const cardPath = faceCardPath('mmc');
    if (existsSync(cardPath)) rmSync(cardPath);
    saveCard({ ...emptyCard('seed'), machine: { name: 'seed' } }, cardPath);
    writeFileSync(join(dir, 'FROZEN-BACKUPS'), 'frozen', 'utf-8');
    try {
      for (let i = 0; i < 6; i++) {
        saveCard({ ...emptyCard(`fz${i}`), machine: { name: `fz${i}` } }, cardPath);
      }
      assert.equal(baksOf('mmc').length, 6, '哨兵在=6 份全保留（零轮换）');
    } finally {
      rmSync(join(dir, 'FROZEN-BACKUPS'));
    }
  });
  it('幂等短路：同内容重写→零新备份', async () => {
    clearBaks('rmc');
    const cardPath = faceCardPath('rmc');
    if (existsSync(cardPath)) rmSync(cardPath); // 清前案卡本体=真首存
    const doc: TrimmcCardDocument = { ...emptyCard('idem'), machine: { name: 'idem-v1' } };
    saveCard(doc, cardPath);      // 首存（无备份）
    saveCard(doc, cardPath);      // 同内容→短路（无备份）
    assert.equal(baksOf('rmc').length, 0, '无变化不写不备份');
    saveCard({ ...doc, machine: { name: 'idem-v2' } }, cardPath); // 变更→1 备份
    assert.equal(baksOf('rmc').length, 1);
  });
});

// ── 别名等价（A1 双证②：别名↔泛化 managed 逐字段等价；同卡 cardPath 注入）──

describe('LG-058 alias equivalence', () => {
  it('同卡态：别名 handler 与 /v1/config/cards/mmc?view=managed 响应逐字段等价', async () => {
    const cardPath = seedCard('mmc');
    const alias = handleGetTrimmcCard(`Bearer ${ADMIN}`, { cardPath }); // cardPath 注入=同一物理卡（沙箱）
    const gen = await req('GET', '/v1/config/cards/mmc?view=managed', `Bearer ${ADMIN}`);
    assert.equal(gen.statusCode, 200);
    assert.deepEqual(gen.body, alias.body, '逐字段等价');
  });
});

// ── status 回写+apply 审计（G6 四族事件）──

describe('LG-058 status/apply audit + ledger sync', () => {
  it('status 回写 applied→审计行+台账 applied_state 同步；非法 state=400', async () => {
    seedCard('rlc');
    const r = await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied' }));
    assert.equal(r.statusCode, 200);
    assert.ok(readEvents().some((e) => e.etype === 'status' && e.face === 'rlc' && e.result === 'ok'));
    assert.equal(readFaceLedger().faces.rlc?.applied_state, 'applied');
    assert.equal((await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'pending' }))).statusCode, 400);
  });
  it('apply 成功→apply 审计行（policies 落沙箱 TRIMODEL_POLICIES_DIR）', async () => {
    seedCard('rlc');
    const r = await req('POST', '/v1/config/cards/rlc/apply', `Bearer ${ADMIN}`);
    assert.equal(r.statusCode, 200);
    assert.ok(readEvents().some((e) => e.etype === 'apply' && e.face === 'rlc' && e.result === 'ok'));
  });
  it('CTO 裁1(甲)：status 非 200（401 错令牌）→ denied 审计行（鉴权拒=写面安全事件）', async () => {
    seedCard('mlc');
    const before = readEvents().filter((e) => e.etype === 'status' && e.face === 'mlc').length;
    const r = await req('PUT', '/v1/config/cards/mlc/status', 'Bearer wrong-token', JSON.stringify({ state: 'applied' }));
    assert.equal(r.statusCode, 401);
    const denied = readEvents().filter((e) => e.etype === 'status' && e.face === 'mlc').slice(before);
    assert.equal(denied.length, 1, 'denied 行恰好一条');
    assert.equal(denied[0].result, 'denied');
    assert.equal(denied[0].reason, 'admin_auth');
  });
  it('CTO 裁1(甲)：apply 非 200（401）→ denied 审计行；业务 4xx（400 路径）→ failed 映射', async () => {
    seedCard('rmc');
    const r = await req('POST', '/v1/config/cards/rmc/apply', 'Bearer wrong-token');
    assert.equal(r.statusCode, 401);
    assert.ok(readEvents().some((e) => e.etype === 'apply' && e.face === 'rmc' && e.result === 'denied' && e.reason === 'admin_auth'));
  });
  it('face-events 全账 len-only 值面扫描（A2 前置自证）', () => {
    const hits = scanLenOnly(readEvents());
    assert.equal(hits.length, 0, `len-only 违规：${JSON.stringify(hits)}`);
  });
});
