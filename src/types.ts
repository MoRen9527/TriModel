export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  usage: {
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

/** Streaming event yielded during model streaming. */
export interface StreamEvent {
  /** Delta content chunk (accumulated by caller) */
  delta: string;
  /** Tool calls accumulated so far (incremental, merge by index) */
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
  /** Finish reason (only present in final event) */
  finish_reason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  /** Usage info (only present in final event) */
  usage?: ChatResponse['usage'];
}

export interface Provider {
  readonly info: ProviderInfo;
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;
  /** CTO-003 P1: Streaming chat with SSE parsing. Yields StreamEvent chunks. */
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent>;
  healthCheck(): Promise<boolean>;
}

export interface ModelRoutingConfig {
  primary: string;
  fallback?: string;
  timeoutMs: number;
}

export type ModelRegistry = Record<string, ModelRoutingConfig>;
