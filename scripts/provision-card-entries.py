# -*- coding: utf-8 -*-
# CEO 2026-09-14 20:43 直令「模型信息下要有条目」：现役 env/keys 源如实登记进卡
# （值与现役同源同值 → 3334 卡优先解析零行为扰动；策略/active/规则零触碰）。
# 密钥全程变量传递，输出仅 masked 指纹。用法：python scripts/provision-card-entries.py
import json, os, re, sys, urllib.request

BASE = 'http://127.0.0.1:3333'
HERE = os.path.dirname(os.path.abspath(__file__))
env_text = open(os.path.join(HERE, '..', '.env'), encoding='utf-8').read()
ADMIN = re.search(r'^TRIMODEL_ADMIN_TOKEN=(.+)$', env_text, re.M).group(1).strip()
API = re.search(r'^TRIMODEL_API_TOKEN=(.+)$', env_text, re.M).group(1).strip()

def req(path, method='GET', body=None, token=ADMIN):
    r = urllib.request.Request(BASE + path, method=method,
        headers={'authorization': 'Bearer ' + token, 'content-type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(r, timeout=10) as resp:
        return resp.status, json.loads(resp.read().decode())

def mask(k):
    return (k[:6] + '...' + k[-4:]) if k and len(k) > 12 else '(short)'

# 现役值来源：GLM=进程 env（3334 同源）；deepseek=3333 keys 面 anthropic 源（env 空）
glm_key = os.environ.get('GLM_API_KEY', '')
assert glm_key, 'GLM_API_KEY not in env'
_, keys_doc = req('/v1/config/keys', token=API)
ds_key = keys_doc['keys']['anthropic']['api_key']
ds_base = keys_doc['keys']['anthropic']['base_url']
glm_base = 'https://open.bigmodel.cn/api/anthropic'

status, card_doc = req('/v1/config/trimmc-card')
assert status == 200, status
card = card_doc['card']
entries = dict(card.get('provider_entries') or {})
now = '2026-09-14T20:45:00+08:00'
entries['e-glm-anthropic'] = {'provider': 'glm', 'model': 'GLM-5.3', 'api_key': glm_key,
    'enabled': True, 'updated_at': now, 'base_url': glm_base}
entries['e-deepseek-anthropic'] = {'provider': 'deepseek', 'model': 'deepseek-v4-pro', 'api_key': ds_key,
    'enabled': True, 'updated_at': now, 'base_url': ds_base}
card['provider_entries'] = entries
# 冻结面零触碰自证：strategies/active_strategy_id/default_model/rules 原样回传
st, put_doc = req('/v1/config/trimmc-card', 'PUT', card)
print('PUT status:', st, 'entries:', len(put_doc.get('card', {}).get('provider_entries', {})))
st2, after = req('/v1/config/trimmc-card')
a = after.get('card', {})
masked = after.get('entries_masked') or {}
print('after: entries=%d strategies=%s active=%s rules(top)=%d' % (
    len(a.get('provider_entries', {})), list((a.get('strategies') or {}).keys()),
    a.get('active_strategy_id'), len(a.get('rules', []))))
for eid, m in masked.items():
    print(' ', eid, m.get('provider'), m.get('model'), m.get('masked'), 'enabled=%s' % m.get('enabled'))
