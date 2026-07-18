# AI 学习系统产品愿景与当前实现偏差文档

> 对照文档：
>
> - `ai-learning-system-product-plan.md`
> - `ai-learning-system-v0-personal-beta.md`
> - `ai-learning-system-cloud-architecture.md`
> - `ai-learning-system-page-prd.md`
>
> 对照实现范围：
>
> - `apps/api/src/**`
> - `workers/ai-worker/src/**`
> - `apps/web/app/(workspace)/**`
> - `apps/web/components/**`
> - `packages/shared/src/**`
>
> 本文只讨论产品愿景、功能闭环、数据语义和可信链路偏差；页面视觉展示问题见 `UI-DESIGN-GAP-ANALYSIS.md`。

## 1. 总体结论

当前实现已经不是最早的纯 V0.1a happy path。它现在具备：

- 登录和 workspace session。
- Note / NoteVersion / NoteBlock。
- AI 学习卡生成 job。
- Evidence 对齐。
- Validation job。
- Understanding Event。
- Review Schedule。
- 前端驾驶舱、学习卡、复习、理解星图、来源、搜索等页面壳。

但实现仍然明显偏离产品愿景的核心：

> 产品愿景要做的是“追踪、验证并进化理解”的 AI 原生学习系统；当前实现更接近“AI 笔记 + 学习卡 + 一些理解状态 UI”。

最关键的问题不是“还缺几个功能”，而是：一些产品核心状态还没有真实数据闭环，却已经在 UI 和流程里被当成真实能力展示。

## 2. 产品愿景核心要求

产品文档定义的主线是：

```text
Source -> Note / Snapshot -> Evidence -> AIArtifact -> Concept / Understanding / Review
```

长期闭环是：

```text
输入 -> 解构 -> 建模 -> 呈现 -> 验证 -> 复习 -> 更新
```

V0 全量至少要证明：

- 用户能持续输入资料或笔记。
- 系统能把资料转成可编辑笔记。
- AI 生成内容不是孤立摘要，而是有证据引用的学习卡。
- 用户能通过问题验证是否理解。
- 系统能根据验证结果生成下一步复习建议。
- 数据结构支持后续扩展到网页、PDF、图片、图谱和多用户。

当前实现对其中部分对象建了表，但产品语义没有全部跑通。

## 3. 关键偏差清单

| 优先级 | 问题 | 当前实现 | 产品风险 |
|---|---|---|---|
| P0 | 理解状态大量是推断或占位 | 驾驶舱、学习卡列表、理解星图多处用卡片数量或数组下标推状态 | 用户会看到假的理解账户，破坏信任 |
| P0 | Source 输入池没有接入真实后端链路 | URL 草稿存在 `localStorage`，文本/Markdown/代码直接创建 Note | `Source -> Snapshot/Segment -> Note Draft` 断裂 |
| P0 | 硬引用门槛没有后端强制执行 | 验证和复习不检查 evidence 是否 hard aligned | 没有硬证据也可能升级理解状态 |
| P0 | Validation Question 不是持久产品对象 | 前端从 keyPoint claim 临时拼题 | 无 expected points，无可重算、可追溯验证题 |
| P0 | Learning Unit 缺失 | 直接用 learning_card 串 validation/review | 学习对象聚合层缺失，后续理解账户难扩展 |
| P1 | 复习更像任务清单 | 完成复习可直接标记，不要求复述/回答 | 偏离“知识再激活”，容易退化成打卡 |
| P1 | 学习卡模型太薄 | 只有 summary + key_points | 缺少关键概念、代码解释、易错点、验证题 |
| P1 | Note revision 不是强约束 | `baseVersionId` 可选，部分入口不传 | 自动保存和生成任务可能绑定错误版本 |
| P1 | Evidence 数据模型语义过窄 | evidence 只绑 keyPoint，不含 target_path / source_type | 很难支撑验证反馈、概念、图谱等后续证据 |
| P1 | 指标和假设验证缺失 | 没有回溯点击率、硬引用准确率、验证完成率等 | 无法判断产品假设是否成立 |
| P2 | 搜索、导出、数据主权未落地 | 搜索是前端过滤，导出缺失 | V0.3 和长期信任能力不足 |
| P2 | AI provider 默认 mock | 默认 provider 用启发式生成/判定 | 自用验证时容易误判真实 AI 质量 |

## 4. 详细问题

### 4.1 理解状态不真实

当前实现位置：

- `apps/web/app/(workspace)/page.tsx`
- `apps/web/app/(workspace)/graph/page.tsx`
- `apps/web/app/(workspace)/cards/page.tsx`

具体表现：

- 首页理解分数按学习卡数量计算，而不是来自 validation / understanding_events。
- 首页理解分布按学习卡数量比例估算。
- 首页显示“× 1 处待修正”“连续天数 1”等固定或推断状态。
- 学习卡列表的证据覆盖率按数组下标生成。
- 理解星图的状态、证据覆盖率、下次复习、误解次数按数组下标推断。

为什么严重：

产品愿景里“理解状态”是一等公民。用户看到的理解分数、薄弱点、误解次数、下次复习，都必须来自真实验证和复习事件。否则产品会从“理解账户”变成“看起来很智能的仪表盘”。

修正方向：

- 所有理解状态 UI 必须只读真实 `validation_events`、`understanding_events`、`review_schedules` 和 hard evidence 统计。
- 没有数据时显示空状态，不生成假分数。
- 先做最小理解状态 API，而不是前端推断。

### 4.2 Source 输入池没有跑通

当前实现位置：

- `apps/api/src/db/schema/note.ts`
- `apps/web/app/(workspace)/sources/page.tsx`
- `apps/web/app/(workspace)/sources/[id]/page.tsx`
- `apps/web/app/(workspace)/page.tsx`

具体表现：

- 后端有 `sources` 和 `source_segments` 表，但没有 Source API、Source service 或 worker 处理流程。
- 快速捕获粘贴 URL 时只写入 `localStorage`。
- 来源页只从 `localStorage` 读取 URL 草稿。
- 文本、Markdown、代码不是创建 Source，而是直接创建 Note。
- Source 详情页里的 snapshot、segment、相关学习卡、相关证据都是空壳。

为什么严重：

产品文档定义 Source 是外部资料进入理解系统的入口。Source 没跑通，Evidence 最终只能绑定 NoteVersionBlock，系统无法证明“用户接触过什么资料”，也无法支撑后续网页、PDF、图片、截图、代码片段等扩展。

修正方向：

- 增加 Source API：
  - `POST /sources`
  - `GET /sources`
  - `GET /sources/:id`
  - `POST /sources/:id/generate-note-draft`
- 文本/Markdown/代码先创建 source snapshot / segments，再生成 note draft。
- URL 只有链接时只保存 Source，不触发学习卡。
- 移除 `localStorage` Source 草稿作为产品数据源。

### 4.3 硬引用门槛没有强制执行

当前实现位置：

- `workers/ai-worker/src/handlers/index.ts`
- `apps/api/src/modules/review/service.ts`
- `apps/api/src/db/schema/evidence.ts`

具体表现：

- `runEvaluateValidation` 取 keyPoint 的第一条 evidence，有 block 就作为参考文本；不检查 `alignment === "aligned"`。
- 没有 hard evidence 时，会退回使用模型 quote。
- 无论 evidence 是否 hard aligned，只要 AI 判定为 `preliminary_understanding`，就会写 `validated` understanding event。
- Review schedule 也会照常生成。
- `unaligned` evidence 仍可能保留 `blockId`，和“未对齐 source_id 必须为空”的架构语义冲突。

为什么严重：

产品文档明确规定：只有硬引用能支撑长期理解状态；软引用和未对齐只能作为弱提示。当前实现会让软/弱证据进入理解升级链路，这是产品信任机制的核心漏洞。

修正方向：

- Validation 前校验 keyPoint 至少有一条有效 hard evidence。
- 没有 hard evidence 时：
  - 可以允许用户回答。
  - 可以返回反馈。
  - 但 outcome 不能升级为 `validated`。
  - review 可以是“回看证据/补证据”类型，而不是理解复习。
- `unaligned` evidence 不应保存 blockId。
- `userOverride=rejected/downgraded` 必须影响 hard evidence 判断。

### 4.4 Validation Question 不是持久对象

当前实现位置：

- `packages/shared/src/schemas.ts`
- `apps/web/app/(workspace)/cards/[id]/page.tsx`
- `workers/ai-worker/src/lib/prompts.ts`

具体表现：

- 学习卡生成 schema 只有 `title`、`summary`、`key_points`。
- 没有 `validation_question`。
- 没有 `expected_points`。
- 没有验证题对应的 evidence refs。
- 前端用 `buildPrompt()` 根据 claim 临时拼题。

为什么严重：

验证题是产品判断“用户是否理解”的入口。它应该是可追溯、可重算、可解释的 AIArtifact 或 Learning Unit 子对象。临时拼题无法保证题目质量，也无法让 expected points 和 hard evidence 绑定。

修正方向：

- 扩展 learning card output schema：
  - `validation_question`
  - `expected_points`
  - `question_type`
  - `evidence_refs`
- 或单独生成 `AIArtifact(type=question)`。
- ValidationEvent 必须引用持久 question，而不是只保存前端传入的字符串。

### 4.5 Learning Unit 聚合层缺失

当前实现位置：

- `apps/api/src/db/schema/card.ts`
- `apps/api/src/db/schema/evidence.ts`

具体表现：

- 当前直接用 `learning_cards` 连接 key_points、validation_events、review_schedules。
- 没有 `learning_units` 表。
- Validation 和 Review 的 subject 在 `card` / `validation` 之间切换。

为什么严重：

产品文档中 Learning Unit 是聚合层：它可以来自 note_version 或 source，聚合学习卡、验证问题、验证记录和复习计划。没有这个层，后续从 Source、PDF、图片、Concept 生成学习对象会变得混乱。

修正方向：

- 增加 `learning_units`：
  - `workspace_id`
  - `source_type`
  - `source_id`
  - `current_card_id`
  - `status`
  - `created_at`
- `validation_events` 和 `review_schedules` 优先绑定 learning_unit。
- learning_card 是 learning_unit 的一个派生 artifact，不是唯一学习对象本身。

### 4.6 复习流程偏成打卡任务

当前实现位置：

- `apps/web/app/(workspace)/review/page.tsx`
- `apps/api/src/modules/review/service.ts`

具体表现：

- 复习页展示到期卡片队列。
- 复习抽屉显示关键要点、模型引用、原文。
- 用户可以直接点击“标记完成”。
- 没有复述输入、验证反馈、下一题。
- 每条复习没有清楚说明“为什么出现”。

为什么严重：

产品文档说复习不是打卡，而是知识再激活。当前复习流程没有真正触发再表达或再验证，完成事件的含义偏弱。

修正方向：

- Review attempt 需要记录：
  - 用户是否回看原文。
  - 用户是否复述/回答。
  - 是否再次写入 understanding_event。
- 复习卡片必须展示原因：
  - 上次表达不清。
  - 有误解。
  - 到期轻触。
  - 证据不足。
- “完成”应基于一次轻量交互，而不是直接点击。

### 4.7 学习卡内容模型太薄

当前实现位置：

- `packages/shared/src/schemas.ts`
- `workers/ai-worker/src/lib/prompts.ts`
- `apps/api/src/db/schema/card.ts`

具体表现：

- 学习卡只有 `summary` 和 `key_points`。
- 代码块没有独立解释。
- 易错点没有结构化字段。
- 关键概念没有抽取。
- “一句话记住”没有字段。
- validation question 没有字段。

为什么严重：

参考 PRD 和 V0 文档里，学习卡是一个可学习、可验证、可复习的知识对象，不是摘要加要点列表。内容模型太薄会让学习卡页难以成为产品记忆点，也会影响验证和复习质量。

修正方向：

- 扩展学习卡 schema：
  - `core_understanding`
  - `key_points`
  - `code_explanations`
  - `pitfalls`
  - `remember_this`
  - `validation_question`
  - `evidence_refs`
- Evidence 必须能指向每个具体字段，而不只是 keyPoint。

### 4.8 Note revision 不是强约束

当前实现位置：

- `apps/api/src/modules/note/schema.ts`
- `apps/api/src/modules/note/service.ts`
- `apps/web/components/NoteEditor.tsx`

具体表现：

- `baseVersionId` 是 optional。
- 后端只有传了 `baseVersionId` 且更新 blocks 时才检查冲突。
- 快速捕获和来源创建 Note 后更新 blocks 时不传 `baseVersionId`。
- `NoteEditor.save()` 捕获 409 后不向 `generateCard()` 抛出失败，存在继续用旧版本 id 派发生成任务的风险。

为什么严重：

产品架构要求 AI 结果必须绑定当时快照。自动保存和生成任务如果没有强 revision 约束，会导致学习卡/Evidence 绑定到用户并不期望的版本。

修正方向：

- 内容更新必须要求 `baseVersionId`。
- 创建 Note 后的首次写入也要使用当前 version id。
- 保存冲突时必须阻断生成学习卡。
- 前端冲突状态要给出明确恢复动作，而不是短暂提示后继续。

### 4.9 Evidence 模型不够通用

当前实现位置：

- `apps/api/src/db/schema/evidence.ts`
- `apps/api/src/modules/evidence/service.ts`

具体表现：

- Evidence 只绑定 `keyPointId`。
- 没有 `target_type`、`target_id`、`target_path`。
- 没有 `source_type`。
- 不能直接表达：
  - validation feedback 的证据。
  - pitfall 的证据。
  - concept relation 的证据。
  - source segment 的证据。
  - asset region 的证据。

为什么严重：

产品愿景中 Evidence 是所有 AI 结论的信任底座。当前模型只够学习卡 keyPoint 使用，后续一旦扩展到验证反馈、误区、图谱和个人手册，会出现重复表或语义混乱。

修正方向：

- 升级为通用 `evidence_refs`：
  - `target_type`
  - `target_id`
  - `target_path`
  - `source_type`
  - `source_id`
  - `quote_text`
  - `alignment_status`
  - `alignment_score`
  - `alignment_candidates_json`
- 保留 keyPoint 便捷查询视图，但不要让 schema 只服务 keyPoint。

### 4.10 产品假设验证缺失

当前实现位置：

- 当前代码中基本缺失。

具体表现：

- 没有 Evidence 回溯点击记录。
- 没有硬引用人工抽样/benchmark 流程。
- 没有验证完成率。
- 没有复习完成率统计。
- 没有学习卡生成率。
- 没有连续使用数据。
- 没有导出能力。

为什么严重：

V0 Personal Beta 的目标不是功能堆满，而是验证关键假设：

- AI 能否稳定产出可对齐 Evidence 的学习卡。
- 用户是否愿意持续输入、验证和复习。
- 理解状态追踪是否比普通笔记更有价值。

没有指标，就无法知道产品方向是否成立。

修正方向：

- 增加最小 analytics/events：
  - `note_created`
  - `card_generated`
  - `evidence_opened`
  - `validation_submitted`
  - `review_completed`
  - `review_dismissed`
- 增加 Evidence benchmark 脚本或后台页面。
- 增加个人数据导出。

## 5. 当前已经做对的部分

这不是全盘否定。当前实现有几个方向是对的：

- workspace/session 已经接近未来多用户方向。
- NoteVersion 和 NoteBlock 已经有不可变快照雏形。
- AIArtifact 已经统一存储模型输出。
- Job worker 有重试、锁定和状态。
- Validation / Review 表已经初步落地。
- Evidence 抽屉和 override 操作方向正确。
- DashScope provider 经过 schema 校验后写入，方向正确。

问题在于这些能力目前还没有严格收束到产品愿景要求的可信学习闭环里。

## 6. 修正优先级

### P0：先修可信闭环

1. 禁止前端生成假的理解状态和证据覆盖率。
2. Validation / Review 必须强制 hard evidence 门槛。
3. Source API 和 Source -> Segment -> Note Draft 跑通。
4. Validation Question 持久化，绑定 expected points 和 Evidence。

### P1：补产品对象

5. 增加 Learning Unit。
6. 升级 Evidence 为通用 evidence_refs。
7. 扩展 Learning Card schema。
8. Review attempt 记录用户复述/回答和反馈。

### P2：补长期能力

9. 搜索投影或后端搜索。
10. Markdown + JSON 导出。
11. Evidence benchmark 和最小行为指标。
12. 数据删除、归档和隐私承诺入口。

## 7. 建议的下一步落地顺序

建议不要继续横向加页面，而是按下面顺序收敛：

```text
1. 去掉所有假理解状态展示
2. 后端提供真实 learning status summary
3. Source API 跑通文本 / Markdown / 代码
4. 学习卡生成同时生成 validation question
5. validation 只允许 hard evidence 支撑升级
6. review 从 validation outcome + evidence reason 生成
7. 学习卡详情页按真实对象重做展示
```

这条路径能让产品重新回到“理解状态可信”这个主轴上。

## 8. 一句话

当前实现的问题不是功能少，而是过早展示了“理解账户”的样子，却没有让理解状态严格来自 Source、Evidence、Validation 和 Review 的真实链路。

下一轮最重要的不是继续丰富页面，而是把这条链打穿：

```text
真实输入
-> 可追溯证据
-> 结构化学习卡
-> 持久验证题
-> 用户回答
-> 有证据约束的理解事件
-> 有原因的复习计划
```

