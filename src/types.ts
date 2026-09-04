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
  /** LG-006 终裁④ per-task：任务级禁接力标记——主链不可用即显式失败不降级（宁失败勿降级）。 */
  noRelay?: boolean;
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
  /** LG-006 透明度分级（稿 §二.5）：跨模型换棒时会话内一次性明示注记；同模型账号间静默不设。 */
  relayNote?: string;
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
  /** LG-006 透明度分级：跨模型换棒一次性明示（首棒前 yield 一次）。 */
  relayNote?: string;
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
