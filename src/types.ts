export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  reasoning_content?: string;
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
  };
}

export interface ProviderInfo {
  name: string;
  models: string[];
  baseUrl: string;
}

export interface Provider {
  readonly info: ProviderInfo;
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;
  healthCheck(): Promise<boolean>;
}

export interface ModelRoutingConfig {
  primary: string;
  fallback?: string;
  timeoutMs: number;
}

export type ModelRegistry = Record<string, ModelRoutingConfig>;
