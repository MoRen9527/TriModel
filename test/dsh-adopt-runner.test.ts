// ── v3 adopt runner 白盒族（BOD 托转 133·CTO 一审绿·mock ctx 形零真 boot）──
// 覆盖面（方案卷 §六.1）：
//   · Config schema 形=validateConfig（缺字段 fail-visible 清单形/非法 mode 拒收）
//   · 版本 pin=versionSupported 矩阵两行+不在册拒跑面（fail-visible）
//   · 两腿选择形：live 在册=adopted-live / resume 绿=adopted / resume not-found→create=created
//     /resume 非寻址错=原样抛（fail-visible 不吞错）
//   · 三模式映射表：queue→followup / steer→steer / inject→inject（inject 形零 whenIdle）
//   · 读数面零值断言：readout 结构=状态面六键·零 letter 内容回显（D-46）
//   · 版本拒跑端到端：不匹配版本→stderr fail-visible+exit 1（禁静默跨版本）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  PLUGIN_NAME,
  SUPPORTED_VERSIONS,
  validateConfig,
  versionSupported,
  shapeReadout,
  apply,
  type RunnerIo,
} from '../src/dsh-adopt/runner.js';

// ── mock 工具 ──

function fakeIo(): RunnerIo & { lines: string[]; errs: string[]; codes: number[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  const codes: number[] = [];
  return {
    lines, errs, codes,
    stdout: (l) => lines.push(l),
    stderr: (l) => errs.push(l),
    exit: (c) => codes.push(c),
  };
}

interface Recorder {
  calls: { name: string; arg?: unknown }[];
  resumeErr?: Error;
}

function fakeAgents(rec: Recorder, liveRequested?: object) {
  const delivered: { mode: string[]; msgs: unknown[] } = { mode: [], msgs: [] };
  const makeAgent = () => ({
    session: { seq: 7 },
    followup: (m: unknown) => { delivered.mode.push('followup'); delivered.msgs.push(m); },
    steer: (m: unknown) => { delivered.mode.push('steer'); delivered.msgs.push(m); },
    inject: (m: unknown) => { delivered.mode.push('inject'); delivered.msgs.push(m); },
    whenIdle: async () => { rec.calls.push({ name: 'whenIdle' }); },
  });
  const resumedAgent = makeAgent();
  const createdAgent = makeAgent();
  // live 在册面=同构完整 agent（投递四原语齐·get() 返回体）
  const liveAgent = liveRequested ? makeAgent() : undefined;
  const registry = {
    get: (id: string) => { rec.calls.push({ name: 'get', arg: id }); return liveAgent; },
    resume: async (opts: unknown) => {
      rec.calls.push({ name: 'resume', arg: opts });
      if (rec.resumeErr) throw rec.resumeErr;
      return { agent: resumedAgent };
    },
    create: async (opts: unknown) => {
      rec.calls.push({ name: 'create', arg: opts });
      return { agent: createdAgent };
    },
  };
  return { registry, delivered, resumedAgent, createdAgent, liveAgent };
}

function fakeCtx(agents: object) {
  return {
    get(name: string) {
      if (name === 'agents') return agents;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) };
      if (name === 'sessions') return { flush: async () => {} };
      if (name === 'fs') return { resolve: async (p: string) => p, processPath: (p: string) => p };
      if (name === 'appExit') return undefined; // io.exit 兜底面
      return undefined;
    },
  };
}

async function runApply(opts: {
  version: string;
  live?: object;
  resumeErr?: Error;
  mode?: 'queue' | 'steer' | 'inject';
  letter?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'trimodel-adoptrunner-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh', version: opts.version }));
    const letterFile = join(dir, 'letter.txt');
    const letterBody = opts.letter ?? 'convene letter body (fixture)';
    writeFileSync(letterFile, letterBody);
    const rec: Recorder = { calls: [], resumeErr: opts.resumeErr };
    const { registry, delivered, resumedAgent, createdAgent } = fakeAgents(rec, opts.live);
    const io = fakeIo();
    await apply(fakeCtx(registry), {
      seat: 'r-duty-cto',
      mode: opts.mode ?? 'queue',
      letterFile,
      dshInstallAnchor: dir,
    }, io, (text) => ({ marker: 'stub-message', text }));
    return { rec, io, delivered, resumedAgent, createdAgent, letterFile, letterBody };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Config schema 形（validateConfig） ──

describe('v3 runner: Config schema 形', () => {
  it('全字段绿·产出规范化配置', () => {
    const c = validateConfig({ seat: 'r-duty-cto', mode: 'steer', letterFile: '/tmp/l.txt', dshInstallAnchor: '/srv/fleet/dsh' });
    assert.equal(c.seat, 'r-duty-cto');
    assert.equal(c.mode, 'steer');
  });

  it('缺字段=fail-visible 清单形（逐字段点名）', () => {
    assert.throws(() => validateConfig({ seat: 'r-duty-cto' }), /letterFile, dshInstallAnchor|dshInstallAnchor, letterFile/);
    assert.throws(() => validateConfig(undefined), /seat/);
  });

  it('非法 mode=拒收（三值域外零容忍）', () => {
    assert.throws(() => validateConfig({ seat: 's', mode: 'wake', letterFile: 'x', dshInstallAnchor: 'y' }), /mode/);
  });
});

// ── 版本 pin（§9.3 fail-visible） ──

describe('v3 runner: 版本 pin fail-visible', () => {
  it('矩阵两行在册（0.2.0-rc.2+0.2.2-rc.3·跨版本实证承录）', () => {
    assert.deepEqual([...SUPPORTED_VERSIONS], ['0.2.0-rc.2', '0.2.2-rc.3']);
    assert.ok(versionSupported('0.2.0-rc.2'));
    assert.ok(versionSupported('0.2.2-rc.3'));
  });

  it('不在册版本=拒跑端到端（stderr fail-visible+exit 1·禁静默跨版本）', async () => {
    const { io, rec } = await runApply({ version: '0.3.0-alpha.1' });
    assert.equal(io.codes.length, 1);
    assert.equal(io.codes[0], 1);
    assert.match(io.errs[0], /not in supported matrix/);
    assert.ok(io.errs[0].includes(PLUGIN_NAME));
    assert.equal(rec.calls.filter((c) => c.name === 'get' && c.arg === 'r-duty-cto').length, 0,
      '版本拒跑必须先于任何会话触面（零静默跨版本运行）');
  });
});

// ── 两腿选择形 ──

describe('v3 runner: adopt-or-create 两腿', () => {
  it('live 在册=adopted-live（投递进活体会话·零 resume/create 调用）', async () => {
    const live = { session: { header: {} } };
    const { io, rec } = await runApply({ version: '0.2.0-rc.2', live });
    assert.equal(io.codes[0], 0);
    const readout = JSON.parse(io.lines[0]);
    assert.equal(readout.outcome, 'adopted-live');
    assert.equal(rec.calls.filter((c) => c.name === 'resume').length, 0);
    assert.equal(rec.calls.filter((c) => c.name === 'create').length, 0);
  });

  it('resume 绿=adopted（persistence 直载腿·resumeSessionId=seat）', async () => {
    const { io, rec } = await runApply({ version: '0.2.0-rc.2' });
    const readout = JSON.parse(io.lines[0]);
    assert.equal(readout.outcome, 'adopted');
    const resumeCall = rec.calls.find((c) => c.name === 'resume');
    assert.equal((resumeCall?.arg as { resumeSessionId: string }).resumeSessionId, 'r-duty-cto');
  });

  it('resume not-found→create 腿=created（七席自举·meta.cwd 注入）', async () => {
    const { io, rec } = await runApply({ version: '0.2.0-rc.2', resumeErr: new Error('session does not exist') });
    const readout = JSON.parse(io.lines[0]);
    assert.equal(readout.outcome, 'created');
    assert.ok(rec.calls.some((c) => c.name === 'create'));
    const createArg = rec.calls.find((c) => c.name === 'create')?.arg as { sessionId: string; meta?: { cwd: string } };
    assert.equal(createArg.sessionId, 'r-duty-cto');
    assert.ok(createArg.meta && typeof createArg.meta.cwd === 'string');
  });

  it('resume 非寻址错=原样抛 fail-visible（不吞错不误转 create）', async () => {
    const { io } = await runApply({ version: '0.2.0-rc.2', resumeErr: new Error('persistence corrupted') });
    assert.equal(io.codes[0], 1);
    assert.match(io.errs[0], /persistence corrupted/);
  });

  it('显式 sessionId 覆盖缺省 seat 形', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trimodel-adoptrunner-sid-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh', version: '0.2.0-rc.2' }));
      const letterFile = join(dir, 'letter.txt');
      writeFileSync(letterFile, 'body');
      const rec: Recorder = { calls: [] };
      const { registry, resumedAgent } = fakeAgents(rec);
      const io = fakeIo();
      await apply(fakeCtx(registry), {
        seat: 'r-duty-cto', mode: 'queue', letterFile, dshInstallAnchor: dir, sessionId: 'session-abc',
      }, io, (text) => ({ marker: 'stub-message', text }));
      assert.equal((rec.calls.find((c) => c.name === 'resume')?.arg as { resumeSessionId: string }).resumeSessionId, 'session-abc');
      assert.equal((JSON.parse(io.lines[0]) as { sessionId: string }).sessionId, 'session-abc');
      assert.ok(resumedAgent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 三模式映射表 ──

describe('v3 runner: 三模式映射表', () => {
  it('queue→followup（待 whenIdle 后 flush）', async () => {
    const { delivered, rec } = await runApply({ version: '0.2.0-rc.2', mode: 'queue' });
    assert.deepEqual(delivered.mode, ['followup']);
    assert.ok(rec.calls.some((c) => c.name === 'whenIdle'));
  });

  it('steer→steer', async () => {
    const { delivered } = await runApply({ version: '0.2.0-rc.2', mode: 'steer' });
    assert.deepEqual(delivered.mode, ['steer']);
  });

  it('inject→inject（不唤醒语义·零 whenIdle 调用）', async () => {
    const { delivered, rec } = await runApply({ version: '0.2.0-rc.2', mode: 'inject' });
    assert.deepEqual(delivered.mode, ['inject']);
    assert.equal(rec.calls.filter((c) => c.name === 'whenIdle').length, 0);
  });
});

// ── 读数面零值断言（D-46） ──

describe('v3 runner: 读数面零值（D-46）', () => {
  it('readout=状态六键·零 letter 内容回显', async () => {
    const secret = 'CONVENE-SECRET-MARKER-xyzzy';
    const { io } = await runApply({ version: '0.2.0-rc.2', letter: `hello ${secret}` });
    assert.equal(io.codes[0], 0);
    assert.equal(io.lines.length, 1, 'stdout 单行状态读数');
    assert.ok(!io.lines[0].includes(secret), 'letter 值面禁入读数（D-46 零值面）');
    const keys = Object.keys(JSON.parse(io.lines[0])).sort();
    assert.deepEqual(keys, ['event', 'flushed', 'mode', 'outcome', 'seat', 'sessionId']);
  });

  it('shapeReadout 纯函数=flushed 恒 true 状态面', () => {
    const r = shapeReadout('seat', 'sid', 'created', 'inject');
    assert.equal(r.event, PLUGIN_NAME);
    assert.equal(r.flushed, true);
  });
});
