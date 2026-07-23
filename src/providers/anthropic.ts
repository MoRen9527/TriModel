import type { Provider, ProviderInfo, Message, ChatOptions, ChatResponse, StreamEvent, ToolCall } from '../types.js';
import { parseAnthropicSSE } from './stream/anthropic-sse-parser.js';

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
        messages: conversationMessages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role };
          if (m.content !== null && m.content !== undefined) msg.content = m.content;
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          return msg;
        }),
        max_tokens: maxTokens,
        stream: false,
      };

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

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

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
        messages: conversationMessages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role };
          if (m.content !== null && m.content !== undefined) msg.content = m.content;
          return msg;
        }),
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

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

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
