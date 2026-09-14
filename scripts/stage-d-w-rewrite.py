# -*- coding: utf-8 -*-
# 层2 段D：W1-W5 段位红重写（v4 三实体新形态；2026-09-14 23:5x）
import io

p = 'test/ui.e2e.gate.test.ts'
s = io.open(p, encoding='utf-8').read()

old_start = s.index("  it('W1 (①) D15 改写")
old_end = s.index("});", s.index("await page.context().close();", s.index("it('W5"))) + len("});")

NEW = """  it('W1 (①) v4: 规则实体持久 — 建默认规则→保存→reload 保持（第四型完整周期）', async () => {
    const page = await freshPage();
    await connectPage(page, 'w1v4');
    await addEntryViaUi(page, 'gate-ui-w1v4', 'glm', 'GLM-5.3', 'sk-gate-w1v4-key');
    await page.click('#tc-save');
    await page.waitForTimeout(700);
    // v4：默认模型归 default 规则实体（编辑面退役）——经规则区表单创建
    await page.click('#tc-r-add');
    await page.selectOption('#tc-r-type', 'default');
    await page.fill('#tc-r-name', '走查默认');
    await waitSelectOptions(page, '#tc-r-entry', 1);
    await page.click('#tc-r-save');
    await page.click('#tc-save');
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'domcontentloaded' }); // 第四型：跨刷新持久周期
    await page.waitForTimeout(900);
    const rulesText = await page.locator('#tc-r-body').innerText();
    assert.ok(rulesText.includes('走查默认'), '默认规则实体须随卡持久（reload 后保持）');
    assert.ok(rulesText.includes('全时段用'), 'default 型摘要正确');
    const entryRows = await page.locator('#tc-entry-body tr').count();
    assert.ok(entryRows >= 1, '条目随卡持久');
    await page.context().close();
  });

  it('W2 (②) v4: 规则区五列+时段窗默认值（fixture self-sufficient）', async () => {
    const page = await freshPage();
    await connectPage(page, 'w2v4');
    await addEntryViaUi(page, 'gate-ui-w2v4', 'glm', 'GLM-5.3', 'sk-gate-w2v4-key');
    await page.click('#tc-save'); // fixture: entry persisted so 窗级条目下拉 has a source
    await page.waitForTimeout(700);
    await page.click('#tc-r-add');
    const heads = await page.$eval('#tc-r-table thead', (el) => Array.from(el.querySelectorAll('th')).map((th) => (th.textContent ?? '').trim()));
    assert.deepEqual(heads, ['规则名', '类型', '摘要', '启用', '操作'], '五列正身（v4 规则区）');
    assert.equal(await page.locator('#tc-r-empty').isVisible(), true, '空态指引在位');
    assert.equal(await page.$eval('#tc-r-form', (el) => (el as HTMLFormElement).hidden), false, '新增表单展开');
    const firstWin = await page.$eval('#tc-r-windows .row-form', (row) => ({
      start: (row.children[0] as HTMLInputElement).value,
      end: (row.children[1] as HTMLInputElement).value,
    }));
    assert.equal(firstWin.start, '09:00', '开始默认 09:00');
    assert.equal(firstWin.end, '18:00', '结束默认 18:00');
    await page.click('#tc-r-cancel');
    await page.context().close();
  });

  it('W3 (③) v4: 旧编辑面退役回归 — fixed/D10 表单/默认模型编辑面零残留', async () => {
    const page = await freshPage();
    await connectPage(page, 'w3v4');
    for (const gone of ['#tc-r-entry-old', '#tc-fixed-active', '#tc-fixed-tip', '#tc-default-model', '#tc-s-default', '#tc-wr-open-add', '#tc-wr-form', '#tc-w-entry']) {
      assert.equal(await page.locator(gone).count(), 0, `${gone} 已退役（DOM 零残留）`);
    }
    // v4 新面在位：规则区+模型集区+策略表单三实体
    assert.equal(await page.locator('#tc-r-table').count(), 1, '规则区在位');
    assert.equal(await page.locator('#tc-ms-table').count(), 1, '模型集区在位');
    assert.equal(await page.locator('#tc-s-modelset').count(), 1, '策略表单模型集下拉在位');
    await page.context().close();
  });

  it('W4 (④) v4: 规则表单 start >= end 人话拒收（跨午夜不暴露）', async () => {
    const page = await freshPage();
    await connectPage(page, 'w4v4');
    await addEntryViaUi(page, 'gate-ui-w4v4', 'deepseek', 'deepseek-v4-pro', 'sk-gate-w4v4-key');
    await page.click('#tc-save');
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const rowsBefore = await page.locator('#tc-r-body tr').count();
    await page.click('#tc-r-add');
    await page.fill('#tc-r-name', '跨午夜走查');
    await page.fill('#tc-r-windows .row-form input[type=time] >> nth=0', '22:00');
    await page.fill('#tc-r-windows .row-form input[type=time] >> nth=1', '06:00');
    await page.click('#tc-r-save');
    await page.waitForTimeout(300);
    const msg = await page.locator('#tc-msg').textContent();
    assert.ok(/结束时间需晚于开始时间/.test(msg ?? ''), `人话拒收文案，实际: ${msg}`);
    assert.equal(await page.$eval('#tc-r-form', (el) => (el as HTMLFormElement).hidden), false, '拒收后表单保持（不静默吞）');
    const rowsAfter = await page.locator('#tc-r-body tr').count();
    assert.equal(rowsAfter, rowsBefore, '拒收规则不得入表');
    await page.click('#tc-r-cancel');
    await page.context().close();
  });

  it('W5 (⑤) v4: 域标签动态化（runtime-info 驱动）— 作用域小字随域显', async () => {
    const page = await freshPage();
    const body = await page.evaluate(() => document.body.innerText);
    assert.ok(body.includes('以下策略应用于'), '作用域小字框架在位');
    assert.ok(body.includes('本地域'), '本地实例域标签=本地域（runtime-info 驱动动态值；sg 域部署时由 TRIMODEL_DOMAIN_LABEL 显 sg）');
    await page.context().close();
  });"""

s = s[:old_start] + NEW + s[old_end:]
io.open(p, 'w', encoding='utf-8').write(s)
print('D-W-rewrite ok')
