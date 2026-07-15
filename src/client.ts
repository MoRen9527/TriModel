import type { Provider, Message, ChatOptions, ChatResponse, ModelRegistry } from './types.js';
import type { TriModelConfig } from './config.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { TriMetaverseProvider } from './providers/trimetaverse.js';

export class ModelClient {
  private providers: Map<string, Provider> = new Map();
  private registry: ModelRegistry;

  constructor(config: TriModelConfig) {
    // Always register DeepSeek as fallback/legacy
    if (config.deepseekApiKey) {
      this.providers.set('deepseek', new DeepSeekProvider(config.deepseekApiKey, config.deepseekBaseUrl));
    }

    // Register TriMetaverse when configured or when API key is present
    if (config.primaryProvider === 'trimetaverse' || config.trimetaverseApiKey) {
      this.providers.set('trimetaverse', new TriMetaverseProvider(config));
    }

    const primary = config.primaryProvider === 'trimetaverse' && this.providers.has('trimetaverse')
      ? 'trimetaverse'
      : 'deepseek';

    // Build registry: models route to their native provider,
    // fallbacks respect primaryProvider preference.
    // When TriStaciss is available, DeepSeek models use tmv-* as cross-provider fallback.
    const hasTmv = this.providers.has('trimetaverse');
    this.registry = {
      'deepseek-chat': {
        primary: 'deepseek',
        fallback: hasTmv ? 'tmv-deepseek-chat' : (primary === 'trimetaverse' ? 'deepseek-chat' : 'deepseek-v4-pro'),
        timeoutMs: config.requestTimeoutMs,
      },
      'deepseek-reasoner': {
        primary: 'deepseek',
        fallback: hasTmv ? 'tmv-deepseek-chat' : 'deepseek-chat',
        timeoutMs: config.requestTimeoutMs,
      },
      'deepseek-v4-pro': {
        primary: 'deepseek',
        fallback: hasTmv ? 'tmv-deepseek-chat' : 'deepseek-chat',
        timeoutMs: config.requestTimeoutMs * 2,
      },
      'deepseek-v4-flash': {
        primary: 'deepseek',
        fallback: hasTmv ? 'tmv-deepseek-chat' : 'deepseek-v4-pro',
        timeoutMs: config.requestTimeoutMs,
      },
    };

    // Add trimetaverse-routed models when trimetaverse provider is available
    if (this.providers.has('trimetaverse')) {
      const tmvModels: Record<string, import('./types.js').ModelRoutingConfig> = {
        'tmv-deepseek-chat': {
          primary: 'trimetaverse',
          fallback: this.providers.has('deepseek') ? 'deepseek-chat' : undefined,
          timeoutMs: config.requestTimeoutMs,
        },
        'tmv-deepseek-reasoner': {
          primary: 'trimetaverse',
          fallback: undefined,
          timeoutMs: config.requestTimeoutMs * 2,
        },
        'tmv-deepseek-v4-pro': {
          primary: 'trimetaverse',
          fallback: 'tmv-deepseek-chat',
          timeoutMs: config.requestTimeoutMs * 2,
        },
        'tmv-deepseek-v4-flash': {
          primary: 'trimetaverse',
          fallback: 'tmv-deepseek-v4-pro',
          timeoutMs: config.requestTimeoutMs,
        },
      };
      Object.assign(this.registry, tmvModels);
    }
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

  /** CTO-003 P1: Streaming chat with provider fallback (same pattern as chat()). */
  async *stream(model: string, messages: Message[], options?: ChatOptions): AsyncGenerator<import('./types.js').StreamEvent> {
    const route = this.registry[model];
    if (!route) {
      throw new Error(`Unknown model: ${model}. Available models: ${this.listModels().join(', ')}`);
    }

    const provider = this.providers.get(route.primary);
    if (!provider) {
      throw new Error(`Provider not found: ${route.primary}`);
    }

    try {
      for await (const event of provider.stream(messages, { ...options, model })) {
        yield event;
      }
    } catch (error) {
      if (route.fallback) {
        const fallbackRoute = this.registry[route.fallback];
        if (fallbackRoute) {
          const fallbackProvider = this.providers.get(fallbackRoute.primary);
          if (fallbackProvider) {
            console.warn(`[trimodel] primary model ${model} failed, falling back to ${route.fallback}`);
            for await (const event of fallbackProvider.stream(messages, { ...options, model: route.fallback })) {
              yield event;
            }
            return;
          }
        }
      }
      throw error;
    }
  }
}
