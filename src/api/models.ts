// ── TriModel API: GET /v1/models handler ──
// LG-035 增补（模型名标准化，CEO 令 2026-09-11）：恰五名，大小写精确，
// /v1/models 输出逐字节=CEO 原文；单一定义点=src/model-catalog.ts。
import { MODEL_CATALOG } from '../model-catalog.js';
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

const DISPLAY_NAMES: Record<string, string> = {
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'GLM-5.3-Flash': 'GLM 5.3 Flash',
  'GLM-5.3': 'GLM 5.3',
  'TMV': 'TriMetaverse Platform',
};

function inferProvider(modelId: string): string {
  if (modelId === 'TMV') return 'trimetaverse';
  if (modelId.startsWith('GLM')) return 'glm';
  return 'deepseek';
}

function inferCapabilities(modelId: string) {
  const reasoning = modelId.includes('v4-pro') || modelId === 'GLM-5.3';
  return {
    chat: true,
    streaming: true,
    tools: true,
    reasoning,
  };
}

export function handleModels(_client: ModelClient): { statusCode: number; body: ModelsResponse } {
  void _client; // catalog is now the single source (registry 拼合面退役)
  const data: ModelItem[] = MODEL_CATALOG.map((id) => ({
    id,
    object: 'model',
    display_name: DISPLAY_NAMES[id] ?? id,
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
