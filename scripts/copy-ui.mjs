// ── Build post-step: copy static UI assets into dist/ (LG-035 P2 工作流 C) ──
// tsc only emits compiled JS; the single-page editor in ui/ is a runtime
// static asset served by src/server.ts from ../ui (dev) — the compiled
// dist/src/server.js resolves ../ui relative to dist/src/, i.e. dist/ui.
// Usage: node scripts/copy-ui.mjs  (wired into `npm run build`)

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'ui');
const dest = resolve(root, 'dist', 'ui');

if (!existsSync(src)) {
  console.error('[copy-ui] ui/ not found — nothing to copy');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-ui] ui/ → dist/ui copied`);
