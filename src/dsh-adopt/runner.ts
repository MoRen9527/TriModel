// ── v3 adopt runner: cordis 插件 fsd-adopt-runner（BOD 托转 133·CTO 一审绿·FSD 主刀）──
// loop convene 投递面：为席位 adopt-or-create dsh 会话→letter 三模式注入→flush→one-shot 退出。
// 架构面（方案卷 §二/§九）：
//   · 零顶层依赖——全部服务经 ctx.get()（dsh 安装面解析域）；TriModel package.json 零新增依赖
//   · 版本 pin fail-visible（§9.3）：读安装面 package.json version 对 SUPPORTED_VERSIONS 矩阵，
//     不匹配拒跑（禁静默跨版本）——矩阵=两行已实证同构（rc.2 触点面 diff=EMPTY 承录）
//   · 适配层分层（§9.2）：dsh-gateway 面=本文件 ctx 触点段；deliver-core 面=纯业务段（零 dsh 依赖）
//   · dsh-llm 助手经 install-anchored 动态解析（config.dshInstallAnchor）——版本锁=安装面物理锁
// 挂载面：--patch overlay 调用级注入（headless-runner disabled + insert 本插件·TriCompany 面生成）。
// 读数面：JSON 状态行 stdout（D-46：零 letter 值回显·零值面）。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'path';
import { pathToFileURL } from 'url';

// ── 兼容矩阵（§9.3 版本 pin 面·两版触点面 0.2.2-rc.3 直测 diff=EMPTY 承录） ──
export const SUPPORTED_VERSIONS = ['0.2.0-rc.2', '0.2.2-rc.3'] as const;

export const PLUGIN_NAME = 'fsd-adopt-runner';

/** cordis 插件稳定名（loader name 解析 face）。 */
export const name = PLUGIN_NAME;

// ── dsh-gateway 面：最小结构类型（零 @deepseek-ai import·运行时全动态） ──

export interface AdoptRunnerConfig {
  /** 席位 id（=会话 id·r-duty-<seat> 形照 T2 映射表）。 */
  seat: string;
  /** 注入模式（proto prompt 三模式同构）。 */
  mode: 'queue' | 'steer' | 'inject';
  /** letter 文件路径（TriCompany 面生成 tmp 文件·YAML 转义面归零）。 */
  letterFile: string;
  /** dsh 安装根（含 package.json·版本 pin+install-anchored 解析双用）。 */
  dshInstallAnchor: string;
  /** 显式会话 id（缺省=seat）。 */
  sessionId?: string;
}

interface AgentLike {
  session: { seq: number };
  followup(message: unknown): void;
  steer(message: unknown): void;
  inject(message: unknown): void;
  whenIdle(): Promise<void>;
}

interface AgentsRegistryLike {
  get(sessionId: string): { session: { header?: Record<string, unknown> } } | undefined;
  resume(opts: { resumeSessionId: string; agentOptions?: unknown; setup?: unknown }): Promise<{ agent: AgentLike }>;
  create(opts: { sessionId: string; meta?: { cwd: string }; agentOptions?: unknown; setup?: unknown }): Promise<{ agent: AgentLike }>;
}

interface CtxLike {
  get(service: string): unknown;
}

export interface AdoptReadout {
  event: typeof PLUGIN_NAME;
  seat: string;
  sessionId: string;
  outcome: 'adopted-live' | 'adopted' | 'created';
  mode: string;
  flushed: true;
}

export interface RunnerIo {
  stdout(line: string): void;
  stderr(line: string): void;
  exit(code: number): void;
}

const defaultIo: RunnerIo = {
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
  exit: (code) => process.exit(code),
};

// ── deliver-core 面（纯业务·零 dsh 依赖） ─────────────────────────────

/** 配置手工校验（fail-visible·缺 Config schema 的等价守卫）。 */
export function validateConfig(raw: unknown): AdoptRunnerConfig {
  const c = (raw ?? {}) as Partial<AdoptRunnerConfig>;
  const missing: string[] = [];
  if (typeof c.seat !== 'string' || c.seat.trim() === '') missing.push('seat');
  if (c.mode !== 'queue' && c.mode !== 'steer' && c.mode !== 'inject') missing.push('mode');
  if (typeof c.letterFile !== 'string' || c.letterFile.trim() === '') missing.push('letterFile');
  if (typeof c.dshInstallAnchor !== 'string' || c.dshInstallAnchor.trim() === '') missing.push('dshInstallAnchor');
  if (missing.length) throw new Error(`${PLUGIN_NAME}: config missing/invalid: ${missing.join(', ')}`);
  return c as AdoptRunnerConfig;
}

/** 版本 pin（§9.3 fail-visible 拒跑）。 */
export function versionSupported(installed: string): boolean {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(installed);
}

export function readInstalledVersion(anchor: string): string {
  const pkg = JSON.parse(readFileSync(join(anchor, 'package.json'), 'utf-8')) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`${PLUGIN_NAME}: install anchor has no version field: ${anchor}`);
  }
  return pkg.version;
}

/** 读数面成形（D-46：状态/计数面零 letter 值）。 */
export function shapeReadout(seat: string, sessionId: string, outcome: AdoptReadout['outcome'], mode: string): AdoptReadout {
  return { event: PLUGIN_NAME, seat, sessionId, outcome, mode, flushed: true };
}

// ── dsh-gateway 面（ctx 触点收口段·版本升级只改此段） ─────────────────

/** install-anchored 解析 @deepseek-ai/dsh-llm（版本锁=安装面物理锁·fail-visible）。 */
async function loadRealMessageFactory(anchor: string): Promise<MessageFactory> {
  const req = createRequire(join(anchor, 'package.json'));
  const llmPath = req.resolve('@deepseek-ai/dsh-llm');
  const mod = (await import(pathToFileURL(llmPath).href)) as Record<string, unknown>;
  const helpers = (mod.createUserMessage ? mod : (mod.default as Record<string, unknown> | undefined)) ?? {};
  const createUserMessage = helpers.createUserMessage as ((arg: unknown) => unknown) | undefined;
  if (typeof createUserMessage !== 'function') {
    throw new Error(`${PLUGIN_NAME}: @deepseek-ai/dsh-llm createUserMessage unresolvable from anchor ${anchor}`);
  }
  return (letter: string) => createUserMessage({ content: [{ type: 'text', text: letter }], source: { kind: 'user' } });
}

/** 消息工厂缝（白盒注入面·运行时缺省=install-anchored 真链）。 */
export type MessageFactory = (letter: string) => unknown;

/** cwd 解析（fs 服务面·缺省 process.cwd 同 headless 形）。 */
async function resolveCwd(ctx: CtxLike): Promise<string> {
  const fs = ctx.get('fs') as { resolve(p: string): Promise<string>; processPath(p: string): string } | undefined;
  if (!fs) return process.cwd();
  return fs.processPath(await fs.resolve('.'));
}

/** 三模式注入映射（§白盒三模式映射表正形）。 */
function deliverMessage(agent: AgentLike, message: unknown, mode: AdoptRunnerConfig['mode']): void {
  if (mode === 'steer') agent.steer(message);
  else if (mode === 'inject') agent.inject(message);
  else agent.followup(message);
}

function exitVia(ctx: CtxLike, io: RunnerIo, code: number): void {
  const appExit = ctx.get('appExit');
  if (typeof appExit === 'function') (appExit as (code: number) => void)(code);
  else if (appExit && typeof (appExit as { exit?: unknown }).exit === 'function') (appExit as { exit: (code: number) => void }).exit(code);
  else io.exit(code);
}

// ── 插件 apply（cordis 契约·io 参数=白盒注入面·运行时 cordis 只传两参） ──

export async function apply(
  ctx: CtxLike,
  rawConfig: unknown,
  io: RunnerIo = defaultIo,
  buildMessage: MessageFactory | undefined = undefined,
): Promise<void> {
  try {
    const config = validateConfig(rawConfig);

    // ① 版本 pin fail-visible（§9.3）
    const installed = readInstalledVersion(config.dshInstallAnchor);
    if (!versionSupported(installed)) {
      throw new Error(`${PLUGIN_NAME}: dsh ${installed} not in supported matrix [${SUPPORTED_VERSIONS.join(', ')}] — refuse to run (fail-visible)`);
    }

    // ② letter 载入（文件面·零 YAML 转义域）
    const letter = readFileSync(config.letterFile, 'utf-8');
    if (letter.trim() === '') throw new Error(`${PLUGIN_NAME}: letter file empty: ${config.letterFile}`);

    const sessionId = config.sessionId?.trim() ? config.sessionId.trim() : config.seat;
    const cwd = await resolveCwd(ctx);
    const agents = ctx.get('agents') as AgentsRegistryLike | undefined;
    const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined;
    const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<void> } | undefined;
    if (!agents || !defaultModel || !sessions) {
      throw new Error(`${PLUGIN_NAME}: required services absent (agents/agentDefaultModel/sessions)`);
    }

    // ③ adopt-or-create 两腿（§2.1）：
    //    live 在册=adopted-live（投递进活体会话·非独占运行面——与 headless one-shot 互斥语义有意分叉）
    //    非活体=agents.resume persistence 直载（adopted）；registry 缺席=agents.create（created·七席自举）
    const agentOptions = defaultModel.currentSelection();
    let agent: AgentLike;
    let outcome: AdoptReadout['outcome'];
    const live = agents.get(sessionId);
    if (live) {
      agent = live as unknown as AgentLike;
      outcome = 'adopted-live';
    } else {
      try {
        ({ agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions }));
        outcome = 'adopted';
      } catch (resumeErr) {
        const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        if (!/not[- ]found|does not exist|no such session/i.test(msg)) throw resumeErr;
        ({ agent } = await agents.create({ sessionId, meta: { cwd }, agentOptions }));
        outcome = 'created';
      }
    }

    // ④ letter 三模式注入（queue/steer/inject·proto prompt 同构）
    const factory: MessageFactory = buildMessage ?? ((text: string) => loadRealMessageFactory(config.dshInstallAnchor).then((f) => f(text)));
    const message = await factory(letter);
    deliverMessage(agent, message, config.mode);

    // ⑤ flush（inject 形零 whenIdle——不唤醒语义；queue/steer 形待 quiescence 后 flush）
    if (config.mode !== 'inject') await agent.whenIdle();
    await sessions.flush((agent as { session: unknown }).session);

    // ⑥ 读数（JSON 状态行·零值面）+ one-shot 退出
    const readout = shapeReadout(config.seat, sessionId, outcome, config.mode);
    io.stdout(JSON.stringify(readout));
    exitVia(ctx, io, 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`dsh: ${PLUGIN_NAME}: ${msg}`);
    exitVia(ctx, io, 1);
  }
}
