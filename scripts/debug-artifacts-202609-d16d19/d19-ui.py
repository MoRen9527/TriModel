# D19: zone 3 strategy entity UI — strategy dropdown, detail, CRUD, switch
p = 'ui/index.html'
s = open(p, encoding='utf-8').read()

# ── Replace zone 3 area: remove fixed-era elements, add strategy entity UI ──
old = """  <h3>模型切换策略</h3>
  <div class="sub" style="margin:-6px 0 10px">以下策略应用于 TriMMC（sg）</div>
  <div class="row-form">
    <label>可切换模型</label>
    <span id="tc-chips" class="sub">暂无已启用条目</span>
  </div>
  <div class="row-form">
    <label>默认模型（可留空=回落引擎默认）</label>
    <select id="tc-default-model" style="width:260px"><option value="">（留空=回落引擎默认）</option></select>
    <span class="sub">窗口时段未命中时使用</span>
  </div>

  <h3 style="margin-top:14px">时段规则（命名候定） <span class="sub">时区：Asia/Shanghai</span></h3>
  <table id="tc-wrules"><thead><tr><th>时段</th><th>目标条目</th><th>优先级</th><th>启用</th><th>操作</th></tr></thead><tbody id="tc-wr-body"></tbody></table>
  <div id="tc-wr-empty" class="sub" style="margin-top:6px">暂无时段规则。点「添加时段规则」创建。</div>
  <form class="card-form" id="tc-wr-form" hidden>
    <h3>添加时段规则</h3>
    <div class="field"><label>目标条目</label><select id="tc-w-entry"></select></div>
    <div class="field"><label>开始</label><input id="tc-w-start" value="09:00" style="width:110px"></div>
    <div class="field"><label>结束</label><input id="tc-w-end" value="18:00" style="width:110px"><span id="tc-w-time-err" class="err" style="font-size:12px"></span></div>
    <div class="field"><label>优先级</label><input id="tc-w-priority" type="number" value="10" style="width:110px"></div>
    <div class="field"><label><input id="tc-w-enabled" type="checkbox" checked> 启用</label></div>
    <div class="row-form">
      <button type="button" class="primary" id="tc-w-save">保存规则</button>
      <button type="button" id="tc-w-cancel">取消</button>
      <span class="sub">跨午夜时段暂不支持；随卡片保存后应用</span>
    </div>
  </form>
  <div class="row-form"><button id="tc-wr-open-add">添加时段规则</button></div>"""
new = """  <h3>当前策略</h3>
  <div class="sub" style="margin:-6px 0 10px">以下策略应用于 TriMMC（sg）</div>
  <div class="row-form">
    <label>策略</label>
    <select id="tc-strategy-sel" style="width:260px"><option value="">暂无策略，请先新增</option></select>
    <button id="tc-str-switch">切换至选中策略</button>
    <button id="tc-str-clear">清除（不使用策略）</button>
  </div>
  <div class="kv" id="tc-str-detail" style="margin-top:8px"></div>
  <div class="row-form"><span id="tc-chips" class="sub">暂无已启用条目</span></div>
  <div class="row-form">
    <label>默认模型（可留空=回落引擎默认）</label>
    <select id="tc-default-model" style="width:260px"><option value="">（留空=回落引擎默认）</option></select>
    <span class="sub">窗口时段未命中时使用</span>
  </div>

  <h3 style="margin-top:14px">策略列表</h3>
  <table id="tc-str-table"><thead><tr><th>名称</th><th>模型集</th><th>规则数</th><th>默认模型</th><th>启用</th><th>操作</th></tr></thead><tbody id="tc-str-body"></tbody></table>
  <div id="tc-str-list-empty" class="sub" style="margin-top:6px">暂无策略。点「新增策略」创建。</div>

  <form class="card-form" id="tc-str-form" hidden>
    <h3 id="tc-str-form-title">新增策略</h3>
    <div class="field"><label>名称（必填）</label><input id="tc-s-name" placeholder="例如 工作时段"></div>
    <div class="field"><label>目的（选填）</label><input id="tc-s-purpose" placeholder="例如 闲时用 glm 忙时用 deepseek"></div>
    <div class="field"><label>模型集</label><select id="tc-s-model" style="width:200px"></select></div>
    <div class="field"><label>默认模型</label><select id="tc-s-default" style="width:200px"></select></div>
    <div class="field"><label><input id="tc-s-enabled" type="checkbox" checked> 启用</label></div>
    <div class="row-form">
      <button type="button" class="primary" id="tc-s-save">保存策略</button>
      <button type="button" id="tc-s-cancel">取消</button>
    </div>
  </form>

  <h3 style="margin-top:14px">时段规则（命名候定） <span class="sub">时区：Asia/Shanghai</span></h3>
  <table id="tc-wrules"><thead><tr><th>时段</th><th>目标条目</th><th>优先级</th><th>启用</th><th>操作</th></tr></thead><tbody id="tc-wr-body"></tbody></table>
  <div id="tc-wr-empty" class="sub" style="margin-top:6px">暂无时段规则。点「添加时段规则」创建。</div>
  <form class="card-form" id="tc-wr-form" hidden>
    <h3>添加时段规则</h3>
    <div class="field"><label>目标条目</label><select id="tc-w-entry"></select></div>
    <div class="field"><label>开始</label><input id="tc-w-start" value="09:00" style="width:110px"></div>
    <div class="field"><label>结束</label><input id="tc-w-end" value="18:00" style="width:110px"><span id="tc-w-time-err" class="err" style="font-size:12px"></span></div>
    <div class="field"><label>优先级</label><input id="tc-w-priority" type="number" value="10" style="width:110px"></div>
    <div class="field"><label><input id="tc-w-enabled" type="checkbox" checked> 启用</label></div>
    <div class="row-form">
      <button type="button" class="primary" id="tc-w-save">保存规则</button>
      <button type="button" id="tc-w-cancel">取消</button>
      <span class="sub">跨午夜时段暂不支持；随卡片保存后应用</span>
    </div>
  </form>
  <div class="row-form"><button id="tc-wr-open-add">添加时段规则</button></div>"""
assert old in s, 'zone3 anchor'
s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('zone3 HTML done')
