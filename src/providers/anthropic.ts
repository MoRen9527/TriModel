import type { Provider, ProviderInfo, Message, ChatOptions, ChatResponse, StreamEvent, ToolCall } from '../types.js';
import { parseAnthropicSSE } from './stream/anthropic-sse-parser.js';

// ── TC-4b 出站消息规范化（2026-08-26）──
// 内核（agent-core）回喂工具结果用的是 OpenAI 形态：{role:'tool', tool_call_id,
// content} 与 assistant.tool_calls 字段。Anthropic Messages 端点要求：
//   tool 结果 = {role:'user', content:[{type:'tool_result', tool_use_id, content}]}
//   工具调用 = assistant.content 内嵌 {type:'tool_use', id, name, input}
// 且相邻同角色需合并。此层统一净化，未匹配形态原样透传。
type AnyMsg = Record<string, unknown>;

function toAnthropicConversation(messages: AnyMsg[]): AnyMsg[] {
  const out: AnyMsg[] = [];
  const mergeToolResult = (block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      (last.content as unknown[]).push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      mergeToolResult({
        type: 'tool_result',
        tool_use_id: String(m.tool_call_id ?? ''),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    const calls = m.tool_calls as Array<Record<string, unknown>> | undefined;
    if (m.role === 'assistant' && calls && calls.length > 0) {
      const blocks: unknown[] = [];
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) blocks.push({ type: 'text', text });
      for (const tc of calls) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        let input: unknown = fn.arguments ?? tc.input ?? {};
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { /* 原样保留 */ }
        }
        blocks.push({
          type: 'tool_use',
          id: String(tc.id ?? ''),
          name: String(fn.name ?? tc.name ?? ''),
          input,
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'assistant' && (m.content === null || m.content === '')) {
      continue; // 空助手消息直接丢弃（部分推理模型会发空壳轮）
    }
    out.push({ role: m.role as string, content: m.content });
  }
  return out;
}


/**
 * Native Anthropic Messages API provider.
 *
 * Connects directly to api.anthropic.com (not via DeepSeek proxy).
 * Reuses Anthropic SSE parsing shared with DeepSeekAnthropicProvider.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private apiKey: string;
  private baseUrl: string;

  readonly info: ProviderInfo = {
    name: 'anthropic',
    models: [
      'claude-sonnet-4-20250514',
      'claude-haiku-3-5-20250514',
      'claude-opus-4-20250514',
    ],
    baseUrl: 'https://api.anthropic.com',
  };

  constructor(apiKey: string, baseUrl = 'https://api.anthropic.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.info = { ...this.info, baseUrl };
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      // OpenRouter 等 Anthropic 兼容网关只认 Bearer 不认 x-api-key（2026-08-25 实证）
      ...(this.baseUrl.includes('openrouter') ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      'anthropic-version': '2023-06-01',
    };
  }

  /** 限流韧性（2026-08-27）：多面共用上游配额时按 key 维度撞 429——
   * 对 429/500/502/503/504 与网络错误做指数退避重试（最多 3 次尝试，
   * 尊重 Retry-After 上限 30s）。外部 signal 可打断等待与在途请求。 */
  private async fetchWithRetry(
    bodyJson: string,
    externalSignal: AbortSignal,
    label: string,
  ): Promise<Response> {
    const RETRYABLE = new Set([429, 500, 502, 503, 504]);
    const MAX_ATTEMPTS = 3;
    const ATTEMPT_TIMEOUT_MS = 120_000;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: bodyJson,
          signal: controller.signal,
        });
        if (response.ok || !RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS) {
          return response;
        }
        const raMs = Number(response.headers.get('retry-after') ?? '') * 1000;
        const backoff = Number.isFinite(raMs) && raMs > 0
          ? Math.min(raMs, 30_000)
          : 1500 * 2 ** (attempt - 1) + Math.random() * 500;
        console.warn(`[anthropic-provider] ${label} ${response.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(backoff)}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      } catch (err) {
        lastErr = err;
        if (externalSignal.aborted) throw err;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${label}: retries exhausted`);
  }


  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? 'claude-sonnet-4-20250514';
    const maxTokens = options?.max_tokens ?? 8192;
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 120_000);

    try {
      const systemMessages = messages.filter((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const body: Record<string, unknown> = {
        model,
        messages: toAnthropicConversation(conversationMessages as unknown as AnyMsg[]),
        max_tokens: maxTokens,
        stream: false,
      };
      // TEMP DEBUG（TC-4b 验证期）：出站请求形态采样
      try {
        const sample = (body.messages as AnyMsg[]).map((m) => ({
          role: m.role,
          contentType: Array.isArray(m.content) ? 'blocks:' + (m.content as unknown[]).map((b) => (b as Record<string, unknown>).type).join('+') : typeof m.content,
        }));
        console.error('[anthropic-provider][dbg] outbound:', model, JSON.stringify(sample));
      } catch { /* ignore */ }

      if (systemMessages.length > 0) {
        body.system = systemMessages
          .map((m) => m.content)
          .filter(Boolean)
          .join('\n');
      }

      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools.map((t) => {
          const fn = (t as unknown as Record<string, unknown>).function as Record<string, unknown> ?? t;
          return {
            name: fn.name ?? (t as unknown as Record<string, unknown>).name,
            description: fn.description ?? (t as unknown as Record<string, unknown>).description,
            input_schema: fn.parameters ?? (t as unknown as Record<string, unknown>).input_schema ?? { type: 'object', properties: {} },
          };
        });
      }

      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }

      const response = await this.fetchWithRetry(JSON.stringify(body), controller.signal, 'chat');

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
      }

      const json = await response.json() as Record<string, unknown>;
      const content = json.content as Array<Record<string, unknown>> | undefined;

      let textContent: string | null = null;
      let toolCalls: ToolCall[] | undefined;

      if (content) {
        for (const block of content) {
          if (block.type === 'text') {
            textContent = (textContent ?? '') + (block.text as string ?? '');
          } else if (block.type === 'tool_use') {
            if (!toolCalls) toolCalls = [];
            toolCalls.push({
              id: block.id as string,
              type: 'function',
              function: {
                name: block.name as string,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }
      }

      const stopMap: Record<string, ChatResponse['finish_reason']> = {
        end_turn: 'stop',
        max_tokens: 'length',
        stop_sequence: 'stop',
        tool_use: 'tool_calls',
      };

      return {
        id: json.id as string,
        content: textContent,
        model: json.model as string,
        finish_reason: stopMap[json.stop_reason as string] ?? 'stop',
        tool_calls: toolCalls,
        usage: {
          prompt_tokens: (json.usage as Record<string, number> | undefined)?.input_tokens ?? 0,
          completion_tokens: (json.usage as Record<string, number> | undefined)?.output_tokens ?? 0,
          total_tokens:
            ((json.usage as Record<string, number> | undefined)?.input_tokens ?? 0) +
            ((json.usage as Record<string, number> | undefined)?.output_tokens ?? 0),
        },
      };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Anthropic API request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    const model = options?.model ?? 'claude-sonnet-4-20250514';
    const maxTokens = options?.max_tokens ?? 8192;
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 120_000);

    try {
      const systemMessages = messages.filter((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const body: Record<string, unknown> = {
        model,
        messages: toAnthropicConversation(conversationMessages as unknown as AnyMsg[]),
        max_tokens: maxTokens,
        stream: true,
      };

      if (systemMessages.length > 0) {
        body.system = systemMessages.map((m) => m.content).filter(Boolean).join('\n');
      }

      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools.map((t) => {
          const fn = (t as unknown as Record<string, unknown>).function as Record<string, unknown> ?? t;
          return {
            name: fn.name ?? (t as unknown as Record<string, unknown>).name,
            description: fn.description ?? (t as unknown as Record<string, unknown>).description,
            input_schema: fn.parameters ?? (t as unknown as Record<string, unknown>).input_schema ?? { type: 'object', properties: {} },
          };
        });
      }

      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }

      const response = await this.fetchWithRetry(JSON.stringify(body), controller.signal, 'stream');

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
      }

      yield* parseAnthropicSSE(response);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Anthropic API streaming timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.chat([{ role: 'user', content: 'ping' }], { max_tokens: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
