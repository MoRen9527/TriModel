import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageAccumulator } from '../src/usage.js';
import type { ChatResponse } from '../src/types.js';

function makeResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    id: 'test-001',
    model: 'deepseek-chat',
    content: 'Hello',
    finish_reason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

describe('UsageAccumulator', () => {
  it('should accumulate a single response', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse());
    const s = acc.summary();

    assert.equal(s.calls, 1);
    assert.equal(s.tokens.prompt_tokens, 10);
    assert.equal(s.tokens.completion_tokens, 5);
    assert.equal(s.tokens.total_tokens, 15);
  });

  it('should accumulate multiple responses', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse({ model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    acc.add(makeResponse({ model: 'deepseek-chat', usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }));

    const s = acc.summary();
    assert.equal(s.calls, 2);
    assert.equal(s.tokens.prompt_tokens, 30);
    assert.equal(s.tokens.completion_tokens, 13);
    assert.equal(s.tokens.total_tokens, 43);
  });

  it('should track usage by model', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse({ model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    acc.add(makeResponse({ model: 'deepseek-reasoner', usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }));

    const s = acc.summary();
    assert.equal(Object.keys(s.byModel).length, 2);
    assert.equal(s.byModel['deepseek-chat'].total_tokens, 15);
    assert.equal(s.byModel['deepseek-reasoner'].total_tokens, 42);
  });

  it('should detect partial (zero-filled) usage', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));

    const s = acc.summary();
    assert.equal(s.partial, true);
  });

  it('should reset to empty state', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse());
    acc.reset();

    const s = acc.summary();
    assert.equal(s.calls, 0);
    assert.equal(s.tokens.total_tokens, 0);
  });

  it('should handle reasoning_tokens when present', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse({
      model: 'deepseek-reasoner',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 200 },
    }));

    const s = acc.summary();
    assert.equal(s.tokens.reasoning_tokens, 200);
  });

  it('should not mark partial when usage is non-zero', () => {
    const acc = new UsageAccumulator();
    acc.add(makeResponse());
    assert.equal(acc.summary().partial, false);
  });
});
