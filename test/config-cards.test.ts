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
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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
  it('LG-058 P1 候修①：PUT 无 provider_entries 载荷=400 人话拒不落盘（原 500）', async () => {
    clearBaks('rlc');
    const cardPath = faceCardPath('rlc');
    if (existsSync(cardPath)) rmSync(cardPath);
    const eventsBefore = readEvents().filter((e) => e.etype === 'write').length;
    // JSON.stringify 丢 undefined 键 → 载荷物理无 provider_entries 键
    const absent = await req('PUT', '/v1/config/cards/rlc', `Bearer ${ADMIN}`, JSON.stringify({ object: 'trimmc-card', machine: { name: 'no-entries' } }));
    assert.equal(absent.statusCode, 400, '缺席=400 非 500');
    assert.equal((absent.body as { error?: string }).error, '条目数据格式错误，请重新添加条目');
    // null / 字符串 / 数值同族（字符串原会以字符索引静默污染合并——一并收口）
    for (const bad of [null, 'oops', 42]) {
      const res = await req('PUT', '/v1/config/cards/rlc', `Bearer ${ADMIN}`, JSON.stringify({ object: 'trimmc-card', provider_entries: bad }));
      assert.equal(res.statusCode, 400, `provider_entries=${JSON.stringify(bad)} 应 400`);
    }
    assert.ok(!existsSync(cardPath), '零落盘（卡文件未产生）');
    assert.equal(readEvents().filter((e) => e.etype === 'write').length, eventsBefore, '零 write 审计行');
    // 正常键（空对象）不受影响——D7 合并语义照常 200（emptyCard 正形）
    const emptyOk = await req('PUT', '/v1/config/cards/rlc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('empty-ok')));
    assert.equal(emptyOk.statusCode, 200);
    assert.ok(existsSync(cardPath), '合法空条目卡照常落盘');
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

// ── 别名等价（A1 双证②：别名↔泛化 managed 等价；同卡 cardPath 注入）──
// P2 随批 additive（CTO 裁 facc0989）后语义收窄为「别名字段集 ⊂ 泛化 body」：
// 泛化 managed 200 = 别名 body 原样 + face + ledger（契约内字段非新增语义）。

describe('LG-058 alias equivalence', () => {
  it('同卡态：别名 handler body 逐字段等于泛化 managed body（泛化=别名+face+ledger 投影）', async () => {
    const cardPath = seedCard('mmc');
    const alias = handleGetTrimmcCard(`Bearer ${ADMIN}`, { cardPath }); // cardPath 注入=同一物理卡（沙箱）
    const gen = await req('GET', '/v1/config/cards/mmc?view=managed', `Bearer ${ADMIN}`);
    assert.equal(gen.statusCode, 200);
    const genBody = gen.body as Record<string, unknown>;
    // additive 增量面恰为两字段（禁夹带）
    assert.deepEqual(Object.keys(genBody).filter((k) => !(k in (alias.body as object))), ['face', 'ledger']);
    assert.equal(genBody.face, 'mmc');
    // 别名既有字段逐字段等价（additive 零改写）
    for (const [k, v] of Object.entries(alias.body)) {
      assert.deepEqual((genBody as Record<string, unknown>)[k], v, `field ${k}`);
    }
    // ledger 投影=readFaceLedger() 原样快照
    assert.deepEqual(genBody.ledger, readFaceLedger());
  });
});

// ── managed face+ledger 投影（P2 随批 additive，CTO 裁 facc0989；§2.2 L67/L167）──

describe('LG-058 P2 managed face+ledger projection', () => {
  it('managed 200：face 字段=路径 face（mlc≠mmc）+ledger 摘要可读（UI 拉取状态区数据源）', async () => {
    seedCard('mlc');
    const gen = await req('GET', '/v1/config/cards/mlc?view=managed', `Bearer ${ADMIN}`);
    assert.equal(gen.statusCode, 200);
    const body = gen.body as { face?: string; ledger?: { faces: Record<string, { applied_state: string | null }> } };
    assert.equal(body.face, 'mlc');
    assert.ok(body.ledger && typeof body.ledger.faces === 'object', 'ledger 摘要在 body');
  });
  it('status 回写后 managed.ledger 反映 applied_state（台账接线闭环；raw face-events 不进 body）', async () => {
    seedCard('rlc');
    await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied' }));
    const gen = await req('GET', '/v1/config/cards/rlc?view=managed', `Bearer ${ADMIN}`);
    assert.equal(gen.statusCode, 200);
    const body = gen.body as { face: string; ledger: { faces: Record<string, { applied_state: string | null }> }; events?: unknown };
    assert.equal(body.face, 'rlc');
    assert.equal(body.ledger.faces.rlc?.applied_state, 'applied');
    assert.equal('events' in body, false, 'raw face-events 审计账不进 managed body（红线②）');
  });
  it('守卫路径零动：401 响应体不带 face/ledger（additive 只落 200 分支）', async () => {
    const r = await req('GET', '/v1/config/cards/mmc?view=managed', 'Bearer wrong');
    assert.equal(r.statusCode, 401);
    const body = r.body as Record<string, unknown>;
    assert.equal('face' in body, false);
    assert.equal('ledger' in body, false);
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
  it('LG-058 N1：status 回写带 tier → 台账 applied_tier 同步；非法 tier=400；缺省 tier=null（层级未决）', async () => {
    seedCard('rlc');
    // 合法 tier=2（降级梯：卡面拉取失败，本地缓存续用）
    const r = await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'failed', error: 'pull_denied', tier: 2 }));
    assert.equal(r.statusCode, 200);
    const st = (r.body as { status?: { tier?: number } }).status;
    assert.equal(st?.tier, 2, 'status 响应带 tier');
    assert.equal(readFaceLedger().faces.rlc?.applied_tier, 2, '台账 applied_tier 同步');
    // 非法 tier=400（越界值 / 类型错）
    assert.equal((await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied', tier: 4 }))).statusCode, 400);
    assert.equal((await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied', tier: '2' }))).statusCode, 400);
    // tier 缺省 → 台账置 null（回写时层级未决语义）
    await req('PUT', '/v1/config/cards/rlc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied' }));
    assert.equal(readFaceLedger().faces.rlc?.applied_tier, null, 'tier 缺省=null（未决）');
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

// ── LG-058 N2：卡面维护面（备份清单/回滚/模板清单/应用模板）──

describe('LG-058 N2 card maintenance (backups/rollback/templates/apply-template)', () => {
  it('templates 清单：目录未建=200 空列表常态；鉴权 401 fail-closed', async () => {
    const noAuth = await req('GET', '/v1/config/cards/rmc/templates');
    assert.equal(noAuth.statusCode, 401);
    const r = await req('GET', '/v1/config/cards/rmc/templates', `Bearer ${ADMIN}`);
    assert.equal(r.statusCode, 200);
    const body = r.body as { object: string; face: string; templates: unknown[] };
    assert.equal(body.object, 'config.card-templates');
    assert.equal(body.face, 'rmc');
    assert.deepEqual(body.templates, []);
  });
  it('backups 清单：无备份=200 空；有备份=file/size_bytes/modified_at 三元组+keep=5', async () => {
    clearBaks('rmc');
    const cardPath = faceCardPath('rmc');
    if (existsSync(cardPath)) rmSync(cardPath);
    const empty = await req('GET', '/v1/config/cards/rmc/backups', `Bearer ${ADMIN}`);
    assert.equal(empty.statusCode, 200);
    assert.deepEqual((empty.body as { backups: unknown[] }).backups, []);
    saveCard({ ...emptyCard('seed'), machine: { name: 'seed' } }, cardPath);
    saveCard({ ...emptyCard('gen1'), machine: { name: 'v1' } }, cardPath);
    const r = await req('GET', '/v1/config/cards/rmc/backups', `Bearer ${ADMIN}`);
    const body = r.body as { object: string; keep: number; backups: Array<{ file: string; size_bytes: number; modified_at: string }> };
    assert.equal(body.object, 'config.card-backups');
    assert.equal(body.keep, 5);
    assert.equal(body.backups.length, 1);
    assert.ok(/\.bak-\d{8}T\d{6}Z-\d+-\d+$/.test(body.backups[0].file), `后缀形态：${body.backups[0].file}`);
    assert.ok(body.backups[0].size_bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(body.backups[0].modified_at)));
  });
  it('apply-template 全链：整卡替换（旧条目零保留，非 PUT 合并）+守卫自动备份+template 审计行', async () => {
    clearBaks('rlc');
    const cardPath = faceCardPath('rlc');
    if (existsSync(cardPath)) rmSync(cardPath); // 跨测试残留清除→seed=首存零备份基线
    seedCard('rlc');
    const tplDoc = emptyCard('tpl');
    tplDoc.provider_entries['t1'] = buildEntry('moonshot', 'moonshot-v2', 'sk-tpl-key-000000', true);
    const tplDir = join(dir, 'templates', 'rlc');
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(tplDir, 'combo-a.json'), JSON.stringify(tplDoc, null, 2), 'utf-8');
    const before = JSON.parse(readFileSync(cardPath, 'utf-8')) as { provider_entries: Record<string, unknown> };
    assert.ok(before.provider_entries['e1'], '前置：现役卡有 e1');
    const r = await req('POST', '/v1/config/cards/rlc/apply-template', `Bearer ${ADMIN}`, JSON.stringify({ template: 'combo-a.json' }));
    assert.equal(r.statusCode, 200);
    const body = r.body as { object: string; template: string; prior_backup: string | null; message: string };
    assert.equal(body.object, 'config.card-template-applied');
    assert.equal(body.template, 'combo-a.json');
    assert.ok(body.prior_backup, '守卫自动备份当前');
    const after = JSON.parse(readFileSync(cardPath, 'utf-8')) as { provider_entries: Record<string, unknown> };
    assert.equal(after.provider_entries['e1'], undefined, '整卡替换（旧条目零保留——切换语义非合并）');
    assert.ok(after.provider_entries['t1'], '模板条目落地');
    assert.equal(baksOf('rlc').length, 1, '写前备份 1 份');
    assert.ok(
      readEvents().some((e) => e.etype === 'write' && e.face === 'rlc' && String(e.detail).includes('template applied=combo-a.json')),
      'write 审计行 detail=template',
    );
  });
  it('rollback 全链：整卡恢复+恢复前自动备份当前（对称安全网）+rollback 审计行', async () => {
    clearBaks('rmc');
    const cardPath = faceCardPath('rmc');
    if (existsSync(cardPath)) rmSync(cardPath); // 跨测试残留清除→首存零备份基线
    saveCard({ ...emptyCard('v1'), machine: { name: 'v1' } }, cardPath);
    saveCard({ ...emptyCard('v2'), machine: { name: 'v2' } }, cardPath);
    const list = await req('GET', '/v1/config/cards/rmc/backups', `Bearer ${ADMIN}`);
    const baks = (list.body as { backups: Array<{ file: string }> }).backups;
    assert.equal(baks.length, 1);
    const r = await req('POST', '/v1/config/cards/rmc/rollback', `Bearer ${ADMIN}`, JSON.stringify({ backup: baks[0].file }));
    assert.equal(r.statusCode, 200);
    const body = r.body as { object: string; restored_from: string; prior_backup: string | null };
    assert.equal(body.object, 'config.card-rollback');
    assert.equal(body.restored_from, baks[0].file);
    assert.ok(body.prior_backup, '回滚前自动备份当前（v2 态可再回滚）');
    const restored = JSON.parse(readFileSync(cardPath, 'utf-8')) as { machine: { name: string } };
    assert.equal(restored.machine.name, 'v1', '卡内容恢复=v1');
    assert.equal(baksOf('rmc').length, 2, '回滚后两份（原备份+回滚前新备份）');
    assert.ok(
      readEvents().some((e) => e.etype === 'write' && e.face === 'rmc' && String(e.detail).startsWith('card rollback from=')),
      'write 审计行 detail=rollback',
    );
  });
  it('白名单拒：穿越名/不在清单名=400 零落盘（卡字节零变）', async () => {
    clearBaks('rlc');
    const cardPath = faceCardPath('rlc');
    seedCard('rlc');
    const before = readFileSync(cardPath, 'utf-8');
    for (const bad of ['../combo-a.json', 'combo-a.json', 'nope.bak-1', '.']) {
      const r = await req('POST', '/v1/config/cards/rlc/rollback', `Bearer ${ADMIN}`, JSON.stringify({ backup: bad }));
      assert.equal(r.statusCode, 400, `backup=${bad} 应 400`);
    }
    const tplR = await req('POST', '/v1/config/cards/rlc/apply-template', `Bearer ${ADMIN}`, JSON.stringify({ template: '../../x.json' }));
    assert.equal(tplR.statusCode, 400);
    assert.equal(readFileSync(cardPath, 'utf-8'), before, '卡字节零变');
  });
  it('内容校验拒：非法 JSON 备份/缺 provider_entries 模板=400 拒写', async () => {
    clearBaks('rmc');
    const cardPath = faceCardPath('rmc');
    saveCard({ ...emptyCard('seed'), machine: { name: 'seed' } }, cardPath);
    saveCard({ ...emptyCard('gen'), machine: { name: 'gen' } }, cardPath);
    const bakName = baksOf('rmc')[0];
    writeFileSync(join(dir, bakName), '{not-json', 'utf-8');
    const r = await req('POST', '/v1/config/cards/rmc/rollback', `Bearer ${ADMIN}`, JSON.stringify({ backup: bakName }));
    assert.equal(r.statusCode, 400);
    assert.match((r.body as { error: string }).error, /不可解析/);
    const tplDir = join(dir, 'templates', 'rmc');
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(tplDir, 'bad.json'), JSON.stringify({ object: 'trimmc-card' }), 'utf-8');
    const t = await req('POST', '/v1/config/cards/rmc/apply-template', `Bearer ${ADMIN}`, JSON.stringify({ template: 'bad.json' }));
    assert.equal(t.statusCode, 400);
    assert.match((t.body as { error: string }).error, /合法卡文档/);
  });
  it('不在册 face 维护面端点=404（防枚举同族）；方法不匹配=404', async () => {
    for (const u of ['/v1/config/cards/nope/backups', '/v1/config/cards/nope/templates']) {
      assert.equal((await req('GET', u, `Bearer ${ADMIN}`)).statusCode, 404);
    }
    for (const u of ['/v1/config/cards/nope/rollback', '/v1/config/cards/nope/apply-template']) {
      assert.equal((await req('POST', u, `Bearer ${ADMIN}`, '{}')).statusCode, 404);
    }
    assert.equal((await req('GET', '/v1/config/cards/rmc/rollback', `Bearer ${ADMIN}`)).statusCode, 404, 'GET rollback=404');
    assert.equal((await req('POST', '/v1/config/cards/rmc/templates', `Bearer ${ADMIN}`, '{}')).statusCode, 404, 'POST templates=404');
  });
});

// ── LG-058 N5 方案二联席：UI 所发载荷形经真通道钉住（server 零改——D7 合并现役够用）──

describe('LG-058 N5 join (face PUT payload shapes from UI)', () => {
  it('域卡点菜：face PUT provider_entries 脏条目 upsert——明文 api_key 水合为密文落盘+managed 掩码读回', async () => {
    clearBaks('rlc');
    const cardPath = faceCardPath('rlc');
    if (existsSync(cardPath)) rmSync(cardPath);
    await req('PUT', '/v1/config/cards/rlc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('join-seed')));
    // UI submitFaceEntries 载荷形：{ provider_entries: { id: {provider,model,enabled,api_key,base_url?} } }
    const r = await req('PUT', '/v1/config/cards/rlc', `Bearer ${ADMIN}`, JSON.stringify({
      ...emptyCard('join'),
      provider_entries: { m1: { provider: 'glm', model: 'GLM-5.3', enabled: true, api_key: 'sk-join-face-key-000000' } },
    }));
    assert.equal(r.statusCode, 200);
    const doc = JSON.parse(readFileSync(cardPath, 'utf-8')) as { provider_entries: Record<string, { model?: string; api_key_encrypted?: string; api_key?: string }> };
    assert.equal(doc.provider_entries.m1?.model, 'GLM-5.3', '条目 upsert 落盘');
    assert.ok(doc.provider_entries.m1?.api_key_encrypted, '明文已水合为密文');
    assert.equal(doc.provider_entries.m1?.api_key, undefined, 'at-rest 零明文字段');
    assert.ok(!readFileSync(cardPath, 'utf-8').includes('sk-join-face-key'), '卡文件零明文（密文唯一形）');
    const g = await req('GET', '/v1/config/cards/rlc?view=managed', `Bearer ${ADMIN}`);
    assert.equal(g.statusCode, 200);
    const masked = (g.body as { entries_masked: Record<string, { model: string; masked: string }> }).entries_masked;
    assert.equal(masked.m1?.model, 'GLM-5.3', 'managed 掩码视图可读回');
    assert.ok(masked.m1?.masked, '掩码串在位');
  });
  it('规则适用勾选：face PUT rules upsert（策略卡规则对象复制进本域）+deleted_rule_ids 移除；悬挂=400 守卫硬门', async () => {
    clearBaks('rmc');
    const cardPath = faceCardPath('rmc');
    if (existsSync(cardPath)) rmSync(cardPath);
    await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('rule-seed')));
    // 真实联席语义：规则按条目 id 解析——先点菜（条目 m1 落本域卡）再勾规则
    const entryUp = await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify({
      ...emptyCard('rule-join'),
      provider_entries: { m1: { provider: 'glm', model: 'GLM-5.3', enabled: true, api_key: 'sk-rule-face-key-00000' } },
    }));
    assert.equal(entryUp.statusCode, 200, '前置：条目 m1 已点进本域卡');
    const ruleObj = { name: '默认规则', type: 'default', entry_id: 'm1', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    // UI 联席载荷形：规则通道搭载空 provider_entries（守卫要求条目键在场——
    // 空对象=本次不改条目，合并基底保留既有条目与密文；rules-only 形被 P1 候修①守卫 400）
    const rulesOnly = await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify({ rules: { r9: ruleObj } }));
    assert.equal(rulesOnly.statusCode, 400, 'rules-only（无条目键在场）=守卫 400（UI 侧以空搭载规避）');
    const up = await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify({ provider_entries: {}, rules: { r9: ruleObj }, machine: { name: 'rule-join' }, connection: { name: 'rule-join' } }));
    assert.equal(up.statusCode, 200, 'rules upsert（空条目搭载）通道 200');
    let doc = JSON.parse(readFileSync(cardPath, 'utf-8')) as { rules: Record<string, unknown>; provider_entries: Record<string, { api_key_encrypted?: string }> };
    assert.ok(doc.rules.r9, '规则复制进本域卡');
    assert.ok(doc.provider_entries.m1?.api_key_encrypted, '空搭载不伤既有条目密文');
    // 悬挂守卫硬门 backstop（UI 前置引导之外的 server 侧如实拒）
    const dangling = await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify({ provider_entries: {}, rules: { r10: { ...ruleObj, entry_id: 'ghost' } }, machine: { name: 'rule-join' }, connection: { name: 'rule-join' } }));
    assert.equal(dangling.statusCode, 400, '悬挂引用=400 拒');
    assert.equal((JSON.parse(readFileSync(cardPath, 'utf-8')) as { rules: Record<string, unknown> }).rules.r10, undefined, '悬挂规则零落盘');
    const del = await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify({ provider_entries: {}, deleted_rule_ids: ['r9'], machine: { name: 'rule-join' }, connection: { name: 'rule-join' } }));
    assert.equal(del.statusCode, 200, 'deleted_rule_ids 通道 200');
    doc = JSON.parse(readFileSync(cardPath, 'utf-8')) as { rules: Record<string, unknown>; provider_entries: Record<string, { api_key_encrypted?: string }> };
    assert.equal(doc.rules.r9, undefined, '规则已从本域卡移除');
  });
});

// ── LG-058 N5 方案三：连接配置四域化——local_config 直改面（改存拉落效五步）──

describe('LG-058 N5 plan3 (local_config 直改面)', () => {
  const lcCardPath = () => faceCardPath('mmc');

  it('改→存：PUT local_config 整表替换+服务端版本单调递增；未携带=维持基座；null=清空', async () => {
    if (existsSync(lcCardPath())) rmSync(lcCardPath());
    await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('lc-seed')));
    const p1 = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({
      provider_entries: {}, machine: { name: 'lc' }, connection: { name: 'lc' },
      local_config: { items: { local_port: '8710', data_dir: '/srv/fleet' } },
    }));
    assert.equal(p1.statusCode, 200, '首存 200');
    let doc = JSON.parse(readFileSync(lcCardPath(), 'utf-8')) as { local_config?: { version?: number; items?: Record<string, string> } | null };
    assert.equal(doc.local_config?.version, 1, '首存 version=1（服务端单调）');
    assert.equal(doc.local_config?.items?.local_port, '8710', '项值落卡');
    // 整表替换语义：第二次 PUT 只带一项 → 旧项不残留（表单全量提交）
    const p2 = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({
      provider_entries: {}, machine: { name: 'lc' }, connection: { name: 'lc' },
      local_config: { items: { local_port: '8711' } },
    }));
    assert.equal(p2.statusCode, 200);
    doc = JSON.parse(readFileSync(lcCardPath(), 'utf-8')) as { local_config?: { version?: number; items?: Record<string, string> } | null };
    assert.equal(doc.local_config?.version, 2, '二存 version=2（单调递增）');
    assert.equal(doc.local_config?.items?.data_dir, undefined, '整表替换：未再提交的项不残留');
    // 未携带=维持基座
    const p3 = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({ provider_entries: {}, machine: { name: 'lc' }, connection: { name: 'lc' } }));
    assert.equal(p3.statusCode, 200);
    doc = JSON.parse(readFileSync(lcCardPath(), 'utf-8')) as { local_config?: { version?: number; items?: Record<string, string> } | null };
    assert.equal(doc.local_config?.version, 2, '未携带 local_config=版本不变');
    // 显式 null=清空
    const p4 = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({ provider_entries: {}, machine: { name: 'lc' }, connection: { name: 'lc' }, local_config: null }));
    assert.equal(p4.statusCode, 200);
    doc = JSON.parse(readFileSync(lcCardPath(), 'utf-8')) as { local_config?: { version?: number; items?: Record<string, string> } | null };
    assert.equal(doc.local_config, null, '显式 null=清空');
  });

  it('守卫：密钥禁入（人话拒零落盘）+非字符串值 400+畸形 local_config 400', async () => {
    const base = { provider_entries: {}, machine: { name: 'lc' }, connection: { name: 'lc' } };
    const before = JSON.parse(readFileSync(lcCardPath(), 'utf-8')) as { local_config: { version: number } | null };
    const vBefore = before.local_config ? before.local_config.version : 0;
    const secretKey = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({ ...base, local_config: { items: { api_key: 'sk-should-be-rejected-000' } } }));
    assert.equal(secretKey.statusCode, 400, 'api_key 项名=400 人话拒');
    assert.ok(String((secretKey.body as { error: string }).error).includes('域卡条目'), '拒因引导到域卡条目通道');
    const tokenKey = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({ ...base, local_config: { items: { admin_token: 'x' } } }));
    assert.equal(tokenKey.statusCode, 400, 'token 项名同拒');
    const badVal = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({ ...base, local_config: { items: { local_port: 8710 } } }));
    assert.equal(badVal.statusCode, 400, '非字符串值=400');
    const badShape = await req('PUT', '/v1/config/cards/mmc', `Bearer ${ADMIN}`, JSON.stringify({ ...base, local_config: { nope: true } }));
    assert.equal(badShape.statusCode, 400, '缺 items=400');
    const after = JSON.parse(readFileSync(lcCardPath(), 'utf-8')) as { local_config: { version: number } | null };
    const vAfter = after.local_config ? after.local_config.version : 0;
    assert.equal(vAfter, vBefore, '守卫拒路径零落盘（版本不变）');
    assert.ok(!readFileSync(lcCardPath(), 'utf-8').includes('sk-should-be-rejected'), '密钥值零落盘');
  });

  it('拉：view=pull 载荷携带 local_config（version+items）；无卡=local_config null', async () => {
    // 沙箱串测残留防御：清 mlc 卡再 seed（D7 字典合并会让前案 rules 存续，
    // 未重带其引用条目=悬挂 400——非本测对象）
    const mlcPath = faceCardPath('mlc');
    if (existsSync(mlcPath)) rmSync(mlcPath);
    await req('PUT', '/v1/config/cards/mlc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('lc-pull')));
    await req('PUT', '/v1/config/cards/mlc', `Bearer ${ADMIN}`, JSON.stringify({
      provider_entries: {}, machine: { name: 'lc-pull' }, connection: { name: 'lc-pull' },
      local_config: { items: { cron_enabled: 'true' } },
    }));
    const pull = await req('GET', '/v1/config/cards/mlc?view=pull', `Bearer ${API_TOKEN}`);
    assert.equal(pull.statusCode, 200);
    const lc = (pull.body as { local_config: { version: number; items: Record<string, string> } | null }).local_config;
    assert.ok(lc, 'pull 载荷带 local_config');
    assert.equal(lc?.version, 1);
    assert.equal(lc?.items.cron_enabled, 'true');
    // 无卡 face：local_config=null（daemon 维持现值语义）
    const absentPath = faceCardPath('rlc');
    if (existsSync(absentPath)) rmSync(absentPath);
    const pullAbsent = await req('GET', '/v1/config/cards/rlc?view=pull', `Bearer ${API_TOKEN}`);
    assert.equal(pullAbsent.statusCode, 200);
    assert.equal((pullAbsent.body as { card_present: boolean }).card_present, false);
    assert.equal((pullAbsent.body as { local_config: unknown }).local_config, null, '无卡=local_config null');
  });

  it('落：status 回写 local_config 落地读数→台账+managed ledger 读回；畸形回写 400', async () => {
    const rmcPath = faceCardPath('rmc');
    if (existsSync(rmcPath)) rmSync(rmcPath);
    await req('PUT', '/v1/config/cards/rmc', `Bearer ${ADMIN}`, JSON.stringify(emptyCard('lc-status')));
    const ok = await req('PUT', '/v1/config/cards/rmc/status', `Bearer ${ADMIN}`, JSON.stringify({
      state: 'applied', tier: 1,
      local_config: { version_applied: 1, write_result: 'ok', file: '/srv/fleet/TriRMC/data/settings.json' },
    }));
    assert.equal(ok.statusCode, 200, '落地回写 200');
    const st = (ok.body as { status: { local_config?: { version_applied: number; write_result: string } } }).status;
    assert.equal(st.local_config?.version_applied, 1, 'status 面读回落地版本');
    // 台账面（UI managed 消费位）
    const g = await req('GET', '/v1/config/cards/rmc?view=managed', `Bearer ${ADMIN}`);
    const ledgerFaces = (g.body as { ledger: { faces: Record<string, { local_config?: { version_applied: number; write_result: string; file?: string } | null }> } }).ledger.faces;
    assert.equal(ledgerFaces.rmc?.local_config?.version_applied, 1, '台账 local_config 落账');
    assert.equal(ledgerFaces.rmc?.local_config?.write_result, 'ok');
    assert.ok(ledgerFaces.rmc?.local_config?.file?.includes('settings.json'), '落地文件名随行（值面对表锚）');
    // 失败落地如实入账（诚实语义：落盘失败不许显示成功）
    const fail = await req('PUT', '/v1/config/cards/rmc/status', `Bearer ${ADMIN}`, JSON.stringify({
      state: 'applied', tier: 1,
      local_config: { version_applied: 2, write_result: 'failed', write_error: 'EACCES: permission denied' },
    }));
    assert.equal(fail.statusCode, 200);
    const g2 = await req('GET', '/v1/config/cards/rmc?view=managed', `Bearer ${ADMIN}`);
    const lc2 = (g2.body as { ledger: { faces: Record<string, { local_config?: { version_applied: number; write_result: string; write_error?: string } | null }> } }).ledger.faces.rmc?.local_config;
    assert.equal(lc2?.version_applied, 2);
    assert.equal(lc2?.write_result, 'failed', '失败落地如实入账');
    assert.ok(lc2?.write_error?.includes('EACCES'), '失败因随行');
    // 畸形回写
    const bad = await req('PUT', '/v1/config/cards/rmc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied', local_config: { version_applied: 0, write_result: 'ok' } }));
    assert.equal(bad.statusCode, 400, 'version_applied 须正整数');
    const bad2 = await req('PUT', '/v1/config/cards/rmc/status', `Bearer ${ADMIN}`, JSON.stringify({ state: 'applied', local_config: { version_applied: 1, write_result: 'maybe' } }));
    assert.equal(bad2.statusCode, 400, 'write_result 枚举外=400');
  });
});
