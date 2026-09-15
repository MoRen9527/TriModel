# -*- coding: utf-8 -*-
# LG-036 sg 栏 UI jsdom 断言追加（CTO 方案 §六.3-4）
import io

p = 'test/ui-boot.test.ts'
s = io.open(p, encoding='utf-8').read()

NEW = """
describe('LG-036 TriMMC（sg）栏（2026-09-16 CTO 方案 c6a6e512）', () => {
  const SG_OK = { object: 'config.claude-fallback.sg', channel: { state: 'ok', label: 'sg 通道正常' }, file_present: true, readable: true, base_url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3[1M]', api_key_masked: '****abcd' };

  const sgOkFor = (url: string, init?: RequestInit) => {
    if (url.includes('/v1/config/claude-fallback/sg/restore')) {
      return { status: 200, body: { ok: true, channel: { state: 'ok', label: 'sg 通道正常' }, message: '兜底直连已写入（x · m）。重启会话后生效。（sg 侧会话重启后生效）' } };
    }
    if (url.includes('/v1/config/claude-fallback/sg/status')) return { status: 200, body: SG_OK };
    return okFor(url);
  };

  it('sg 栏渲染+现状展示：四输入+按钮在位；status ok → 地址/模型/尾4 展示；不参与禁用链', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [sgOkFor]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    assert.ok(d.getElementById('fb-sg-baseurl'), 'sg 服务地址输入');
    assert.equal((d.getElementById('fb-sg-key') as HTMLInputElement).type, 'password', 'sg 密钥遮蔽');
    assert.ok(d.getElementById('fb-sg-model'), 'sg 模型输入');
    assert.equal((d.getElementById('fb-sg-token') as HTMLInputElement).type, 'password', 'sg 管理令牌遮蔽');
    assert.ok(d.getElementById('fb-sg-restore'), 'sg 还原兜底按钮');
    await waitFor(() => (d.getElementById('fb-sg-current') as HTMLElement).textContent.includes('sg 通道正常'));
    assert.ok((d.getElementById('fb-sg-current') as HTMLElement).textContent.includes('glm-5.3[1M]'), 'sg 现状模型展示');
    assert.ok((d.getElementById('fb-sg-current') as HTMLElement).textContent.includes('****abcd'), 'sg 密钥尾4（status 透传）');
    assert.equal((d.getElementById('fb-zone') as HTMLElement).classList.contains('disabled-panel'), false, '禁用链零波及');
    retireUi(dom);
  });

  it('点击 sg 还原：POST 发出（body 四值含 sg_admin_token）→成功文案含「sg 侧会话重启后生效」+密钥框清空', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [sgOkFor]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    (d.getElementById('adminToken') as HTMLInputElement).value = 'ta-local';
    (d.getElementById('fb-sg-baseurl') as HTMLInputElement).value = 'https://open.bigmodel.cn/api/anthropic';
    (d.getElementById('fb-sg-key') as HTMLInputElement).value = 'sk-sg-ui-key-abcdefghij';
    (d.getElementById('fb-sg-model') as HTMLInputElement).value = 'glm-5.3[1M]';
    (d.getElementById('fb-sg-token') as HTMLInputElement).value = 'sg-admin-token-xyz';
    d.getElementById('fb-sg-restore').click();
    await waitFor(() => log.some((c) => c.url.includes('sg/restore')));
    const call = log.find((c) => c.url.includes('sg/restore'))!;
    assert.equal(call.init?.method, 'POST');
    const sent = JSON.parse(String(call.init?.body)) as { base_url: string; api_key: string; model: string; sg_admin_token: string };
    assert.equal(sent.base_url, 'https://open.bigmodel.cn/api/anthropic', '地址 verbatim');
    assert.equal(sent.api_key, 'sk-sg-ui-key-abcdefghij', '密钥 verbatim');
    assert.equal(sent.sg_admin_token, 'sg-admin-token-xyz', 'sg 令牌 verbatim');
    await waitFor(() => (d.getElementById('fb-sg-msg') as HTMLElement).textContent.includes('sg 侧会话重启后生效'));
    assert.equal((d.getElementById('fb-sg-key') as HTMLInputElement).value, '', '写后 sg 密钥清空');
    retireUi(dom);
  });

  it('失败态：短密钥行内拒零请求；sg 通道不可达→人话', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const dom = bootUi(log, [(url: string, init?: RequestInit) => {
      if (url.includes('/v1/config/claude-fallback/sg/restore')) return { status: 502, body: { error: 'sg 通道不可达（请检查网络或联系运维）', channel: { state: 'unreachable', label: 'sg 通道不可达（请检查网络或联系运维）' } } };
      return sgOkFor(url, init);
    }]);
    await new Promise((r) => setTimeout(r, 120));
    const d = dom.window.document;
    (d.getElementById('fb-sg-baseurl') as HTMLInputElement).value = 'https://x.example.com';
    (d.getElementById('fb-sg-key') as HTMLInputElement).value = 'short';
    (d.getElementById('fb-sg-model') as HTMLInputElement).value = 'm';
    (d.getElementById('fb-sg-token') as HTMLInputElement).value = 't';
    d.getElementById('fb-sg-restore').click();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok((d.getElementById('fb-sg-msg') as HTMLElement).textContent.includes('16'), '短密钥人话拒');
    assert.equal(log.some((c) => c.url.includes('sg/restore')), false, '零网络请求');
    (d.getElementById('fb-sg-key') as HTMLInputElement).value = 'sk-sg-ui-key-abcdefghij';
    d.getElementById('fb-sg-restore').click();
    await waitFor(() => (d.getElementById('fb-sg-msg') as HTMLElement).textContent.includes('不可达'));
    retireUi(dom);
  });
});
"""

s = s.replace("describe('S8.2: jsdom 首启五断言', () => {", NEW + "\ndescribe('S8.2: jsdom 首启五断言', () => {", 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('lg036-ui-tests ok')
