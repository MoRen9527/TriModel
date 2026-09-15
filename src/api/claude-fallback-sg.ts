// ── TriModel API: Claude 直连兜底·sg 通道（LG-036，CTO 方案 c6a6e512）──
//
// GET  /v1/config/claude-fallback/sg/status    — 本地无鉴权（同 v1 GET 先例）：
//         ssh 转发 sg `GET /v1/config/claude-fallback`，映射 channel 三态
//         （ok | unreachable | version_unsupported）+人话 label；请求头
//         X-SG-Admin-Token 时转发为 Authorization（尾 4 位 admin-gated 继承 v1）。
// POST /v1/config/claude-fallback/sg/restore   — 本地 fail-closed（同 v1）：
//         body { base_url, api_key, model, sg_admin_token } → 本地前置校验 →
//         ssh 转发 sg restore 端点（写入在 sg 侧由 sg TriModel 落盘）。
//
// 凭据全链（R1-R5 零落盘五规则，方案 §三）：浏览器内存 → 本进程内存 →
// ssh stdin（curl -K 配置格式）——**argv 零密钥零载荷**（ssh 远端命令串为静态
// 常量 `curl -s -m 10 -K -`）；本机文件面零写；响应不回显密钥。
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

export const SG_SSH_HOST_ENV = 'TRIMODEL_SG_SSH_HOST';
export const SG_ENDPOINT_ENV = 'TRIMODEL_SG_TRI_ENDPOINT';

/** ssh 远端命令串=静态常量（argv 零载荷、零令牌——R3）。 */
export const SSH_REMOTE_COMMAND = ['curl', '-s', '-m', '10', '-K', '-'] as const;
export const SSH_BASE_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] as const;

function sshHost(): string {
  return process.env[SG_SSH_HOST_ENV]?.trim() || 'sg-ecs-server';
}

/** sg 侧 TriModel 环回端点（ssh 到 sg 后 curl 打 sg 本机 3333）。 */
function sgEndpoint(): string {
  return (process.env[SG_ENDPOINT_ENV]?.trim() || 'http://127.0.0.1:3333').replace(/\/+$/, '');
}

/** Windows ssh.exe 完整路径兜底（PATH 缺失场景；方案 §八）。 */
export function resolveSshExe(): string {
  if (process.platform !== 'win32') return 'ssh';
  const winPath = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  return existsSync(winPath) ? winPath : 'ssh';
}

export interface SshCurlRequest {
  method: 'GET' | 'POST';
  /** sg 侧路径（如 /v1/config/claude-fallback）。 */
  path: string;
  /** 转发给 sg 端点的 Authorization（来源：本地 X-SG-Admin-Token / body.sg_admin_token）。 */
  bearerToken?: string;
  /** POST body（JSON 序列化后经 curl config 的 data 项送 stdin）。 */
  body?: unknown;
}

export type SshCurlOutcome =
  | { kind: 'done'; statusCode: number; body: unknown }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'bad_output'; detail: string };

export type SpawnFn = (cmd: string, args: string[], options?: SpawnOptions) => ReturnType<typeof nodeSpawn>;

/** curl config 值转义（双引号包裹；反斜杠与引号按 curl 规则转义）。 */
export function curlConfigQuote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * 构造 curl -K 配置文本（全载荷经此 stdin 通道；argv 零泄漏）。
 * write-out 状态码尾标记：`\n__HTTP__<code>`（stdout 末行解析）。
 */
export function buildCurlConfig(req: SshCurlRequest): string {
  const lines: string[] = [
    `url = ${curlConfigQuote(sgEndpoint() + req.path)}`,
    `request = ${curlConfigQuote(req.method)}`,
    `header = ${curlConfigQuote('content-type: application/json')}`,
  ];
  if (req.bearerToken) {
    lines.push(`header = ${curlConfigQuote(`Authorization: Bearer ${req.bearerToken}`)}`);
  }
  if (req.body !== undefined) {
    lines.push(`data = ${curlConfigQuote(JSON.stringify(req.body))}`);
  }
  lines.push('write-out = "\\n__HTTP__%{http_code}"');
  return lines.join('\n') + '\n';
}

/**
 * ssh + curl -K 执行（异步；错误→人话态映射）。
 * spawnFn 可注入（测试契约断言；默认 node child_process.spawn）。
 */
export function runSshCurl(req: SshCurlRequest, spawnFn: SpawnFn = nodeSpawn as SpawnFn): Promise<SshCurlOutcome> {
  return new Promise((resolveP) => {
    const args = [...SSH_BASE_OPTIONS, sshHost(), ...SSH_REMOTE_COMMAND];
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnFn(resolveSshExe(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolveP({ kind: 'unreachable', detail: `ssh 启动失败：${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: SshCurlOutcome) => {
      if (settled) return;
      settled = true;
      resolveP(outcome);
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (err) => finish({ kind: 'unreachable', detail: err.message }));
    child.on('close', (code) => {
      const marker = '\n__HTTP__';
      const idx = stdout.lastIndexOf(marker);
      if (code !== 0 || idx < 0) {
        finish({ kind: 'unreachable', detail: (stderr || `ssh 退出码 ${code}`).slice(0, 200) });
        return;
      }
      const statusCode = Number(stdout.slice(idx + marker.length).trim());
      const payload = stdout.slice(0, idx);
      let body: unknown;
      try {
        body = JSON.parse(payload);
      } catch {
        finish({ kind: 'bad_output', detail: payload.slice(0, 200) });
        return;
      }
      finish({ kind: 'done', statusCode, body });
    });
    child.stdin?.write(buildCurlConfig(req));
    child.stdin?.end();
  });
}

// ── channel 态映射（方案 §四 人话词表四态，零黑话）──

export const SG_CHANNEL_LABELS = {
  ok: 'sg 通道正常',
  unreachable: 'sg 通道不可达（请检查网络或联系运维）',
  version_unsupported: 'sg 侧版本过旧，请先更新 sg 侧 TriModel',
  token_rejected: 'sg 令牌不正确',
} as const;

export type SgChannelState = keyof typeof SG_CHANNEL_LABELS;

function channel(state: SgChannelState) {
  return { state, label: SG_CHANNEL_LABELS[state] };
}

function localAdminOk(authHeader: string | undefined): boolean {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  return Boolean(adminToken) && authHeader === `Bearer ${adminToken}`;
}

function localRequireAdmin(authHeader: string | undefined): { statusCode: 503 | 401; body: Record<string, unknown> } | null {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return { statusCode: 503, body: { error: '兜底写入未启用：请先在服务端配置管理令牌' } };
  }
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    return { statusCode: 401, body: { error: '令牌不正确或未填写，请检查连接设置' } };
  }
  return null;
}

/**
 * GET sg status（本地无鉴权；X-SG-Admin-Token → 转发 sg Authorization）。
 * sg 端点 404（旧版无兜底端点）→ version_unsupported；ssh/curl 失败 → unreachable。
 */
export async function handleGetClaudeFallbackSg(
  opts: { sgAdminHeader?: string; spawnFn?: SpawnFn } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const req: SshCurlRequest = { method: 'GET', path: '/v1/config/claude-fallback' };
  if (opts.sgAdminHeader) req.bearerToken = opts.sgAdminHeader;
  const out = await runSshCurl(req, opts.spawnFn);
  if (out.kind === 'unreachable') {
    return { statusCode: 200, body: { object: 'config.claude-fallback.sg', channel: channel('unreachable') } };
  }
  if (out.kind === 'bad_output') {
    return { statusCode: 200, body: { object: 'config.claude-fallback.sg', channel: channel('unreachable') } };
  }
  if (out.statusCode === 404) {
    return { statusCode: 200, body: { object: 'config.claude-fallback.sg', channel: channel('version_unsupported') } };
  }
  if (out.statusCode !== 200) {
    return { statusCode: 200, body: { object: 'config.claude-fallback.sg', channel: channel('unreachable') } };
  }
  const sgBody = (out.body ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {
    object: 'config.claude-fallback.sg',
    channel: channel('ok'),
    file_present: sgBody.file_present,
    readable: sgBody.readable,
    base_url: sgBody.base_url ?? null,
    model: sgBody.model ?? null,
  };
  if (sgBody.api_key_masked) body.api_key_masked = sgBody.api_key_masked;
  return { statusCode: 200, body };
}

/**
 * POST sg restore（本地 fail-closed 同 v1）→ 转发 sg restore 端点。
 * 写入在 sg 侧执行（本机零落盘）；sg 401 → 「sg 令牌不正确」；404 → 版本态。
 */
export async function handlePostClaudeFallbackSgRestore(
  authHeader: string | undefined,
  rawBody: string | undefined,
  opts: { spawnFn?: SpawnFn } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const authError = localRequireAdmin(authHeader);
  if (authError) return authError;

  let input: { base_url?: unknown; api_key?: unknown; model?: unknown; sg_admin_token?: unknown };
  try {
    input = rawBody ? (JSON.parse(rawBody) as typeof input) : {};
  } catch (err) {
    return { statusCode: 400, body: { error: `请求内容不是有效的 JSON：${err instanceof Error ? err.message : String(err)}` } };
  }
  const baseUrl = typeof input.base_url === 'string' ? input.base_url.trim() : '';
  const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const sgToken = typeof input.sg_admin_token === 'string' ? input.sg_admin_token.trim() : '';
  // 本地前置校验（人话早错；与 v1 同口径）
  if (!baseUrl) return { statusCode: 400, body: { error: '请填写服务地址' } };
  if (!/^https?:\/\/.+/i.test(baseUrl)) return { statusCode: 400, body: { error: '服务地址需以 http:// 或 https:// 开头' } };
  if (!apiKey) return { statusCode: 400, body: { error: '请填写 API 密钥' } };
  if (apiKey.length < 16) return { statusCode: 400, body: { error: 'API 密钥长度不足（至少 16 位），请核对后重填' } };
  if (!model) return { statusCode: 400, body: { error: '请填写模型名称' } };
  if (!sgToken) return { statusCode: 400, body: { error: '请填写 sg 管理令牌（用于 sg 侧鉴权）' } };

  const out = await runSshCurl(
    { method: 'POST', path: '/v1/config/claude-fallback/restore', bearerToken: sgToken, body: { base_url: baseUrl, api_key: apiKey, model } },
    opts.spawnFn,
  );
  if (out.kind === 'unreachable' || out.kind === 'bad_output') {
    return { statusCode: 502, body: { error: 'sg 通道不可达（请检查网络或联系运维）', channel: channel('unreachable') } };
  }
  if (out.statusCode === 404) {
    return { statusCode: 502, body: { error: 'sg 侧版本过旧，请先更新 sg 侧 TriModel', channel: channel('version_unsupported') } };
  }
  if (out.statusCode === 401) {
    return { statusCode: 401, body: { error: 'sg 令牌不正确（请核对 sg 管理令牌）', channel: channel('token_rejected') } };
  }
  if (out.statusCode === 503) {
    return { statusCode: 503, body: { error: 'sg 侧兜底写入未启用：请先在 sg 侧配置管理令牌', channel: channel('unreachable') } };
  }
  if (out.statusCode !== 200) {
    const sgBody = (out.body ?? {}) as Record<string, unknown>;
    return { statusCode: 502, body: { error: typeof sgBody.error === 'string' ? sgBody.error : 'sg 侧操作未成功，请稍后重试', channel: channel('unreachable') } };
  }
  const sgBody = (out.body ?? {}) as Record<string, unknown>;
  return {
    statusCode: 200,
    body: {
      ...sgBody,
      channel: channel('ok'),
      message: typeof sgBody.message === 'string'
        ? sgBody.message.replace(/\n+/g, ' ') + '（sg 侧会话重启后生效）'
        : '兜底直连已写入 sg 侧。sg 侧会话重启后生效。',
    },
  };
}
