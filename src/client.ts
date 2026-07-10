import type { Provider, Message, ChatOptions, ChatResponse, ModelRegistry } from './types.js';
import type { TriModelConfig } from './config.js';
import { DeepSeekProvider } from './providers/deepseek.js';

export class ModelClient {
  private providers: Map<string, Provider> = new Map();
  private registry: ModelRegistry;

  constructor(config: TriModelConfig) {
    const deepseek = new DeepSeekProvider(config);
    this.providers.set('deepseek', deepseek);

    this.registry = {
      'deepseek-chat': {
        primary: 'deepseek',
        fallback: 'deepseek-v4-pro',
        timeoutMs: config.requestTimeoutMs,
      },
      'deepseek-reasoner': {
        primary: 'deepseek',
        fallback: 'deepseek-chat',
        timeoutMs: config.requestTimeoutMs,
      },
      'deepseek-v4-pro': {
        primary: 'deepseek',
        fallback: 'deepseek-chat',
        timeoutMs: config.requestTimeoutMs * 2,
      },
      'deepseek-v4-flash': {
        primary: 'deepseek',
        fallback: 'deepseek-v4-pro',
        timeoutMs: config.requestTimeoutMs,
      },
    };
  }

  getProvider(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  listModels(): string[] {
    return Object.keys(this.registry);
  }

  async chat(model: string, messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const route = this.registry[model];
    if (!route) {
      throw new Error(`Unknown model: ${model}. Available models: ${this.listModels().join(', ')}`);
    }

    const provider = this.providers.get(route.primary);
    if (!provider) {
      throw new Error(`Provider not found: ${route.primary}`);
    }

    try {
      return await provider.chat(messages, { ...options, model });
    } catch (error) {
      if (route.fallback) {
        const fallbackRoute = this.registry[route.fallback];
        if (fallbackRoute) {
          const fallbackProvider = this.providers.get(fallbackRoute.primary);
          if (fallbackProvider) {
            console.warn(`[trimodel] primary model ${model} failed, falling back to ${route.fallback}`);
            return await fallbackProvider.chat(messages, { ...options, model: route.fallback });
          }
        }
      }
      throw error;
    }
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, provider] of this.providers) {
      results[name] = await provider.healthCheck();
    }
    return results;
  }
}
