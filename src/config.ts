// ── Auto-load TriModel's own .env at import time ──
// dotenv silently ignores missing files; default behavior is override: false
// (won't clobber externally-set env vars, preserving constructor-param priority)
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __currentDir = dirname(fileURLToPath(import.meta.url));
// Try multiple levels: src/ → root (dev), dist/src/ → root (compiled)
dotenvConfig({ path: resolve(__currentDir, '..', '.env') });
dotenvConfig({ path: resolve(__currentDir, '..', '..', '.env') });
dotenvConfig({ path: resolve(__currentDir, '..', '..', '..', '.env') });

export interface TriModelConfig {
  // DeepSeek direct (L1 — direct provider key)
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekAnthropicBaseUrl: string;

  // Anthropic native (L1 — Phase 2)
  anthropicApiKey: string;
  anthropicBaseUrl: string;

  // OpenAI native (L1 — Phase 2)
  openaiApiKey: string;
  openaiBaseUrl: string;

  // TriMetaverse platform provider (L2 — routes through TriStaciss)
  trimetaverseApiKey: string;
  trimetaverseBaseUrl: string;

  // Provider selection
  primaryProvider: 'deepseek' | 'trimetaverse';

  // General
  defaultModel: string;
  fallbackModel: string;
  requestTimeoutMs: number;
}

export function readConfig(): TriModelConfig {
  return {
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    deepseekAnthropicBaseUrl: process.env.DEEPSEEK_ANTHROPIC_BASE_URL ?? 'https://api.deepseek.com/anthropic',

    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',

    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',

    trimetaverseApiKey: process.env.TRIMODEL_TRIMETAVERSE_API_KEY ?? 'tmv-sk-dev-default',
    trimetaverseBaseUrl: process.env.TRIMODEL_TRISTACISS_BASE_URL ?? 'http://127.0.0.1:8008/v1',

    primaryProvider: (process.env.TRIMODEL_PRIMARY_PROVIDER as 'deepseek' | 'trimetaverse') ?? 'deepseek',

    // O-R3-1 (2026-08-13): 默认模型名同步 tmv-* 注册表（r3 教训：注册表变更必须
    // 同步默认值硬编码）。env TRIMODEL_DEFAULT_MODEL 覆盖仍优先。
    defaultModel: process.env.TRIMODEL_DEFAULT_MODEL ?? 'tmv-deepseek-v4-pro',
    fallbackModel: process.env.TRIMODEL_FALLBACK_MODEL ?? 'deepseek-v4-flash',
    requestTimeoutMs: Number(process.env.TRIMODEL_REQUEST_TIMEOUT_MS ?? 60_000),
  };
}
