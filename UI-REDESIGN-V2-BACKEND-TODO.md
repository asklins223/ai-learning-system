# UI Redesign V2 Backend TODO

本轮前端先按 `product-design-assets/ui-redesign-v2` 落地真实应用界面。以下能力在设计稿中已展示或预留，但当前后端接口尚未完整支持，前端只能展示静态说明、局部草稿或从详情页读取。

## Dashboard / Today

- 需要统一的今日事件流接口，聚合 note、card、validation、review、evidence、job 事件。
- 需要今日摘要接口，返回新增笔记、学习卡、验证、误解、复习、证据缺口等计数。
- 需要明日轻触建议接口，基于 review schedule 和 validation outcome 排序。

## Sources

- 需要 Source / Source Snapshot / Source Segment 的正式 CRUD API。
- URL 抓取、正文抽取、分段、生成笔记草稿目前未接通。
- 来源列表需要返回解析状态、片段数、关联笔记、关联学习卡和证据覆盖。
- 需要来源详情接口，返回原文快照、分段、关联笔记、相关证据和处理任务。

## Search

- 需要统一搜索接口，按业务对象分组返回 note、card、evidence、source、review。
- 需要高亮命中字段、跳转目标、对象类型、相关证据和复习状态。

## Notes / Cards Lists

- 笔记列表需要聚合学习卡数量、证据缺口、最近 AI 任务状态。
- 学习卡列表需要聚合 hard/soft evidence 数量、最近 validation outcome、review due 状态。

## Graph

- 需要学习对象图谱接口，返回节点、关系、状态、来源和证据覆盖。
- 当前只能用 card 列表近似展示，不能推断节点大小、关系强度或掌握状态。

## Review

- 需要复习队列排序原因：misunderstanding、evidence_gap、due_review、manual_pin。
- 需要复习尝试写入接口，包含回答、反馈、下一次复习安排和状态推进规则。
- 需要证据回看入口关联 source_segment。

## Mobile Review

- 需要移动端复习专用 API 响应，减少桌面详情字段。
- 需要离线/弱网状态和提交重试策略。
