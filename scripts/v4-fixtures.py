# -*- coding: utf-8 -*-
# ui-boot/ui-e11 fixture v3→v4 形态（2026-09-14 23:1x 兼容补丁配套）
import io, re

V4_CARD = """{
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: {}, model_sets: { ms1: { name: '工作集', entry_ids: [], created_at: 'x', updated_at: 'x' } },
      rules: {
        r1: { name: '工作时段#时段', type: 'time', enabled: true, windows: [{ start: '09:00', end: '18:00', entry_id: 'e1' }], created_at: 'x', updated_at: 'x' },
        r2: { name: '工作时段#默认', type: 'default', enabled: true, entry_id: 'e1', created_at: 'x', updated_at: 'x' },
      },
      strategies: { s1: { name: '工作时段', purpose: '', model_set_id: 'ms1', rule_ids: ['r1', 'r2'], created_at: 'x', updated_at: 'x' } },
      active_strategy_id: 's1', deleted_strategy_ids: [],
      default_model: 'GLM-5.3',
      status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    }"""

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old not in s:
            print(f'MISS {path}: {old[:70]}')
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)

# ui-boot L5 案 fixture（v3 策略内嵌 → v4 三实体引用；e1 条目补进 entries+集）
patch('test/ui-boot.test.ts', [(
"""    const card = {
      version: 2, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: {}, rules: [],
      strategies: { s1: { name: '工作时段', purpose: '', models: ['GLM-5.3'], rules: [{ type: 'window', windows: [{ start: '09:00', end: '18:00' }], model: 'GLM-5.3', priority: 10, enabled: true }], default_model: 'GLM-5.3', enabled: true, created_at: 'x', updated_at: 'x' } },
      active_strategy_id: 's1', deleted_strategy_ids: [],
      status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };""",
"""    const card = {
      version: 4, machine: { name: 'm' }, connection: { name: '本机' },
      provider_entries: { e1: { provider: 'glm', model: 'GLM-5.3', api_key_encrypted: 'QUFB', enabled: true, updated_at: 'x' } },
      model_sets: { ms1: { name: '工作集', entry_ids: ['e1'], created_at: 'x', updated_at: 'x' } },
      rules: {
        r1: { name: '工作时段#时段', type: 'time', enabled: true, windows: [{ start: '09:00', end: '18:00', entry_id: 'e1' }], created_at: 'x', updated_at: 'x' },
        r2: { name: '工作时段#默认', type: 'default', enabled: true, entry_id: 'e1', created_at: 'x', updated_at: 'x' },
      },
      strategies: { s1: { name: '工作时段', purpose: '', model_set_id: 'ms1', rule_ids: ['r1', 'r2'], created_at: 'x', updated_at: 'x' } },
      active_strategy_id: 's1', deleted_strategy_ids: [],
      default_model: 'GLM-5.3',
      status: { state: 'pending', at: 'x' }, reserved: { quota_switch: null, instances_group: null, env_tag: null },
    };"""
)])
print('ui-boot L5 done')
