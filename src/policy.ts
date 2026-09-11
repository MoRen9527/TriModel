// ── TriModel: Schedule-based default-model policy ──
// LG-035 P1 (2026-09-11): time-window policy over the default model.
//
// Design notes:
// - policy.json lives at the TriModel repo root (same resolution pattern as
//   config.ts dotenv: dev src/ → root, compiled dist/src/ → root).
// - File absent / unparsable / bad shape ⇒ loadPolicy() returns null and the
//   caller falls back to env default — behaviour identical to pre-policy days
//   (backward-compat guarantee).
// - savePolicy() writes tmp + rename (atomic on same filesystem).
// - Windows are evaluated in Asia/Shanghai local time explicitly (host TZ is
//   never consulted). Start is inclusive, end is exclusive.
// - P1 candidate-domain note: NO authentication on policy write path by design
//   (admin-token enforcement is a pending adjudication item; the config-plane
//   server binds 127.0.0.1 only). See src/api/policy.ts.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface PolicyWindow {
  start: string; // 'HH:MM' inclusive, Asia/Shanghai local time
  end: string; // 'HH:MM' exclusive
}

export interface PolicySchedule {
  id: string;
  target: 'daemon-default';
  model: string;
  windows: PolicyWindow[];
  timezone: 'Asia/Shanghai';
  enabled: boolean;
  priority: number; // higher number wins when multiple windows match
}

export interface PolicyShape {
  version: string;
  schedules: PolicySchedule[];
}

export interface PolicyEvaluation {
  model: string;
  matched_schedule_id: string;
}

const SUPPORTED_TIMEZONE = 'Asia/Shanghai';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Env fallback shared with keys.ts (same resolution as keys.ts legacy const). */
export function envDefaultModel(): string {
  return process.env.TRIMODEL_DEFAULT_MODEL ?? 'tmv-deepseek-v4-pro';
}

function toMinutes(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Format a Date as 'HH:MM' in the given IANA timezone (never the host TZ). */
function hhmmInZone(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date);
}

function windowMatches(hhmm: string, window: PolicyWindow): boolean {
  const now = toMinutes(hhmm);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (Number.isNaN(now) || Number.isNaN(start) || Number.isNaN(end)) return false;
  if (start < end) {
    // Same-day window: [start, end)
    return now >= start && now < end;
  }
  if (start > end) {
    // Overnight window (e.g. 18:00-00:00): [start, midnight) ∪ [00:00, end)
    return now >= start || now < end;
  }
  // start === end: zero-length window matches nothing
  return false;
}

/**
 * Evaluate the policy at instant `now`. Enabled schedules are ordered by
 * descending priority; the first schedule with a matching window wins.
 * Returns null when nothing matches (caller falls back to env default).
 */
export function evaluatePolicy(
  now: Date,
  policy: PolicyShape | null | undefined,
): PolicyEvaluation | null {
  if (!policy || !Array.isArray(policy.schedules)) return null;
  const enabled = policy.schedules
    .filter((s) => s && s.enabled)
    .sort((a, b) => b.priority - a.priority);
  for (const schedule of enabled) {
    if (schedule.timezone !== SUPPORTED_TIMEZONE) continue; // P1: single-TZ support
    const hhmm = hhmmInZone(now, schedule.timezone);
    if (Array.isArray(schedule.windows) && schedule.windows.some((w) => windowMatches(hhmm, w))) {
      return { model: schedule.model, matched_schedule_id: schedule.id };
    }
  }
  return null;
}

/** Validate an untrusted document against PolicyShape. Returns error string or ''. */
export function validatePolicyShape(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return 'policy must be a JSON object';
  const p = doc as Record<string, unknown>;
  if (typeof p.version !== 'string' || p.version.length === 0) return 'version must be a non-empty string';
  if (!Array.isArray(p.schedules)) return 'schedules must be an array';
  for (const [i, raw] of p.schedules.entries()) {
    if (typeof raw !== 'object' || raw === null) return `schedules[${i}] must be an object`;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id.length === 0) return `schedules[${i}].id must be a non-empty string`;
    if (s.target !== 'daemon-default') return `schedules[${i}].target must be 'daemon-default'`;
    if (typeof s.model !== 'string' || s.model.length === 0) return `schedules[${i}].model must be a non-empty string`;
    if (!Array.isArray(s.windows) || s.windows.length === 0) {
      return `schedules[${i}].windows must be a non-empty array`;
    }
    for (const [j, w] of (s.windows as unknown[]).entries()) {
      if (typeof w !== 'object' || w === null) return `schedules[${i}].windows[${j}] must be an object`;
      const win = w as Record<string, unknown>;
      if (typeof win.start !== 'string' || !TIME_RE.test(win.start)) {
        return `schedules[${i}].windows[${j}].start must be 'HH:MM' (00:00-23:59)`;
      }
      if (typeof win.end !== 'string' || !TIME_RE.test(win.end)) {
        return `schedules[${i}].windows[${j}].end must be 'HH:MM' (00:00-23:59)`;
      }
    }
    if (s.timezone !== SUPPORTED_TIMEZONE) return `schedules[${i}].timezone must be '${SUPPORTED_TIMEZONE}' (P1)`;
    if (typeof s.enabled !== 'boolean') return `schedules[${i}].enabled must be a boolean`;
    if (typeof s.priority !== 'number' || !Number.isFinite(s.priority)) {
      return `schedules[${i}].priority must be a finite number`;
    }
  }
  const ids = new Set<string>();
  for (const s of p.schedules as PolicySchedule[]) {
    if (ids.has(s.id)) return `duplicate schedule id: ${s.id}`;
    ids.add(s.id);
  }
  return '';
}

function candidatePolicyPaths(): string[] {
  // Same layout logic as config.ts dotenv resolution:
  //   src/policy.ts    → ../policy.json   (dev repo root)
  //   dist/src/policy.js → ../../policy.json (compiled repo root)
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, '..', 'policy.json'), resolve(here, '..', '..', 'policy.json')];
}

/**
 * Load policy.json from the TriModel repo root. Returns null when the file is
 * absent, unparsable, or fails shape validation — never throws (the server
 * must keep serving the env default when policy storage is broken).
 */
export function loadPolicy(pathOverride?: string): PolicyShape | null {
  const candidates = pathOverride ? [pathOverride] : candidatePolicyPaths();
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue; // absent (or unreadable) → try next candidate
    }
    try {
      const doc: unknown = JSON.parse(text);
      const error = validatePolicyShape(doc);
      if (error) {
        console.warn(`[trimodel] policy.json at ${path} failed validation: ${error}`);
        return null;
      }
      return doc as PolicyShape;
    } catch (err) {
      console.warn(`[trimodel] policy.json at ${path} is not valid JSON:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

/** Atomically persist the policy (tmp + rename). Default target: repo root. */
export function savePolicy(policy: PolicyShape, pathOverride?: string): void {
  const target = pathOverride ?? candidatePolicyPaths()[0];
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
  renameSync(tmp, target);
}

/** One-call helper for hot-path consumers: policy hit or env default. */
export function effectiveModel(now: Date = new Date()): {
  model: string;
  matched_schedule_id: string | null;
  source: 'policy' | 'env-default';
} {
  const hit = evaluatePolicy(now, loadPolicy());
  if (hit) return { model: hit.model, matched_schedule_id: hit.matched_schedule_id, source: 'policy' };
  return { model: envDefaultModel(), matched_schedule_id: null, source: 'env-default' };
}
