// ── Card face registry + face pull ledger + face-events audit (LG-058 P0) ──
// 泛化层纯新增件（revert 单 commit 语义）：现役 trimmc-card 路径零触碰。
//
// face registry（方案 v3 §2.1）：静态声明式四值常量，无动态注册协议——
// daemon 侧「注册」=拉取时呈 face_id+凭据，server 校验在册+凭据绑定→记拉取台账。
//
// face pull ledger（§2.1）：每 face 记 {last_pull_at,last_pull_from,
// last_pull_result,applied_state}，落 TRIMODEL_DATA_DIR/face-ledger.json
// （读盘零重启语义同族——每次读文件，无常驻缓存）。
//
// face-events 审计账（§十 P0②）：单一 jsonl，事件型四族 pull/write/apply/
// status；len-only 纪律——审计不落键值内容（敏感面零明文），detail/attrs
// 值面只允许枚举/长度/计数/文件名。
//
// 归因码（§3.3）：pull_denied / decrypt_failed / apply_rejected。
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, basename, dirname } from 'path';

export interface CardFaceInfo {
  face_id: string;
  display: string;
  card_file: string;
  plane: 'service' | 'local';
  domain: 'M' | 'R';
}

/** 静态 face registry（MVP 声明式；mmc 卡文件=现役 trimmc-card.json 原位
 * 零迁移——别名保留条款的文件面延伸；其余 face 按模板 <face>-card.json）。 */
export const FACES: Readonly<Record<'mmc' | 'mlc' | 'rmc' | 'rlc', CardFaceInfo>> = {
  mmc: { face_id: 'mmc', display: 'TriMMC（M·服务域·sg 8710）', card_file: 'trimmc-card.json', plane: 'service', domain: 'M' },
  mlc: { face_id: 'mlc', display: 'TriMLC（M·本地域·本机 8713）', card_file: 'trimlc-card.json', plane: 'local', domain: 'M' },
  rmc: { face_id: 'rmc', display: 'TriRMC（R·服务域·河源）', card_file: 'trirmc-card.json', plane: 'service', domain: 'R' },
  rlc: { face_id: 'rlc', display: 'TriRLC（R·本地域·本机 8711 寄居过渡）', card_file: 'trirlc-card.json', plane: 'local', domain: 'R' },
} as const;

export type FaceId = keyof typeof FACES;
export const FACE_IDS: readonly FaceId[] = ['mmc', 'mlc', 'rmc', 'rlc'];

export function isRegisteredFace(face: string): face is FaceId {
  return (FACE_IDS as readonly string[]).includes(face);
}

/** 归因码枚举（§3.3 fail-closed 失败语义；STE seam④ 常量导出）。 */
export const ATTRIBUTION_CODES = ['pull_denied', 'decrypt_failed', 'apply_rejected'] as const;
export type AttributionCode = (typeof ATTRIBUTION_CODES)[number];

// ── 数据域（TRIMODEL_DATA_DIR；STE seam①：可钉 tmp）──

export function dataDir(): string {
  const env = process.env.TRIMODEL_DATA_DIR?.trim();
  return resolve(env || process.cwd());
}

/** face 卡目录钉位（LG-058 seam：生产未设=cwd 原语义；测试钉 tmp 防活卡污染——
 * T7 活体生产面零接触）。 */
export const CARDS_DIR_ENV = 'TRIMODEL_CARDS_DIR';

/** face 卡文件规范路径（TRIMODEL_CARDS_DIR ?? cwd 基座；沙箱测试钉 env——
 * 同 TRIMODEL_CARD_FILE 只钉 mmc 单文件的既有语义泛化到 face 族）。 */
export function faceCardPath(face: FaceId): string {
  const dir = process.env[CARDS_DIR_ENV]?.trim() || process.cwd();
  return resolve(dir, FACES[face].card_file);
}

/** face 卡模板目录（LG-058 N2：卡面模板切换的模板实体落点）——
 * `<cardsDir>/templates/<face>/*.json`，模板=完整卡文档快照（预设组合）。
 * 目录未建=该 face 暂无模板（清单端点空列表常态，非错误）。 */
export function cardTemplatesDir(face: FaceId): string {
  return resolve(process.env[CARDS_DIR_ENV]?.trim() || process.cwd(), 'templates', face);
}

/** 卡文件路径 → face 反推（face-events 审计行 face 字段来源；
 * 沙箱自定义文件名→basename 兜底，len-only 安全）。 */
export function faceFromPath(cardPath: string): string {
  const base = basename(cardPath);
  for (const face of FACE_IDS) {
    if (FACES[face].card_file === base) return face;
  }
  return base;
}

// ── face pull ledger（§2.1）──

export interface FaceLedgerEntry {
  last_pull_at: string | null;
  last_pull_from: 'loopback' | 'remote' | null;
  last_pull_result: 'ok' | 'denied' | 'failed' | null;
  applied_state: 'pending' | 'applied' | 'failed' | null;
  // LG-058 N1：当前配置层级（应用方 status 回写携带）——语义对表消费端降级梯：
  // 1=卡面拉取 / 2=本地缓存（含 stale 宽限）/ 3=出厂默认；null=未回写或回写时层级未决。
  applied_tier: 1 | 2 | 3 | null;
}

export interface FaceLedger {
  faces: Partial<Record<FaceId, FaceLedgerEntry>>;
}

export function faceLedgerPath(): string {
  return resolve(dataDir(), 'face-ledger.json');
}

export function readFaceLedger(): FaceLedger {
  const p = faceLedgerPath();
  if (!existsSync(p)) return { faces: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as FaceLedger;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.faces !== 'object') return { faces: {} };
    return parsed;
  } catch {
    return { faces: {} };
  }
}

/** 读盘零重启：每次更新=读-合并-原子写（tmp+rename 同族）。 */
export function updateFaceLedger(face: FaceId, patch: Partial<FaceLedgerEntry>): FaceLedgerEntry {
  const ledger = readFaceLedger();
  const base: FaceLedgerEntry = ledger.faces[face] ?? { last_pull_at: null, last_pull_from: null, last_pull_result: null, applied_state: null, applied_tier: null };
  const merged: FaceLedgerEntry = { ...base, ...patch };
  ledger.faces[face] = merged;
  const p = faceLedgerPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
  renameSync(tmp, p);
  return merged;
}

// ── face-events 审计账（单一 jsonl；len-only）──

export type FaceEventType = 'pull' | 'write' | 'apply' | 'status';

export interface FaceEvent {
  ts: string;
  face: string;
  etype: FaceEventType;
  result: 'ok' | 'denied' | 'failed';
  detail: string;
  // CTO 裁 1(甲)（de6d49f8）：reason 放宽为自由说明域——pull 域语义值仍是
  // 三归因码枚举（AttributionCode/ATTRIBUTION_CODES 单源承载）；写面审计
  // （status/apply 非 200）新增 'admin_auth' / `http_<code>` 值。`(string & {})`
  // 保枚举成员 IDE 提示不塌缩为 string。len-only 纪律不变。
  reason?: AttributionCode | (string & {});
}

export function faceEventsPath(): string {
  return resolve(dataDir(), 'face-events.jsonl');
}

/** append 一行 JSON（jsonl）；len-only 由调用方契约保证——本函数只做
 * 结构封装，detail/attrs 值面敏感内容（键值/token/明文）禁入（§十 P0②）。 */
export function appendFaceEvent(evt: Omit<FaceEvent, 'ts'>): void {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...evt })}\n`;
  const p = faceEventsPath();
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, line, 'utf-8');
}
