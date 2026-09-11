// ── TriModel provider-key source of truth (LG-035 UI 重设计 S5·存储归并) ──
//
// 裁定：trimmc-card.json 已启用条目 = provider key 唯一活源。
// derive 规则：enabled 条目按 provider（vendor）分组，同 vendor 取
// updated_at 最新者；回落序 = card entries → env（.env 最终引导兜底）。
// keys.enc 自迁移完成后退役，不再进读链。
//
// SEC 不回退（全保留）：条目 at-rest 逐条目加密/明文仅 admin 通道解密/
// fail-safe（卡缺席/坏/解密失败 → env 回落，绝不 throw）。
import { loadCard } from './trimmc-card.js';
import { decrypt } from './security/key-encryptor.js';

export interface DerivedProviderKey {
  api_key: string;
  base_url?: string;
  source: 'card-entry' | 'env-fallback';
}

/**
 * Derive the effective provider keys from the card's enabled entries
 * (latest updated_at per vendor), falling back to env when a provider has
 * no usable entry. Never throws.
 */
export function deriveProviderKeys(
  envKeys: Record<string, { api_key: string; base_url?: string }>,
  cardPath?: string,
): Record<string, DerivedProviderKey> {
  const out: Record<string, DerivedProviderKey> = {};
  for (const [provider, k] of Object.entries(envKeys)) {
    out[provider] = { api_key: k.api_key, ...(k.base_url ? { base_url: k.base_url } : {}), source: 'env-fallback' };
  }

  let doc = null;
  try {
    doc = loadCard(cardPath);
  } catch {
    doc = null;
  }
  if (!doc) return out;

  // latest-enabled-entry per vendor
  const latest: Record<string, { api_key_encrypted: string; updated_at: string; base_url?: string }> = {};
  for (const entry of Object.values(doc.provider_entries ?? {})) {
    if (!entry?.enabled || !entry.api_key_encrypted) continue;
    const prev = latest[entry.provider];
    if (!prev || entry.updated_at > prev.updated_at) {
      latest[entry.provider] = { api_key_encrypted: entry.api_key_encrypted, updated_at: entry.updated_at, ...(entry.base_url ? { base_url: entry.base_url } : {}) };
    }
  }

  for (const [provider, pick] of Object.entries(latest)) {
    try {
      const apiKey = decrypt(Buffer.from(pick.api_key_encrypted, 'base64'));
      if (apiKey) {
        out[provider] = { api_key: apiKey, ...(pick.base_url ? { base_url: pick.base_url } : {}), source: 'card-entry' };
      }
    } catch (err) {
      // Undecryptable entry → keep env fallback for this provider (fail-safe).
      console.warn(`[trimodel] card entry for '${provider}' undecryptable — env fallback:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** One-provider convenience over deriveProviderKeys. */
export function deriveProviderKey(provider: string, envApiKey: string, envBaseUrl?: string, cardPath?: string): DerivedProviderKey {
  const all = deriveProviderKeys({ [provider]: { api_key: envApiKey, ...(envBaseUrl ? { base_url: envBaseUrl } : {}) } }, cardPath);
  return all[provider] ?? { api_key: '', source: 'env-fallback' };
}
