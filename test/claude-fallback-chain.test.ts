// ── 兜底按钮真链路回归（2026-09-15 BOD 打回诊断：本缺陷属层=HTTP 链路层）──
// 教训：单测直调 handler（手工传 rawBody）+jsdom mock fetch——真 server 的读体
// 层零覆盖。此件起**真 server**（随机端口）+**真 HTTP POST** 断言落盘——凡
// 「请求体是否到达 handler」类缺陷，只有这层能拦（第四型盲区同族位）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'fb-chain-secret';

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolveP(p));
    });
    srv.on('error', reject);
  });
}

describe('兜底端点真链路（真 server + 真 HTTP POST）', () => {
  let dir: string;
  let settingsFile: string;
  let port = 0;
  let server: ChildProcess | null = null;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-chain-'));
    settingsFile = join(dir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://old.example.com/api', ANTHROPIC_AUTH_TOKEN: 'sk-old-token-0123456789', ANTHROPIC_MODEL: 'old-model', KEEP_ME: 'untouched' },
      model: 'old-model',
      permissions: { defaultMode: 'bypassPermissions' },
    }, null, 2) + '\n');
    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRIMODEL_PORT: String(port),
      TRIMODEL_ADMIN_TOKEN: TOKEN,
      TRIMODEL_CLAUDE_SETTINGS: settingsFile, // 钉位：绝不碰真实 ~/.claude/settings.json
    };
    server = spawn(process.execPath, ['--import', 'tsx', join('src', 'server.ts')], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('server did not become healthy');
  });
  after(() => {
    if (server && server.exitCode === null && server.signalCode === null) { try { server.kill(); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('真 HTTP POST restore：体到达 handler→200→三组值落盘（BOD 打回缺陷回归位）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/config/claude-fallback/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ base_url: 'https://api.deepseek.com/anthropic', api_key: 'sk-chain-token-abcdefghij', model: 'deepseek-flash[1M]' }),
    });
    assert.equal(res.status, 200, `真链路 POST 必 200（实际 ${res.status}——若 400/请填写服务地址=读体层丢体复发）`);
    const body = await res.json() as { message?: string };
    assert.ok(body.message?.includes('重启会话后生效'));
    const doc = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    assert.equal(doc.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(doc.env.ANTHROPIC_AUTH_TOKEN, 'sk-chain-token-abcdefghij');
    assert.equal(doc.env.ANTHROPIC_MODEL, 'deepseek-flash[1M]');
    assert.equal(doc.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'deepseek-flash[1M]');
    assert.equal(doc.env.KEEP_ME, 'untouched', '其余字段保留');
    assert.ok(readdirSync(dir).some((f) => f.startsWith('settings.json.bak-')), '备份在');
  });

  it('真 HTTP GET：读到刚写入的现值', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/config/claude-fallback`);
    assert.equal(res.status, 200);
    const body = await res.json() as { base_url: string; model: string };
    assert.equal(body.base_url, 'https://api.deepseek.com/anthropic');
    assert.equal(body.model, 'deepseek-flash[1M]');
  });

  it('真 HTTP POST 无令牌→401（fail-closed 链路层）', async () => {
    const before = readFileSync(settingsFile, 'utf-8');
    const res = await fetch(`http://127.0.0.1:${port}/v1/config/claude-fallback/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_url: 'https://x.example.com', api_key: 'sk-chain-token-abcdefghij', model: 'm' }),
    });
    assert.equal(res.status, 401);
    assert.equal(readFileSync(settingsFile, 'utf-8'), before, '拒写零触碰');
  });

  it('真 HTTP POST 空体→400 人话（体为 {} 时三值皆空）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/config/claude-fallback/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('服务地址'), '空体被正确解析为缺值（而非读体层丢失）');
  });
});
