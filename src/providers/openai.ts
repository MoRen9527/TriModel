import type { Provider, ProviderInfo, Message, ChatOptions, ChatResponse, StreamEvent, ToolCall } from '../types.js';
import { parseOpenAISSE } from './stream/openai-sse-parser.js';

/**
 * OpenAI Chat Completions API provider.
 *
 * Connects directly to api.openai.com.
 * Uses OpenAI-compatible SSE streaming (shared with DeepSeekProvider).
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private apiKey: string;
  private baseUrl: string;

  readonly info: ProviderInfo = {
    name: 'openai',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
    baseUrl: 'https://api.openai.com',
  };

  constructor(apiKey: string, baseUrl = 'https://api.openai.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.info = { ...this.info, baseUrl };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? 'gpt-5-mini';
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 120_000);

    try {
      const body: Record<string, unknown> = {
        model,
        messages: messages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role };
          if (m.content !== null && m.content !== undefined) msg.content = m.content;
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          return msg;
        }),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 4096,
        stream: false,
      };

      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
      }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `******`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
      }

      const json = await response.json() as Record<string, unknown>;
      const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
      if (!choice) throw new Error('OpenAI response missing choices');

      const responseMessage = choice.message as Record<string, unknown>;
      const finishReason = choice.finish_reason as string;

      let content: string | null = (responseMessage.content as string) ?? null;
      let toolCalls: ToolCall[] | undefined;

      if (responseMessage.tool_calls) {
        toolCalls = (responseMessage.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const fn = tc.function as Record<string, unknown>;
          return {
            id: tc.id as string,
            type: 'function' as const,
            function: {
              name: fn.name as string,
              arguments: fn.arguments as string,
            },
          };
        });
        if (finishReason === 'tool_calls') {
          content = null;
        }
      }

      return {
        id: json.id as string,
        content,
        model,
        finish_reason: (finishReason as ChatResponse['finish_reason']) ?? 'stop',
        tool_calls: toolCalls,
        usage: {
          prompt_tokens: (json.usage as Record<string, number> | undefined)?.prompt_tokens ?? 0,
          completion_tokens: (json.usage as Record<string, number> | undefined)?.completion_tokens ?? 0,
          total_tokens: (json.usage as Record<string, number> | undefined)?.total_tokens ?? 0,
        },
      };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('OpenAI API request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    const model = options?.model ?? 'gpt-5-mini';
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 120_000);

    try {
      const body: Record<string, unknown> = {
        model,
        messages: messages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role };
          if (m.content !== null && m.content !== undefined) msg.content = m.content;
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          return msg;
        }),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 4096,
        stream: true,
      };

      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
      }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `******`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
      }

      yield* parseOpenAISSE(response);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('OpenAI API streaming timed out');
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
