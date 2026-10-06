// ── TriModel API: TriMMC card endpoints (LG-035 TriMMC 栏 T1) ──
// GET  /v1/config/trimmc-card          — card with api_key DECRYPTED in this
//                                        response only (UI never consumes it;
//                                        UI consumes masked/status surfaces)
// PUT  /v1/config/trimmc-card          — save ⇒ status resets to 'pending'
// PUT  /v1/config/trimmc-card/status   — COS write-back: applied|failed + at
//
// Admin plane: fail-closed 503 (TRIMODEL_ADMIN_TOKEN unset) / 401 (wrong
// Bearer) / 200 — same family as the P2 secure key plane.
import { loadCard, saveCard, emptyCard, validateCard, CARD_STATES, buildEntry, entryReferenceGuards, modelSetReferenceGuard, ruleReferenceGuard } from '../trimmc-card.js';
import type { TrimmcCardDocument, CardState, CardEntry } from '../trimmc-card.js';
import { decrypt } from '../security/key-encryptor.js';
import { savePolicyForMachine, validatePolicyShape } from '../policy.js';
import type { PolicyShape } from '../policy.js';
import { maskKey } from '../secure-keys.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireAdmin(authHeader: string | undefined): { statusCode: 503 | 401; body: Record<string, unknown> } | null {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: 'trimmc card plane disabled: TRIMODEL_ADMIN_TOKEN not configured (fail-closed)' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: 'Unauthorized: invalid or missing admin token' } };
  }
  return null;
}

export function handleGetTrimmcCard(
  authHeader: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  const doc = loadCard(opts?.cardPath);
  if (!doc) {
    const blank = emptyCard();
    return { statusCode: 200, body: { object: 'config.trimmc-card', card: blank, card_file_present: false, entries_decrypted: {}, entries_masked: {} } };
  }
  // api_key decrypted HERE only (UI never consumes it); masked view is the
  // UI-facing surface (tail-4 like the P2 secure-key status plane).
  const entries_decrypted: Record<string, { provider: string; model: string; api_key: string; enabled: boolean; updated_at: string }> = {};
  const entries_masked: Record<string, { provider: string; model: string; masked: string; enabled: boolean; updated_at: string }> = {};
  for (const [id, entry] of Object.entries(doc.provider_entries)) {
    let apiKey = '';
    try {
      apiKey = decrypt(Buffer.from(entry.api_key_encrypted, 'base64'));
    } catch (err) {
      console.warn(`[trimodel] trimmc-card entry '${id}' undecryptable:`, err instanceof Error ? err.message : err);
    }
    const base = { provider: entry.provider, model: entry.model, enabled: entry.enabled, updated_at: entry.updated_at, ...(entry.base_url ? { base_url: entry.base_url } : {}) };
    entries_decrypted[id] = { ...base, api_key: apiKey };
    entries_masked[id] = { ...base, masked: maskKey(apiKey) };
  }
  return { statusCode: 200, body: { object: 'config.trimmc-card', card: doc, card_file_present: true, entries_decrypted, entries_masked } };
}

export function handlePutTrimmcCard(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  if (rawBody === undefined || rawBody.trim() === '') {
    return { statusCode: 400, body: { error: 'request body required (JSON card document)' } };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const card = doc as TrimmcCardDocument;
  // D7 合并语义：PUT provider_entries = 脏条目 upsert（非整卡回写）——
  // 前端只发用户新增/编辑的条目，既有密文条目不回传不覆盖。
  // 形态三态：对象+明文 api_key → 服务端加密水合；对象+api_key_encrypted →
  // 原样保留（密文搬运）；字符串/数组等退化形态 → 400 人话拒不落盘。

  // 退化形态前置拒（水合/校验前即断，防任何路径落盘）。
  // LG-058 P1 候修①（范围6①，2026-09-29）：provider_entries 缺席/null/原始值
  // 原漏过本守卫 → 合并段 Object.entries(undefined) 抛错=500（字符串形态更会
  // 以字符索引静默污染合并）——统一 400 人话拒（CTO 候修裁：500→400）。
  const providedRaw = (card as { provider_entries?: unknown }).provider_entries;
  if (providedRaw === undefined || providedRaw === null || typeof providedRaw !== 'object' || Array.isArray(providedRaw)) {
    return { statusCode: 400, body: { error: '条目数据格式错误，请重新添加条目' } };
  }
  if (typeof providedRaw === 'object' && providedRaw !== null) {
    for (const [id, entry] of Object.entries(providedRaw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) {
        return { statusCode: 400, body: { error: `条目数据格式错误（${id}），请重新添加条目` } };
      }
    }
  }

  // Hydrate BEFORE validation: UI supplies `api_key` (masked display makes it
  // impossible to paste back — F1-P2 family); the server encrypts here so
  // at-rest storage is ciphertext only.
  if (typeof card.provider_entries === 'object' && card.provider_entries !== null) {
    for (const [id, entry] of Object.entries(card.provider_entries)) {
      const plain = (entry as CardEntry & { api_key?: unknown }).api_key;
      if (typeof plain === 'string' && plain && !plain.includes('*')) {
        card.provider_entries[id] = buildEntry(entry.provider, entry.model, plain, entry.enabled, (entry as CardEntry & { base_url?: string }).base_url);
      }
    }
  }

  // 合并基底：既有卡（provider_entries 保留未被本次 PUT 提及的条目）
  const existing = loadCard(opts?.cardPath);
  const base = existing ?? emptyCard('');
  // D15② 跨 id 幂等去重：同条目名+同厂商+同模型的既有条目，若本次 PUT 又以
  // 新 id 提交同内容 → 视为同一逻辑条目，保留 PUT 侧（updated_at 更新），旧 id
  // 沉默淘汰（零挫败；updated_at 由水合/直传分支刷新）。
  for (const [newId, entry] of Object.entries(card.provider_entries)) {
    const dupIds = Object.entries(base.provider_entries)
      .filter(([oldId, old]) => oldId !== newId && old.provider === entry.provider && old.model === entry.model)
      .map(([oldId]) => oldId);
    for (const oldId of dupIds) delete base.provider_entries[oldId];
  }
  const merged: TrimmcCardDocument = {
    ...base,
    machine: card.machine?.name ? card.machine : base.machine,
    connection: card.connection?.name ? card.connection : base.connection,
    provider_entries: { ...base.provider_entries, ...card.provider_entries },
    // v4 三实体字典合并（UI 编辑的实体 upsert 到基座；终稿 §七.2）
    model_sets: { ...base.model_sets, ...(isRecord(card.model_sets) ? card.model_sets : {}) },
    rules: { ...base.rules, ...(isRecord(card.rules) ? card.rules : {}) },
    strategies: { ...base.strategies, ...(isRecord(card.strategies) ? card.strategies : {}) },
    active_strategy_id: 'active_strategy_id' in card ? card.active_strategy_id ?? null : base.active_strategy_id ?? null,
    // N5 方案三：本地配置直改面——占位基座值，PUT 携带时经下方校验段整表替换
    // （须能 400 早退，故校验后置于 merged 构造，与 deleted_* 通道同形）。
    local_config: base.local_config ?? null,
    // 派生缓存：apply 时自活动策略 default 规则同步（无编辑面；PUT 不接受直改——
    // 传入值与基座一致时透传，否则以基座为准防第二真源）。
    default_model: base.default_model ?? null,
    status: { state: 'pending', at: new Date().toISOString() },
    reserved: { quota_switch: null, instances_group: null, env_tag: null },
  };
  // N5 方案三：本地配置直改面（改→存链的「存」；整表替换+服务端版本单调）。
  // PUT 未携带=维持基座；显式 null=清空；携带对象=items 全量替换、version+1。
  // 密钥禁入（hint「各域密钥走域卡条目域内自管」——方稿 2.4 同族）；值面禁超长。
  if ('local_config' in card) {
    if (card.local_config === null) {
      merged.local_config = null;
    } else if (isRecord(card.local_config) && isRecord((card.local_config as { items?: unknown }).items)) {
      const rawItems = (card.local_config as { items: Record<string, unknown> }).items;
      const keys = Object.keys(rawItems);
      if (keys.length > 50) {
        return { statusCode: 400, body: { error: '本地配置项过多（上限 50 项），请精简后再保存' } };
      }
      const items: Record<string, string> = {};
      for (const k of keys) {
        if (!k || k.length > 64) {
          return { statusCode: 400, body: { error: `本地配置项名不合法（${k || '（空）'}）：1-64 字符`, } };
        }
        if (/(^|_)(api[_-]?keys?|tokens?|secrets?|passwo?rds?|passwd|private[_-]?keys?|credentials?)($|_)/i.test(k)) {
          return { statusCode: 400, body: { error: `本地配置项「${k}」疑似密钥——密钥禁入本地配置表，各域密钥走域卡条目域内自管` } };
        }
        const v = rawItems[k];
        if (typeof v !== 'string') {
          return { statusCode: 400, body: { error: `本地配置项「${k}」的值须为字符串` } };
        }
        if (v.length > 2000) {
          return { statusCode: 400, body: { error: `本地配置项「${k}」的值过长（上限 2000 字符）` } };
        }
        items[k] = v;
      }
      merged.local_config = {
        version: (base.local_config?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
        items,
      };
    } else {
      return { statusCode: 400, body: { error: '本地配置格式错误：local_config 须为 null 或含 items 字符串键值表的对象' } };
    }
  }
  // v4 删除通道：三通道显式移除（守卫前置——被引用禁删人话拒）。
  if (Array.isArray(card.deleted_model_set_ids)) {
    for (const id of card.deleted_model_set_ids) {
      if (typeof id !== 'string') continue;
      const guard = modelSetReferenceGuard(merged, id);
      if (guard) return { statusCode: 400, body: { error: guard } };
      delete merged.model_sets[id];
    }
    merged.deleted_model_set_ids = card.deleted_model_set_ids.filter((id): id is string => typeof id === 'string');
  }
  if (Array.isArray(card.deleted_rule_ids)) {
    for (const id of card.deleted_rule_ids) {
      if (typeof id !== 'string') continue;
      const guard = ruleReferenceGuard(merged, id);
      if (guard) return { statusCode: 400, body: { error: guard } };
      delete merged.rules[id];
    }
    merged.deleted_rule_ids = card.deleted_rule_ids.filter((id): id is string => typeof id === 'string');
  }
  if (Array.isArray(card.deleted_strategy_ids)) {
    for (const id of card.deleted_strategy_ids) {
      if (typeof id !== 'string') continue;
      if (merged.active_strategy_id === id) {
        return { statusCode: 400, body: { error: '活动策略使用中，请先切换' } };
      }
      delete merged.strategies[id];
    }
    merged.deleted_strategy_ids = card.deleted_strategy_ids.filter((id): id is string => typeof id === 'string');
  }
  // D7 删除通道：deleted_entry_ids 显式移除（守卫=被集或被规则引用均禁删）
  if (Array.isArray(card.deleted_entry_ids)) {
    for (const id of card.deleted_entry_ids) {
      if (typeof id !== 'string') continue;
      const guard = entryReferenceGuards(merged, id);
      if (guard) return { statusCode: 400, body: { error: guard } };
      delete merged.provider_entries[id];
    }
    merged.deleted_entry_ids = card.deleted_entry_ids.filter((id): id is string => typeof id === 'string');
  }
  // D9 校验序重构：validate 对合并后终态（镜像引用经合并解析；真悬挂——
  // 既不在传入也不在既有——仍 400 人话）。原「对传入文档孤立校验」错层
  // 即 f2 谜题第二半：引用既有条目的规则被误判悬挂。
  const validationError = validateCard(merged);
  if (validationError) {
    return { statusCode: 400, body: { error: `trimmc card validation failed: ${validationError}` } };
  }
  try {
    saveCard(merged, opts?.cardPath);
  } catch (err) {
    return { statusCode: 500, body: { error: `failed to persist trimmc-card.json: ${err instanceof Error ? err.message : String(err)}` } };
  }
  return { statusCode: 200, body: { ok: true, status: merged.status, entries: Object.keys(merged.provider_entries), rules: merged.rules } };
}

export function handlePutTrimmcCardStatus(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts?: { cardPath?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  let doc: { state?: unknown; error?: unknown; tier?: unknown; local_config?: unknown } = {};
  try {
    doc = rawBody ? (JSON.parse(rawBody) as { state?: unknown; error?: unknown; tier?: unknown; local_config?: unknown }) : {};
  } catch (err) {
    return { statusCode: 400, body: { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const state = doc.state;
  if (state !== 'applied' && state !== 'failed') {
    return { statusCode: 400, body: { error: `state must be 'applied' | 'failed' (pending is set by save only); valid: ${CARD_STATES.join(', ')}` } };
  }
  // LG-058 N1：当前配置层级（应用方降级梯 tier1 卡面拉取 / tier2 本地缓存 / tier3 出厂默认）。
  // 可选字段——缺省/null=回写时层级未决；提供时必须 ∈ {1,2,3}。
  const tier = doc.tier;
  if (tier !== undefined && tier !== null && tier !== 1 && tier !== 2 && tier !== 3) {
    return { statusCode: 400, body: { error: `tier must be 1 | 2 | 3 (or omit when undecided); got ${JSON.stringify(tier)}` } };
  }
  // N5 方案三：daemon 本地配置落地回写（拉→落→效链的「落」读数；可选——
  // 缺省=该 daemon 未实现落地链或本域无变更，台账保持现值）。
  let lcReport: { version_applied: number; applied_at: string; write_result: 'ok' | 'failed'; write_error?: string; file?: string } | undefined;
  if (doc.local_config !== undefined && doc.local_config !== null) {
    const lc = doc.local_config as Record<string, unknown>;
    const va = lc.version_applied;
    const wr = lc.write_result;
    if (typeof va !== 'number' || !Number.isInteger(va) || va < 1) {
      return { statusCode: 400, body: { error: `local_config.version_applied must be a positive integer; got ${JSON.stringify(va)}` } };
    }
    if (wr !== 'ok' && wr !== 'failed') {
      return { statusCode: 400, body: { error: `local_config.write_result must be 'ok' | 'failed'; got ${JSON.stringify(wr)}` } };
    }
    lcReport = { version_applied: va, applied_at: new Date().toISOString(), write_result: wr };
    if (typeof lc.write_error === 'string' && lc.write_error) lcReport.write_error = lc.write_error.slice(0, 500);
    if (typeof lc.file === 'string' && lc.file) lcReport.file = lc.file.slice(0, 512);
  }

  const card = loadCard(opts?.cardPath);
  if (!card) {
    return { statusCode: 404, body: { error: 'no trimmc-card.json on disk — save the card first' } };
  }
  const status: { state: CardState; at: string; error?: string; tier?: 1 | 2 | 3; local_config?: typeof lcReport } = { state, at: new Date().toISOString() };
  if (typeof doc.error === 'string' && doc.error) status.error = doc.error;
  if (tier === 1 || tier === 2 || tier === 3) status.tier = tier;
  if (lcReport) status.local_config = lcReport;
  card.status = status;
  saveCard(card, opts?.cardPath);
  return { statusCode: 200, body: { ok: true, status } };
}

/**
 * LG-035 本地侧（2026-09-14）：「应用到本机」——把活动策略落本机生效面。
 * v4（schema 终稿 §三）：活动策略 rule_ids → 解析规则实体 → 分型分流——
 * time → window schedule（id=strategy:<pid>:<rid>，priority 归一 100）；
 * default → card.default_model 派生缓存同步（三层计算序中间层零改动）；
 * quota → 不进 schedules（异常路径层，钩子位另接）。
 * 应用硬门：活动策略须含 ≥1 条 time 或 default 规则（纯 quota 策略不可应用）。
 */
export function handleApplyStrategy(
  authHeader: string | undefined,
  opts?: { cardPath?: string; machine?: string },
): { statusCode: number; body: Record<string, unknown> } {
  const authError = requireAdmin(authHeader);
  if (authError) return authError;

  const card = loadCard(opts?.cardPath);
  if (!card) {
    return { statusCode: 404, body: { error: '暂无卡片配置：请先在“活动策略”区新增策略并保存卡片' } };
  }
  const activeId = card.active_strategy_id;
  if (!activeId) {
    return { statusCode: 400, body: { error: '未选择活动策略：请先在“策略”下拉中选择并切换至某个策略' } };
  }
  const strategy = card.strategies[activeId];
  if (!strategy) {
    return { statusCode: 400, body: { error: '活动策略不存在：请重新选择策略' } };
  }

  const schedules: PolicyShape['schedules'] = [];
  let defaultModel: string | null = null;
  let quotaCount = 0;
  for (const rid of strategy.rule_ids) {
    const rule = card.rules[rid];
    if (!rule) {
      return { statusCode: 400, body: { error: `活动策略引用的规则不存在（${rid}）：请先修正策略规则引用` } };
    }
    if (rule.type === 'time' && rule.windows && rule.windows.length > 0) {
      // 窗级 entry_id（BOD 22:2x 修正令）：一条规则多窗各带条目——每窗一个
      // schedule（model 取窗级条目；id 带窗序稳定）。
      for (const [wi, w] of rule.windows.entries()) {
        const entry = card.provider_entries[w.entry_id];
        if (!entry) return { statusCode: 400, body: { error: `规则「${rule.name}」第 ${wi + 1} 窗引用的条目不存在：请先修正规则` } };
        schedules.push({
          id: `strategy:${activeId}:${rid}:${wi}`,
          target: 'daemon-default',
          model: entry.model,
          windows: [{ start: w.start, end: w.end }],
          timezone: 'Asia/Shanghai',
          enabled: rule.enabled,
          priority: 100,
          type: 'window',
        });
      }
    } else if (rule.type === 'default' && rule.entry_id) {
      const entry = card.provider_entries[rule.entry_id];
      if (!entry) return { statusCode: 400, body: { error: `规则「${rule.name}」引用的条目不存在：请先修正规则` } };
      defaultModel = entry.model;
    } else if (rule.type === 'quota') {
      quotaCount++;
    }
  }
  // 应用硬门：≥1 条 time 或 default（防「应用了个寂寞」；纯 quota 不可应用）
  if (schedules.length === 0 && !defaultModel) {
    return { statusCode: 400, body: { error: '该策略暂无可应用的规则：请先添加至少一条时段规则或默认规则' } };
  }

  const doc = { version: '1', schedules };
  const shapeError = validatePolicyShape(doc);
  if (shapeError) {
    return { statusCode: 400, body: { error: `策略规则不合法：${shapeError}` } };
  }

  try {
    savePolicyForMachine(opts?.machine ?? 'local', doc);
  } catch (err) {
    return { statusCode: 500, body: { error: `策略落盘失败：${err instanceof Error ? err.message : String(err)}` } };
  }

  // default 实体 → card.default_model 派生缓存同步（三层计算序中间层零改动）
  card.default_model = defaultModel;
  try {
    saveCard(card, opts?.cardPath);
  } catch (err) {
    return { statusCode: 500, body: { error: `策略已生效但卡片默认模型落盘失败：${err instanceof Error ? err.message : String(err)}` } };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      applied: {
        strategy_id: activeId,
        strategy_name: strategy.name,
        schedules: schedules.length,
        default_model: defaultModel,
        quota_rules: quotaCount,
        machine: opts?.machine ?? 'local',
      },
      message: `已应用到本机：${strategy.name}（${schedules.length} 条时段规则${defaultModel ? `，默认模型 ${defaultModel}` : ''}${quotaCount ? `，${quotaCount} 条额度规则待信号` : ''}）`,
    },
  };
}
