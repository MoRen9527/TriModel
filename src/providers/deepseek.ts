import type { ChatOptions, ChatResponse, Message, ToolCall, StreamEvent, Provider, ProviderInfo } from '../types.js';
import { parseOpenAISSE } from './stream/openai-sse-parser.js';

export class DeepSeekProvider implements Provider {
  readonly name = 'deepseek';
  private apiKey: string;
  private baseUrl: string;

  readonly info: ProviderInfo = {
    name: 'deepseek',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    baseUrl: 'https://api.deepseek.com',
  };

  constructor(apiKey: string, baseUrl = 'https://api.deepseek.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? 'deepseek-v4-flash';
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 60_000);

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
        max_tokens: options?.max_tokens ?? 8192,
        stream: false,
      };
      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`DeepSeek API error ${response.status}: ${errorBody}`);
      }

      const json = await response.json() as Record<string, unknown>;
      const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
      if (!choice) throw new Error('DeepSeek response missing choices');

      const responseMessage = choice.message as Record<string, unknown>;
      const finishReason = choice.finish_reason as string;

      let content: string | null = (responseMessage.content as string) ?? null;
      let toolCalls: ToolCall[] | undefined;

      if (responseMessage.tool_calls) {
        toolCalls = (responseMessage.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const fn = tc.function as Record<string, unknown>;
          return {
            id: tc.id as string,
            type: 'function',
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
        model: model,
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
        throw new Error('DeepSeek API request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    const model = options?.model ?? 'deepseek-v4-flash';
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
        max_tokens: options?.max_tokens ?? 8192,
        stream: true,
      };
      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`DeepSeek API error ${response.status}: ${errorBody}`);
      }

      yield* parseOpenAISSE(response);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('DeepSeek API streaming timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.chat([{ role: 'user', content: 'ping' }], {
        max_tokens: 1,
      });
      return true;
    } catch {
      return false;
    }
  }
}
