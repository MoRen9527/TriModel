// ── LG-036 兜底两套·sg 通道测试（CTO 方案 c6a6e512 §六.4）──
// 覆盖：ssh spawn 契约（argv 零载荷零密钥+stdin curl -K 配置格式）+错误态映射
// （unreachable/version_unsupported/token_rejected）+GET/POST 全链+本地 fail-closed
// +本地前置校验零 spawn+零落盘断言（文件面 diff 空+argv 扫描零命中）。
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SSH_BASE_OPTIONS,
  SSH_REMOTE_COMMAND,
  buildCurlConfig,
  curlConfigQuote,
  handleGetClaudeFallbackSg,
  handlePostClaudeFallbackSgRestore,
  runSshCurl,
  type SpawnFn,
} from '../src/api/claude-fallback-sg.js';

const ADMIN = 'Bearer sg-probe-local-admin';
const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  __argv: string[];
  __stdin: () => string;
}

function makeFakeSpawn(exitCode: number, stdoutText: string, stderrText = ''): { spawnFn: SpawnFn; calls: FakeChild[] } {
  const calls: FakeChild[] = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    const child = new EventEmitter() as unknown as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.__argv = [cmd, ...args];
    let stdinData = '';
    child.stdin.resume();
    child.stdin.on('data', (c: Buffer) => { stdinData += c.toString('utf-8'); });
    child.__stdin = () => stdinData;
    calls.push(child);
    setImmediate(() => {
      child.stdout.write(stdoutText);
      child.stderr.write(stderrText);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', exitCode));
    });
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as SpawnFn;
  return { spawnFn, calls };
}

const SG_OK_BODY = {
  object: 'config.claude-fallback',
  file_present: true,
  readable: true,
  base_url: 'https://open.bigmodel.cn/api/anthropic',
  model: 'glm-5.3[1M]',
  api_key_masked: '****abcd',
};
const mkStdout = (code: number, body: unknown) => JSON.stringify(body) + '\n__HTTP__' + code;

describe('LG-036 sg 通道：ssh 契约（argv 零载荷 + stdin -K 配置）', () => {
  it('argv=静态常量（零密钥零载荷零路径注入）；载荷全在 stdin curl config', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0, mkStdout(200, SG_OK_BODY));
    const out = await runSshCurl(
      { method: 'POST', path: '/v1/config/claude-fallback/restore', bearerToken: 'sg-token-secret-xyz', body: { base_url: 'https://x.example.com', api_key: 'sk-payload-secret-123456', model: 'm1' } },
      spawnFn,
    );
    assert.equal(out.kind, 'done');
    const argv = calls[0].__argv;
    // argv 后段=SSH_BASE_OPTIONS+host+SSH_REMOTE_COMMAND；整体扫描零密钥零载荷
    assert.deepEqual(argv.slice(1 + SSH_BASE_OPTIONS.length + 1), [...SSH_REMOTE_COMMAND], '远端命令串=静态常量');
    for (const forbidden of ['sk-payload-secret', 'sg-token-secret', 'x.example.com', 'base_url']) {
      assert.equal(argv.join(' ').includes(forbidden), false, `argv 泄漏: ${forbidden}`);
    }
    // stdin：curl -K 配置格式（url/request/header/data 全在）
    const stdinText = calls[0].__stdin();
    assert.ok(stdinText.includes('url = "http://127.0.0.1:3333/v1/config/claude-fallback/restore"'), 'url 项');
    assert.ok(stdinText.includes('request = "POST"'), 'request 项');
    assert.ok(stdinText.includes('header = "Authorization: Bearer sg-token-secret-xyz"'), 'bearer 经 header 项');
    assert.ok(stdinText.includes('__HTTP__%{http_code}'), 'write-out 状态码项');
    // data 项=JSON（转义引号后）可回读
    const dataLine = stdinText.split('\n').find((l) => l.startsWith('data = '))!;
    const raw = dataLine.slice('data = '.length).replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const parsed = JSON.parse(raw) as { base_url: string; api_key: string; model: string };
    assert.equal(parsed.api_key, 'sk-payload-secret-123456', 'data 项含原值（仅 stdin 通道）');
    assert.equal(parsed.base_url, 'https://x.example.com');
  });

  it('curlConfigQuote：引号/反斜杠转义正确（注入零逃逸）', () => {
    assert.equal(curlConfigQuote('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(curlConfigQuote('plain'), '"plain"');
  });

  it('buildCurlConfig：GET 无 data 项；无 bearer 时无 Authorization 头', () => {
    const cfg = buildCurlConfig({ method: 'GET', path: '/v1/config/claude-fallback' });
    assert.equal(cfg.includes('data = '), false);
    assert.equal(cfg.includes('Authorization'), false);
    assert.ok(cfg.includes('request = "GET"'));
  });
});

describe('LG-036 sg 通道：GET status 态映射', () => {
  it('ok：channel=正常+地址/模型/masked 透传', async () => {
    const { spawnFn } = makeFakeSpawn(0, mkStdout(200, SG_OK_BODY));
    const r = await handleGetClaudeFallbackSg({ spawnFn });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { channel: { state: string } }).channel.state, 'ok');
    assert.equal((r.body as { base_url: string }).base_url, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal((r.body as { api_key_masked: string }).api_key_masked, '****abcd');
  });

  it('404 → version_unsupported（人话「版本过旧」）', async () => {
    const { spawnFn } = makeFakeSpawn(0, mkStdout(404, { error: 'Not found' }));
    const r = await handleGetClaudeFallbackSg({ spawnFn });
    const ch = (r.body as { channel: { state: string; label: string } }).channel;
    assert.equal(ch.state, 'version_unsupported');
    assert.ok(ch.label.includes('版本过旧'));
  });

  it('ssh 失败（exit≠0 或 spawn error）→ unreachable 人话', async () => {
    const { spawnFn } = makeFakeSpawn(255, '', 'ssh: connect to host failed');
    const r = await handleGetClaudeFallbackSg({ spawnFn });
    const ch = (r.body as { channel: { state: string; label: string } }).channel;
    assert.equal(ch.state, 'unreachable');
    assert.ok(ch.label.includes('不可达'));
  });

  it('X-SG-Admin-Token → 转发为 sg Authorization（config header 项）', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0, mkStdout(200, SG_OK_BODY));
    await handleGetClaudeFallbackSg({ sgAdminHeader: 'sg-admin-abc', spawnFn });
    assert.ok(calls[0].__stdin().includes('Authorization: Bearer sg-admin-abc'));
  });
});

describe('LG-036 sg 通道：POST restore（本地 fail-closed+映射）', () => {
  beforeEach(() => { process.env.TRIMODEL_ADMIN_TOKEN = 'sg-probe-local-admin'; });
  const payload = JSON.stringify({ base_url: 'https://open.bigmodel.cn/api/anthropic', api_key: 'sk-sg-new-key-abcdefghij', model: 'glm-5.3[1M]', sg_admin_token: 'sg-admin-token-xyz' });

  it('happy path：转发 sg 200 → 透传 message+「sg 侧会话重启后生效」+channel ok', async () => {
    const { spawnFn } = makeFakeSpawn(0, mkStdout(200, { ok: true, message: '兜底直连已写入（x · m）。重启会话后生效。' }));
    const r = await handlePostClaudeFallbackSgRestore(ADMIN, payload, { spawnFn });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { channel: { state: string } }).channel.state, 'ok');
    assert.ok((r.body as { message: string }).message.includes('sg 侧会话重启后生效'));
    assert.equal(JSON.stringify(r.body).includes('sk-sg-new-key'), false, '响应不回显密钥');
  });

  it('本地 fail-closed：无令牌配置 503 / 错令牌 401（零 spawn）', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0, mkStdout(200, {}));
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    assert.equal((await handlePostClaudeFallbackSgRestore(ADMIN, payload, { spawnFn })).statusCode, 503);
    process.env.TRIMODEL_ADMIN_TOKEN = 'sg-probe-local-admin';
    assert.equal((await handlePostClaudeFallbackSgRestore('Bearer wrong', payload, { spawnFn })).statusCode, 401);
    assert.equal(calls.length, 0, '鉴权失败零 spawn');
  });

  it('本地前置校验：空/坏地址/短密钥/缺 sg 令牌 → 400 人话零 spawn', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0, mkStdout(200, {}));
    const bads: Array<[Record<string, unknown>, string]> = [
      [{ base_url: '', api_key: 'sk-sg-new-key-abcdefghij', model: 'm', sg_admin_token: 't' }, '服务地址'],
      [{ base_url: 'ftp://x', api_key: 'sk-sg-new-key-abcdefghij', model: 'm', sg_admin_token: 't' }, 'http'],
      [{ base_url: 'https://x', api_key: 'short', model: 'm', sg_admin_token: 't' }, '16'],
      [{ base_url: 'https://x', api_key: 'sk-sg-new-key-abcdefghij', model: '', sg_admin_token: 't' }, '模型'],
      [{ base_url: 'https://x', api_key: 'sk-sg-new-key-abcdefghij', model: 'm', sg_admin_token: '' }, 'sg 管理令牌'],
    ];
    for (const [b, needle] of bads) {
      const r = await handlePostClaudeFallbackSgRestore(ADMIN, JSON.stringify(b), { spawnFn });
      assert.equal(r.statusCode, 400, JSON.stringify(b));
      assert.ok((r.body as { error: string }).error.includes(needle));
    }
    assert.equal(calls.length, 0, '前置校验失败零 spawn');
  });

  it('sg 401 → token_rejected「sg 令牌不正确」；sg 404 → 版本态；ssh 失败 → 502 不可达', async () => {
    const t401 = await handlePostClaudeFallbackSgRestore(ADMIN, payload, { spawnFn: makeFakeSpawn(0, mkStdout(401, { error: 'Unauthorized' })).spawnFn });
    assert.equal(t401.statusCode, 401);
    assert.equal((t401.body as { channel: { state: string } }).channel.state, 'token_rejected');
    const t404 = await handlePostClaudeFallbackSgRestore(ADMIN, payload, { spawnFn: makeFakeSpawn(0, mkStdout(404, { error: 'Not found' })).spawnFn });
    assert.equal((t404.body as { channel: { state: string } }).channel.state, 'version_unsupported');
    const tSsh = await handlePostClaudeFallbackSgRestore(ADMIN, payload, { spawnFn: makeFakeSpawn(255, '', 'connect failed').spawnFn });
    assert.equal(tSsh.statusCode, 502);
    assert.equal((tSsh.body as { channel: { state: string } }).channel.state, 'unreachable');
  });
});

describe('LG-036 sg 通道：零落盘断言（R1 本机文件面零写）', () => {
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
  });

  it('sg 全流程前后：本机文件面 diff=空（含无新文件/无临时文件）', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'sg-probe-local-admin';
    const probe = mkdtempSync(join(tmpdir(), 'sg-zero-write-'));
    // 陷阱位：若实现误写「本机兜底目标」，会落在 TRIMODEL_CLAUDE_SETTINGS 钉位
    const settingsTrap = join(probe, 'settings.json');
    process.env.TRIMODEL_CLAUDE_SETTINGS = settingsTrap;
    const snapshot = readdirSync(probe).sort();
    const { spawnFn } = makeFakeSpawn(0, mkStdout(200, { ok: true, message: 'ok' }));
    await handleGetClaudeFallbackSg({ spawnFn });
    await handlePostClaudeFallbackSgRestore(ADMIN, JSON.stringify({ base_url: 'https://x.example.com', api_key: 'sk-sg-new-key-abcdefghij', model: 'm', sg_admin_token: 't' }), { spawnFn });
    assert.deepEqual(readdirSync(probe).sort(), snapshot, '零新文件（含零临时/备份）');
    assert.equal(existsSync(settingsTrap), false, '本机 settings 钉位零触碰（sg 流程不落本机）');
    rmSync(probe, { recursive: true, force: true });
    delete process.env.TRIMODEL_CLAUDE_SETTINGS;
  });
});
