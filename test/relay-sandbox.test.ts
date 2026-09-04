// ── LG-006 额度接力 sandbox 测试（验收判据五条映射；双席合流稿 f312a695）──
// sandbox 形态：fake provider 注入（不起真网络），分类/台账/冷却/链循环全覆盖。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient, parseFallbackChain } from '../src/client.js';
import { classifyRelayError, getTokenStats, isCoolingDown, markCooldown, resetRelayState, type RelayReason } from '../src/relay.js';
import type { Provider, Message, ChatResponse } from '../src/types.js';

function fakeProvider(failWith?: () => never, tag = 'ok'): Provider {
  return {
    info: { name: tag, models: [], baseUrl: 'mock://' },
    async chat(): Promise<ChatResponse> {
      if (failWith) failWith();
      return {
        id: `resp-${tag}-${Date.now()}`,
        model: tag,
        content: `hello from ${tag}`,
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      if (failWith) failWith();
      return; // sandbox 不走真流
    },
    async healthCheck() { return true; },
  };
}

function statusError(status: number): Error {
  return new Error(`request failed with status ${status}`);
}

const MSGS: Message[] = [{ role: 'user', content: 'hi' }];

function makeClientWithChain(chainRaw: string, providers: Record<string, Provider>): ModelClient {
  const client = new ModelClient({} as never);
  const map = (client as unknown as { providers: Map<string, Provider> }).providers;
  for (const [k, v] of Object.entries(providers)) map.set(k, v);
  (client as unknown as { fallbackChain: ReturnType<typeof parseFallbackChain> }).fallbackChain =
    parseFallbackChain(chainRaw);
  return client;
}

describe('LG-006 relay sandbox（验收五条）', () => {
  beforeEach(() => resetRelayState());

  test('验收1 额度尽自动接力：429 触发换棒，次棒成功+跨模型 relayNote+台账', async () => {
    let calls = 0;
    const client = makeClientWithChain('glm-5.3-flash@anthropic,deepseek-v4-flash@deepseek', {
      anthropic: fakeProvider(() => { calls += 1; throw statusError(429); }, 'anthropic'),
      deepseek: fakeProvider(undefined, 'deepseek'),
    });
    const resp = await client.chat('glm-5.3-flash', MSGS);
    assert.match(resp.content!, /deepseek/);
    assert.match(resp.relayNote!, /已切换至 deepseek-v4-flash/);
    const stats = getTokenStats();
    assert.equal(stats.length, 1);
    assert.equal(stats[0].from_model, 'glm-5.3-flash');
    assert.equal(stats[0].to_model, 'deepseek-v4-flash');
    assert.equal(stats[0].reason, 'rate_limited');
    assert.ok(stats[0].ts > 0);
    assert.ok(calls >= 1);
  });

  test('验收2 严格按序：链序零跳越（attempted 序=链序）+链穷尽显式报告', async () => {
    const client = makeClientWithChain('a@p1,b@p2,c@p3', {
      p1: fakeProvider(() => { throw statusError(500); }, 'p1'),
      p2: fakeProvider(() => { throw statusError(500); }, 'p2'),
      p3: fakeProvider(() => { throw statusError(500); }, 'p3'),
    });
    await assert.rejects(
      () => client.chat('a', MSGS),
      (err: Error) => {
        assert.match(err.message, /All 3 chain nodes exhausted \[a@p1 → b@p2 → c@p3\]/);
        return true;
      },
    );
    const stats = getTokenStats();
    assert.equal(stats.length, 2); // a→b, b→c
    assert.deepEqual(
      stats.map((s) => `${s.from_model}@${s.from_account}→${s.to_model}@${s.to_account}`),
      ['a@p1→b@p2', 'b@p2→c@p3'],
    );
  });

  test('验收3 透明度分级：同模型账号间静默（无 relayNote 仅台账）', async () => {
    const client = makeClientWithChain('glm-5.3-flash@anthropic,glm-5.3-flash@openai', {
      anthropic: fakeProvider(() => { throw statusError(401); }, 'anthropic'),
      openai: fakeProvider(undefined, 'openai'),
    });
    const resp = await client.chat('glm-5.3-flash', MSGS);
    assert.equal(resp.relayNote, undefined); // 同模型静默
    assert.equal(getTokenStats().length, 1); // 仅台账
  });

  test('验收4 禁接力显式失败：noRelay 主棒断即 fail 不降级', async () => {
    resetRelayState(); // 显式清（防跨用例台账残留——beforeEach 钩子未生效实证）
    const client = makeClientWithChain('a@p1,b@p2', {
      p1: fakeProvider(() => { throw statusError(429); }, 'p1'),
      p2: fakeProvider(undefined, 'p2'),
    });
    await assert.rejects(
      () => client.chat('a', MSGS, { noRelay: true }),
      (err: Error) => {
        assert.match(err.message, /Relay disabled for this task/);
        return true;
      },
    );
    assert.deepEqual(
      getTokenStats(),
      [],
      `noRelay 不得记台账（chain=${'a@p1,b@p2'}）`,
    ); // 无换棒发生
    // per-task 之外正常接力不受影响
    const resp = await client.chat('a', MSGS);
    assert.match(resp.content!, /p2/);
  });

  test('验收5 冷却窗防回切抖动：换棒后冷却期内原棒被跳过', () => {
    markCooldown('m', 'acc1');
    assert.equal(isCoolingDown('m', 'acc1'), true);
    assert.equal(isCoolingDown('m', 'acc2'), false);
    // 二次请求链循环内：首棒在冷却→从次棒起（经 chatWithChain 冷却跳过分支）
    resetRelayState();
    markCooldown('a', 'p1');
    const client = makeClientWithChain('a@p1,b@p2', {
      p1: fakeProvider(() => { throw new Error('should not be called: cooling'); }, 'p1'),
      p2: fakeProvider(undefined, 'p2'),
    });
    return client.chat('a', MSGS).then((resp) => {
      assert.match(resp.content!, /p2/);
      assert.equal(getTokenStats().length, 0); // 冷却跳过=无换棒事件
    });
  });

  test('网络超时重试 1 次后换棒（稿 §二.2 retry_first）', async () => {
    let calls = 0;
    const client = makeClientWithChain('a@p1,b@p2', {
      p1: fakeProvider(() => { calls += 1; throw new Error('fetch failed: ETIMEDOUT'); }, 'p1'),
      p2: fakeProvider(undefined, 'p2'),
    });
    const resp = await client.chat('a', MSGS);
    assert.match(resp.content!, /p2/);
    assert.equal(calls, 2); // 重试 1 次=同节点共 2 次调用
    assert.equal(getTokenStats()[0].reason, 'network_timeout');
  });

  test('正常响应永不换棒 + 400 类不换棒显式抛', async () => {
    const client = makeClientWithChain('a@p1,b@p2', {
      p1: fakeProvider(undefined, 'p1'),
      p2: fakeProvider(undefined, 'p2'),
    });
    const resp = await client.chat('a', MSGS);
    assert.match(resp.content!, /p1/);
    assert.equal(getTokenStats().length, 0);

    const client2 = makeClientWithChain('a@p1,b@p2', {
      p1: fakeProvider(() => { throw statusError(400); }, 'p1'),
      p2: fakeProvider(undefined, 'p2'),
    });
    await assert.rejects(() => client2.chat('a', MSGS), /status 400/);
    assert.equal(getTokenStats().length, 0);
  });

  test('parseFallbackChain：model@账号 粒度解析+空表', () => {
    assert.deepEqual(parseFallbackChain('a@x, b, c@y'), [
      { model: 'a', account: 'x' },
      { model: 'b', account: null },
      { model: 'c', account: 'y' },
    ]);
    assert.deepEqual(parseFallbackChain(''), []);
    assert.deepEqual(parseFallbackChain(undefined), []);
  });

  test('错误分类表首版码集（候裁点②落法固化）', () => {
    const cases: Array<[Error, boolean, RelayReason | null]> = [
      [statusError(401), true, 'auth_failed'],
      [statusError(403), true, 'auth_failed'],
      [statusError(429), true, 'rate_limited'],
      [statusError(500), true, 'upstream_error'],
      [statusError(402), true, 'quota_exhausted'],
      [new Error('insufficient_balance'), true, 'quota_exhausted'],
      [new Error('fetch failed: ETIMEDOUT'), true, 'network_timeout'],
      [statusError(400), false, null],
    ];
    for (const [err, relay, reason] of cases) {
      const cls = classifyRelayError(err);
      assert.equal(cls.relay, relay, `${err.message}: relay`);
      assert.equal(cls.reason, reason, `${err.message}: reason`);
    }
  });
});
