// ── TriModel API: GET /health handler ──
import type { ModelClient } from '../client.js';
import { getTokenStats } from '../relay.js';

interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  providers: Record<string, boolean>;
  /** LG-006：额度接力限流换棒计数（tokenStats 中 reason='rate_limited' 事件数；P4-d 项字段）。 */
  rateLimitedCount: number;
}

export async function handleHealth(client: ModelClient): Promise<{ statusCode: number; body: HealthResponse }> {
  const providers = await client.healthCheck();
  return {
    statusCode: 200,
    body: {
      ok: true,
      service: 'trimodel',
      version: '0.1.0',
      providers,
      rateLimitedCount: getTokenStats().filter((e) => e.reason === 'rate_limited').length,
    },
  };
}
