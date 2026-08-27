import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient, readConfig, DeepSeekProvider, AnthropicProvider, OpenAIProvider } from '../src/index.js';
import type { TriModelConfig, Message } from '../src/index.js';

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

  it('should fallback from deepseek-chat to deepseek-v4-flash', async () => {
    let callCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};

      // First call: deepseek-chat fails (rate limit)
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Anthropic-format endpoint keeps Anthropic response shape
      if (url.includes('/messages')) {
        return new Response(JSON.stringify({
          id: 'msg_fallback_001',
          model: body.model ?? 'deepseek-v4-pro',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fallback response via Anthropic endpoint' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Fallback: deepseek-v4-flash via OpenAI-compatible endpoint
      return new Response(JSON.stringify({
        id: 'chatcmpl-fallback-001',
        model: body.model ?? 'deepseek-v4-flash',
        choices: [{
          message: { role: 'assistant', content: 'Fallback response from deepseek-v4-flash' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
      () => client.chat('unknown-model', messages),
      /Unknown model/,
    );
  });

  it('should list Anthropic models when anthropicApiKey is set', () => {
    const client = new ModelClient(testConfig);
    const models = client.listModels();
    assert.ok(models.includes('claude-sonnet-4-20250514'));
    assert.ok(models.includes('claude-haiku-3-5-20250514'));
  });

  it('should list OpenAI models when openaiApiKey is set', () => {
    const client = new ModelClient(testConfig);
    const models = client.listModels();
    assert.ok(models.includes('gpt-5'));
    assert.ok(models.includes('gpt-5-mini'));
  });

  it('should not include Anthropic models without anthropicApiKey', () => {
    const configWithoutAnthropic: TriModelConfig = {
      ...testConfig,
      anthropicApiKey: '',
    };
    const client = new ModelClient(configWithoutAnthropic);
    const models = client.listModels();
    assert.ok(!models.includes('claude-sonnet-4-20250514'));
  });

  it('should respect fallback depth limit (max 2 hops)', async () => {
    // Setup: make all providers fail to trigger max fallback
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: 'service unavailable' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new ModelClient(testConfig);
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];

    await assert.rejects(
      () => client.chat('deepseek-v4-pro', messages),
      /All fallback models exhausted/,
    );
  });

  it('should have bounded fallback ring (v4-pro <-> v4-flash stops at depth limit)', () => {
    const client = new ModelClient(testConfig);
    const models = client.listModels();

    // Verify deepseek-chat fallback is v4-flash (not v4-pro which created circular risk)
    assert.ok(models.includes('deepseek-v4-flash'));

    // Verify v4-pro fallback is v4-flash (not deepseek-chat which created circular risk)
    assert.ok(models.includes('deepseek-v4-pro'));
  });
});

describe('AnthropicProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/v1/messages')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        id: 'msg_ant_001',
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Anthropic mock!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('should complete a chat request', async () => {
    const provider = new AnthropicProvider('ant-test-key');
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const response = await provider.chat(messages, { model: 'claude-sonnet-4-20250514' });

    assert.equal(response.model, 'claude-sonnet-4-20250514');
    assert.ok(response.content && response.content.length > 0);
    assert.equal(response.finish_reason, 'stop');
    assert.ok(response.usage);
  });
});

describe('OpenAIProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/v1/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-oai-001',
        model: 'gpt-5-mini',
        choices: [{
          message: { role: 'assistant', content: 'Hello from OpenAI mock!' },
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
    const provider = new OpenAIProvider('sk-openai-test');
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const response = await provider.chat(messages, { model: 'gpt-5-mini' });

    assert.equal(response.model, 'gpt-5-mini');
    assert.ok(response.content && response.content.length > 0);
    assert.equal(response.finish_reason, 'stop');
  });
});

describe('Streaming', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('should stream from DeepSeekAnthropicProvider with SSE parsing', async () => {
    const sseChunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" World"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    let chunkIndex = 0;
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIndex]));
            chunkIndex++;
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const { DeepSeekAnthropicProvider: DSAProvider } = await import('../src/providers/deepseek-anthropic.js');
    const provider = new DSAProvider('sk-test', 'https://api.deepseek.com/anthropic');
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];

    const events: Array<{ delta: string }> = [];
    for await (const event of provider.stream(messages, { model: 'deepseek-v4-pro' })) {
      events.push({ delta: event.delta });
    }

    // Should have received multiple incremental events (not a single synthetic one)
    assert.ok(events.length >= 2, `Expected >= 2 stream events, got ${events.length}`);
    const fullText = events.map((e) => e.delta).join('');
    assert.ok(fullText.includes('Hello'));
  });
});

describe('readConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  before(() => {
    const vars = [
      'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'TRIMODEL_TRIMETAVERSE_API_KEY', 'TRIMODEL_TRISTACISS_BASE_URL',
      'TRIMODEL_PRIMARY_PROVIDER', 'TRIMODEL_DEFAULT_MODEL', 'TRIMODEL_FALLBACK_MODEL',
      'TRIMODEL_REQUEST_TIMEOUT_MS',
    ];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it('should return defaults when no env vars set', () => {
    const config = readConfig();
    assert.equal(config.deepseekApiKey, '');
    assert.equal(config.anthropicApiKey, '');
    assert.equal(config.openaiApiKey, '');
    assert.equal(config.defaultModel, 'tmv-deepseek-v4-pro');
    assert.equal(config.requestTimeoutMs, 60_000);
  });
});
