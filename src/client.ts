import type { Provider, Message, ChatOptions, ChatResponse, ModelRegistry, StreamEvent } from './types.js';
import type { TriModelConfig } from './config.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { DeepSeekAnthropicProvider } from './providers/deepseek-anthropic.js';
import { TriMetaverseProvider } from './providers/trimetaverse.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';

const MAX_FALLBACK_DEPTH = 2;

function buildRegistry(providers: Map<string, Provider>, config: TriModelConfig): ModelRegistry {
  const registry: ModelRegistry = {};
  const hasTmv = providers.has('trimetaverse');

  // DeepSeek models (Phase 1, fallback chain fixed Phase 2)
  if (providers.has('deepseek') || providers.has('deepseek-anthropic')) {
    // Terminal model: deepseek-chat (falls back to nothing within DeepSeek family)
    registry['deepseek-chat'] = {
      primary: 'deepseek',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['deepseek-reasoner'] = {
      primary: 'deepseek',
      fallback: 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['deepseek-v4-pro'] = {
      primary: 'deepseek-anthropic',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['deepseek-v4-flash'] = {
      primary: 'deepseek-anthropic',
      fallback: 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs,
    };
  }

  // TriMetaverse-routed models
  if (hasTmv) {
    Object.assign(registry, {
      'tmv-deepseek-chat': {
        primary: 'trimetaverse',
        fallback: providers.has('deepseek') ? 'deepseek-chat' : undefined,
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
    });
  }

  // Anthropic models (Phase 2)
  if (providers.has('anthropic')) {
    registry['claude-sonnet-4-20250514'] = {
      primary: 'anthropic',
      fallback: providers.has('deepseek-anthropic') ? 'deepseek-v4-pro' : 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['claude-haiku-3-5-20250514'] = {
      primary: 'anthropic',
      fallback: 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['claude-opus-4-20250514'] = {
      primary: 'anthropic',
      fallback: providers.has('deepseek-anthropic') ? 'deepseek-v4-pro' : 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs * 2,
    };
  }

  // OpenAI models (Phase 2)
  if (providers.has('openai')) {
    registry['gpt-5'] = {
      primary: 'openai',
      fallback: providers.has('deepseek-anthropic') ? 'deepseek-v4-pro' : 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['gpt-5-mini'] = {
      primary: 'openai',
      fallback: 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['gpt-5-nano'] = {
      primary: 'openai',
      fallback: 'deepseek-chat',
      timeoutMs: config.requestTimeoutMs,
    };
  }

  return registry;
}

export class ModelClient {
  private providers: Map<string, Provider> = new Map();
  private registry: ModelRegistry;
  private config: TriModelConfig;

  constructor(config: TriModelConfig) {
    this.config = config;

    // Always register DeepSeek as fallback/legacy
    if (config.deepseekApiKey) {
      this.providers.set('deepseek', new DeepSeekProvider(config.deepseekApiKey, config.deepseekBaseUrl));
      this.providers.set('deepseek-anthropic', new DeepSeekAnthropicProvider(config.deepseekApiKey, config.deepseekAnthropicBaseUrl));
    }

    // Anthropic native (Phase 2)
    if (config.anthropicApiKey) {
      this.providers.set('anthropic', new AnthropicProvider(config.anthropicApiKey, config.anthropicBaseUrl));
    }

    // OpenAI native (Phase 2)
    if (config.openaiApiKey) {
      this.providers.set('openai', new OpenAIProvider(config.openaiApiKey, config.openaiBaseUrl));
    }

    // Register TriMetaverse when configured or when API key is present
    if (config.primaryProvider === 'trimetaverse' || config.trimetaverseApiKey) {
      this.providers.set('trimetaverse', new TriMetaverseProvider(config));
    }

    // Build registry dynamically based on available providers
    this.registry = buildRegistry(this.providers, config);
  }

  getProvider(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  listModels(): string[] {
    return Object.keys(this.registry);
  }

  async chat(model: string, messages: Message[], options?: ChatOptions, _depth = 0): Promise<ChatResponse> {
    if (_depth > MAX_FALLBACK_DEPTH) {
      throw new Error(`All fallback models exhausted for ${model}. Please try again later.`);
    }
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
        console.warn(`[trimodel] ${model} failed (depth=${_depth}), trying ${route.fallback}`);
        return await this.chat(route.fallback, messages, options, _depth + 1);
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

  /** CTO-003 P1: Streaming chat with provider fallback (same pattern as chat(), with depth limit). */
  async *stream(model: string, messages: Message[], options?: ChatOptions, _depth = 0): AsyncGenerator<StreamEvent> {
    if (_depth > MAX_FALLBACK_DEPTH) {
      throw new Error(`All fallback models exhausted for ${model}. Please try again later.`);
    }
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
        console.warn(`[trimodel] ${model} failed (depth=${_depth}), trying stream fallback ${route.fallback}`);
        for await (const event of this.stream(route.fallback, messages, options, _depth + 1)) {
          yield event;
        }
        return;
      }
      throw error;
    }
  }

  /**
   * TK-011: Refresh the provider registry.
   * In the current architecture (provider keys injected at construction time),
   * this is primarily a no-op. It exists as a hook for external consumers (e.g., TriLC)
   * to notify ModelClient after key-cache updates. Phase 2 serves as an extension point
   * for future dynamic provider registration.
   */
  refreshRegistry(): void {
    // Rebuild registry in case providers were added/removed externally
    this.registry = buildRegistry(this.providers, this.config);
    console.log(`[trimodel] registry refreshed: ${Object.keys(this.registry).length} models`);
  }
}
