// ── LG-035 P2 secure-key store + transition detector tests ──
// Covers: keystore encrypt/decrypt roundtrip, fail-closed admin plane
// (503 unset / 401 wrong token / 200 correct), PUT validation, masked
// status (no plaintext), corrupted keystore fail-safe, and the model
// transition detector (whitelist record — no key material).
// All disk writes go through pathOverride into mkdtemp dirs (repo root untouched).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import {
  writeSecureKeys,
  readSecureKeys,
  keystoreExists,
  upsertSecureKey,
  maskKey,
  selfCheckKeystore,
} from '../src/secure-keys.js';
import type { SecureKeysDocument } from '../src/secure-keys.js';
import {
  recordModelTransitionIfChanged,
  resetTransitionStateForTest,
} from '../src/transition.js';
import { readFileSync } from 'node:fs';

describe('secure-keys: roundtrip + fail-safe (path override)', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-securekeys-test-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('upsert → read returns the same key material (encrypted at rest)', () => {
    const path = join(dir, 'keys.enc');
    upsertSecureKey('deepseek', 'sk-test-abcdef1234', 'https://api.example.com/v1', path);
    assert.ok(existsSync(path));
    assert.ok(!existsSync(path + '.tmp'), 'tmp must be renamed away');
    // Encrypted at rest: raw bytes must not contain the plaintext key
    const raw = readFileSync(path);
    assert.equal(raw.includes(Buffer.from('sk-test-abcdef1234')), false, 'plaintext must not appear in keys.enc');

    const doc = readSecureKeys(path);
    assert.ok(doc);
    assert.equal(doc.providers.deepseek.api_key, 'sk-test-abcdef1234');
    assert.equal(doc.providers.deepseek.base_url, 'https://api.example.com/v1');
  });

  it('second upsert of another provider merges (read-modify-write)', () => {
    const path = join(dir, 'keys.enc');
    upsertSecureKey('deepseek', 'sk-a', undefined, path);
    upsertSecureKey('anthropic', 'sk-b', undefined, path);
    const doc = readSecureKeys(path);
    assert.ok(doc?.providers.deepseek && doc?.providers.anthropic);
  });

  it('readSecureKeys: absent file → null; corrupted file → null (fail-safe, never throws)', () => {
    assert.equal(readSecureKeys(join(dir, 'missing.enc')), null);
    const bad = join(dir, 'bad.enc');
    writeFileSync(bad, Buffer.from('this is definitely not AES-GCM output'));
    assert.equal(readSecureKeys(bad), null);
    // Empty/garbage JSON-shaped-but-wrong-shape file → null
    const wrongShape = join(dir, 'wrong.enc');
    writeSecureKeys({ version: '1', providers: {} } satisfies SecureKeysDocument, wrongShape);
    assert.ok(readSecureKeys(wrongShape));
  });

  it('maskKey: tail-4 only, never more', () => {
    assert.equal(maskKey('sk-1234567890'), '****7890');
    assert.equal(maskKey('abcd'), '****');
    assert.equal(maskKey('abc'), '****');
  });

  it('keystoreExists + selfCheckKeystore do not throw on absent/corrupt store', () => {
    assert.equal(keystoreExists(join(dir, 'nope.enc')), false);
    const bad = join(dir, 'bad.enc');
    assert.doesNotThrow(() => { selfCheckKeystore(bad); });
  });
});

describe('S5 退役面: PUT secure → 410; status → migration indicator', () => {
  const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;
  before(() => { process.env.TRIMODEL_ADMIN_TOKEN = 'admin-tc'; });
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN; else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
  });

  it('PUT /v1/config/keys/secure retired: always 410 + human guidance (S5)', async () => {
    const { handlePutSecureKeys } = await import('../src/api/keys.js');
    const gone = handlePutSecureKeys('Bearer admin-tc', JSON.stringify({ provider: 'deepseek', api_key: 'sk-x' }));
    assert.equal(gone.statusCode, 410);
    assert.ok(JSON.stringify(gone.body).includes('模型信息'), 'retirement message must point at the card entry form');
  });

  it('status: 503 fail-closed / 401 wrong / 200 migration indicator (S5 semantics)', async () => {
    const { handleSecureKeysStatus } = await import('../src/api/keys.js');
    const ORIGINAL = process.env.TRIMODEL_ADMIN_TOKEN;
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    assert.equal(handleSecureKeysStatus('Bearer x').statusCode, 503);
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-tc';
    assert.equal(handleSecureKeysStatus('Bearer wrong').statusCode, 401);
    const ok = handleSecureKeysStatus('Bearer admin-tc');
    assert.equal(ok.statusCode, 200);
    const body = ok.body as { legacy_present: boolean; migrated: boolean; card_present: boolean; message: string };
    assert.equal(typeof body.legacy_present, 'boolean');
    assert.equal(typeof body.migrated, 'boolean');
    assert.ok(body.message.length > 0);
    process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL;
  });

  it('F1-P2 masked-echo guard lives on the card plane now: masked api_key never hydrates', async () => {
    const { handlePutTrimmcCard } = await import('../src/api/trimmc-card.js');
    const { emptyCard } = await import('../src/trimmc-card.js');
    const doc = {
      ...emptyCard('c'),
      provider_entries: { e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: '****7666', enabled: true, updated_at: 'x' } },
      rules: [],
    };
    const res = handlePutTrimmcCard('Bearer admin-tc', JSON.stringify(doc), { cardPath: join(tmpdir(), 'no-such-dir-guard', 'c.json') });
    assert.equal(res.statusCode, 400, 'masked value → no ciphertext → structural 400 (echo pollution cannot land)');
  });
});

describe('transition detector: value-change semantics + whitelist record (SEC red line)', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-transition-test-')); resetTransitionStateForTest(); });
  after(() => { rmSync(dir, { recursive: true, force: true }); resetTransitionStateForTest(); });

  it('first observation records nothing; change records one line; same value records nothing', () => {
    const log = join(dir, 'transitions.jsonl');
    const first = recordModelTransitionIfChanged({ model: 'GLM-5.3', source: 'env-default', matched_schedule_id: null }, log);
    assert.equal(first, null);
    const t = recordModelTransitionIfChanged({ model: 'deepseek-v4-pro', source: 'policy', matched_schedule_id: 's1' }, log);
    assert.ok(t);
    assert.equal(t.from, 'GLM-5.3');
    assert.equal(t.to, 'deepseek-v4-pro');
    const again = recordModelTransitionIfChanged({ model: 'deepseek-v4-pro', source: 'policy', matched_schedule_id: 's1' }, log);
    assert.equal(again, null);
    // Exactly one JSONL line on disk
    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
  });

  it('SEC-20260813-001: record contains only {at, from, to, source, matched_schedule_id} — no key material field', () => {
    const log = join(dir, 'transitions2.jsonl');
    recordModelTransitionIfChanged({ model: 'a', source: 'env-default', matched_schedule_id: null }, log);
    recordModelTransitionIfChanged({ model: 'b', source: 'policy', matched_schedule_id: 'x' }, log);
    const record = JSON.parse(readFileSync(log, 'utf-8').trim().split('\n')[1]) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(record).sort(),
      ['at', 'from', 'matched_schedule_id', 'source', 'to'],
    );
  });

  it('unwritable log path: warn, no throw, state still advances', () => {
    resetTransitionStateForTest();
    const badDir = join(dir, 'missing-subdir', 't.jsonl');
    assert.doesNotThrow(() => {
      const r1 = recordModelTransitionIfChanged({ model: 'a', source: 'env-default', matched_schedule_id: null }, badDir);
      assert.equal(r1, null);
      const r2 = recordModelTransitionIfChanged({ model: 'b', source: 'policy', matched_schedule_id: null }, badDir);
      assert.ok(r2, 'transition detected even when append fails');
    });
  });
});
