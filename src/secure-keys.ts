// ── TriModel Secure Key Store (LG-035 P2 工作流 B) ──
// Encrypted provider-key store: keys.enc at the TriModel repo root.
//
// Semantics (CEO 三裁 B 方案，2026-09-11):
//   - PUT /v1/config/keys/secure → encrypt → keys.enc (tmp+rename, atomic).
//   - keys.enc present ⇒ its provider entries OVERRIDE same-name .env L1
//     keys in the read chain (readKeys overlay); .env remains the bootstrap
//     fallback when keys.enc is absent.
//   - NO read-back endpoint: GET /v1/config/keys/secure must not exist.
//     Plaintext never leaves the server; only masked tail-4 via the status
//     endpoint (Bearer-protected).
//   - Fail-safe family: keys.enc present but undecryptable (machine moved,
//     corrupted, tampered) ⇒ stderr warn + fall back to .env, never throw.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { hostname } from 'node:os';
import { decrypt, encrypt } from './security/key-encryptor.js';
import { loadCard, saveCard } from './trimmc-card.js';

export interface SecureKeyEntry {
  api_key: string;
  base_url?: string;
  updated_at: string;
}

// ── LG-035 UI 重设计 S5：keys.enc 一次性迁移（→trimmc-card 合成条目）──
// 合成映射（spec 定稿）：deepseek→deepseek-v4-pro / glm→GLM-5.3 /
// trimetaverse→TMV；条目标记 auto_imported。幂等 = .migrated 存在即跳过。
// 密文直接搬运（同机器指纹同加密域，无需解密重加密——解密失败亦可迁）。

export interface MigrationResult {
  migrated: boolean;
  imported: string[];
  reason?: 'already-migrated' | 'no-legacy' | 'undecryptable' | 'empty';
}

const MIGRATION_MODEL_MAP: Record<string, string> = {
  deepseek: 'deepseek-v4-pro',
  glm: 'GLM-5.3',
  trimetaverse: 'TMV',
};

export function migrateKeysEncToCard(
  cardPath?: string,
  loadOverride?: () => SecureKeysDocument | null,
  legacyPathOverride?: string,
): MigrationResult {
  const here = dirname(fileURLToPath(import.meta.url));
  const legacy = legacyPathOverride ?? resolve(here, '..', 'keys.enc');
  const migrated = `${legacy}.migrated`;
  if (existsSync(migrated)) return { migrated: false, imported: [], reason: 'already-migrated' };
  if (!existsSync(legacy)) return { migrated: false, imported: [], reason: 'no-legacy' };

  const readDoc = loadOverride ?? (() => readSecureKeys());
  const doc = readDoc();
  if (!doc) return { migrated: false, imported: [], reason: 'undecryptable' };

  // Load-or-create the card, then merge synthetic entries (ciphertext moved
  // verbatim — same machine fingerprint, same encryption domain).
  let card = loadCard(cardPath);
  if (!card) {
    card = {
      version: 2,
      machine: { name: hostname() },
      connection: { name: 'auto-import' },
      provider_entries: {},
      rules: [],
      status: { state: 'pending', at: new Date().toISOString() },
      reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };
  }
  const imported: string[] = [];
  const now = new Date().toISOString();
  for (const [provider, entry] of Object.entries(doc.providers)) {
    const model = MIGRATION_MODEL_MAP[provider];
    if (!model) continue;
    const entryId = `auto:${provider}`;
    card.provider_entries[entryId] = {
      provider,
      model,
      api_key_encrypted: entry.api_key, // verbatim ciphertext
      enabled: true,
      updated_at: now,
      auto_imported: true,
    };
    imported.push(entryId);
  }
  saveCard(card, cardPath);
  renameSync(legacy, migrated);
  console.log(`[trimodel] keys.enc migrated to card entries: ${imported.join(', ') || '(none)'}; legacy renamed to keys.enc.migrated`);
  return { migrated: imported.length > 0, imported, reason: imported.length > 0 ? undefined : 'empty' };
}

export interface SecureKeysDocument {
  version: '1';
  providers: Record<string, SecureKeyEntry>;
}

export const KNOWN_PROVIDERS = ['deepseek', 'anthropic', 'openai', 'trimetaverse'] as const;

/** Masked tail: '****' + last 4 chars (or all-dot when shorter). */
export function maskKey(apiKey: string): string {
  if (apiKey.length <= 4) return '****';
  return `****${apiKey.slice(-4)}`;
}

function candidateKeystorePaths(): string[] {
  // Same layout logic as policy.ts / config.ts:
  //   src/secure-keys.ts     → ../keys.enc    (dev repo root)
  //   dist/src/secure-keys.js → ../../keys.enc (compiled repo root)
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, '..', 'keys.enc'), resolve(here, '..', '..', 'keys.enc')];
}

/** Persist the secure keystore (encrypt → tmp → rename). Default: repo root. */
export function writeSecureKeys(doc: SecureKeysDocument, pathOverride?: string): void {
  const target = pathOverride ?? candidateKeystorePaths()[0];
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, encrypt(JSON.stringify(doc)));
  renameSync(tmp, target);
}

/**
 * Read + decrypt keys.enc. Returns null when absent or undecryptable —
 * callers fall back to env keys (fail-safe, same family as loadPolicy).
 * Never throws.
 */
export function readSecureKeys(pathOverride?: string): SecureKeysDocument | null {
  const candidates = pathOverride ? [pathOverride] : candidateKeystorePaths();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (err) {
      console.warn(`[trimodel] keys.enc unreadable at ${path}:`, err instanceof Error ? err.message : err);
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(decrypt(raw));
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof (parsed as SecureKeysDocument).providers === 'object' &&
        (parsed as SecureKeysDocument).providers !== null
      ) {
        return parsed as SecureKeysDocument;
      }
      console.warn(`[trimodel] keys.enc at ${path} has invalid shape — falling back to env keys`);
      return null;
    } catch (err) {
      // GCM auth failure (wrong machine / tampered / corrupted) lands here.
      console.warn(
        `[trimodel] keys.enc at ${path} undecryptable — falling back to env keys:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
  return null;
}

/** True when any candidate keystore path holds a keys.enc file. */
export function keystoreExists(pathOverride?: string): boolean {
  const candidates = pathOverride ? [pathOverride] : candidateKeystorePaths();
  return candidates.some((p) => existsSync(p));
}

/**
 * Startup self-check (server main): when keys.enc exists, attempt one decrypt
 * so a broken keystore is loudly reported at boot instead of silently
 * degrading to env keys on first read.
 */
export function selfCheckKeystore(pathOverride?: string): void {
  if (!keystoreExists(pathOverride)) return;
  const doc = readSecureKeys(pathOverride);
  if (doc === null) {
    // readSecureKeys already warned with the reason; add the boot-context line.
    console.warn('[trimodel] startup self-check: keys.enc present but unusable — serving env keys until it is repaired or removed');
  }
}

/**
 * Upsert one provider entry onto the existing keystore (read-modify-write).
 * Called by the PUT /v1/config/keys/secure handler.
 */
export function upsertSecureKey(
  provider: string,
  apiKey: string,
  baseUrl: string | undefined,
  pathOverride?: string,
): SecureKeysDocument {
  const existing = readSecureKeys(pathOverride);
  const doc: SecureKeysDocument = existing ?? { version: '1', providers: {} };
  doc.providers[provider] = {
    api_key: apiKey,
    ...(baseUrl ? { base_url: baseUrl } : {}),
    updated_at: new Date().toISOString(),
  };
  writeSecureKeys(doc, pathOverride);
  return doc;
}
