export interface TriModelConfig {
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  defaultModel: string;
  fallbackModel: string;
  requestTimeoutMs: number;
}

export function readConfig(): TriModelConfig {
  return {
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    defaultModel: process.env.TRIMODEL_DEFAULT_MODEL ?? 'deepseek-chat',
    fallbackModel: process.env.TRIMODEL_FALLBACK_MODEL ?? 'deepseek-chat',
    requestTimeoutMs: Number(process.env.TRIMODEL_REQUEST_TIMEOUT_MS ?? 60_000),
  };
}
