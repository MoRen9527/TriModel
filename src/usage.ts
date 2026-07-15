import type { ChatResponse } from './types.js';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export interface UsageSummary {
  /** Total calls accumulated */
  calls: number;
  /** Total tokens across all calls */
  tokens: TokenUsage;
  /** Breakdown by model */
  byModel: Record<string, TokenUsage>;
  /** Whether any calls had partial (zero-filled) usage data */
  partial: boolean;
}

export class UsageAccumulator {
  private total: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  private byModel: Record<string, TokenUsage> = {};
  private calls = 0;
  private hasPartial = false;

  add(response: ChatResponse): void {
    const u = response.usage;
    const model = response.model ?? 'unknown';

    this.total.prompt_tokens += u.prompt_tokens;
    this.total.completion_tokens += u.completion_tokens;
    this.total.total_tokens += u.total_tokens;
    if (u.reasoning_tokens !== undefined) {
      this.total.reasoning_tokens = (this.total.reasoning_tokens ?? 0) + u.reasoning_tokens;
    }

    if (!this.byModel[model]) {
      this.byModel[model] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    this.byModel[model].prompt_tokens += u.prompt_tokens;
    this.byModel[model].completion_tokens += u.completion_tokens;
    this.byModel[model].total_tokens += u.total_tokens;
    if (u.reasoning_tokens !== undefined) {
      this.byModel[model].reasoning_tokens =
        (this.byModel[model].reasoning_tokens ?? 0) + u.reasoning_tokens;
    }

    this.calls++;

    // Mark partial if usage was zero-filled (provider didn't return actual data)
    if (u.prompt_tokens === 0 && u.completion_tokens === 0 && u.total_tokens === 0) {
      this.hasPartial = true;
    }
  }

  summary(): UsageSummary {
    return {
      calls: this.calls,
      tokens: { ...this.total },
      byModel: { ...this.byModel },
      partial: this.hasPartial,
    };
  }

  reset(): void {
    this.total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    this.byModel = {};
    this.calls = 0;
    this.hasPartial = false;
  }
}
