# Plan 23 Stop Line 代码审查清单（W0-01）

> 依据：`docs/plans/learning-companion/23-learning-objective-content-topology-system-rebase.md` §1.4 Stop Line、§5 产品原则、§6 页面职责矩阵、§29.2 通用完成标准。
>
> 用途：Code Review / PR 模板引用。任何 PR 若命中下方任一 Red 项，**必须**在合入前删除或给出 Owner 书面豁免；Green 项为鼓励方向，不构成强制。

## 版本与录入

| 字段 | 值 |
|---|---|
| 冻结文档 | 23 方案 §1.4 / §5 / §6 / §29.2 |
| 评审基期 | 2026-08-16（推进本方案期间持续更新） |
| 维护者 | implementation 记录 |

---

## 一、Red：立即停止并退回的形态（§1.4）

| # | 检查项 | 命中示例 |
|---|---|---|
| R1 | 首页继续基于旧 `/cards`、`schemaJson.title/summary` 增加功能 | 新增的 Home section 读取 `listCards()` 返回值拼接标题 |
| R2 | 把 `PublicLearningCardV2` 转成 legacy `CardListItem` 后再开发新功能 | 卡库/详情把 V2 DTO 塞进 `CardListItem` union adapter |
| R3 | 星图继续增加 `Card → alias key_point` 临时补丁 | projection adapter 为 V2 Objective 伪造 keyPoint 节点 |
| R4 | 让 Card 详情重新承载本地作答、填空、排序、判断或提交 | 详情页出现 textarea / cloze / ordering / submit 输入 |
| R5 | 把公开 Card 的 `front.prompt` 当成系统内知识标题或知识摘要 | 用 prompt 生成列表标题、图谱 label、搜索结果 |
| R6 | 为 legacy archived alias 增加正式统计、搜索或图谱可见性 | Stats/Search/Graph 计入 alias card |
| R7 | 为 Home、Today、Graph、Pet 分别实现不同的 V1/V2 合并逻辑 | 页面各自 `v1.concat(v2)` 去重 |
| R8 | 把 answer、rubric、完整 quote 或 private assessment 放入公共 DTO | Dashboard/Surface/Search 响应含 `canonicalAnswer` |
| R9 | 前端根据 label 文本或本地时钟推断 action / eligibility / lifecycle | 通过 CTA 文案判断 resume vs create |
| R10 | 以复制 summary/claim 作为临时正式事实 | 新代码读 `card_key_points.claim` 当题目 |

## 二、Green：鼓励且不违反停止线的方向（§1.4 第二段）

| # | 检查项 |
|---|---|
| G1 | 方案 16 LearningRun / Artifact / Assessment / Commit / Schedule / Projection 既有合同 |
| G2 | 方案 20 Candidate / Activation / Reveal / Revision / TargetSnapshot 正确性 |
| G3 | 安全、RLS、幂等、性能和无障碍缺陷修复 |
| G4 | 不依赖旧 Card 内容模型的 UI 基础设施（token、skeleton、可访问控件） |

## 三、通用完成标准（§29.2，任务标记 done 前置条件）

| # | 检查项 |
|---|---|
| D1 | 交付物与 Wave 表中描述一致 |
| D2 | scoped typecheck / lint / test 通过 |
| D3 | 无 answer/rubric/quote/private assessment 进入公共 DTO |
| D4 | 新读取逻辑以 `objectiveId` 为身份，不重新依赖 legacy Card summary |
| D5 | 新写入有 workspace / user 权限边界、幂等或 OCC 约束 |
| D6 | 涉及 UI 时覆盖 loading、empty、error、stale、窄屏 |
| D7 | 涉及迁移时提供 dry-run、reconciliation 与 rollback 证据 |

## 四、评审记录

| 日期 | PR / commit | 结论 |
|---|---|---|
| — | — | — |
