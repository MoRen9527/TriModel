import type { Provider, ProviderInfo, Message, ChatOptions, ChatResponse } from '../types.js';
import type { TriModelConfig } from '../config.js';

export class DeepSeekProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;

  readonly info: ProviderInfo = {
    name: 'deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4-flash'],
    baseUrl: 'https://api.deepseek.com/v1',
  };

  constructor(config: TriModelConfig) {
    this.apiKey = config.deepseekApiKey;
    this.baseUrl = config.deepseekBaseUrl;
    this.info.baseUrl = config.deepseekBaseUrl;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? "deepseek-chat";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.max_tokens ?? 4096,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`DeepSeek API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json() as {
        id: string;
        model: string;
        choices: Array<{
          message: { role: string; content: string; reasoning_content?: string };
          finish_reason: string | null;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };

      const choice = data.choices?.[0];
      if (!choice?.message) {
        throw new Error('DeepSeek API returned empty response');
      }

      const content = choice.message.content || choice.message.reasoning_content || '';

      return {
        id: data.id,
        model: data.model,
        content,
        reasoning_content: choice.message.reasoning_content,
        finish_reason: (choice.finish_reason as ChatResponse['finish_reason']) ?? null,
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
          reasoning_tokens: data.usage.completion_tokens_details?.reasoning_tokens,
        } : undefined,
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
}