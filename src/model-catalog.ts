// ── TriModel model catalog (LG-035 增补·模型名标准化，CEO 令 2026-09-11) ──
//
// 恰五名，大小写精确（/v1/models 输出逐字节=CEO 原文）：
//   deepseek-flash / deepseek-v4-pro / GLM-5.3-Flash / GLM-5.3 / TMV
// tmv-* 内部正典名全退役（单命名层，无双账本；现无在役 policy.json 零迁移）；
// 旧名请求=显式报错 400+有效模型列表（TriModel 层语义清晰优先）。
// 单一定义点：policy 校验（PUT /v1/config/policy）/ models 表 / 3334 路由
// 三面共享本表，禁第四处复写。

export const MODEL_CATALOG = [
  'deepseek-flash',
  'deepseek-v4-pro',
  'GLM-5.3-Flash',
  'GLM-5.3',
  'TMV',
] as const;

export type ModelCatalogEntry = (typeof MODEL_CATALOG)[number];

export const MODEL_CATALOG_LIST = MODEL_CATALOG.join(', ');

export function isCatalogModel(model: string): model is ModelCatalogEntry {
  return (MODEL_CATALOG as readonly string[]).includes(model);
}
