import type { Provider, ProviderInfo, Message, ChatOptions, ChatResponse, StreamEvent, ToolCall } from '../types.js';
import type { TriModelConfig } from '../config.js';

/**
 * TriMetaverseProvider — routes through TriStaciss Anthropic-compatible endpoint.
 *
 * When primaryProvider === 'trimetaverse', users authenticate with their
 * TriMetaverse-issued API key, and TriStaciss relays the request to the
 * backend model using the platform key (transparent to the user).
 *
 * Architecture (per CPO 2026-07-10 design, CTO confirmed):
 *   User key (TriModel config) → TriStaciss Bearer auth → platform key → real model
 *
 * Request format: Anthropic Messages API (POST /v1/messages)
 * This is the same format Claude Code CLI uses, enabling dev-prod parity.
 */
export class TriMetaverseProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;

  readonly info: ProviderInfo = {
    name: 'trimetaverse',
    models: [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'glm-4-plus',
      'kimi-k2',
    ],
    baseUrl: 'http://127.0.0.1:8000/v1',
  };

  constructor(config: TriModelConfig) {
    this.apiKey = config.trimetaverseApiKey;
    this.baseUrl = config.trimetaverseBaseUrl;
    this.info.baseUrl = config.trimetaverseBaseUrl;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? 'deepseek-chat';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      // Build Anthropic Messages API request body
      // System messages are extracted into the top-level "system" field;
      // user/assistant messages become content blocks with role.
      const systemMessages = messages.filter((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const systemText = systemMessages.map((m) => m.content).join('\n\n') || undefined;

      const anthropicMessages: Array<Record<string, unknown>> = [];

      for (const msg of conversationMessages) {
        const blocks: Array<Record<string, unknown>> = [];

        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }

        // Map OpenAI-style tool_calls → Anthropic tool_use content blocks
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: unknown;
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = {};
            }
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }

        // Map tool result messages → Anthropic tool_result blocks
        if (msg.role === 'tool' && msg.tool_call_id) {
          anthropicMessages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content ?? '',
              },
            ],
          });
          continue;
        }

        anthropicMessages.push({
          role: msg.role,
          content: blocks,
        });
      }

      const body: Record<string, unknown> = {
        model,
        messages: anthropicMessages,
        stream: false,
        max_tokens: options?.max_tokens ?? 4096,
      };

      if (systemText) {
        body.system = systemText;
      }
      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }
      // Pass tools in Anthropic format: { name, description, input_schema }
      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }));
      }

      const response = await fetch(`${this.baseUrl}/messages`, {
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
        throw new Error(
          `TriMetaverse API error ${response.status}: ${errorBody}`,
        );
      }

      const data = await response.json() as {
        id: string;
        model: string;
        role: string;
        content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        stop_reason: string | null;
        usage?: {
          input_tokens: number;
          output_tokens: number;
        };
      };

      // Extract text from Anthropic text content blocks
      const contentText =
        data.content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n') ?? '';

      // Extract tool_use blocks → ToolCall[]
      const toolUses = data.content?.filter((block) => block.type === 'tool_use') ?? [];
      const toolCalls: ToolCall[] | undefined = toolUses.length > 0
        ? toolUses.map((tu) => ({
            id: tu.id ?? `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function' as const,
            function: {
              name: tu.name ?? '',
              arguments: JSON.stringify(tu.input ?? {}),
            },
          }))
        : undefined;

      const finishReasonMap: Record<string, ChatResponse['finish_reason']> = {
        end_turn: 'stop',
        max_tokens: 'length',
        stop_sequence: 'stop',
        tool_use: 'tool_calls',
      };

      return {
        id: data.id,
        model: data.model,
        content: contentText || null,
        tool_calls: toolCalls,
        finish_reason: finishReasonMap[data.stop_reason ?? ''] ?? null,
        usage: {
          prompt_tokens: data.usage?.input_tokens ?? 0,
          completion_tokens: data.usage?.output_tokens ?? 0,
          total_tokens:
            (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.chat([{ role: 'user', content: 'ping' }], {
        model: 'deepseek-chat',
        max_tokens: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** CTO-003 P1: Anthropic SSE streaming — not yet implemented. Falls back to chat(). */
  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    // Anthropic SSE streaming requires different parsing (event: content_block_delta, etc.)
    // For now, fall back to chat() and yield a single synthetic stream event.
    const response = await this.chat(messages, options);
    yield {
      delta: response.content ?? '',
      tool_calls: response.tool_calls?.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      finish_reason: response.finish_reason,
      usage: response.usage,
    };
  }
}
