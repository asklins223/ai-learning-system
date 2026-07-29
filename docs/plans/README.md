# 版本计划索引

此目录存放当前受控版本计划和仍未关闭的发布后续。已完成的实施计划转入本地
`project-archive`，不再作为远端活动文档。

| 版本 | 文档类型 | 计划状态 | 文档 |
| --- | --- | --- | --- |
| v0.5 | 发布后续 | 功能实现已归档；发布硬门禁未关闭 | [v0.5 未完成项与发布后续](v0.5-unfinished-release-work.md) |
| v0.6 | 活动实施计划 | Approved；M0-M6 代码候选，M7 未开始；正式版本仍为 0.5.0 | [AI 学习系统 v0.6 版本实施计划：可信掌握闭环](AI学习系统-v0.6-版本实施计划-2026-07-22.md) |
| v0.7 | 活动实施计划 | Draft；批准后可与 v0.6 M7 收尾受控并行开发；`v0.7.0` 发布以 `v0.6.0` 正式发布为前置 | [AI 学习系统 v0.7 版本实施计划：游戏化掌握旅程](AI学习系统-v0.7-版本实施计划-2026-07-26.md) |
| v0.7 | 方向性预期 | 候选池（保留）；主方向已于 2026-07-26 由 repository owner 决策为「游戏化学习旅程」，概念图谱（2.1）仅「相同概念跨笔记聚合」切片进入 v0.7，其余候选继续保留供后续版本选择 | [AI 学习系统 v0.7 方向性预期](AI学习系统-v0.7-方向性预期-2026-07-22.md) |

v0.6 的实施进度见 [实施登记册](v0.6-implementation-register.md)，2026-07-26 审查结论与修复证据见 [实施审查与修复记录](../evidence/v0.6/implementation-review-and-fixes-2026-07-26.md)。M7 完成前不得把 v0.6 标记为 Released。

v0.7 计划批准后需另建 `v0.7-implementation-register.md` 与 `docs/evidence/v0.7/` 证据索引；其主方向决策与治理修订理由见计划正文 0.2 节及待立的 ADR-0011。

## 同期附加功能

| 功能 | 状态 | 文档 |
| --- | --- | --- |
| 来源收录简化与 URL 解析 | 已实施；真实中文编码/生产网络仍需验收 | [来源收录简化与 URL 解析修复方案](source-ingestion-simplification.md) |
| Milkdown WYSIWYG 编辑器 | 已实施；完整人工/E2E 清单仍需闭环 | [Milkdown 编辑器接入方案](milkdown-editor-integration.md) |
| 长笔记学习卡生成优化 | 仅方案设计，未计入 v0.6 已交付能力 | [长笔记学习卡生成优化方案](long-note-card-generation-optimization.md) |

活动实施计划的状态生命周期：`Draft → Approved → Superseded → Archived`。状态变化必须同步更新计划正文和本索引。

`Directional expectation` 只表示后续候选方向，不属于活动实施计划，也不授权提前实施；进入开发前必须另建并批准唯一 canonical 版本计划。
