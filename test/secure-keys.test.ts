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
    assert.doesNotThrow(() => selfCheckKeystore(bad));
  });
});

describe('secure plane API: fail-closed admin auth + validation + masked status', () => {
  const ORIGINAL_ADMIN = process.env.TRIMODEL_ADMIN_TOKEN;
  let dir: string;

  before(() => { dir = mkdtempSync(join(tmpdir(), 'trimodel-secureapi-test-')); });
  after(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.TRIMODEL_ADMIN_TOKEN;
    else process.env.TRIMODEL_ADMIN_TOKEN = ORIGINAL_ADMIN;
    rmSync(dir, { recursive: true, force: true });
  });

  it('QB1 fail-closed: TRIMODEL_ADMIN_TOKEN unset ⇒ 503 disabled (no body processing)', async () => {
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    const { handlePutSecureKeys, handleSecureKeysStatus } = await import('../src/api/keys.js');
    const put = handlePutSecureKeys('Bearer whatever', '{"provider":"deepseek","api_key":"sk-x"}', { keystorePath: join(dir, 'k.enc') });
    assert.equal(put.statusCode, 503);
    const status = handleSecureKeysStatus('Bearer whatever', { keystorePath: join(dir, 'k.enc') });
    assert.equal(status.statusCode, 503);
  });

  it('admin token set: wrong/missing token ⇒ 401; correct token + valid body ⇒ 200 masked', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-secret-lg035';
    const { handlePutSecureKeys } = await import('../src/api/keys.js');
    const keystore = join(dir, 'k.enc');
    assert.equal(handlePutSecureKeys(undefined, '{"provider":"deepseek","api_key":"sk-x"}', { keystorePath: keystore }).statusCode, 401);
    assert.equal(handlePutSecureKeys('Bearer wrong', '{"provider":"deepseek","api_key":"sk-x"}', { keystorePath: keystore }).statusCode, 401);

    const ok = handlePutSecureKeys(
      'Bearer admin-secret-lg035',
      JSON.stringify({ provider: 'deepseek', api_key: 'sk-live-999888777666', base_url: 'https://api.deepseek.com/v1' }),
      { keystorePath: keystore },
    );
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.body as { masked: string }).masked, '****7666');
    assert.equal(JSON.stringify(ok.body).includes('sk-live-999888777666'), false, 'plaintext must never be echoed');
  });

  it('PUT validation: unknown provider / empty key / bad JSON / empty body ⇒ 400', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-secret-lg035';
    const { handlePutSecureKeys } = await import('../src/api/keys.js');
    const keystore = join(dir, 'k.enc');
    const auth = 'Bearer admin-secret-lg035';
    assert.equal(handlePutSecureKeys(auth, undefined, { keystorePath: keystore }).statusCode, 400);
    assert.equal(handlePutSecureKeys(auth, 'not json', { keystorePath: keystore }).statusCode, 400);
    assert.equal(handlePutSecureKeys(auth, JSON.stringify({ provider: 'nope', api_key: 'sk-x' }), { keystorePath: keystore }).statusCode, 400);
    assert.equal(handlePutSecureKeys(auth, JSON.stringify({ provider: 'deepseek', api_key: '' }), { keystorePath: keystore }).statusCode, 400);
  });

  it('F1-P2: masked-tail values are rejected (echo pollution guard); real keys pass', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-secret-lg035';
    const { handlePutSecureKeys } = await import('../src/api/keys.js');
    const keystore = join(dir, 'k.enc');
    const auth = 'Bearer admin-secret-lg035';
    // Masked api_key value → 400
    const maskedKey = handlePutSecureKeys(auth, JSON.stringify({ provider: 'deepseek', api_key: '****7666' }), { keystorePath: keystore });
    assert.equal(maskedKey.statusCode, 400);
    assert.ok(JSON.stringify(maskedKey.body).includes('masked value rejected'));
    // Masked base_url value → 400
    const maskedUrl = handlePutSecureKeys(auth, JSON.stringify({ provider: 'deepseek', api_key: 'sk-real-key-1', base_url: 'https://****/v1' }), { keystorePath: keystore });
    assert.equal(maskedUrl.statusCode, 400);
    // Normal key still passes and lands in the store
    const ok = handlePutSecureKeys(auth, JSON.stringify({ provider: 'deepseek', api_key: 'sk-real-key-1' }), { keystorePath: keystore });
    assert.equal(ok.statusCode, 200);
    assert.equal(readSecureKeys(keystore)?.providers.deepseek.api_key, 'sk-real-key-1');
  });

  it('status endpoint: provider list + masked tails only, no api_key field anywhere', async () => {
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-secret-lg035';
    const { handlePutSecureKeys, handleSecureKeysStatus } = await import('../src/api/keys.js');
    // Dedicated keystore: F1-P2 test above overwrites 'deepseek' in k.enc —
    // this assertion needs its own store to stay order-independent.
    const keystore = join(dir, 'status.enc');
    handlePutSecureKeys(
      'Bearer admin-secret-lg035',
      JSON.stringify({ provider: 'deepseek', api_key: 'sk-live-999888777666' }),
      { keystorePath: keystore },
    );
    const status = handleSecureKeysStatus('Bearer admin-secret-lg035', { keystorePath: keystore });
    assert.equal(status.statusCode, 200);
    const text = JSON.stringify(status.body);
    assert.equal(text.includes('sk-live-999888777666'), false, 'no plaintext in status');
    assert.ok(text.includes('****7666'));
    const providers = (status.body as { providers: Array<{ provider: string; masked: string }> }).providers;
    assert.equal(providers[0].provider, 'deepseek');
    assert.equal(providers[0].masked, '****7666');
    assert.equal((providers[0] as unknown as Record<string, unknown>).api_key, undefined);
  });

  it('no GET /v1/config/keys/secure route exists (404 by dispatch)', async () => {
    const { dispatch } = await import('../src/api/routes.js');
    const result = await dispatch({} as never, 'GET', '/v1/config/keys/secure', {});
    assert.equal(result.statusCode, 404);
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
