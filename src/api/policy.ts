// ── TriModel API: Schedule policy endpoints ──
// GET /v1/config/policy — current policy + effective default-model preview
// PUT /v1/config/policy — validate + atomically persist the policy document
//
// LG-035 P1 (2026-09-11): NO authentication on this endpoint pair by design —
// admin-token enforcement is a PENDING ADJUDICATION ITEM (候裁域，本批不做).
// Mitigation in place: the configuration-plane server binds 127.0.0.1 only
// (TRIMODEL_HOST default). Revisit before any non-loopback exposure — that
// exposure itself is also a pending adjudication domain (sg 暴露候裁).
import { evaluatePolicy, loadPolicy, savePolicy, validatePolicyShape, envDefaultModel } from '../policy.js';
import type { PolicyShape } from '../policy.js';

export interface EffectivePreview {
  model: string;
  matched_schedule_id: string | null;
  source: 'policy' | 'env-default';
  evaluated_at: string;
}

function previewNow(policy: PolicyShape | null): EffectivePreview {
  const now = new Date();
  const hit = evaluatePolicy(now, policy);
  return {
    model: hit ? hit.model : envDefaultModel(),
    matched_schedule_id: hit ? hit.matched_schedule_id : null,
    source: hit ? 'policy' : 'env-default',
    evaluated_at: now.toISOString(),
  };
}

export function handleGetPolicy(): { statusCode: number; body: Record<string, unknown> } {
  const policy = loadPolicy();
  return {
    statusCode: 200,
    body: {
      object: 'config.policy',
      policy: policy ?? { version: '1', schedules: [] },
      policy_file_present: policy !== null,
      effective: previewNow(policy),
    },
  };
}

export function handlePutPolicy(
  rawBody: string | undefined,
): { statusCode: number; body: Record<string, unknown> } {
  if (rawBody === undefined || rawBody.trim() === '') {
    return { statusCode: 400, body: { error: 'request body required (JSON policy document)' } };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(rawBody);
  } catch (err) {
    return {
      statusCode: 400,
      body: { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
    };
  }

  const validationError = validatePolicyShape(doc);
  if (validationError) {
    return { statusCode: 400, body: { error: `policy validation failed: ${validationError}` } };
  }

  const policy = doc as PolicyShape;
  try {
    savePolicy(policy);
  } catch (err) {
    return {
      statusCode: 500,
      body: { error: `failed to persist policy.json: ${err instanceof Error ? err.message : String(err)}` },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      policy,
      effective: previewNow(policy),
    },
  };
}
