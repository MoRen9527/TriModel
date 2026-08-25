// ── TriModel API: GET /v1/models handler ──
import type { ModelClient } from '../client.js';

interface ModelItem {
  id: string;
  object: string;
  display_name: string;
  provider: string;
  capabilities: {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    reasoning: boolean;
  };
  created: number;
}

interface ModelsResponse {
  object: string;
  data: ModelItem[];
}

function inferCapabilities(modelId: string) {
  const reasoning = modelId.includes('reasoner') || modelId.includes('v4-pro');
  return {
    chat: true,
    streaming: true,
    tools: true,
    reasoning,
  };
}

function inferDisplayName(modelId: string): string {
  const map: Record<string, string> = {
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
    'deepseek-chat': 'DeepSeek Chat',
    'deepseek-reasoner': 'DeepSeek Reasoner',
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'tmv-deepseek-chat': 'TriMetaverse DeepSeek Chat',
    'tmv-deepseek-reasoner': 'TriMetaverse DeepSeek Reasoner',
    'tmv-deepseek-v4-pro': 'TriMetaverse DeepSeek V4 Pro',
    'tmv-deepseek-v4-flash': 'TriMetaverse DeepSeek V4 Flash',
    'stealth/ox-alpha': 'Ox Alpha (OpenRouter)',
  };
  return map[modelId] ?? modelId;
}

function inferProvider(modelId: string): string {
  if (modelId.startsWith('tmv-')) return 'trimetaverse';
  if (modelId.startsWith('deepseek')) return 'deepseek';
  return 'unknown';
}

export function handleModels(client: ModelClient): { statusCode: number; body: ModelsResponse } {
  const modelIds = client.listModels();
  const data: ModelItem[] = modelIds.map((id) => ({
    id,
    object: 'model',
    display_name: inferDisplayName(id),
    provider: inferProvider(id),
    capabilities: inferCapabilities(id),
    created: 1735689600,
  }));

  return {
    statusCode: 200,
    body: {
      object: 'list',
      data,
    },
  };
}
