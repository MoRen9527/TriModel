// ── TriModel API: GET /health handler ──
import type { ModelClient } from '../client.js';

interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  providers: Record<string, boolean>;
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
    },
  };
}
