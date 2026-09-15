# -*- coding: utf-8 -*-
# 兜底 UI jsdom 断言追加（2026-09-15 任务书验收 4）
import io

p = 'test/ui-boot.test.ts'
s = io.open(p, encoding='utf-8').read()

NEW = """
describe('直连兜底区（2026-09-15 任务书）', () => {
  const FB_GET_BODY = { object: 'config.claude-fallback', file_present: true, readable: true, base_url: 'https://old.example.com/api', model: 'old-model' };

  const fbOkFor = (url: string, init?: RequestInit) => {
    if (url.includes('/v1/config/claude-fallback/restore')) {
      return { status: 200, body: { ok: true, message: '兜底直连已写入（https://api.deepseek.com/anthropic · deepseek-flash[1M]）。重启会话后生效。' } };
    }
    if (url.includes('/v1/config/claude-fallback')) return { status: 200, body: FB_GET_BODY };
    return okFor(url);
  };

  it('区块渲染+现状展示：三输入+按钮在位；GET 填充当前地址/模型；不参与卡片禁用链', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [fbOkFor]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    assert.ok(d.getElementById('fb-baseurl'), '服务地址输入在位');
    assert.ok(d.getElementById('fb-key'), '密钥输入在位');
    assert.equal((d.getElementById('fb-key') as HTMLInputElement).type, 'password', '密钥默认遮蔽');
    assert.ok(d.getElementById('fb-model'), '模型输入在位');
    assert.ok(d.getElementById('fb-restore'), '还原兜底按钮在位');
    // 现状展示（GET 填充）
    await waitFor(() => (d.getElementById('fb-current') as HTMLElement).textContent.includes('old.example.com'));
    assert.ok((d.getElementById('fb-current') as HTMLElement).textContent.includes('old-model'), '当前模型展示');
    // 不参与卡片禁用链：无令牌态下区块无 disabled-panel、按钮不灰
    assert.equal((d.getElementById('fb-zone') as HTMLElement).classList.contains('disabled-panel'), false, '禁用链零波及');
    assert.equal((d.getElementById('fb-restore') as HTMLButtonElement).disabled, false, '按钮恒可用（兜底语义）');
    retireUi(dom);
  });

  it('点击还原兜底：POST 发出（三值 verbatim）→成功文案含「重启会话后生效」+密钥框清空', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [fbOkFor]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    (d.getElementById('adminToken') as HTMLInputElement).value = 'ta-ok';
    (d.getElementById('fb-baseurl') as HTMLInputElement).value = 'https://api.deepseek.com/anthropic';
    (d.getElementById('fb-key') as HTMLInputElement).value = 'sk-ui-token-abcdefghij';
    (d.getElementById('fb-model') as HTMLInputElement).value = 'deepseek-flash[1M]';
    d.getElementById('fb-restore').click();
    await waitFor(() => log.some((c) => c.url.includes('claude-fallback/restore')));
    const call = log.find((c) => c.url.includes('claude-fallback/restore'))!;
    assert.equal(call.init?.method, 'POST', 'POST 方法');
    const sent = JSON.parse(String(call.init?.body)) as { base_url: string; api_key: string; model: string };
    assert.equal(sent.base_url, 'https://api.deepseek.com/anthropic', '地址 verbatim');
    assert.equal(sent.api_key, 'sk-ui-token-abcdefghij', '密钥 verbatim');
    assert.equal(sent.model, 'deepseek-flash[1M]', '模型 verbatim');
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('重启会话后生效'));
    assert.equal((d.getElementById('fb-key') as HTMLInputElement).value, '', '写后密钥框清空（不回显）');
    retireUi(dom);
  });

  it('失败态：401→人话引导；短密钥→行内拒且不发请求', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [(url: string, init?: RequestInit) => {
      if (url.includes('/v1/config/claude-fallback/restore')) return { status: 401, body: { error: 'Unauthorized' } };
      return fbOkFor(url, init);
    }]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    // 短密钥：行内拒、零请求
    (d.getElementById('fb-baseurl') as HTMLInputElement).value = 'https://x.example.com';
    (d.getElementById('fb-key') as HTMLInputElement).value = 'short';
    (d.getElementById('fb-model') as HTMLInputElement).value = 'm1';
    d.getElementById('fb-restore').click();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok((d.getElementById('fb-msg') as HTMLElement).textContent.includes('16'), '短密钥人话拒');
    assert.equal(log.some((c) => c.url.includes('restore')), false, '零网络请求');
    // 401：服务端人话引导
    (d.getElementById('fb-key') as HTMLInputElement).value = 'sk-ui-token-abcdefghij';
    d.getElementById('fb-restore').click();
    await waitFor(() => (d.getElementById('fb-msg') as HTMLElement).textContent.includes('管理令牌'));
    assert.ok((d.getElementById('fb-msg') as HTMLElement).textContent.includes('令牌不正确或未填写'), '401 人话');
    retireUi(dom);
  });
});
"""

s = s.replace("describe('S8.2: jsdom 首启五断言', () => {", NEW + "\ndescribe('S8.2: jsdom 首启五断言', () => {", 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('fb-ui-tests ok')
