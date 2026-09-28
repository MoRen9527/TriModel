// ── Card write guard: backup-first + rotation + idempotent short-circuit (LG-058 P0①) ──
// 泛化层纯新增件。机制=claude-fallback 写面五门① 同款泛化（§十 P0① 裁定）：
// 写前 copy＋唯一后缀＋keep=5 轮换＋FROZEN-BACKUPS 哨兵豁免＋幂等短路。
//
// 挂载点=saveCard 引擎层前置（trimmc-card.ts +2 行纯增量 import+调用）——
// 备份保护全部卡写路径（别名端点与泛化端点同享，方案「卡写备份」语义本体；
// 幂等短路对 apply 无变化重放场景有真实价值）。实现裁定随交付卷呈门审。
//
// 备份名唯一性后缀 bak-<ts>-<pid>-<seq>：LG-054 族③ io-kernel 同毫秒覆盖
// 教训直引——同毫秒双写零覆盖为本件硬保证（seq 模块级单调递增）。
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { rotateBackups } from '@trimetaverse/tricode/trimodel-cli';
import { appendFaceEvent, faceFromPath } from './card-faces.js';

export const BACKUP_SUFFIX_SEQ_MAX = Number.MAX_SAFE_INTEGER;

let backupSeq = 0;

function backupStamp(): string {
  // UTC 压缩形态（文件名安全；Z 后缀消歧时区）
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  backupSeq += 1;
  return `${ts}-${process.pid}-${backupSeq}`;
}

export interface PreSaveGuardResult {
  skipped: boolean;
  backup_file: string | null;
  rotated: boolean;
  removed: number;
}

/**
 * saveCard 前置守卫：
 * 1. 幂等短路——现文件与将写序列化逐字节相等→跳过（不写不备份不轮换）；
 * 2. 备份先行——现文件 copy 至 `<target>.bak-<ts>-<pid>-<seq>`（唯一后缀）；
 *    备份失败=拒写（throw，数据安全优先，五门①同语义）；
 * 3. 轮换 keep=5——core rotateBackups（`*.bak-` 前缀族；哨兵豁免内建）；
 * 4. write 审计行（face-events；len-only）。
 * 无现文件（首存）→无备份直接放行。
 */
export function preSaveCardGuard(doc: unknown, target: string): PreSaveGuardResult {
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  if (existsSync(target)) {
    let currentRaw = '';
    try {
      currentRaw = readFileSync(target, 'utf-8');
    } catch (err) {
      throw new Error(`卡写前置守卫：现卡不可读，拒写以免覆盖（${err instanceof Error ? err.message : String(err)}）`);
    }
    // 幂等短路（无变化不写不备份）
    if (currentRaw === serialized) {
      return { skipped: true, backup_file: null, rotated: false, removed: 0 };
    }
    // 备份先行（唯一性后缀）
    const backupFile = `${target}.bak-${backupStamp()}`;
    try {
      copyFileSync(target, backupFile);
    } catch (err) {
      throw new Error(`卡写前置守卫：备份失败，拒写（${err instanceof Error ? err.message : String(err)}）`);
    }
    // 轮换近 5 份（FROZEN-BACKUPS 哨兵豁免在 core 内建）
    let rotated = false;
    let removed = 0;
    try {
      const r = rotateBackups(target);
      rotated = r.rotated;
      removed = r.removed;
    } catch {
      // 轮换失败不阻塞主写（备份已落，只多不删）
    }
    appendFaceEvent({
      face: faceFromPath(target),
      etype: 'write',
      result: 'ok',
      detail: `card write guarded (backup=${backupFile.split(/[\\/]/).pop()}, rotated=${rotated}, removed=${removed})`,
    });
    return { skipped: false, backup_file: backupFile, rotated, removed };
  }
  // 首存：无备份，仍记 write 事件（新卡面可见性）
  appendFaceEvent({
    face: faceFromPath(target),
    etype: 'write',
    result: 'ok',
    detail: 'card first-write (no prior file, no backup)',
  });
  return { skipped: false, backup_file: null, rotated: false, removed: 0 };
}
