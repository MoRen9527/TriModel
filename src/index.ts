export { ModelClient } from './client.js';
export { DeepSeekProvider } from './providers/deepseek.js';
export { readConfig } from './config.js';
export type { TriModelConfig } from './config.js';
export type {
  Message,
  ChatOptions,
  ChatResponse,
  Provider,
  ProviderInfo,
  ModelRegistry,
  ModelRoutingConfig,
} from './types.js';

import { ModelClient } from './client.js';
import { readConfig, type TriModelConfig } from './config.js';

export function createModelClient(config?: Partial<TriModelConfig>): ModelClient {
  const base = readConfig();
  const merged: TriModelConfig = { ...base, ...config };
  return new ModelClient(merged);
}
