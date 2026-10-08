# 本机实例退役标记（ARCHIVED）

- retiredAt: 2026-10-08 09:56:52 +0800
- 令源: CEO 2026-10-08 09:31「把本地TriModel卸载掉」（承接 09:30 交付面纠偏——验收面=R-HY）
- 执行: BOD；部署毕报卷=FSD df65d515（fsd-rhy-deploy-gapfix-20261008.md，R-HY 绿独立复验过）
- 退役内容: 本机 3333 服务已停（pid 28524 终止，监听清零，无复活）
- **仓原地保留原因**: TriMLC/TriMMC/TriRLC/TriRMC 四仓 node_modules/trimodel 符号链接指向本仓——物理移除/改名会断 8713/8711 现役 daemon 依赖链。退役=停服+本标记，非物理删除。
- 交付面（唯一）: R-HY trimodel.service（http://127.0.0.1:3333/ui @ R-HY-8.155.54.79）
- 代码真源: sg bare（ssh://47.245.122.61/srv/git/TriModel.git）+GitHub 双源；本仓 dev==origin/dev 零 ahead，五断点+全部施工笔已推
- 防误改纪律: 本机实例非交付面——后续施工一律改源码后走「推双源→R-HY 拉取→build→restart trimodel→值面探针」链，禁在本机起 3333 自验交付
