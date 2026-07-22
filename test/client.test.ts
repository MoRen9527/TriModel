import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient, readConfig, DeepSeekProvider } from '../src/index.js';
import type { TriModelConfig, Message, ChatResponse } from '../src/index.js';

const testConfig: TriModelConfig = {
  deepseekApiKey: 'sk-test-mock-key',
  deepseekBaseUrl: 'https://api.deepseek.com/v1',
  deepseekAnthropicBaseUrl: 'https://api.deepseek.com/anthropic',
  trimetaverseApiKey: 'tmv-sk-dev-test',
  trimetaverseBaseUrl: 'http://127.0.0.1:8000/v1',
  primaryProvider: 'deepseek',
  defaultModel: 'deepseek-chat',
  fallbackModel: 'deepseek-chat',
  requestTimeoutMs: 5000,
};

describe('DeepSeekProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }

      const isReasoning = JSON.stringify(init?.body).includes('deepseek-reasoner');
      return new Response(JSON.stringify({
        id: 'chatcmpl-mock-001',
        model: isReasoning ? 'deepseek-reasoner' : 'deepseek-chat',
        choices: [{
          message: { role: 'assistant', content: 'Hello from DeepSeek mock!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('should complete a chat request', async () => {
    const provider = new DeepSeekProvider(testConfig.deepseekApiKey, testConfig.deepseekBaseUrl);
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const response = await provider.chat(messages, { model: 'deepseek-chat' });

    assert.equal(response.model, 'deepseek-chat');
    assert.ok(response.content && response.content.length > 0);
    assert.equal(response.finish_reason, 'stop');
    assert.ok(response.usage);
  });

  it('should handle deepseek-reasoner model', async () => {
    const provider = new DeepSeekProvider(testConfig.deepseekApiKey, testConfig.deepseekBaseUrl);
    const messages: Message[] = [{ role: 'user', content: 'Solve this problem' }];
    const response = await provider.chat(messages, { model: 'deepseek-reasoner' });

    assert.equal(response.model, 'deepseek-reasoner');
    assert.equal(response.finish_reason, 'stop');
  });
});

describe('ModelClient', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const model = body.model ?? 'deepseek-chat';

      return new Response(JSON.stringify({
        id: `chatcmpl-mock-${model}`,
        model,
        choices: [{
          message: { role: 'assistant', content: `Response from ${model}` },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('should list available models', () => {
    const client = new ModelClient(testConfig);
    const models = client.listModels();
    assert.ok(models.includes('deepseek-chat'));
    assert.ok(models.includes('deepseek-reasoner'));
  });

  it('should route chat request to correct provider', async () => {
    const client = new ModelClient(testConfig);
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];
    const response = await client.chat('deepseek-chat', messages);

    assert.equal(response.model, 'deepseek-chat');
    assert.ok(response.content?.includes('deepseek-chat'));
  });

  it('should fallback from deepseek-chat via TriStaciss on failure', async () => {
    let callCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};

      // First call: deepseek-chat fails
      if (url.includes('/chat/completions') || callCount === 1) {
        if (!url.includes('/messages')) {
          return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Fallback: tmv-deepseek-chat via TriStaciss (Anthropic format)
      return new Response(JSON.stringify({
        id: 'msg_fallback_001',
        model: body.model ?? 'deepseek-chat',
        role: 'assistant',
        content: [{ type: 'text', text: 'Fallback response via TriStaciss' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const client = new ModelClient(testConfig);
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];
    const response = await client.chat('deepseek-chat', messages);

    assert.ok(callCount >= 2);
    assert.ok(response.content?.includes('Fallback'));
  });

  it('should throw for unknown model', async () => {
    const client = new ModelClient(testConfig);
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];

    await assert.rejects(
      () => client.chat('unknown-model' as string, messages),
      /Unknown model/,
    );
  });
});

describe('readConfig', () => {
  it('should return defaults when no env vars set', () => {
    const config = readConfig();
    assert.equal(config.deepseekApiKey, '');
    assert.equal(config.defaultModel, 'deepseek-chat');
    assert.equal(config.requestTimeoutMs, 60_000);
  });
});
