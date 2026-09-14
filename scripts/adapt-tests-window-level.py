# -*- coding: utf-8 -*-
# 窗级 entry_id 适配：三测试件 fixture/断言批量改（BOD 22:2x 修正令）
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old not in s:
            print(f'MISS in {path}: {old[:60]}...')
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)

# ── apply-strategy.test.ts ──
patch('test/apply-strategy.test.ts', [
    ("windows: [{ start: '14:00', end: '18:00' }], entry_id: 'eds',",
     "windows: [{ start: '14:00', end: '18:00', entry_id: 'eds' }],"),
    ("windows: [{ start: '18:00', end: '23:59' }, { start: '00:00', end: '06:00' }], entry_id: 'eglm',",
     "windows: [{ start: '18:00', end: '23:59', entry_id: 'eglm' }, { start: '00:00', end: '06:00', entry_id: 'eglm' }],"),
    ("assert.equal(applied.schedules, 2, '2 条 time 实体 → 2 schedules');",
     "assert.equal(applied.schedules, 3, '窗级展开：r_day 1 窗+r_eve 2 窗 → 3 schedules（每窗一条）');"),
    ("assert.equal(doc.schedules.length, 2);\n    assert.ok(doc.schedules.every((s) => s.id.startsWith('strategy:s1:r_')),",
     "assert.equal(doc.schedules.length, 3);\n    assert.ok(doc.schedules.every((s) => /^strategy:s1:r_\\w+:\\d+$/.test(s.id)),"),
    ("const eve = doc.schedules.find((s) => s.model === 'GLM-5.3')!;\n    assert.equal(eve.windows.length, 2, '多窗整组直通：一条规则 2 窗 → 一个 schedule 带 2 窗');\n    assert.equal(eve.windows[0].start, '18:00');",
     "assert.equal(doc.schedules.filter((s) => s.model === 'GLM-5.3').length, 2, '窗级展开：r_eve 2 窗 → 2 个各 1 窗的 schedules');"),
    ("assert.equal(applied.schedules, 2, 'v3 两窗内嵌 → 2 个 time 实体 → 2 schedules');",
     "assert.equal(applied.schedules, 2, 'v3 两窗内嵌 → 1 条 time 实体（全窗归一）→ 2 schedules（每窗一条）');"),
    ("assert.equal(doc.schedules.length, 2);\n  });\n\n  it('鉴权：错 token → 401'",
     "assert.equal(doc.schedules.length, 3);\n  });\n\n  it('鉴权：错 token → 401'"),
])

# ── d16-strategy.test.ts ──
patch('test/d16-strategy.test.ts', [
    ("windows: [{ start: '09:00', end: '18:00' }], entry_id: 'e1',",
     "windows: [{ start: '09:00', end: '18:00', entry_id: 'e1' }],"),
])

# ── trimmc-card-v4.test.ts ──
patch('test/trimmc-card-v4.test.ts', [
    ("windows: [{ start: '01:00', end: '02:00' }], entry_id: 'e_glm', watch_entry_id: 'e_glm',",
     "windows: [{ start: '01:00', end: '02:00', entry_id: 'e_glm' }], watch_entry_id: 'e_glm',"),
    ("windows: [{ start: '01:00', end: '05:00' }], entry_id: 'e_glm',",
     "windows: [{ start: '01:00', end: '05:00', entry_id: 'e_glm' }],"),
    ("windows: [{ start: '04:00', end: '06:00' }], entry_id: 'e_deep',",
     "windows: [{ start: '04:00', end: '06:00', entry_id: 'e_deep' }],"),
    ("windows: [{ start: '01:00', end: '02:00' }], entry_id: 'e1',",
     "windows: [{ start: '01:00', end: '02:00', entry_id: 'e1' }],"),
    ("assert.equal(defRules[0].name, '时段切换策略默认');",
     "assert.equal(defRules[0].name, '默认模型', '默认规则名（BOD 22:2x 令）');"),
])
print('done')
