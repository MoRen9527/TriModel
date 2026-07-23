import type { StreamEvent } from '../../types.js';

/**
 * Shared Anthropic SSE parser for Anthropic Messages API streaming responses.
 *
 * Parses the Anthropic SSE event format:
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{...}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{...}}
 *
 * Used by DeepSeekAnthropicProvider, TriMetaverseProvider, and AnthropicProvider.
 */
export async function* parseAnthropicSSE(
  response: Response,
): AsyncGenerator<StreamEvent> {
  if (!response.body) {
    throw new Error('Streaming response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const toolCallsAccumulator: Map<number, NonNullable<StreamEvent['tool_calls']>[number]> = new Map();
  let finishReason: StreamEvent['finish_reason'] = null;
  let usage: StreamEvent['usage'];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events: "event: <name>\ndata: <json>\n\n"
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split('\n');
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            dataStr = line.slice(6).trim();
          }
        }
        if (!dataStr) continue;

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(dataStr) as Record<string, unknown>;
        } catch {
          continue; // Skip unparseable SSE lines
        }

        switch (json.type) {
          case 'content_block_delta': {
            const delta = json.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta') {
              yield { delta: (delta.text as string) ?? '', finish_reason: null };
            } else if (delta?.type === 'input_json_delta' && json.index !== undefined) {
              // Tool call argument streaming
              const idx = json.index as number;
              const existing = toolCallsAccumulator.get(idx) ?? {
                index: idx,
                type: 'function' as const,
                function: {},
              };
              existing.function = {
                ...existing.function,
                arguments: (existing.function?.arguments ?? '') + ((delta.partial_json as string) ?? ''),
              };
              toolCallsAccumulator.set(idx, existing);
              yield {
                delta: '',
                tool_calls: Array.from(toolCallsAccumulator.values()),
                finish_reason: null,
              };
            }
            break;
          }
          case 'content_block_start': {
            const block = json.content_block as Record<string, unknown> | undefined;
            if (block?.type === 'tool_use' && json.index !== undefined) {
              toolCallsAccumulator.set(json.index as number, {
                index: json.index as number,
                id: block.id as string,
                type: 'function',
                function: { name: block.name as string, arguments: '' },
              });
            }
            break;
          }
          case 'message_delta': {
            const delta = json.delta as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              const stopMap: Record<string, StreamEvent['finish_reason']> = {
                end_turn: 'stop',
                max_tokens: 'length',
                stop_sequence: 'stop',
                tool_use: 'tool_calls',
              };
              finishReason = stopMap[delta.stop_reason as string] ?? null;
            }
            if (json.usage) {
              const u = json.usage as Record<string, number>;
              usage = {
                prompt_tokens: u.input_tokens ?? 0,
                completion_tokens: u.output_tokens ?? 0,
                total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
              };
            }
            break;
          }
          case 'message_stop':
            // Final event marker — will flush accumulated state after loop
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Yield residual tool calls and final event
  if (toolCallsAccumulator.size > 0 || finishReason !== null) {
    yield {
      delta: '',
      tool_calls: toolCallsAccumulator.size > 0
        ? Array.from(toolCallsAccumulator.values())
        : undefined,
      finish_reason: finishReason,
      usage,
    };
  }
}
