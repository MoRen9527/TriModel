// ── Claude 兜底 v2 波①五门单测（TASK-TRIMODEL-RECOVERY-LADDER-01 波①，2026-09-25/26）──
// 覆盖：门①备份轮换+哨兵豁免+幂等短路 / 门②模板键名锁定（inject-key 服务端供值）/
// 门③凭据健康门三态 / 门④预览零写+回滚守卫（文件名正则/404/坏备份拒滚/回滚前备份）/
// 门⑤审计行+钥值红线。独立文件（既有 claude-fallback.test.ts 11 测不动）。
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  credentialGate, rotateBackups, BACKUP_KEEP, listTemplates, MODEL_TIER_KEYS,
  handlePostClaudeFallbackRestore, handlePostClaudeFallbackPreview,
  handlePostClaudeFallbackRollback, handlePostClaudeFallbackInjectKey,
  handleGetClaudeFallbackBackups,
} from '../src/api/claude-fallback.js';

const ADMIN = 'Bearer fb-secret';
const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;
const ORIGINAL_AUDIT = process.env.TRIMODEL_AUDIT_LOG;
const KEY_A = 'sk-wave1-test-key-0123456789abcdef'; // 32 位合成钥（非真实凭据）

function writeBase(path: string, extraEnv: Record<string, string> = {}): void {
  writeFileSync(path, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-old-token-0123456789',
      ANTHROPIC_BASE_URL: 'https://old.example.com/api',
      ANTHROPIC_MODEL: 'old-model',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      KEEP_ME: 'untouched-value',
      ...extraEnv,
    },
    permissions: { allow: ['Bash(npm run *)'], defaultMode: 'bypassPermissions' },
  }, null, 2) + '\n', 'utf-8');
}

after(() => {
  if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
  if (ORIGINAL_AUDIT === undefined) delete process.env.TRIMODEL_AUDIT_LOG; else process.env.TRIMODEL_AUDIT_LOG = ORIGINAL_AUDIT;
});

describe('claude-fallback v2 门③ credentialGate（纯函数）', () => {
  it('合法 32 位钥 → null（放行）', () => {
    assert.equal(credentialGate(KEY_A), null);
  });
  it('空串 → 拒（空或纯空白）', () => {
    assert.match(String(credentialGate('')), /空/);
  });
  it('纯空白 → 拒', () => {
    assert.match(String(credentialGate('   \t ')), /空/);
  });
  it('含 PLACEHOLDER → 拒（占位符残留）', () => {
    assert.match(String(credentialGate('sk-PLACEHOLDER-residual-000000')), /占位符/);
  });
  it('15 位 → 拒（长度不足）', () => {
    assert.match(String(credentialGate('a'.repeat(15))), /长度不足/);
  });
  it('16 位整 → null（下边界放行）', () => {
    assert.equal(credentialGate('a'.repeat(16)), null);
  });
});

describe('claude-fallback v2 门① rotateBackups（轮换+哨兵）', () => {
  it(`8 份备份 → 轮换删 3 份、保留最新 ${BACKUP_KEEP} 份`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-rot-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, '{}', 'utf-8');
      for (let i = 1; i <= 8; i++) {
        const p = `${path}.bak-${i}`;
        writeFileSync(p, `{"i":${i}}`, 'utf-8');
        utimesSync(p, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
      }
      const r = rotateBackups(path);
      assert.equal(r.rotated, true);
      assert.equal(r.removed, 3);
      const left = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).sort();
      assert.deepEqual(left, ['settings.json.bak-4', 'settings.json.bak-5', 'settings.json.bak-6', 'settings.json.bak-7', 'settings.json.bak-8']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('FROZEN-BACKUPS 哨兵 → 豁免轮换（回滚锚防自毁）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-frz-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, '{}', 'utf-8');
      for (let i = 1; i <= 8; i++) writeFileSync(`${path}.bak-${i}`, '{}', 'utf-8');
      writeFileSync(join(dir, 'FROZEN-BACKUPS'), '', 'utf-8');
      const r = rotateBackups(path);
      assert.deepEqual(r, { rotated: false, removed: 0 });
      assert.equal(readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 8);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('claude-fallback v2 门④ preview（零写 diff+掩码红线）', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-prev-'));
    path = join(dir, 'settings.json');
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
    process.env.TRIMODEL_AUDIT_LOG = join(dir, 'audit.log');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('预览零写入：文件逐字节不变+diff 凭据 len-only+全响应无钥值', () => {
    writeBase(path);
    const before = readFileSync(path, 'utf-8');
    const r = handlePostClaudeFallbackPreview(ADMIN, JSON.stringify({ base_url: 'https://new.example.com/api', api_key: KEY_A, model: 'glm-5.3-flash' }), { settingsPath: path });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { dry_run: boolean }).dry_run, true);
    assert.equal(readFileSync(path, 'utf-8'), before, '预览必须零写');
    const body = JSON.stringify(r.body);
    assert.equal(body.includes(KEY_A), false, '响应体不得出现原始钥值');
    const diff = (r.body as { diff: Array<{ key: string; before: unknown; after: unknown }> }).diff;
    const cred = diff.find((d) => d.key === 'ANTHROPIC_AUTH_TOKEN');
    assert.ok(cred, 'diff 必含 AUTH_TOKEN 行');
    assert.match(String(cred.after), /^len=/);
    const modelRow = diff.find((d) => d.key === 'ANTHROPIC_MODEL');
    assert.equal(modelRow?.before, 'old-model', '非凭据行原值直显');
  });
  it('既有 ANTHROPIC_API_KEY 载体 → diff 附该键行（F-1 预告）', () => {
    writeBase(path, { ANTHROPIC_API_KEY: 'sk-old-api-key-0123456789' });
    const r = handlePostClaudeFallbackPreview(ADMIN, JSON.stringify({ base_url: 'https://n.example.com', api_key: KEY_A, model: 'm' }), { settingsPath: path });
    const diff = (r.body as { diff: Array<{ key: string }> }).diff;
    assert.ok(diff.some((d) => d.key === 'ANTHROPIC_API_KEY'), '载体存在必须出现在 diff');
  });
  it('门③ 经 preview：PLACEHOLDER 钥 → 400 拒（fail-closed）', () => {
    writeBase(path);
    const r = handlePostClaudeFallbackPreview(ADMIN, JSON.stringify({ base_url: 'https://n.example.com', api_key: 'sk-PLACEHOLDER-00000000000', model: 'm' }), { settingsPath: path });
    assert.equal(r.statusCode, 400);
    assert.match((r.body as { error: string }).error, /占位符/);
  });
  it('令牌错误 → 401', () => {
    writeBase(path);
    const r = handlePostClaudeFallbackPreview('Bearer wrong', '{}', { settingsPath: path });
    assert.equal(r.statusCode, 401);
  });
});

describe('claude-fallback v2 POST rollback（守卫+可逆）', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-rb-'));
    path = join(dir, 'settings.json');
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
    process.env.TRIMODEL_AUDIT_LOG = join(dir, 'audit.log');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function mkBackup(name: string, baseUrl: string): void {
    writeFileSync(join(dir, name), JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'sk-bak-token-0123456789', ANTHROPIC_MODEL: 'bak-model' } }, null, 2) + '\n', 'utf-8');
  }

  it('快乐路径：回滚到指定备份+回滚前自动备份当前态（可逆）', () => {
    writeBase(path); // 当前态=old.example.com
    mkBackup('settings.json.bak-first', 'https://first.example.com');
    mkBackup('settings.json.bak-second', 'https://second.example.com');
    const r = handlePostClaudeFallbackRollback(ADMIN, JSON.stringify({ backup: 'settings.json.bak-first' }), { settingsPath: path });
    assert.equal(r.statusCode, 200);
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as { env: Record<string, string> };
    assert.equal(doc.env.ANTHROPIC_BASE_URL, 'https://first.example.com');
    const pre = (r.body as { pre_rollback_backup: string | null }).pre_rollback_backup;
    assert.ok(pre, '回滚前必须有当前态备份（可逆）');
    assert.ok(readFileSync(pre, 'utf-8').includes('old.example.com'), '回滚前备份=回滚时点的当前态');
  });
  it('文件名格式不符（含路径成分）→ 400', () => {
    const r = handlePostClaudeFallbackRollback(ADMIN, JSON.stringify({ backup: '../evil' }), { settingsPath: path });
    assert.equal(r.statusCode, 400);
  });
  it('合法格式但不存在 → 404', () => {
    writeBase(path);
    const r = handlePostClaudeFallbackRollback(ADMIN, JSON.stringify({ backup: 'settings.json.bak-nope' }), { settingsPath: path });
    assert.equal(r.statusCode, 404);
  });
  it('坏 JSON 备份 → 400 拒滚（不把坏备份拷成现役）', () => {
    writeBase(path);
    writeFileSync(join(dir, 'settings.json.bak-corrupt'), 'not-json{', 'utf-8');
    const r = handlePostClaudeFallbackRollback(ADMIN, JSON.stringify({ backup: 'settings.json.bak-corrupt' }), { settingsPath: path });
    assert.equal(r.statusCode, 400);
    assert.match((r.body as { error: string }).error, /JSON/);
    assert.ok(readFileSync(path, 'utf-8').includes('old.example.com'), '现役文件未被触碰');
  });
  it('backups 清单：keep=5+sentinel 标志+条目文件名', () => {
    writeBase(path);
    mkBackup('settings.json.bak-z1', 'https://z1.example.com');
    const r = handleGetClaudeFallbackBackups(ADMIN, { settingsPath: path });
    assert.equal(r.statusCode, 200);
    const body = r.body as { keep: number; sentinel: boolean; backups: Array<{ file: string }> };
    assert.equal(body.keep, BACKUP_KEEP);
    assert.equal(body.sentinel, false);
    assert.ok(body.backups.some((b) => b.file === 'settings.json.bak-z1'));
  });
});

describe('claude-fallback v2 POST inject-key（独立钥文件 fail-closed）', () => {
  let dir: string;
  let path: string;
  let keyPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-inj-'));
    path = join(dir, 'settings.json');
    keyPath = join(dir, '.deploy-key');
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
    process.env.TRIMODEL_AUDIT_LOG = join(dir, 'audit.log');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('钥文件缺失 → 422（fail-closed 不猜）', () => {
    const r = handlePostClaudeFallbackInjectKey(ADMIN, undefined, { settingsPath: path, deployKeyPath: keyPath });
    assert.equal(r.statusCode, 422);
    assert.match((r.body as { error: string }).error, /未落位/);
  });
  it('钥文件空 → 422', () => {
    writeFileSync(keyPath, '  \n', 'utf-8');
    const r = handlePostClaudeFallbackInjectKey(ADMIN, undefined, { settingsPath: path, deployKeyPath: keyPath });
    assert.equal(r.statusCode, 422);
    assert.match((r.body as { error: string }).error, /为空/);
  });
  it('钥文件 PLACEHOLDER → 422（门③同源拒）', () => {
    writeFileSync(keyPath, 'sk-PLACEHOLDER-residual-0000', 'utf-8');
    const r = handlePostClaudeFallbackInjectKey(ADMIN, undefined, { settingsPath: path, deployKeyPath: keyPath });
    assert.equal(r.statusCode, 422);
    assert.match((r.body as { error: string }).error, /占位符/);
  });
  it('成功路径：模板供值直写+双载体同写同值+响应零钥值+审计行红线', () => {
    writeFileSync(keyPath, KEY_A + '\n', 'utf-8');
    writeBase(path, { ANTHROPIC_API_KEY: 'sk-old-api-key-0123456789' });
    const r = handlePostClaudeFallbackInjectKey(ADMIN, undefined, { settingsPath: path, deployKeyPath: keyPath });
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.stringify(r.body).includes(KEY_A), false, '响应体零钥值');
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as { env: Record<string, string> };
    assert.equal(doc.env.ANTHROPIC_AUTH_TOKEN, KEY_A);
    assert.equal(doc.env.ANTHROPIC_API_KEY, KEY_A, '既有 API_KEY 载体同写同值（F-1）');
    assert.equal(doc.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(doc.env.ANTHROPIC_MODEL, 'glm-5.3-flash');
    assert.equal(doc.env.KEEP_ME, 'untouched-value', '其余键值级保留');
    for (const k of MODEL_TIER_KEYS) assert.equal(doc.env[k], 'glm-5.3-flash', `档位键 ${k} 全族同值`);
    const audit = readFileSync(join(dir, 'audit.log'), 'utf-8');
    assert.ok(audit.includes('who=ui-inject'), '审计行存在');
    assert.ok(audit.includes('assert=pass'));
    assert.equal(audit.includes(KEY_A), false, '审计行零钥值（len-only 红线）');
  });
  it('未知模板 → 400；候批模板（deepseek）→ 400 拒注入', () => {
    writeFileSync(keyPath, KEY_A, 'utf-8');
    const r1 = handlePostClaudeFallbackInjectKey(ADMIN, JSON.stringify({ template: 'nope' }), { settingsPath: path, deployKeyPath: keyPath });
    assert.equal(r1.statusCode, 400);
    const r2 = handlePostClaudeFallbackInjectKey(ADMIN, JSON.stringify({ template: 'deepseek' }), { settingsPath: path, deployKeyPath: keyPath });
    assert.equal(r2.statusCode, 400);
    assert.match((r2.body as { error: string }).error, /尚未启用/);
  });
  it('模板表：bigmodel deployed+deepseek 候批（门②同源供值面）', () => {
    const tpls = listTemplates();
    assert.equal(tpls.length, 2);
    const bm = tpls.find((t) => t.id === 'bigmodel');
    assert.ok(bm?.deployed);
    assert.equal(bm?.base_url, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(tpls.find((t) => t.id === 'deepseek')?.deployed, false);
  });
});

describe('claude-fallback v2 门①幂等短路+门⑤restore 审计', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-idem-'));
    path = join(dir, 'settings.json');
    process.env.TRIMODEL_ADMIN_TOKEN = 'fb-secret';
    process.env.TRIMODEL_AUDIT_LOG = join(dir, 'audit.log');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('三值已全等 → already_same=true 不重写不备份（字节不变）', () => {
    writeFileSync(path, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: KEY_A,
        ANTHROPIC_BASE_URL: 'https://same.example.com',
        ...Object.fromEntries(MODEL_TIER_KEYS.map((k) => [k, 'same-model'])),
        KEEP_ME: 'untouched-value',
      },
    }, null, 2) + '\n', 'utf-8');
    const before = readFileSync(path, 'utf-8');
    const r = handlePostClaudeFallbackRestore(ADMIN, JSON.stringify({ base_url: 'https://same.example.com', api_key: KEY_A, model: 'same-model' }), { settingsPath: path });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as { restored: { already_same: boolean } }).restored.already_same, true);
    assert.equal((r.body as { restored: { backup: string | null } }).restored.backup, null);
    assert.equal(readFileSync(path, 'utf-8'), before, '幂等路径零写入');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 0, '不产生备份');
  });
  it('成功写路径审计行：who=ui-restore assert=pass+零钥值', () => {
    writeBase(path);
    const r = handlePostClaudeFallbackRestore(ADMIN, JSON.stringify({ base_url: 'https://new.example.com/api', api_key: KEY_A, model: 'glm-5.3-flash' }), { settingsPath: path });
    assert.equal(r.statusCode, 200);
    const bak = (r.body as { restored: { backup: string } }).restored.backup;
    assert.ok(bak && basename(bak).startsWith('settings.json.bak-'), '写成功必有回滚锚');
    const audit = readFileSync(join(dir, 'audit.log'), 'utf-8');
    assert.ok(audit.includes('who=ui-restore'));
    assert.ok(audit.includes('assert=pass'));
    assert.equal(audit.includes(KEY_A), false);
  });
});
