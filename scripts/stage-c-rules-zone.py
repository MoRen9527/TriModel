# -*- coding: utf-8 -*-
# 层2 段C：规则区三型 CRUD（2026-09-14 23:3x）
import io

p = 'ui/index.html'
s = io.open(p, encoding='utf-8').read()

# DOM：规则区（模型集区与策略区之间）
s = s.replace("""  <h3>活动策略</h3>""",
"""  <h3>规则 <button class="primary" id="tc-r-add" style="margin-left:8px;font-size:12px;padding:2px 8px">+ 新增规则</button></h3>
  <table id="tc-r-table"><thead><tr><th>规则名</th><th>类型</th><th>摘要</th><th>启用</th><th>操作</th></tr></thead><tbody id="tc-r-body"></tbody></table>
  <div id="tc-r-empty" class="sub" style="margin-top:6px">暂无规则。点「新增规则」创建（时段/默认/额度三型）。</div>
  <form class="card-form" id="tc-r-form" hidden style="max-width:560px">
    <h3 id="tc-r-form-title">新增规则</h3>
    <div class="field"><label>类型（先选）</label><select id="tc-r-type"><option value="time">时段（窗内用某条目，多窗）</option><option value="default">默认（其余时段用某条目）</option><option value="quota">额度（监控条目用尽依序转）</option></select></div>
    <div class="field"><label>规则名（必填）</label><input id="tc-r-name" placeholder="例如 三窗切换"></div>
    <div id="tc-r-time-zone">
      <div class="field"><label>时段窗（可多窗）</label><div id="tc-r-windows"></div></div>
      <div class="row-form"><button type="button" id="tc-r-win-add">+ 加一个时段窗</button></div>
    </div>
    <div class="field" id="tc-r-default-row"><label>默认条目</label><select id="tc-r-entry"></select></div>
    <div class="field" id="tc-r-watch-row" hidden><label>监控条目</label><select id="tc-r-watch"></select></div>
    <div class="field" id="tc-r-fallback-row" hidden style="align-items:flex-start"><label>转入序列（有序勾选）</label><div id="tc-r-fallback" style="max-height:110px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px 10px"></div></div>
    <div class="field"><label><input id="tc-r-enabled" type="checkbox" checked> 启用（停用=保留但不参与组合）</label></div>
    <div class="row-form">
      <button type="button" class="primary" id="tc-r-save">保存规则</button>
      <button type="button" id="tc-r-cancel">取消</button>
    </div>
  </form>

  <h3>活动策略</h3>""", 1)

JS_BLOCK = """
// ── 层2 段C：规则区（三型命名规则 CRUD；被策略引用禁删；quota 待额度数据徽标）──
function tcRuleSummary(r) {
  if (r.type === 'time') return (r.windows ?? []).map((w) => w.start + '–' + w.end + ' ' + tcWindowModel(w.entry_id)).join('；');
  if (r.type === 'default') return '全时段用 ' + tcWindowModel(r.entry_id);
  return '监控 ' + tcWindowModel(r.watch_entry_id) + ' → 依序转 ' + (r.fallback_ids ?? []).map((f) => tcWindowModel(f)).join('、') + '（待额度数据）';
}

function tcRenderRules() {
  const tb = $('tc-r-body');
  if (!tb) return;
  tb.innerHTML = '';
  $('tc-r-empty').hidden = Object.keys(tcRules).length > 0;
  for (const [id, r] of Object.entries(tcRules)) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td><button data-edit style="margin-right:4px">编辑</button><button class="danger" data-del>删除</button></td>';
    tr.children[0].textContent = r.name;
    tr.children[1].textContent = r.type === 'time' ? '时段' : (r.type === 'default' ? '默认' : '额度（待额度数据）');
    tr.children[2].textContent = tcRuleSummary(r);
    tr.children[3].textContent = r.enabled ? '✓' : '✗';
    tr.querySelector('[data-edit]').onclick = () => tcOpenRuleForm(id);
    tr.querySelector('[data-del]').onclick = () => {
      const ref = Object.values(tcStrategies).find((st) => st.rule_ids.includes(id));
      if (ref) { tcMsg('该规则正被策略「' + ref.name + '」引用，请先解除引用', 'err'); return; }
      delete tcRules[id];
      tcDeletedRules.push(id);
      tcRenderRules();
      tcFillStrategySelects();
      tcRenderWindowRules();
      tcMarkDirty();
    };
    tb.appendChild(tr);
  }
}

function tcFillEntrySelect(sel, selected) {
  const all = { ...tcMirror, ...tcEntries };
  sel.innerHTML = '';
  for (const eid of Object.keys(all).sort()) {
    const o = document.createElement('option');
    o.value = eid; o.textContent = eid + '（' + all[eid].model + '）';
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

function tcAddWindowRow(win) {
  const box = $('tc-r-windows');
  const row = document.createElement('div');
  row.className = 'row-form';
  const start = document.createElement('input'); start.type = 'time'; start.value = (win && win.start) || '09:00'; start.style.width = '110px';
  const end = document.createElement('input'); end.type = 'time'; end.value = (win && win.end) || '18:00'; end.style.width = '110px';
  const entry = document.createElement('select'); entry.style.width = '200px'; tcFillEntrySelect(entry, win && win.entry_id);
  const del = document.createElement('button'); del.type = 'button'; del.textContent = '×'; del.className = 'danger';
  del.onclick = () => { if (box.children.length > 1) row.remove(); else tcMsg('至少保留一个时段窗', 'warn'); };
  row.appendChild(start); row.appendChild(end); row.appendChild(entry); row.appendChild(del);
  box.appendChild(row);
}

let tcEditingRuleId = null;
function tcOpenRuleForm(editId) {
  const editing = editId ? tcRules[editId] : null;
  tcEditingRuleId = editId ?? null;
  $('tc-r-form-title').textContent = editId ? ('编辑规则「' + (editing ? editing.name : '') + '」') : '新增规则';
  $('tc-r-type').value = editing ? editing.type : 'time';
  $('tc-r-type').disabled = !!editId; // 类型编辑期锁定（分型字段异构，改型=删了重建）
  $('tc-r-name').value = (editing && editing.name) || '';
  $('tc-r-enabled').checked = editing ? editing.enabled : true;
  $('tc-r-windows').innerHTML = '';
  if (editing && editing.type === 'time') {
    for (const w of editing.windows || []) tcAddWindowRow(w);
    if ($('tc-r-windows').children.length === 0) tcAddWindowRow();
  } else {
    tcAddWindowRow();
  }
  tcFillEntrySelect($('tc-r-entry'), editing && editing.type === 'default' ? editing.entry_id : undefined);
  tcFillEntrySelect($('tc-r-watch'), editing && editing.type === 'quota' ? editing.watch_entry_id : undefined);
  const fb = $('tc-r-fallback'); fb.innerHTML = '';
  const all = { ...tcMirror, ...tcEntries };
  for (const eid of Object.keys(all).sort()) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:13px;margin:2px 0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = eid; cb.dataset.fid = eid;
    if (editing && editing.type === 'quota' && (editing.fallback_ids || []).includes(eid)) cb.checked = true;
    const span = document.createElement('span'); span.textContent = eid + '（' + all[eid].model + '）';
    label.appendChild(cb); label.appendChild(span); fb.appendChild(label);
  }
  tcSyncRuleFormType();
  $('tc-r-form').hidden = false;
}

function tcSyncRuleFormType() {
  const t = $('tc-r-type').value;
  $('tc-r-time-zone').hidden = t !== 'time';
  $('tc-r-default-row').hidden = t !== 'default';
  $('tc-r-watch-row').hidden = t !== 'quota';
  $('tc-r-fallback-row').hidden = t !== 'quota';
}
$('tc-r-type').onchange = tcSyncRuleFormType;
$('tc-r-win-add').onclick = () => tcAddWindowRow();
$('tc-r-add').onclick = () => tcOpenRuleForm(null);
$('tc-r-cancel').onclick = () => { $('tc-r-form').hidden = true; };
$('tc-r-save').onclick = () => {
  const name = $('tc-r-name').value.trim();
  if (!name) return tcMsg('规则名称必填', 'err');
  if (Object.values(tcRules).some((r) => r.name === name && tcRules[tcEditingRuleId] !== r)) {
    return tcMsg('名称「' + name + '」已存在', 'err');
  }
  const type = $('tc-r-type').value;
  const enabled = $('tc-r-enabled').checked;
  const now = new Date().toISOString();
  let entity = null;
  const timeRe = /^([01]\\d|2[0-3]):([0-5]\\d)$/;
  if (type === 'time') {
    const windows = [];
    for (const row of $('tc-r-windows').children) {
      const start = row.children[0].value, end = row.children[1].value, entry = row.children[2].value;
      if (!timeRe.test(start) || !timeRe.test(end)) return tcMsg('时间格式须为 HH:MM（' + start + '–' + end + '）', 'err');
      if (start >= end) return tcMsg('结束时间需晚于开始时间（' + start + '–' + end + '）', 'err');
      if (!entry) return tcMsg('时段窗需选择条目', 'err');
      windows.push({ start: start, end: end, entry_id: entry });
    }
    if (windows.length === 0) return tcMsg('至少一个时段窗', 'err');
    entity = { name: name, type: type, enabled: enabled, windows: windows };
  } else if (type === 'default') {
    const entry_id = $('tc-r-entry').value;
    if (!entry_id) return tcMsg('请选择默认条目', 'err');
    entity = { name: name, type: type, enabled: enabled, entry_id: entry_id };
  } else {
    const watch = $('tc-r-watch').value;
    const fallback_ids = Array.from(document.querySelectorAll('#tc-r-fallback input[type=checkbox]')).filter((cb) => cb.checked).map((cb) => cb.dataset.fid);
    if (!watch) return tcMsg('请选择监控条目', 'err');
    if (fallback_ids.length === 0) return tcMsg('转入序列不能为空（至少勾选一个）', 'err');
    entity = { name: name, type: type, enabled: enabled, watch_entry_id: watch, fallback_ids: fallback_ids };
  }
  const id = tcEditingRuleId || ('rule_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const prev = tcRules[id];
  tcRules[id] = Object.assign({}, entity, { created_at: prev ? prev.created_at : now, updated_at: now });
  $('tc-r-form').hidden = true;
  tcRenderRules();
  tcFillStrategySelects();
  tcRenderWindowRules();
  tcRenderStrategyDetail();
  tcMarkDirty();
};

function tcRenderStrategySel() {"""

s = s.replace("function tcRenderStrategySel() {", JS_BLOCK, 1)

s = s.replace("""  tcRender();
  tcRenderModelSets();""",
"""  tcRender();
  tcRenderModelSets();
  tcRenderRules();""", 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('C ok')
