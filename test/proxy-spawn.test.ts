// ── a1 proxy-spawn 白盒族（BOD 裁124 续·CTO 六判据门禁·三件面·FSD 主刀）──
// 覆盖三件（方案卷 §五.3）：
//   ①解卡双条目 mock 形（buildGlmChildEnv 双键全形+键计数+base env 保全）
//   ②零明文断言（env patch 面仅增双 GLM 键·card at-rest 无明文·真链
//     decrypt roundtrip·读数面计数形非值形）
//   ③fail-safe 缺条目形（缺主=null 不 spawn·缺档=单键形降级·坏卡/无卡=
//     undefined 零 throw）
// 卡面全部走 TRIMODEL_CARD_FILE 显式钉沙箱（candidateCardPaths env 独占候选
// 序——env 在场即不回落默认位·真卡零触）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { encrypt } from '../src/security/key-encryptor.js';
import {
  PROXY_SCRIPT_NAME,
  GLM_ENTRY_MAIN,
  GLM_ENTRY_FLASH,
  decryptGlmEntry,
  buildGlmChildEnv,
  resolveProxyLaunch,
} from '../src/proxy-spawn.js';
import { CARD_VERSION, CARD_FILE_ENV } from '../src/trimmc-card.js';

// ── 沙箱卡面工具（v4 最小 doc·loadCard shape 校验仅求 provider_entries 对象）──
function sandboxCard(dir: string, entries: Record<string, unknown>, name = 'trimmc-card.json'): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ version: CARD_VERSION, provider_entries: entries }));
  return p;
}

describe('a1 proxy-spawn: 解卡双条目 mock 形（白盒①）', () => {
  it('双条目全形：GLM_API_KEY+GLM_FLASH_API_KEY 双注入·keyCount=2·base env 保全', () => {
    const plan = buildGlmChildEnv(
      (id) => (id === GLM_ENTRY_MAIN ? 'sk-main-AAA' : id === GLM_ENTRY_FLASH ? 'sk-flash-BBB' : undefined),
      { FOO: 'bar', PATH: '/usr/bin' },
    );
    assert.ok(plan);
    assert.equal(plan.keyCount, 2);
    assert.equal(plan.childEnv.GLM_API_KEY, 'sk-main-AAA');
    assert.equal(plan.childEnv.GLM_FLASH_API_KEY, 'sk-flash-BBB');
    assert.equal(plan.childEnv.FOO, 'bar', 'base env 必须保全（spawn 子进程非裸 env）');
    assert.equal(plan.childEnv.PATH, '/usr/bin');
  });

  it('未知条目 id 零触（判据①最小权限解卡面·e-deepseek 族不入解卡域）', () => {
    const seen: string[] = [];
    buildGlmChildEnv((id) => { seen.push(id); return 'sk-x'; }, {});
    assert.deepEqual(seen.sort(), [GLM_ENTRY_FLASH, GLM_ENTRY_MAIN].sort(),
      'decryptEntry 只被调双 GLM 条目 id——其余条目（e-deepseek 等）零触');
  });
});

describe('a1 proxy-spawn: 零明文断言（白盒②）', () => {
  it('env patch 面最小性：仅增双 GLM 键·无其余键新增', () => {
    const base = { A: '1', B: '2', GLM_API_KEY: 'stale-old-value' };
    const plan = buildGlmChildEnv(
      (id) => (id === GLM_ENTRY_MAIN ? 'sk-new-plain' : 'sk-flash-plain'),
      base,
    );
    assert.ok(plan);
    const added = Object.keys(plan.childEnv).filter((k) => !(k in base));
    assert.deepEqual(added.sort(), ['GLM_FLASH_API_KEY'],
      'patch 面新增键=GLM_FLASH_API_KEY 单键（GLM_API_KEY 系覆盖非新增·零明文外溢面·判据②）');
    assert.equal(plan.childEnv.GLM_API_KEY, 'sk-new-plain', '主键=新解密值覆盖');
    assert.notEqual(plan.childEnv.GLM_API_KEY, 'stale-old-value', '旧值必须被新解密值覆盖');
    assert.equal(plan.childEnv.A, '1');
    assert.equal(plan.childEnv.B, '2');
  });

  it('真链 roundtrip：card 条目 encrypt→at-rest 无明文→decryptGlmEntry 还原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-proxyspawn-test-'));
    try {
      const plainMain = 'sk-glm-e2e-plain-001';
      const plainFlash = 'sk-glmflash-e2e-plain-002';
      const cardPath = sandboxCard(dir, {
        [GLM_ENTRY_MAIN]: {
          provider: 'glm', model: 'GLM-5.3',
          api_key_encrypted: encrypt(plainMain).toString('base64'),
          enabled: true, updated_at: '2026-11-17T00:00:00.000Z',
        },
        [GLM_ENTRY_FLASH]: {
          provider: 'glm', model: 'GLM-5.3-Flash',
          api_key_encrypted: encrypt(plainFlash).toString('base64'),
          enabled: true, updated_at: '2026-11-17T00:00:00.000Z',
        },
        'e-deepseek': {
          provider: 'deepseek', model: 'deepseek-v4-pro',
          api_key_encrypted: encrypt('sk-ds-not-touched').toString('base64'),
          enabled: true, updated_at: '2026-11-17T00:00:00.000Z',
        },
      });
      const prev = process.env[CARD_FILE_ENV];
      process.env[CARD_FILE_ENV] = cardPath;
      try {
        // at-rest 断言：卡原文零明文（base64 密文形态）
        const raw = readFileSync(cardPath, 'utf-8');
        assert.ok(!raw.includes(plainMain), 'card at-rest 不得含主条目明文');
        assert.ok(!raw.includes(plainFlash), 'card at-rest 不得含档条目明文');
        // 真链还原
        assert.equal(decryptGlmEntry(GLM_ENTRY_MAIN), plainMain);
        assert.equal(decryptGlmEntry(GLM_ENTRY_FLASH), plainFlash);
        // e-deepseek 零触面：解卡器可解但 buildGlmChildEnv 域不调（①面已证调用域）——
        // 此处补真链还原面证卡内第三条目形态自洽（非 a1 消费面）
        assert.equal(decryptGlmEntry('e-deepseek'), 'sk-ds-not-touched');
      } finally {
        if (prev === undefined) delete process.env[CARD_FILE_ENV];
        else process.env[CARD_FILE_ENV] = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('读数面计数形（零值面）：buildGlmChildEnv 返回结构只有 childEnv+keyCount 两键', () => {
    const plan = buildGlmChildEnv(() => 'sk-c', {});
    assert.ok(plan);
    assert.deepEqual(Object.keys(plan).sort(), ['childEnv', 'keyCount'],
      '读数面=计数形（keyCount）非值形——D-46 键名面零值面结构承载');
  });
});

describe('a1 proxy-spawn: fail-safe 缺条目形（白盒③）', () => {
  it('缺主条目 → null（不 spawn·现状维持）', () => {
    const plan = buildGlmChildEnv((id) => (id === GLM_ENTRY_FLASH ? 'sk-flash-only' : undefined), {});
    assert.equal(plan, null);
  });

  it('缺档条目 → 单键形降级（keyCount=1·GLM_FLASH_API_KEY 缺席不阻 spawn）', () => {
    const plan = buildGlmChildEnv((id) => (id === GLM_ENTRY_MAIN ? 'sk-main-only' : undefined), {});
    assert.ok(plan);
    assert.equal(plan.keyCount, 1);
    assert.equal(plan.childEnv.GLM_API_KEY, 'sk-main-only');
    assert.ok(!('GLM_FLASH_API_KEY' in plan.childEnv), '档键缺席=键不入 env（非空值形）');
  });

  it('空串解密值 → 视同缺席（缺主=null·缺档不注入）', () => {
    assert.equal(buildGlmChildEnv(() => '', {}), null, '主条目空串=null');
    const plan = buildGlmChildEnv((id) => (id === GLM_ENTRY_MAIN ? 'sk-m' : ''), {});
    assert.ok(plan);
    assert.equal(plan.keyCount, 1, '档条目空串=单键形');
    assert.ok(!('GLM_FLASH_API_KEY' in plan.childEnv));
  });

  it('坏卡（非法 JSON）→ undefined 零 throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-proxyspawn-bad-'));
    try {
      const cardPath = join(dir, 'trimmc-card.json');
      writeFileSync(cardPath, '{not-json');
      const prev = process.env[CARD_FILE_ENV];
      process.env[CARD_FILE_ENV] = cardPath;
      try {
        assert.equal(decryptGlmEntry(GLM_ENTRY_MAIN), undefined);
      } finally {
        if (prev === undefined) delete process.env[CARD_FILE_ENV];
        else process.env[CARD_FILE_ENV] = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无卡（env 钉不存在路径·独占候选序）→ undefined 零 throw 零回落', () => {
    const prev = process.env[CARD_FILE_ENV];
    process.env[CARD_FILE_ENV] = join(tmpdir(), `no-such-card-${process.pid}-x`, 'trimmc-card.json');
    try {
      assert.equal(decryptGlmEntry(GLM_ENTRY_MAIN), undefined,
        'env 独占候选序：钉路径缺席即无卡——不得回落真卡位');
    } finally {
      if (prev === undefined) delete process.env[CARD_FILE_ENV];
      else process.env[CARD_FILE_ENV] = prev;
    }
  });
});

describe('a1 proxy-spawn: 启动形双态解析（白盒附面）', () => {
  it('PROXY_SCRIPT_NAME=proxy-server·tsx dev 形（src 树）解析出 .ts+--import tsx', () => {
    assert.equal(PROXY_SCRIPT_NAME, 'proxy-server');
    const launch = resolveProxyLaunch();
    assert.ok(launch, '本仓 src/proxy-server.ts 在场——dev 形必可解析');
    assert.ok(launch.script.endsWith('proxy-server.ts'), `dev 形脚本=${launch.script}`);
    assert.deepEqual(launch.execArgs, ['--import', 'tsx']);
  });
});
