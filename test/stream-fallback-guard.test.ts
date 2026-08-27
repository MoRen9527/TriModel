/**
 * ============================================================================
 * P0-1 对抗守护测试（stream 中途失败 x 有/无 fallback 门禁回归）
 * ============================================================================
 *
 * 运行环境（sandbox）：
 *   本文件由编排层复制进 p0fix4-trimodel-stream 树的 reports/sandbox/test/ 下，
 *   与镜像的 src/**（overlay 了 PE-1 修复版 client.ts，工件 reports/pe1/client.ts.fixed）
 *   及既有 usage.test.ts / client.test.ts 同目录同跑：
 *     node18 --import tsx --test sandbox/test/*.test.ts
 *   导入路径用相对形式 `../src/client.js`（tsx 解析 .js -> .ts）。
 *   StreamAbortedError 必须经 ../src/client.js 直接导入 —— index.js 未 re-export 该类。
 *
 * 被测对象定位：
 *   sandbox/src/client.ts 的 ModelClient.stream()（PE-1 修复后形态）
 *     - reports/pe1/client.ts.fixed:255-265  emitted 每帧私有旗标（try 外声明、yield 前自增）
 *     - client.ts.fixed:267-273              已发 >=1 后失败 -> 一律抛 StreamAbortedError({cause})
 *     - client.ts.fixed:274-281              首事件前失败 -> 有 fallback 则递归(_depth+1)；否则原样重抛
 *     - client.ts.fixed:141-146              StreamAbortedError 类（extends Error, options.cause, name 固定）
 *   路由真源（同一 client.ts.fixed 的 buildRegistry）：
 *     - :20-24   deepseek-chat            primary=deepseek,        fallback=deepseek-v4-flash
 *     - :50-54   tmv-deepseek-reasoner    primary=trimetaverse,    fallback=undefined（无兜底路由例）
 *
 * PE-1 四象限契约映射表（pe1-fix-report.md 第 2.1 节原文口径）：
 *   | 失败时机          | route.fallback | 行为                                                     |
 *   | ----------------- | -------------- | -------------------------------------------------------- |
 *   | 首个事件前        | 是             | console.warn + 递归 fallback(_depth+1)，代码逐字未动        |
 *   | 首个事件前        | 否             | 原错误原样抛出不动                                        |
 *   | 已 yield >=1 之后 | 是             | 抛 StreamAbortedError(message 含模型名, {cause})，禁拼接    |
 *   | 已 yield >=1 之后 | 否             | 同样抛 StreamAbortedError 包装（编排层裁定的统一辨型口径）  |
 *
 * 用例 <-> 审计向量对应关系：
 *   g1 = Q「已发>=1 x 有fallback」：截断 A + 全量 B 静默拼接死证 —— fetch 必须
 *        恰好 1 次（fallback 流从未启动即结构性排除拼接），前缀事件全部 A 标记，
 *        抛 StreamAbortedError 且 cause 为原错误【同一实例】。
 *   g2 = Q「首事件前 x 有fallback」：chat() 同款整轮 fallback 保留 —— 整体正常
 *        完成、全部事件 B 标记、零 A 残留、fetch 恰 2 次（>=2 规格）。
 *   g3 = Q「已发>=1 x 无fallback」(tmv-deepseek-reasoner)：统一包装口径 —— 仍抛
 *        StreamAbortedError、cause 在案、message 指认断流模型、fetch 恰 1 次。
 *   g4 = Q「首事件前 x 无fallback」：原错误原样透传 —— name 保持 'Error' 非
 *        StreamAbortedError，message 匹配 provider 原始错误面，零事件外泄。
 *   g5 = StreamAbortedError 单元直测：name/message/cause 三属性逐项。
 *   g6 = 深度上限既有回归钉：全 provider 恒 503 时 chat('deepseek-v4-pro')
 *        仍拒 /All fallback models exhausted/（修复杂化兜底路径的守护）。
 *   g7 = （本守卫套件自加的补充回归钉）无失败正常流式链路行为不变：正常收尾、
 *        全部 A 标记、单拨号 —— 防「修复破坏基本流」这类修复自身引入的回归。
 *
 * 源码校准依据（全部实读，file:line）：
 *   - delta 事件形状不臆测：openai 兼容流 data 行协议产出
 *     {delta:string, finish_reason:null|null|...}（TriModel src/providers/stream/openai-sse-parser.ts:32-78，
 *     deepseek 走它：src/providers/deepseek.ts:132-147 yield* parseOpenAISSE）；
 *     tmv 走 anthropic SSE「\n\n」分帧 + text_delta 产出 {delta:text}（trimetaverse
 *     src/providers/trimetaverse.ts:261-276 -> src/providers/stream/anthropic-sse-parser.ts:40-64）。
 *   - 错误面正则出处：src/providers/deepseek.ts:142-145（`DeepSeek API error <st>: <body>`）、
 *     src/providers/trimetaverse.ts:271-274（`TriMetaverse API error <st>: <body>`）。
 *   - SSE 注入手法学自既有 Streaming describe（TriModel test/client.test.ts:297-346，
 *     ReadableStream pull -> enqueue(Uint8Array) -> close/error，包进 new Response(stream,{status:200})）。
 *   - testConfig 照抄 test/client.test.ts:6-20（deepseek+anthropic+openai+trimetaverse 四家 mock key）。
 *
 * 如实申报（诚实纪律）：
 *   本实例无 Bash 工具面，全程未经运行执行——本文件的每个「应然」结论均来自上述
 *   实读源码的静态推导；凡依赖运行时流调度细节而无法从字面完全锁死的点，逐处标注
 *   「推演待实证 T#」，门禁执行由编排层承担。当前登记共 4 条：
 *     T1 g1/g3/g7 的 pull/highWaterMark(=1) 与消费端交错顺序：出错终局前调用方可见
 *        前缀恰为已入队增量（推导源：ReadableStream 队列上限 + 既有 test 先例同款手法）。
 *     T2 controller.error(原实例) 经 reader.read() 拒绝 -> parser -> provider 再抛后，
 *        cause 身份仍为同一 Error 实例（WHATWG error(reason) 按值传递拒因）。
 *     T3 g6 恰好 3 次上游拨号：_depth>MAX_FALLBACK_DEPTH 的判定在 client.ts.fixed:242-244
 *        位于帧入口、先于任何 provider 访问 -> 0/1/2 三帧各一拨、第 4 帧入口即断。
 *     T4 相对导入 ../src/client.js 由 tsx 解析为 sandbox/src/client.ts 并随镜像落位
 *        可跑（任务书口径，非本实例可执行验证）；tsc --noEmit 只含 src/**（类型健全
 *        仅作静态义务，不入门禁）。
 * ============================================================================
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

// 类型面独走 types.js（纯类型导出、零副作用）；config.js 仅 type-import，
// 运行期不会触发其模块顶层的 dotenv 自动装载，保住测试封闭性。
import type { TriModelConfig } from '../src/config.js';
import type { Message, StreamEvent } from '../src/types.js';
// StreamAbortedError 不经 index.js（未 re-export），直取模块本体。
import { ModelClient, StreamAbortedError } from '../src/client.js';

// ── testConfig：照抄 TriModel test/client.test.ts:6-20 形态 ──────────────────
const testConfig: TriModelConfig = {
  deepseekApiKey: 'sk-test-mock-key',
  deepseekBaseUrl: 'https://api.deepseek.com/v1',
  deepseekAnthropicBaseUrl: 'https://api.deepseek.com/anthropic',
  anthropicApiKey: 'ant-test-mock-key',
  anthropicBaseUrl: 'https://api.anthropic.com',
  openaiApiKey: 'sk-openai-test-mock-key',
  openaiBaseUrl: 'https://api.openai.com',
  trimetaverseApiKey: 'tmv-sk-dev-test',
  trimetaverseBaseUrl: 'http://127.0.0.1:8000/v1',
  primaryProvider: 'deepseek',
  defaultModel: 'deepseek-v4-pro',
  fallbackModel: 'deepseek-v4-flash',
  requestTimeoutMs: 5000,
};

const MESSAGES: Message[] = [{ role: 'user', content: 'p0fix4 PE-T guard probe' }];

// 模型归属标记：注入 mock SSE 正文，用于逐事件断言「输出来自哪个模型」。
const TAG_A = '[[[GUARD-A-CHUNK';
const TAG_B = '[[[GUARD-B-CHUNK';
const TAG_TMV = '[[[GUARD-TMV-CHUNK';

const ENCODER = new TextEncoder();
const OPENAI_SSE_DONE = 'data: [DONE]\n\n';

/** OpenAI 兼容（deepseek 走此协议）内容增量 SSE 数据行，行尾 \\n 保证 parser 即时可解析。 */
function openAiContentChunk(text: string): string {
  const payload = {
    id: 'chatcmpl-guard',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Anthropic 协议（trimetaverse 走此协议）text_delta SSE 事件块，「\n\n」分帧。 */
function anthropicTextDeltaChunk(text: string): string {
  const payload = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 把字符串分片装进 ReadableStream：按 pull 逐一放行；分片耗尽后要么
 * controller.error(terminalError) 制造中途断流，要么 close() 正常收尾。
 * 手法对齐 TriModel test/client.test.ts:318-331 的 Streaming 先例。
 */
function sseBodyStream(chunks: readonly string[], terminalError: unknown): ReadableStream<Uint8Array> {
  let cursor = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor < chunks.length) {
        controller.enqueue(ENCODER.encode(chunks[cursor]));
        cursor += 1;
        return;
      }
      if (terminalError !== undefined) {
        controller.error(terminalError);
        return;
      }
      controller.close();
    },
  });
}

/** 抓取 generator 生命周期内抛出的异常对象，供后续逐属性细察。 */
async function drainInto(gen: AsyncGenerator<StreamEvent>, sink: StreamEvent[]): Promise<void> {
  for await (const event of gen) {
    sink.push(event);
  }
}

function newTextResponse(chunks: readonly string[], terminalError: unknown): Response {
  return new Response(sseBodyStream(chunks, terminalError), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('P0-1 stream fallback 对抗守护（PE-T 沙箱）', () => {
  let originalFetch: typeof globalThis.fetch;

  // 保存/恢复真实 fetch，防污染同跑兄弟文件（usage.test.ts / client.test.ts）。
  // 各用例自行整体覆写 globalThis.fetch（既有 client.test.ts 内联覆写先例 :114/:195）。
  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('g1 [已发>=1 x 有fallback] 中途错拒拼接：前缀全 A、抛 StreamAbortedError、cause 同实例、fetch 恰 1 次', async () => {
    const client = new ModelClient(testConfig);
    const upstreamReset = new Error('mock upstream reset after partial emission');
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      // deepseek-chat 路由唯一上游端口；若 fallback（deepseek-v4-flash）被启动，
      // 会发生第二次拨号 —— 此处不主动拦截，让计数在断言尾暴露违规。
      fetchCalls += 1;
      return newTextResponse(
        [openAiContentChunk(`${TAG_A}-p1>>`), openAiContentChunk(`${TAG_A}-p2>>`)],
        upstreamReset,
      );
    };

    const got: StreamEvent[] = [];
    let caught: unknown;
    try {
      await drainInto(client.stream('deepseek-chat', MESSAGES), got);
    } catch (err) {
      caught = err;
    }

    // 前缀审计：中断前到达调用方的每一个事件都必须来自 A 模型。
    assert.ok(got.length >= 2, `expected >=2 prefix events, got ${got.length}: ${inspect(got)}`);
    for (const event of got) {
      assert.ok(
        event.delta.startsWith(TAG_A),
        `pre-abort event did not come from model A: ${JSON.stringify(event.delta)}`,
      );
    }

    // 抛弃拼接：必须以命名错误终止，且 message 自指认失败模型。
    assert.ok(caught instanceof StreamAbortedError, `expected StreamAbortedError, got ${inspect(caught)}`);
    const aborted = caught as StreamAbortedError;
    assert.match(aborted.message, /aborted-in-stream/);
    assert.match(aborted.message, /deepseek-chat/);

    // cause 必须是原错误【同一实例】而非副本（推演待实证 T2：error(reason) 拒因按值透传）。
    assert.equal(aborted.cause, upstreamReset);

    // B 流从未启动 = 拼接死证：整个生命周期只允许一次上游拨号。
    assert.equal(fetchCalls, 1);
  });

  it('g2 [首事件前 x 有fallback] 整体成功完成、全部事件来自 B、零 A 残留、fetch>=2', async () => {
    const client = new ModelClient(testConfig);
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        // 首事件前失败：429 让 deepseek 在 parseOpenAISSE 之前就抛（emitted 仍 false）。
        return new Response(JSON.stringify({ error: { message: 'rate limited before first byte' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // fallback deepseek-v4-flash：同走 deepseek 协议端点，输出打 B 标记并完整收尾。
      return newTextResponse(
        [
          openAiContentChunk(`${TAG_B}-b1>>`),
          openAiContentChunk(`${TAG_B}-b2>>`),
          OPENAI_SSE_DONE,
        ],
        undefined,
      );
    };

    const got: StreamEvent[] = [];
    // 关键差异：此处【不得抛】——首事件前失败允许整轮换模重来直至成功收尾。
    await drainInto(client.stream('deepseek-chat', MESSAGES), got);

    assert.ok(got.length >= 2, `fallback stream should deliver >=2 events, got ${got.length}`);
    const joined = got.map((event) => event.delta).join('');
    assert.ok(!joined.includes(TAG_A), 'A-model residue must not leak into a clean fallback stream');
    for (const event of got) {
      assert.ok(
        event.delta.startsWith(TAG_B),
        `post-fallback event did not come from model B: ${JSON.stringify(event.delta)}`,
      );
    }
    // 主拨号(A 失败)+兜底拨号(B 成功)=恰 2 次（强于规格下限 >=2 的精确形态）。
    assert.equal(fetchCalls, 2);
  });

  it('g3 [已发>=1 x 无fallback(tmvr)] 统一包装口径：仍抛 StreamAbortedError、cause 在案、不重拨', async () => {
    const client = new ModelClient(testConfig);
    const tmvReset = new Error('mock tmv stream collapsed mid-flight');
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      // tmv-deepseek-reasoner 走 TriStaciss anthropic 兼容端点 /messages。
      return newTextResponse(
        [anthropicTextDeltaChunk(`${TAG_TMV}-t1>>`), anthropicTextDeltaChunk(`${TAG_TMV}-t2>>`)],
        tmvReset,
      );
    };

    const got: StreamEvent[] = [];
    let caught: unknown;
    try {
      await drainInto(client.stream('tmv-deepseek-reasoner', MESSAGES), got);
    } catch (err) {
      caught = err;
    }

    assert.ok(got.length >= 2, `expected >=2 tmv prefix events, got ${got.length}`);
    for (const event of got) {
      assert.ok(event.delta.startsWith(TAG_TMV), `unexpected non-tmv delta: ${JSON.stringify(event.delta)}`);
    }

    // 编排层裁定统一口径：无 fallback 也必须包装成同名错误供上层单一辨型，
    // 而不是把 provider 原生错误直接漏给调用方。
    assert.ok(caught instanceof StreamAbortedError, `expected StreamAbortedError, got ${inspect(caught)}`);
    const aborted = caught as StreamAbortedError;
    assert.match(aborted.message, /tmv-deepseek-reasoner/);
    assert.equal(aborted.cause, tmvReset);
    // fallback 本就是 undefined：一次拨号后必须直接终局，不存在任何隐藏重试。
    assert.equal(fetchCalls, 1);
  });

  it('g4 [首事件前 x 无fallback] 原错误原样透传：name 非 StreamAbortedError、零事件外泄、单拨号', async () => {
    const client = new ModelClient(testConfig);
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'guard-503 unavailable' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const got: StreamEvent[] = [];
    let caught: unknown;
    try {
      await drainInto(client.stream('tmv-deepseek-reasoner', MESSAGES), got);
    } catch (err) {
      caught = err;
    }

    // 「首事件前」的定义闭环：调用方一条事件都不该见到。
    assert.equal(got.length, 0, `no event may escape a pre-first-event failure, got ${inspect(got)}`);

    // 原样透传的硬证据：默认 Error 名（未改写 name）、非包装类、provider 原始错误面。
    assert.ok(caught instanceof Error, `expected an Error, got ${inspect(caught)}`);
    assert.ok(!(caught instanceof StreamAbortedError), 'pre-event failure without fallback must NOT be wrapped');
    assert.equal((caught as Error).name, 'Error');
    // 正则出处：TrimetaverseProvider.stream 的 !ok 分支模板（trimetaverse.ts:271-274）。
    assert.match((caught as Error).message, /^TriMetaverse API error 503:/);
    assert.equal(fetchCalls, 1);
  });

  it('g5 StreamAbortedError 单元直测：name/message/cause 三属性逐项成立', () => {
    const root = new TypeError('original provider fault');
    const wrapped = new StreamAbortedError('x', { cause: root });

    assert.equal(wrapped.name, 'StreamAbortedError');
    assert.equal(wrapped.message, 'x');
    assert.equal(wrapped.cause, root);
    // 保持 Error 血统，instanceof 辨型通路可用（client.ts.fixed:141-146）。
    assert.ok(wrapped instanceof Error);
  });

  it('g6 深度上限回归钉：全 provider 恒 503 时 chat(v4-pro) 仍拒 /All fallback models exhausted/', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'service unavailable' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = new ModelClient(testConfig);

    // 既有行为（client.test.ts:193-209 同款场景）：深度熔断文案必须在案。
    await assert.rejects(() => client.chat('deepseek-v4-pro', MESSAGES), /All fallback models exhausted/);

    // 静态推导恰好 3 次（推演待实证 T3）：v4-pro<->v4-flash 环，depth 0/1/2 各一拨，
    // depth 3 在帧入口（client.ts.fixed:242-244，先于 provider 访问）即断。
    assert.equal(fetchCalls, 3);
  });

  it('g7 [补充回归钉] 修复不破常规：无失败正常流照常收尾、全 A 标记、单拨号', async () => {
    const client = new ModelClient(testConfig);
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return newTextResponse(
        [openAiContentChunk(`${TAG_A}-c1>>`), openAiContentChunk(`${TAG_A}-c2>>`), OPENAI_SSE_DONE],
        undefined,
      );
    };

    // 不得有任何异常逃逸 —— 正常完成本身是断言的一部分。
    const got: StreamEvent[] = [];
    await drainInto(client.stream('deepseek-chat', MESSAGES), got);

    assert.ok(got.length >= 2);
    const joined = got.map((event) => event.delta).join('');
    assert.ok(joined.startsWith(TAG_A), `normal stream corrupted: ${JSON.stringify(joined)}`);
    assert.equal(fetchCalls, 1);
  });
});
