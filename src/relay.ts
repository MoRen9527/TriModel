// ── LG-006 额度接力：错误分类 / 换棒台账（token_stats）/ 冷却窗 ──
// 双席合流稿 f312a695（BOD 终裁四项全批；CTO 派工令 2026-09-05）实施面。
// 设计边界：本模块=TriModel client 层接力配套；TriStaciss provider 池=服务层，
// 两层不混（稿 §四）。

/** 换棒原因分类（错误分类表，稿 §二.2）。 */
export type RelayReason =
  | 'auth_failed'        // 401/403 凭据失效
  | 'rate_limited'       // 429 限流
  | 'upstream_error'     // 5xx 上游故障
  | 'quota_exhausted'    // 额度尽（402 / insufficient 码族）
  | 'network_timeout';   // 网络超时（重试 1 次后换棒）

/** 换棒台账事件（稿 §二.3：from→to+reason+ts）。 */
export interface RelayEvent {
  from_model: string;
  from_account: string;
  to_model: string;
  to_account: string;
  reason: RelayReason;
  ts: number;
}

/** 单条目换棒分类结果。 */
export interface ClassifyResult {
  relay: boolean;       // 是否换棒
  retry_first: boolean; // 网络超时先重试 1 次
  reason: RelayReason | null;
}

/**
 * 错误分类表→换棒判据（稿 §二.2）。
 * - 401/403 凭据失效、429 限流、5xx 上游故障、额度尽码族 → 直接换棒；
 * - 网络层超时/连接断 → retry_first=true（重试 1 次后仍败换棒）；
 * - 400 请求坏/其他客户端错 → 不换（换棒无意义，显式抛）；
 * - 正常响应永不换棒（调用侧语义：本函数只见异常）。
 */
export function classifyRelayError(error: unknown): ClassifyResult {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const statusMatch = /(?:status|code)[:=\s]*(\d{3})/i.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 401 || status === 403) return { relay: true, retry_first: false, reason: 'auth_failed' };
  if (status === 429) return { relay: true, retry_first: false, reason: 'rate_limited' };
  if (status !== null && status >= 500) return { relay: true, retry_first: false, reason: 'upstream_error' };
  if (status === 402 || /insufficient|quota|额度尽/i.test(message)) {
    return { relay: true, retry_first: false, reason: 'quota_exhausted' };
  }
  if (
    /timeout|timed?\s*out|econnreset|econnrefused|enotfound|fetch failed|network/i.test(message)
  ) {
    return { relay: true, retry_first: true, reason: 'network_timeout' };
  }
  return { relay: false, retry_first: false, reason: null };
}

// ── 换棒台账（token_stats 面，候裁点③落法=独立模块）────────────────────────

const tokenStats: RelayEvent[] = [];
const MAX_LEDGER_SIZE = 500; // 内存台账封顶（防长驻进程无界增长），FIFO 淘汰

/** 记录一次换棒事件（台账 + 显式日志行，稿 §二.3 防静默降级假成功）。 */
export function recordRelayEvent(ev: RelayEvent): void {
  tokenStats.push(ev);
  if (tokenStats.length > MAX_LEDGER_SIZE) tokenStats.shift();
  console.warn(
    `[trimodel-relay] ${new Date(ev.ts).toISOString()} ${ev.from_model}@${ev.from_account} → ` +
    `${ev.to_model}@${ev.to_account} reason=${ev.reason}`,
  );
}

/** 台账只读视图（消费方可查询；返回副本防外改）。 */
export function getTokenStats(): RelayEvent[] {
  return [...tokenStats];
}

// ── 冷却窗（验收判据 5：换棒后冷却期内不回切原棒）──────────────────────────

const RELAY_COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<string, number>(); // `${model}@${account}` → ts

function cooldownKey(model: string, account: string): string {
  return `${model}@${account}`;
}

/** 换棒发生时：给离棒节点记冷却（冷却期内新请求跳过该节点防回切抖动）。 */
export function markCooldown(model: string, account: string, now = Date.now()): void {
  cooldownUntil.set(cooldownKey(model, account), now + RELAY_COOLDOWN_MS);
}

/** 节点是否处于冷却期（冷却期内不回切）。 */
export function isCoolingDown(model: string, account: string, now = Date.now()): boolean {
  const until = cooldownUntil.get(cooldownKey(model, account));
  if (until === undefined) return false;
  if (now >= until) {
    cooldownUntil.delete(cooldownKey(model, account));
    return false;
  }
  return true;
}

/** 测试辅助：清空台账与冷却表。 */
export function resetRelayState(): void {
  tokenStats.length = 0;
  cooldownUntil.clear();
}
