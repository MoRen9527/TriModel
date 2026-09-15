// ── Claude 直连兜底端点测试（2026-09-15 任务书 W38/fallback-button）──
// 七态：正常写 / 幂等（已是该值不重写）/ 备份存在 / 密钥不回显 / 401 拒 / 503 未启用 /
// 非法地址拒 / 文件缺失（新建）/ 坏 JSON（拒写不覆盖）/ GET 无鉴权+令牌尾4。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGetClaudeFallback, handlePostClaudeFallbackRestore, MODEL_TIER_KEYS } from '../src/api/claude-fallback.js';

const ADMIN = 'Bearer fb-secret';
const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;

/** 现役同款基线文件（含其余键做「逐字节保留」断言）。 */
function baseSettings() {
  return {
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-old-token-0123456789',
      ANTHROPIC_BASE_URL: 'https://old.example.com/api',
      ANTHROPIC_MODEL: 'old-model',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      KEEP_ME: 'untouched-value',
    },
    permissions: { allow: ['Bash(npm run *)', 'mcp__codegraph__codegraph_search'], defaultMode: 'bypassPermissions' },
    model: 'old-model',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'date' }] }] },
  };
}

describe('claude-fallback: GET（无鉴权读）', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-get-'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(baseSettings(), null, 2) + '\n');
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
  });
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
    rmSync(dir, { recursive: true, force: true });
  });

  it('无令牌：200 返回地址+模型，不含密钥位', () => {
    const r = handleGetClaudeFallback(undefined, { settingsPath: join(dir, 'settings.json') });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { base_url: string }).base_url, 'https://old.example.com/api');
    assert.equal((r.body as { model: string }).model, 'old-model');
    assert.equal('api_key_masked' in r.body, false, '无令牌不给密钥尾位');
  });

  it('管理令牌正确：附密钥尾 4 位（不回显全值）', () => {
    const r = handleGetClaudeFallback(ADMIN, { settingsPath: join(dir, 'settings.json') });
    assert.equal((r.body as { api_key_masked: string }).api_key_masked, '****6789');
    assert.equal(JSON.stringify(r.body).includes('sk-old-token'), false, '全值零出现');
  });

  it('令牌错误：等同无令牌（fail-safe 不给敏感位）', () => {
    const r = handleGetClaudeFallback('Bearer wrong', { settingsPath: join(dir, 'settings.json') });
    assert.equal(r.statusCode, 200);
    assert.equal('api_key_masked' in r.body, false);
  });

  it('文件缺失：200 空值返回（读面不炸）', () => {
    const r = handleGetClaudeFallback(undefined, { settingsPath: join(dir, 'missing.json') });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { file_present: boolean }).file_present, false);
  });
});

describe('claude-fallback: POST restore（管理令牌 fail-closed）', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-post-'));
    path = join(dir, 'settings.json');
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
  });
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
    rmSync(dir, { recursive: true, force: true });
  });

  const body = JSON.stringify({ base_url: 'https://api.deepseek.com/anthropic', api_key: 'sk-new-token-abcdefghij', model: 'deepseek-flash[1M]' });

  it('正常写：三组值落盘（地址/密钥/9 键全族）+ 其余字段逐字节保留 + 备份在', () => {
    writeFileSync(path, JSON.stringify(baseSettings(), null, 2) + '\n');
    const r = handlePostClaudeFallbackRestore(ADMIN, body, { settingsPath: path });
    assert.equal(r.statusCode, 200);
    const doc = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(doc.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(doc.env.ANTHROPIC_AUTH_TOKEN, 'sk-new-token-abcdefghij');
    for (const k of MODEL_TIER_KEYS) assert.equal(doc.env[k], 'deepseek-flash[1M]', `${k} verbatim`);
    assert.equal(MODEL_TIER_KEYS.length, 9, '9 键全族');
    // 其余字段逐字节保留（值级 deep-equal；文本级目标行外一致）
    const orig = baseSettings() as Record<string, unknown>;
    const now = doc as Record<string, unknown>;
    assert.deepEqual(now.permissions, orig.permissions);
    assert.deepEqual(now.hooks, orig.hooks);
    assert.equal(now.model, 'old-model');
    assert.equal(doc.env.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1');
    assert.equal(doc.env.KEEP_ME, 'untouched-value');
    // 备份存在且=迁移前原文
    const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-'));
    assert.equal(backups.length, 1, '备份一份');
    assert.equal(readFileSync(join(dir, backups[0]), 'utf-8'), JSON.stringify(baseSettings(), null, 2) + '\n', '备份=写前原文');
    // 响应不回显密钥
    assert.equal(JSON.stringify(r.body).includes('sk-new-token'), false);
    assert.ok((r.body as { message: string }).message.includes('重启会话后生效'));
  });

  it('幂等：重复提交同值 → already_same 明示、不重写不新增备份', () => {
    writeFileSync(path, JSON.stringify(baseSettings(), null, 2) + '\n');
    handlePostClaudeFallbackRestore(ADMIN, body, { settingsPath: path });
    const before = readFileSync(path, 'utf-8');
    const backupsBefore = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length;
    const r2 = handlePostClaudeFallbackRestore(ADMIN, body, { settingsPath: path });
    assert.equal(r2.statusCode, 200);
    assert.equal((r2.body as { restored: { already_same: boolean } }).restored.already_same, true);
    assert.ok((r2.body as { message: string }).message.includes('已是'));
    assert.equal(readFileSync(path, 'utf-8'), before, '盘上零重写');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, backupsBefore, '零新增备份');
  });

  it('401：令牌错拒写（文件零触碰）', () => {
    writeFileSync(path, JSON.stringify(baseSettings(), null, 2) + '\n');
    const before = readFileSync(path, 'utf-8');
    const r = handlePostClaudeFallbackRestore('Bearer wrong', body, { settingsPath: path });
    assert.equal(r.statusCode, 401);
    assert.equal(readFileSync(path, 'utf-8'), before);
  });

  it('503：管理令牌未配置（fail-closed）', () => {
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    const r = handlePostClaudeFallbackRestore(ADMIN, body, { settingsPath: path });
    assert.equal(r.statusCode, 503);
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
  });

  it('非法输入：坏地址/短密钥/空值 人话拒（不落盘）', () => {
    writeFileSync(path, JSON.stringify(baseSettings(), null, 2) + '\n');
    const before = readFileSync(path, 'utf-8');
    const bad = [
      [{ base_url: 'ftp://x', api_key: 'sk-new-token-abcdefghij', model: 'm' }, 'http'],
      [{ base_url: '', api_key: 'sk-new-token-abcdefghij', model: 'm' }, '服务地址'],
      [{ base_url: 'https://x', api_key: 'short', model: 'm' }, '16'],
      [{ base_url: 'https://x', api_key: '', model: 'm' }, '密钥'],
      [{ base_url: 'https://x', api_key: 'sk-new-token-abcdefghij', model: '' }, '模型'],
    ] as Array<[Record<string, unknown>, string]>;
    for (const [payload, needle] of bad) {
      const r = handlePostClaudeFallbackRestore(ADMIN, JSON.stringify(payload), { settingsPath: path });
      assert.equal(r.statusCode, 400, JSON.stringify(payload));
      assert.ok((r.body as { error: string }).error.includes(needle), `${needle}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(readFileSync(path, 'utf-8'), before, '拒绝零落盘');
  });

  it('文件缺失：新建并在文案注明「已新建」', () => {
    const r = handlePostClaudeFallbackRestore(ADMIN, body, { settingsPath: path });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { restored: { file_created: boolean } }).restored.file_created, true);
    assert.ok((r.body as { message: string }).message.includes('已新建'));
    const doc = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(doc.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 0, '原无文件不产备份');
  });

  it('坏 JSON：拒写不覆盖（人话附路径）', () => {
    writeFileSync(path, '{broken json 不是');
    const before = readFileSync(path, 'utf-8');
    const r = handlePostClaudeFallbackRestore(ADMIN, body, { settingsPath: path });
    assert.equal(r.statusCode, 400);
    assert.ok((r.body as { error: string }).error.includes(path), '附路径');
    assert.equal(readFileSync(path, 'utf-8'), before, '不覆盖坏文件');
  });
});
