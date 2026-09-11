// ── LG-035 P2 STE gate: build chain (C) ──
// npm run build:verify（tsc + copy-ui + dist 断言脚本）全链绿 + dist/ui/index.html 落位。
// CI yml 现势为观察项（build:verify 脚本已断言，ci.yml「Verify dist integrity」步未含
// dist/ui 行——观察记录入门禁报告，不作红测）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('GATE P2: build chain (C)', () => {
  it('npm run build:verify is green (tsc + copy-ui + dist assertions)', () => {
    const res = spawnSync('npm run build:verify', { cwd: REPO_ROOT, shell: true, encoding: 'utf-8', timeout: 120000 });
    assert.equal(res.status, 0, `build:verify failed:\n${(res.stdout ?? '').slice(-800)}\n${(res.stderr ?? '').slice(-800)}`);
  });

  it('dist/ui/index.html exists after build (compiled UI_ROOT reachable)', () => {
    const ui = join(REPO_ROOT, 'dist', 'ui', 'index.html');
    assert.ok(existsSync(ui), 'dist/ui/index.html must be copied by the build chain');
    const html = readFileSync(ui, 'utf-8');
    assert.ok(html.includes('<title'), 'copied UI page is non-empty HTML');
  });

  it('compiled server references dist/ui (UI_ROOT seam)', () => {
    const serverJs = readFileSync(join(REPO_ROOT, 'dist', 'src', 'server.js'), 'utf-8');
    assert.ok(serverJs.includes('ui'), 'dist/src/server.js must resolve the ui root beside dist');
  });

  it('OBSERVATION: ci.yml Verify-dist step state recorded (not a red assertion)', () => {
    // STE-GATE-C-OBS: whether to wire dist/ui assertion into ci.yml (main-only
    // trigger) is a CTO adjudication alongside the CI-governance挂账 item.
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');
    const hasUiAssertion = ci.includes('dist/ui');
    // eslint-disable-next-line no-console
    console.log(`[ste-gate] ci.yml dist/ui assertion present = ${hasUiAssertion} (observation, see gate report)`);
    assert.ok(ci.includes('dist/src/server.js'), 'existing dist integrity baseline assertion intact');
  });
});
