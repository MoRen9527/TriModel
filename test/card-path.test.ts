// ── LG-035 D9: card path canonicalization + merged-validation order tests ──
// Covers: env/cwd/legacy candidate order, boot migration (rename-style,
// idempotent), merged-validation (mirror-rule references resolved by merge;
// true dangling still 400).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  migrateLegacyDistCard,
  loadCard,
  saveCard,
  emptyCard,
} from '../src/trimmc-card.js';

describe('D9: path canonicalization', () => {
  const ORIGINAL_ENV = process.env.TRIMODEL_CARD_FILE;
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-cardpath-test-')); });
  after(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TRIMODEL_CARD_FILE; else process.env.TRIMODEL_CARD_FILE = ORIGINAL_ENV;
    rmSync(dir, { recursive: true, force: true });
  });

  it('env override wins: TRIMODEL_CARD_FILE pins the card location', () => {
    const pinned = join(dir, 'pinned.json');
    process.env.TRIMODEL_CARD_FILE = pinned;
    saveCard(emptyCard('c'), undefined);
    assert.ok(existsSync(pinned), 'card must land at the env-pinned path');
    assert.ok(loadCard(undefined), 'loadCard must read the env-pinned path');
  });

  it('legacy dist-adjacent card is migrated rename-style to the canonical path (idempotent)', () => {
    process.env.TRIMODEL_CARD_FILE = join(dir, 'fresh', 'trimmc-card.json'); // canonical absent
    const legacy = join(dir, 'legacy', 'trimmc-card.json');
    mkdirSync(join(dir, 'legacy'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ ...emptyCard('legacy-machine'), provider_entries: { old: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } } }));
    const r1 = migrateLegacyDistCard(legacy);
    assert.equal(r1.migrated, true);
    assert.equal(existsSync(legacy), false, 'legacy path must be renamed away');
    assert.ok(existsSync(join(dir, 'fresh', 'trimmc-card.json')), 'canonical card must exist after migration');
    const migrated = loadCard(undefined);
    assert.ok(migrated?.provider_entries.old, 'legacy entries must survive migration');
    // Idempotent: second run short-circuits
    const r2 = migrateLegacyDistCard(legacy);
    assert.equal(r2.reason, 'already-canonical');
  });
});

describe('D9: merged-validation order (校验序重构)', () => {
  const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'trimodel-mergedval-test-'));
    process.env.TRIMODEL_ADMIN_TOKEN = 'd9-secret';
  });
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
    rmSync(dir, { recursive: true, force: true });
  });

  it('mirror-rule reference is resolved by merge: partial PUT (rules referencing existing entry, empty provided) → 200', async () => {
    const { handlePutTrimmcCard } = await import('../src/api/trimmc-card.js');
    const cardPath = join(dir, 'c.json');
    const auth = 'Bearer d9-secret';
    // Seed: full card with e1 + fixed rule referencing it (pre-D9 this shape
    // 400'd because validation ran on the partial incoming document alone).
    const seed = handlePutTrimmcCard(auth, JSON.stringify({
      version: 2, machine: { name: 'm' }, connection: { name: 'seed' },
      provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: 'sk-seed-key-0000001', enabled: true, updated_at: 'x' } },
      rules: [{ rule_id: 'trimmc:e1', type: 'fixed', entry_id: 'e1' }],
      status: { state: 'applied', at: 'x' },
    }), { cardPath });
    assert.equal(seed.statusCode, 200);
    // Partial PUT: rename only (no entries, no rules) — must NOT 400
    const partial = handlePutTrimmcCard(auth, JSON.stringify({
      version: 2, machine: { name: 'm' }, connection: { name: 'renamed' },
      provider_entries: {}, deleted_entry_ids: [], rules: [],
      status: { state: 'pending', at: 'x' },
    }), { cardPath });
    assert.equal(partial.statusCode, 200, 'merge semantics: mirror references resolve via base');
  });

  it('true dangling (neither provided nor existing) still 400 after merge', async () => {
    const { handlePutTrimmcCard } = await import('../src/api/trimmc-card.js');
    const cardPath = join(dir, 'c2.json');
    const auth = 'Bearer d9-secret';
    const res = handlePutTrimmcCard(auth, JSON.stringify({
      version: 2, machine: { name: 'm' }, connection: { name: 'c' },
      provider_entries: {},
      rules: [{ rule_id: 'r', type: 'fixed', entry_id: 'ghost' }],
      status: { state: 'pending', at: 'x' },
    }), { cardPath });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.stringify(res.body).includes('does not reference an existing entry'));
  });
});
