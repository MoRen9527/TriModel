import type { StreamEvent } from '../../types.js';

/**
 * Shared OpenAI-compatible SSE parser for Chat Completions API streaming.
 *
 * Parses the standard SSE format used by OpenAI, DeepSeek, and compatible providers:
 *   data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"},...}],...}
 *   data: [DONE]
 *
 * Used by DeepSeekProvider and OpenAIProvider (and any OpenAI-compatible provider).
 */
export async function* parseOpenAISSE(
  response: Response,
): AsyncGenerator<StreamEvent> {
  if (!response.body) {
    throw new Error('Streaming response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue; // Skip unparseable SSE lines
        }

        const choices = json.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) continue;

        const choice = choices[0];
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        const event: StreamEvent = {
          delta: (delta.content as string) ?? '',
          finish_reason: (choice.finish_reason as StreamEvent['finish_reason']) ?? null,
        };

        // Parse incremental tool calls
        if (delta.tool_calls) {
          const rawToolCalls = delta.tool_calls as Array<Record<string, unknown>>;
          event.tool_calls = rawToolCalls.map((tc) => ({
            index: tc.index as number,
            id: tc.id as string | undefined,
            type: (tc.type as 'function') ?? 'function',
            function: tc.function as { name?: string; arguments?: string } | undefined,
          }));
        }

        // Usage on final chunk
        if (json.usage) {
          const u = json.usage as Record<string, number>;
          event.usage = {
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
            total_tokens: u.total_tokens ?? 0,
          };
        }

        yield event;
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
        try {
          const json = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
          const choices = json.choices as Array<Record<string, unknown>> | undefined;
          if (choices?.[0]) {
            const d = choices[0].delta as Record<string, unknown> | undefined;
            yield {
              delta: (d?.content as string) ?? '',
              finish_reason: choices[0].finish_reason as StreamEvent['finish_reason'] ?? null,
            };
          }
        } catch {
          // ignore trailing garbage
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
