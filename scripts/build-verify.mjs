// ── Build verify: dist/ui/index.html must exist after `npm run build` ──
// (LG-035 P2 工作流 C — replaces the ad-hoc manual copy step.)
// Usage: node scripts/build-verify.mjs  (wired into `npm run build:verify`)

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = ['dist/ui/index.html', 'dist/src/server.js', 'dist/src/policy.js', 'dist/src/secure-keys.js'];

const missing = required.filter((rel) => !existsSync(resolve(root, rel)));
if (missing.length > 0) {
  console.error(`[build-verify] missing after build: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('[build-verify] all build artifacts present (incl. dist/ui/index.html)');
