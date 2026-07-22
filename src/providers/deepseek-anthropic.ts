import type { ChatOptions, ChatResponse, Message, ToolCall, StreamEvent, Provider, ProviderInfo } from '../types.js';

/**
 * DeepSeek Anthropic-compatible Messages API provider.
 * Uses https://api.deepseek.com/anthropic/messages for models that only
 * work on DeepSeek's Anthropic-compatible endpoint (e.g. deepseek-v4-pro).
 */
export class DeepSeekAnthropicProvider implements Provider {
  readonly name = 'deepseek-anthropic';
  private apiKey: string;
  private baseUrl: string;

  readonly info: ProviderInfo = {
    name: 'deepseek-anthropic',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    baseUrl: 'https://api.deepseek.com/anthropic',
  };

  constructor(apiKey: string, baseUrl = 'https://api.deepseek.com/anthropic') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? 'deepseek-v4-pro';
    // v4-pro is a reasoning model — thinking blocks consume token budget.
    // Use generous default to ensure text response after thinking.
    const maxTokens = options?.max_tokens ?? 8192;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      // Convert internal messages to Anthropic format
      const systemMessages = messages.filter(m => m.role === 'system');
      const conversationMessages = messages.filter(m => m.role !== 'system');

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
        body.system = systemMessages.map(m => m.content).filter(Boolean).join('\n');
      }

      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools.map(t => {
          const fn = (t as any).function ?? t;
          return {
            name: fn.name ?? (t as any).name,
            description: fn.description ?? (t as any).description,
            input_schema: fn.parameters ?? (t as any).input_schema ?? { type: 'object', properties: {} },
          };
        });
      }

      const response = await fetch(`${this.baseUrl}/messages`, {
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
        throw new Error(`DeepSeek Anthropic API error ${response.status}: ${errorBody}`);
      }

      const json = await response.json() as Record<string, unknown>;
      const content = json.content as Array<Record<string, unknown>> | undefined;

      let textContent: string | null = null;
      let thinkingContent: string | null = null;
      let toolCalls: ToolCall[] | undefined;

      if (content) {
        for (const block of content) {
          if (block.type === 'text') {
            textContent = (textContent ?? '') + (block.text as string ?? '');
          } else if (block.type === 'thinking') {
            thinkingContent = (thinkingContent ?? '') + (block.thinking as string ?? '');
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

      return {
        id: json.id as string,
        content: textContent ?? thinkingContent,
        model: json.model as string,
        finish_reason: (json.stop_reason as ChatResponse['finish_reason']) ?? 'stop',
        tool_calls: toolCalls,
        usage: {
          prompt_tokens: (json.usage as Record<string, number> | undefined)?.input_tokens ?? 0,
          completion_tokens: (json.usage as Record<string, number> | undefined)?.output_tokens ?? 0,
          total_tokens: ((json.usage as Record<string, number> | undefined)?.input_tokens ?? 0) + ((json.usage as Record<string, number> | undefined)?.output_tokens ?? 0),
        },
      };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('DeepSeek Anthropic API request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    // Streaming not yet implemented for Anthropic endpoint
    // Fall through to non-streaming
    const result = await this.chat(messages, options);
    if (result.content) {
      yield { delta: result.content, finish_reason: result.finish_reason };
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
