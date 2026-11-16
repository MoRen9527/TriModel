// ── a1 机制：进程内解卡 → spawn 3334 带 GLM env ──────────────────────────
// (BOD 裁124 续·CTO 六判据门禁一审绿·FSD 主刀·2026-11-17)
//
// 机制面：3333 配置面进程持 card 条目解密权（key-encryptor decrypt 族，
// key-source.ts:53 同形先例）→解卡双 GLM 条目（card provider_entries:
// e-glm-anthropic / e-glm-flash-anthropic·其余条目零触=最小权限解卡面·
// 判据①）→spawn 3334 proxy 子进程带 GLM env（key 零出进程：解密值只在
// 父进程内存→子 env 链·零落盘零日志零读数卷·D-46 全程·判据②）。
//
// 源面勘正（编码期实勘 2026-11-17）：条目活源=trimmc-card.json
// provider_entries（key-source.ts 裁定：keys.enc 自迁移毕退役不再进读链——
// R-HY 迁移后 keys.enc 已改名 .migrated，readSecureKeys 恒 null。方案卷
// §2.1「keys.enc providers 面」系设计期近似表述，以本模块实装为准）。
//
// 启动形双态解析：dist 生产形（server.js 旁 proxy-server.js 直启）为主；
// tsx dev 形（src/proxy-server.ts·--import tsx）为备。两形俱缺席=fail-safe
// 不 spawn（现状维持）。
//
// 精化注（CTO 一审）：旧 3334 独立进程 stop=本形设计内替换（spawn 取代）——
// 零重启指主链 daemon（TriRLC/TriMMC/3333 主面不动）；3334 转 3333 子进程=
// 包含式耦合（3333 重启窗=3334 短隙·startup 序重 spawn 自愈）。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadCard } from './trimmc-card.js';
import { decrypt } from './security/key-encryptor.js';

/** 3334 proxy 入口脚本（同目录旁置形·dist/.ts 双态解析见 resolveProxyLaunch）。 */
export const PROXY_SCRIPT_NAME = 'proxy-server';

/** card provider_entries 双 GLM 条目 id（判据①·e-deepseek 等其余条目零触）。 */
export const GLM_ENTRY_MAIN = 'e-glm-anthropic';
export const GLM_ENTRY_FLASH = 'e-glm-flash-anthropic';

export interface GlmSpawnPlan {
  /** 子进程完整 env（base env + GLM 键补丁·明文仅在父进程内存）。 */
  childEnv: Record<string, string>;
  /** 注入键计数（1=单键形降级·2=双键全形）——读数面计数形，零值面。 */
  keyCount: number;
}

/**
 * 单条目解卡（card provider_entries → key-encryptor decrypt·key-source.ts:53
 * 同形）。缺席/坏卡/解密失败 → undefined（fail-safe：调面降级单键形或不
 * spawn·零 throw·零明文日志）。
 */
export function decryptGlmEntry(entryId: string): string | undefined {
  try {
    const doc = loadCard();
    const enc = doc?.provider_entries?.[entryId]?.api_key_encrypted;
    if (!enc) return undefined;
    const plain = decrypt(Buffer.from(enc, 'base64'));
    return plain || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组装 3334 子进程 env（纯函数·白盒面）：主条目缺席/解密失败 → null（不
 * spawn·fail-safe 现状维持）；档条目缺席 = 单键形降级（GLM_FLASH_API_KEY
 * 缺席不阻 spawn）。值面零日志——调用面只出计数形读数。
 */
export function buildGlmChildEnv(
  decryptEntry: (entryId: string) => string | undefined,
  baseEnv: Record<string, string> = process.env as Record<string, string>,
): GlmSpawnPlan | null {
  const mainKey = decryptEntry(GLM_ENTRY_MAIN);
  const flashKey = decryptEntry(GLM_ENTRY_FLASH);
  if (!mainKey) return null;
  const childEnv: Record<string, string> = { ...baseEnv };
  childEnv.GLM_API_KEY = mainKey;
  if (flashKey) childEnv.GLM_FLASH_API_KEY = flashKey;
  return { childEnv, keyCount: flashKey ? 2 : 1 };
}

/** 启动形双态解析：dist .js 直启为主；src .ts + --import tsx 为备；俱缺席=null。
 * （导出面=白盒族用·行为面与私有无异。） */
export function resolveProxyLaunch(): { execArgs: string[]; script: string } | null {
  const dir = dirname(fileURLToPath(import.meta.url));
  const js = resolve(dir, `${PROXY_SCRIPT_NAME}.js`);
  if (existsSync(js)) return { execArgs: [], script: js };
  const ts = resolve(dir, `${PROXY_SCRIPT_NAME}.ts`);
  if (existsSync(ts)) return { execArgs: ['--import', 'tsx'], script: ts };
  return null;
}

/**
 * 3333 listen 后挂钩点（server.ts 启动序末段调）：解卡→spawn 3334 子进程带
 * GLM env。失败面全 fail-safe（解密失败/条目缺席/脚本缺席 → 不 spawn·
 * 现状维持·零 throw 出进程）。
 */
export function spawnProxyWithKeys(): void {
  try {
    const plan = buildGlmChildEnv(decryptGlmEntry);
    if (!plan) {
      console.log('[trimodel] a1: GLM 主条目缺席/解密失败 — proxy spawn skipped (fail-safe 现状维持)');
      return;
    }
    const launch = resolveProxyLaunch();
    if (!launch) {
      console.log('[trimodel] a1: proxy-server 入口脚本缺席（dist/.ts 双态俱缺）— proxy spawn skipped (fail-safe 现状维持)');
      return;
    }
    // env 面零字段化读数（计数形·D-46：键名面零值面·判据④）
    console.log(`[trimodel] a1: spawning 3334 proxy with GLM env (keys=${plan.keyCount}, values never logged)`);
    const child = spawn(process.execPath, [...launch.execArgs, launch.script], {
      env: plan.childEnv,
      stdio: 'inherit',
      detached: false,
    });
    child.on('exit', (code) => {
      console.log(`[trimodel] a1: 3334 proxy child exited (code=${code ?? 'signal'}) — startup 序重 spawn 自愈（包含式耦合注）`);
    });
  } catch (err) {
    console.error('[trimodel] a1: proxy spawn failed —', err instanceof Error ? err.message : String(err), '（fail-safe 现状维持·零明文面）');
  }
}
