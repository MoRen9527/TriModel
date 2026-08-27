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
    // deepseek-chat / deepseek-reasoner are retired upstream model names, kept as
    // backward-compat aliases: primary call 400s on the retired name, then auto-falls
    // back to deepseek-v4-flash (old callers upgrade transparently).
    registry['deepseek-chat'] = {
      primary: 'deepseek',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['deepseek-reasoner'] = {
      primary: 'deepseek',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['deepseek-v4-pro'] = {
      primary: 'deepseek',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['deepseek-v4-flash'] = {
      primary: 'deepseek',
      fallback: 'deepseek-v4-pro',
      timeoutMs: config.requestTimeoutMs,
    };
  }

  // TriMetaverse-routed models
  if (hasTmv) {
    Object.assign(registry, {
      'tmv-deepseek-chat': {
        primary: 'trimetaverse',
        fallback: providers.has('deepseek') ? 'deepseek-v4-flash' : undefined,
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

  // Anthropic-compatible models (Phase 2)
  // 2026-08-26 模型切换：stealth/ox-alpha 上游停服移除，GLM（bigmodel.cn
  // Anthropic 兼容端点，ANTHROPIC_BASE_URL 环境变量驱动）接替。glm-5.3[1M]
  // 是 CC 宿主的上下文档位后缀别名，与裸名同路由。
  if (providers.has('anthropic')) {
    registry['glm-5.3'] = {
      primary: 'anthropic',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['glm-5.3[1M]'] = {
      primary: 'anthropic',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    // flash 档（2026-08-27）：glm-5.3-flash 为 bigmodel.cn 正典 ID（大写为别名，
    // 上游归一返回 glm-5.3-flash）；R/M 面编排档位切换用
    registry['glm-5.3-flash'] = {
      primary: 'anthropic',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['GLM-5.3-Flash'] = {
      primary: 'anthropic',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['GLM-4.7-Flash'] = {
      primary: 'anthropic',
      timeoutMs: config.requestTimeoutMs,
    };
registry['claude-sonnet-4-20250514'] = {
      primary: 'anthropic',
      fallback: providers.has('deepseek-anthropic') ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['claude-haiku-3-5-20250514'] = {
      primary: 'anthropic',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['claude-opus-4-20250514'] = {
      primary: 'anthropic',
      fallback: providers.has('deepseek-anthropic') ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs * 2,
    };
  }

  // OpenAI models (Phase 2)
  if (providers.has('openai')) {
    registry['gpt-5'] = {
      primary: 'openai',
      fallback: providers.has('deepseek-anthropic') ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs * 2,
    };
    registry['gpt-5-mini'] = {
      primary: 'openai',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs,
    };
    registry['gpt-5-nano'] = {
      primary: 'openai',
      fallback: 'deepseek-v4-flash',
      timeoutMs: config.requestTimeoutMs,
    };
  }

  return registry;
}

/**
 * P0-1: Thrown when a streaming call fails after at least one StreamEvent has
 * already been yielded to the caller. At that point fallback must not restart a
 * second generation (it would silently splice two models' outputs together);
 * this named error lets callers distinguish a mid-stream abort from a plain
 * upstream error and own the retry decision. `cause` carries the original error.
 */
export class StreamAbortedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StreamAbortedError';
  }
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
    // TEMP DEBUG（TC-4b 验证期）
    console.error(`[trimodel-client][dbg] chat model=${model} depth=${_depth} msgs=${messages.length} lastRole=${messages[messages.length - 1]?.role} known=${!!this.registry[model]}`);
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
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[trimodel] ${model} failed (depth=${_depth}, reason: ${reason.slice(0, 300)}), trying ${route.fallback}`);
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
  // P0-1 fallback contract (see also StreamAbortedError above):
  // - Fallback (chat()-style recursion on route.fallback with _depth+1) is allowed
  //   ONLY on a pre-first-event failure: zero StreamEvents have reached the caller.
  // - Once >=1 event has been yielded, fallback is FORBIDDEN even when route.fallback
  //   exists: restarting a second model silently splices its full fresh output onto
  //   the partial first-model stream — text becomes truncated-A + full-B, and tool_call
  //   deltas corrupt because StreamEvent.tool_calls merge by index at the caller
  //   (types.ts StreamEvent).
  // - Post-emission failure ALWAYS throws StreamAbortedError (message names the failing
  //   model, `cause` carries the original error) — likewise when no fallback
  //   is configured — so upper layers identify a mid-stream abort by error type alone.
  // - Pre-first-event failure without fallback rethrows the original error untouched,
  //   same surface as chat().
  // Retry ownership is the caller's: a post-abort retry replaces the partial output;
  // this generator never appends a second model's events to it.
  async *stream(model: string, messages: Message[], options?: ChatOptions, _depth = 0): AsyncGenerator<StreamEvent> {
    console.error(`[trimodel-client][dbg] STREAM model=${model} depth=${_depth} msgs=${messages.length} known=${!!this.registry[model]}`);
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

    // P0-1 emission tracker: one flag per attempt, scoped to this frame only (never an
    // instance/module field) so nested fallback frames cannot read or clobber it. It is
    // declared in the scope shared by try/catch — ES block scoping makes a flag declared
    // inside try{} itself invisible to catch — and is incremented BEFORE each yield so
    // the first handed-out event flips it ahead of any downstream suspension.
    let emitted = false;
    try {
      for await (const event of provider.stream(messages, { ...options, model })) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (emitted) {
        // Partial output already reached the caller: refuse to splice, surface the abort.
        throw new StreamAbortedError(
          `Stream aborted-in-stream: model '${model}' failed after partial events were already yielded to the caller; silent fallback splice is forbidden (audit P0-1), original failure attached as cause.`,
          { cause: error },
        );
      }
      if (route.fallback) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[trimodel] ${model} failed (depth=${_depth}, reason: ${reason.slice(0, 300)}), trying stream fallback ${route.fallback}`);
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
