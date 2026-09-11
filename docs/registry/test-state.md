# TriModel 测试状态登记（test-state）

## 文档同步元信息

- sourceOfTruth: TriModel/docs/registry/test-state.md
- syncMode: source-only
- lastSyncedAt: 2026-09-11（LG-035 首批钉入，打样第一）
- 供料源: COS 转达 STE/CTO 线读数（2026-09-11 21:35+0800），CGR 钉入

## 1. 当前测试基线

LG-035 五批门禁读数链：P1 73/73（14:46）→ P2 86/86 → P2 合并 98/98（16:08）→ 切片 1 113/113（17:08）→ **双线合并 135/135 pass/0 fail 双跑稳定**（20:26 终态；TriModel f8e752e+TC 对表 0d30621）。tsc 绿+lint 0 error 各批在案。

## 2. 门禁状态

P1/P2/切片 1/双线四道正式 PASS（STE 签发+CTO 收口分工现行）；E1-E8 真浏览器门禁族 STE 编写中（env-gate 族+截图证据落档，playwright-core 装包已裁）。

## 3. 已知缺口

1. 「当前生效与固定规则」走查不合格七条返工中（CPO v3 重设计+CTO 实现修订 88ecedd2 在途；135 中 3 失败系 STE 对表中间态 git 实证非产品缺陷）。
2. E1-E8 未上线。
3. fallback 常量残留候 TriRLC 分叉窗批。

## 4. 最近验证时点

2026-09-11 20:26+0800（135/135，commit f8e752e）。

> 登记纪律：本件系工作型登记层（经确认事实，禁记临时猜测）；更新守 owner 提交纪律（STE 供料+CTO 门禁收口）；D-04 时刻纪律适用。
