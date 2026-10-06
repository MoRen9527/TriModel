// ── LG-058 r5b：密钥行白名单豁免真链 E2E（BOD 2026-10-07 03:12 阻塞级派工·裁 a）──
// 缺陷：r5 表单增补后密钥行保存必 400——trimmc-card.ts 守卫黑名单正则 100% 命中
// ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY（STE 真链路实测）；jsdom 全绿+真链 400
// =「单测直调+jsdom mock」双盲（09-15 家族第三次实证）→ 本卷=真链路硬锚：
// 真 socket serve→真 dispatch 路由→PUT /v1/config/cards/rmc→落盘→双面回读。
// 裁 a 修法：守卫两键精确名白名单豁免（黑名单前置），泛拦照旧不松——
//   案1 白名单过：两键+普通键 PUT→200+落盘值面（假值）+HTTP 回读+文件回读
//   案2 黑名单仍拦：FOO_API_KEY→400+卡零污染（version 不动）
//   案3 精确名边界：小写 anthropic_auth_token→400（大小写敏感，豁免不外溢）
// 沙箱纪律同 STE 卷（T7 活体生产面零接触）：三钉位 env 钉 mkdtemp+临时端口。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dispatch } from '../src/api/routes.js';
import { faceCardPath } from '../src/card-faces.js';
import { emptyCard, saveCard } from '../src/trimmc-card.js';
import type { ModelClient } from '../src/client.js';

const CLIENT = null as unknown as ModelClient;
const ADMIN = 'test-admin-token-r5b-truechain';
const API_TOKEN = 'test-api-token-r5b-truechain';

let dir: string;
let base = '';
let httpServer: import('node:http').Server | undefined;
const prevEnv: Record<string, string | undefined> = {};

function pinEnv(key: string, value: string | undefined): void {
  if (!(key in prevEnv)) prevEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'trimodel-r5b-truechain-'));
  pinEnv('TRIMODEL_DATA_DIR', dir);
  pinEnv('TRIMODEL_CARDS_DIR', dir);
  pinEnv('TRIMODEL_POLICIES_DIR', dir);
  pinEnv('TRIMODEL_ADMIN_TOKEN', ADMIN);
  pinEnv('TRIMODEL_API_TOKEN', API_TOKEN);
  pinEnv('TRIMODEL_FACE_TOKENS', undefined);
  pinEnv('TRIMODEL_CARD_FILE', undefined);
  // 布景：沙箱 rmc 存量卡（生产现势=表单编辑既有卡——merge 基底须有
  // connection.name，emptyCard('') 空名必 400）。引擎层直写仅作 arrangement。
  const seed = emptyCard('r5b-sandbox-conn');
  saveCard(seed, faceCardPath('rmc'));
  // 真 socket serve：请求面零替身（socket→dispatch 真路由→handler→沙箱盘），
  // 唯一替身=ModelClient（本面端点不消费，e13 truechain 同族自足形）。
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const out = await dispatch(CLIENT, req.method ?? 'GET', req.url ?? '/', req.headers as Record<string, string>, Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(out.statusCode, out.headers);
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  httpServer = server;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((r) => httpServer!.close(() => r())),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 沙箱清理尽力 */ }
});

async function putRmc(items: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  // 载荷保真度=ui/index.html L1736 r5 表单 save 正形：空 provider_entries 搭载
  // （P1 候修①守卫形：键须在场，空=本次不改条目）+ local_config.items 全量替换
  const res = await fetch(`${base}/v1/config/cards/rmc`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ provider_entries: {}, local_config: { items } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('LG-058 r5b 密钥行白名单豁免真链（BOD 裁 a）', () => {

  it('案1 白名单过：两键+普通键 PUT→200+落盘值面（假值）+HTTP/文件双面回读', async () => {
    const TOKEN = 'sk-test-r5b-token-000000';
    const APIKEY = 'sk-test-r5b-apikey-000000';
    const r = await putRmc({
      ANTHROPIC_AUTH_TOKEN: TOKEN,
      ANTHROPIC_API_KEY: APIKEY,
      ANTHROPIC_BASE_URL: 'https://api-r5b.example.test',
    });
    assert.equal(r.status, 200, `白名单两键必放行（r5b 修复面）: ${JSON.stringify(r.body)}`);

    // 回读 A：HTTP GET managed（UI 表单回填走此面）→ local_config.items 值面在
    const g = await fetch(`${base}/v1/config/cards/rmc`, { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(g.status, 200);
    const gb = (await g.json()) as { card: { local_config: { version: number; items: Record<string, string> } | null } };
    assert.ok(gb.card.local_config, 'managed 回读 local_config 必在');
    assert.equal(gb.card.local_config.items.ANTHROPIC_AUTH_TOKEN, TOKEN, 'AUTH_TOKEN 值面回读（明文投影语义，cc-switch 对齐）');
    assert.equal(gb.card.local_config.items.ANTHROPIC_API_KEY, APIKEY, 'API_KEY 值面回读');
    assert.equal(gb.card.local_config.items.ANTHROPIC_BASE_URL, 'https://api-r5b.example.test', '普通键同行落盘');

    // 回读 B：直读沙箱卡文件（落盘值面，不隔 handler 面）
    const doc = JSON.parse(readFileSync(faceCardPath('rmc'), 'utf-8')) as { local_config: { version: number; items: Record<string, string> } };
    assert.equal(doc.local_config.items.ANTHROPIC_AUTH_TOKEN, TOKEN, '落盘 AUTH_TOKEN 值面（假值）');
    assert.equal(doc.local_config.items.ANTHROPIC_API_KEY, APIKEY, '落盘 API_KEY 值面（假值）');
    assert.equal(doc.local_config.version, 1, '首存 version=1');
  });

  it('案2 黑名单仍拦：FOO_API_KEY→400 人话拒+卡零污染（version/键面不动）', async () => {
    const before = JSON.parse(readFileSync(faceCardPath('rmc'), 'utf-8')) as { local_config: { version: number; items: Record<string, string> } };
    const r = await putRmc({ FOO_API_KEY: 'sk-test-r5b-nonexistent-000000' });
    assert.equal(r.status, 400, '非白名单密钥类键必仍拒（泛拦不松）');
    assert.ok(String((r.body as { error?: string }).error ?? '').includes('疑似密钥'), `400 error 须人话点名疑似密钥: ${JSON.stringify(r.body)}`);

    // 整卡 PUT 400 早退=零落盘污染（校验前置于 merged 构造后落盘前）
    const after = JSON.parse(readFileSync(faceCardPath('rmc'), 'utf-8')) as { local_config: { version: number; items: Record<string, string> } };
    assert.equal(after.local_config.version, before.local_config.version, '拒收 PUT 不得 bump version');
    assert.equal('FOO_API_KEY' in after.local_config.items, false, '拒收键零落盘');

    // 案1 值面未被案2 波及（幂等现势保持）
    assert.equal(after.local_config.items.ANTHROPIC_AUTH_TOKEN, 'sk-test-r5b-token-000000', '案1 白名单值面不受案2 拒收影响');
  });

  it('案3 精确名边界：小写 anthropic_auth_token→400（豁免大小写敏感不外溢）', async () => {
    const r = await putRmc({ anthropic_auth_token: 'sk-test-r5b-lowercase-000000' });
    assert.equal(r.status, 400, '精确名白名单=大小写敏感，同族小写键仍入黑名单');
    assert.ok(String((r.body as { error?: string }).error ?? '').includes('疑似密钥'), `小写键拒收 error 人话: ${JSON.stringify(r.body)}`);
  });
});
