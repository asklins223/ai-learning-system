# AI 学习系统 v0.6 版本实施计划：可信掌握闭环

> 状态：Approved（M0-M6 为代码候选；2026-07-26 修复后全量单元回归与数据库、AIQ、Worker、Web、会话恢复审查已完成；M7 未开始；正式版本仍为 0.5.0，v0.6 尚未发布）<br>
> 文档版本：3.5<br>
> 计划日期：2026-07-22<br>
> 批准日期：2026-07-24<br>
> 目标版本：`v0.6.0`<br>
> 产品阶段：Private Alpha 深化<br>
> 基线版本：`v0.5.0`<br>
> Base SHA：`40fdf1c`（merge: complete v0.5 workspace implementation）<br>
> v0.6 分支：`v0.6-implementation`<br>
> v0.5 迁移末端：`0039_sec01_policy_catalog_repair.sql`<br>
> v0.6 迁移末端：`0043_v06_rls_context_alignment.sql`<br>
> 关联决策：ADR-0004、ADR-0005、ADR-0010<br>
> 最新审查证据：[v0.6 实施审查与修复记录（2026-07-26）](../evidence/v0.6/implementation-review-and-fixes-2026-07-26.md)<br>
> 文档 Owner：repository owner `@asklins223`<br>
> 容量假设：2 条并行实施流时 7～9 周；单实施流 10～12 周；随后至少 14 日受控观察<br>
> 一句话目标：让系统能够基于当前硬证据提出不泄露答案的问题，在用户独立作答后逐项判断理解，并以可解释、可回放的结果安排下一次复习。

> **重要声明**：本文只定义 v0.6 的目标、边界、依赖和验收门槛，不代表任何条目已经实现，也不授权跳过评审直接修改代码、数据库或部署环境。所有 checkbox 初始均为未完成；已有代码只有在绑定 clean SHA 与验收证据后才能计入完成度。

## 0. 文档治理、基线与版本边界

### 0.1 Canonical 计划

本文件是唯一 canonical v0.6 活动计划，固定路径为：

`docs/plans/AI学习系统-v0.6-版本实施计划-2026-07-22.md`

发现入口为 `docs/plans/README.md`。详细方案获批后状态从 `Draft` 进入 `Approved`，并另建精简的实施登记册和证据索引；不得把逐次实施日志不断堆入本文。

### 0.2 决策依据

Repository owner 已选择方向 A“可信掌握闭环”，并要求没有进入 v0.6 的概念图谱、Embedding、Vision、流式、多模型路由、完整结构化反馈、自适应题库和 FSRS 正式接管进入 v0.7 方向性预期。

ADR-0010 固定以下主链：

```text
硬证据
  → AI question + rubric
  → question-first 独立作答
  → rubric 逐点评估
  → 服务端确定性 outcome
  → 证据化反馈
  → 统一离散调度
```

### 0.3 当前工作树不是发布基线

当前仓库仍声明 `0.5.0`，工作树包含大量未提交或尚未正式发布的多工作区、图片、迁移、安全和质量能力。v0.6 M0 必须先完成：

1. 确认 v0.5 的 clean accepted SHA、迁移末端与 release evidence；
2. 明确当前工作树每项能力属于 v0.5 收尾、v0.6 baseline candidate 还是未采用实验；
3. 关闭或正式记录 v0.5 剩余 RLS、E2E、真实 Provider、Alpha 环境和发布审批阻断；
4. 从可复现基线建立 v0.6 分支和迁移序列。

在此之前不得修改 `release/version.json`、package 版本或 README，把本计划误写成已发布能力。

### 0.4 多工作区与图片候选基线的版本归属

Personal Workspace First、工作区切换、加入/退出、头像和笔记图片等已经进入当前工作树，但在绑定 clean accepted SHA 前只能称为 baseline candidate。它们不再作为 v0.6 产品主线；M0 决定归属后，纳入的能力必须继续满足 RLS、迁移、导出、删除、备份、恢复、三视口和发布门禁，但不与本版 AI 工作包争夺 Must 叙事。

当前 v0.5 计划、实施登记册和证据索引对 Must 数量、DoD 完成度和剩余比例存在不同快照口径。M0 必须先统一同一日期、同一分母和同一证据源；未统一前不得用任一百分比宣称 v0.5 已完成，也不得据此冻结 v0.6 Base SHA。

ADR-0002/0003 的当前工作树还包含对 Accepted 决策的直接 amendment。M0 必须按 ADR 治理规则确认：保留历史原文，只在旧文档顶部添加非决策性指向，并把新的版本分配或补充决策收口到后继 ADR。本文不擅自回退这些已有用户改动。

## 1. 当前事实与核心缺口

| 领域 | 当前事实 | v0.6 缺口 |
| --- | --- | --- |
| 验证题 | `validation_questions` 已绑定 card/key point/note version，但题面由前端 `buildValidationPrompt` 生成后提交 | 题目不是 AI artifact，没有 rubric、用户级 fingerprint、生命周期和服务端难度/题型决策 |
| 验证输入 | API 仍兼容客户端提交完整 `question/questionType` | 任意客户端题面不能成为可信理解升级依据 |
| AI 评估 | 已输出 covered/missing/misunderstandings，但模型临时拆点并直接给总体 outcome | 缺少持久 rubric item、逐项 assessment、数据库 evidence 绑定和确定性 reducer |
| 验证 UX | 卡片正文、claim、quote 与验证面板同屏；`ValidationPanel` 提交前挂载证据引用 | 测到的可能是看答案后的复述，不是真正主动回忆 |
| Review UX | 原文虽折叠，但用户查看后仍可自选“掌握”，客户端 outcome 驱动调度 | 需要服务端评估、assistance 记录和保守升级门禁 |
| 卡片生成 | 一次模型调用后运行 `sanitizeCardOutput`；严格结果为空时会渐进放宽 fallback | 缺少 reason code、按需二次修复、修复链路和硬失败策略 |
| 调度 | Review Attempt 使用 `[1,3,7,14,30,60]`，Worker 首次验证另有 `0/1/3` 天映射 | 两套入口语义不一致，`partial` 仍会前进间隔 |
| AIQ | 现有 30 篇数据集主要衡量 citation precision 与 coverage | 缺少 question/rubric、逐点评估、虚假掌握和条件式修复质量集 |
| Provider | Mock、DashScope、OpenAI-compatible 已有，调用契约只覆盖 card 与 evaluation | 缺少 question 和 repair 契约、统一 usage/cost 记录 |

关键实现基线：

- `apps/api/src/db/schema/evidence.ts`
- `apps/api/src/modules/validation/service.ts`
- `apps/api/src/modules/review/attempt-service.ts`
- `apps/api/src/modules/review/scheduling-policy.ts`
- `apps/web/components/ValidationPanel.tsx`
- `apps/web/lib/validation-question.ts`
- `workers/ai-worker/src/handlers/index.ts`
- `workers/ai-worker/src/lib/card-quality.ts`
- `packages/shared/src/prompts.ts`
- `packages/ai-quality/src/scorer.ts`

## 2. 目标用户与关键旅程

### 2.1 目标用户

1. **个人学习者**：希望不看原文检验自己是否真的理解，并获得具体、可信的补充建议；
2. **协作空间中的学习者**：共享 workspace-owned 内容，但题目、回答、评估和复习历史仍按 user 隔离；
3. **Workspace Owner / 维护者**：配置 Provider、查看去内容化质量与成本，不读取成员个人回答；
4. **版本维护者**：通过固定数据集和 release evidence 判断 AI 变化是否安全发布。

### 2.2 旅程 A：首次可信验证

```text
打开当前 active 学习卡
→ 选择“开始验证”或具体 key point
→ 服务端检查当前用户有效硬证据
→ 选择已有有效题目，或异步生成 question + rubric
→ 进入独立 Focus 会话
→ 在 claim/quote/expected points 不可见时作答
→ AI 逐项判定 rubric
→ 服务端汇总 outcome
→ 揭示覆盖点、缺失点、误解和硬证据
→ 解释下一次复习日期与 reason code
```

### 2.3 旅程 B：到期复习

```text
打开复习队列
→ 进入单条 Focus 会话
→ 恢复已有 attempt 或开始新 attempt
→ 服务端返回同一条有效问题
→ 用户作答或选择“暂时想不起来”
→ 服务端评估并生成 canonical review outcome
→ attempt、反馈、理解事件和下一 schedule 原子完成
→ 用户看到本次间隔变化原因
```

### 2.4 旅程 C：AI 失败时保守降级

```text
题目生成 Provider 失败
→ 尝试创建同样绑定 hard evidence/fingerprint 的持久化 deterministic fallback
→ fallback 成功则进入正常作答；瞬时故障则进入 question_retryable
→ 内置 fallback 自身未通过 safety gate 则进入不可重试 question_blocked 并告警
→ hard evidence 已失效等不可重试故障则阻断会话，不创建结果或 schedule

评估 Provider 失败
→ 最终答案和绑定 revision 保存在 submission
→ 进入 evaluation_retryable，不创建 canonical outcome、assessment 或 schedule 副作用
→ 使用同一 submission/question 幂等重试；unable 只由用户显式选择产生
```

### 2.5 旅程 D：卡片质量修复

```text
生成 card draft
→ 确定性质量检查输出 issue reason codes
→ 无触发：直接进入既有落库和 evidence alignment
→ 有触发：同 Provider 最多修复一次
→ 使用同一检查重新验证
→ hard gate 通过才创建 active card，否则 job 失败
```

## 3. 版本目标与非目标

### 3.1 目标一：题目本身可信

- 每个可升级题目都有 user、card、key point、note version、artifact、rubric version、硬证据和 source fingerprint；
- 客户端只拿到净化题面，不拿到评分标准和答案上下文；
- 同一 active attempt 刷新或跨设备后恢复同一 question identity；
- 题目 stale 后保留历史，但不能产生新升级。

### 3.2 目标二：AI 只判断逐项事实，业务规则决定结果

- AI 不再自由决定总体 outcome；
- 每个 rubric item 恰好一个 assessment，未知 ID、遗漏项或重复项均 fail closed；
- outcome、review rating 和 schedule 由版本化纯函数从 assessments 重算；
- 用户看到的每个“已覆盖/待补充/需纠正”都能回到 rubric item 和 evidence snapshot。

### 3.3 目标三：主动回忆不被答案泄漏破坏

- 首次验证和复习均为独立 Focus 页面；
- `unassisted_answering` 阶段的全部 API 响应、RSC/hydration 数据、预取数据和 DOM 不包含生成卡片/笔记标题、claim、quote、blockContent、expected points、evidence refs、已完成历史答案或历史反馈；
- 查看原文是显式、可审计动作：服务端先原子切换为不可逆的 `assisted_review`，再返回受权限控制的原文；该阶段允许展示证据，但本轮不能提升理解状态；
- 活跃会话内打开卡片、笔记或来源的入口必须先选择“查看原文并继续”或“放弃本轮”；可信升级依赖服务端记录的 assistance，而不声称能阻止用户从其他窗口自行查阅资料；
- 客户端不能通过提交 `outcome=correct` 推进 schedule。

### 3.4 目标四：提高卡片质量但控制第二次调用

- 默认仍只调用一次模型；
- 第二次调用只能由确定性 reason code 触发且最多一次；
- repair 前后都记录 prompt/model/usage、质量报告和 artifact lineage；
- 修复不能绕过 quote/evidence/schema hard gate。

### 3.5 目标五：统一调度并积累 FSRS 对照数据

- 首次验证和复习共用 `discrete-v2`；
- schedule 变更都有 policy version、before/after、reason code；
- FSRS 只写 shadow decision，对正式到期时间零影响；
- v0.6 不以“间隔变长”宣称 FSRS 成功。

### 3.6 明确非目标

本版本不做：

- 自动 Concept Graph、概念合并、前置依赖和矛盾真值；
- 生产级 Embedding evidence 替换；
- 图片真实视觉理解、OCR、PDF/Office 摄取；
- 流式 token 输出和多模型自动路由；
- FSRS 正式接管、个体参数在线拟合或面向普通用户展示 D/S/R；
- 选择题、判断题、填空、排序和无执行沙箱的代码题；
- 全库聊天或通用 AI 导师；
- 因为某位用户答错而自动修改共享学习卡；
- 自动把旧 key point 的理解历史迁移到重新生成的相似 key point；
- 模糊的“掌握百分比”或把模型 confidence 当作理解程度。

## 4. 成功指标与硬门禁

### 4.1 安全与业务不变量

以下任一失败均阻断 RC：

- [ ] 0 次跨 workspace/user 题目、回答、rubric、assessment 或复习历史泄漏；
- [ ] 0 次客户端自由题面或客户端 outcome 产生理解升级；
- [ ] 0 次无当前用户有效硬证据的理解升级；
- [ ] 0 次在 `answer_locked_at` 之前发生的 assistance 却延长正式间隔；post-result exposure 不回改历史结果，但必须门禁下一次 trusted start；
- [ ] 0 次 stale fingerprint 产生新 schedule 或升级事件；
- [ ] 100% 新可信结果绑定 question、rubric version、submission/attempt、artifact 和逐项 assessment；
- [ ] 100% outcome 可从持久化 assessments 与 reducer version 确定性重算；
- [ ] 相同输入、重复 job、网络重试只产生一条结果和一个后继 schedule；
- [ ] FSRS shadow 对 `review_schedules.next_review_at/interval_days` 的正式写入为 0；
- [ ] telemetry、日志和 metrics 不包含题面、答案、claim、quote、expected concept 或 Provider 原始响应。

### 4.2 AI 质量门禁

M0 冻结以下数据集、人工标签规则和阈值。阈值只允许在实施前通过 ADR 修订，不得在 RC 失败后降低。

| 数据集 | 最小规模 | 主要标签 | RC 建议门槛 |
| --- | ---: | --- | --- |
| Question/Rubric Gold v1 | ≥ 60 个跨领域 key point | 题型适配、答案泄漏、rubric 完整性、证据支持、人工接受 | schema/ref 完整性 100%；答案泄漏 0；hard-evidence support precision ≥ 95%；人工接受率 ≥ 85% |
| Evaluation Gold v1 | ≥ 120 个回答，覆盖正确/部分/明确误解/无法判断 | 每个 rubric item verdict、总体 outcome、关键误解 | outcome weighted κ ≥ 0.75；关键类别 recall 均 ≥ 0.70；含实质误解却判 preliminary 的 false-mastery rate ≤ 5% |
| Evidence Feedback Gold v1 | 包含所有评估样本 | evidence snapshot 与用户反馈对应关系 | evidence reference precision ≥ 95%；未知/伪造 evidence ref 为 0 |
| Card Repair Gold v1 | ≥ 30 个含可注入质量缺陷的 card draft | trigger reason、修复后 hard gate、非回归 | hard violation 0；既有 90/85/85 指标不得回归；非触发样本二次调用为 0 |

人工标注至少双人独立完成高风险“misunderstanding vs preliminary”样本，并记录分歧解决。样本不足必须写 `insufficient_data`，不能包装为通过。

### 4.3 产品观察指标

以下用于 14 日 Alpha 观察，不单独替代硬质量门禁：

- 有资格卡片中成功开始 question-first 会话的比例；
- 会话开始、提交、完成和结果查看的分子/分母；
- `暂时想不起来`、查看原文、评估重试和放弃比例；
- 用户提交“判定有问题”的比例与原因；
- 同一 key point 的重复错误和随后纠正比例；
- question generation、evaluation、repair 的 Provider 分桶延迟、token 和估算成本；
- repair 触发率、一次修复成功率和 hard-failure 率；
- discrete-v2 与 FSRS shadow 的 due-date 差异、预测分桶校准和模拟工作量。

小样本指标必须同时显示分子、分母、观察周期和 Provider/model，不只显示百分比。

### 4.4 体验与运行 SLO

- 已缓存有效题目的 session start p95 < 1.5 秒；
- 冷启动 question/evaluation 按 Provider 分桶，样本不足只报告；真实 Provider p95 目标在 M0 基线后冻结；
- job 失败后答案保存成功率 100%，幂等重试不重复业务副作用；
- 5 秒仍未完成的评估显示可离开的后台状态，用户可从同一会话恢复；
- 390 / 768 / 1440 三视口、200% zoom、键盘主路径和 WCAG 2.2 AA serious/critical 为 0。

## 5. 版本范围

### 5.1 Must

| 工作包 | 核心结果 |
| --- | --- |
| FDN-06 | 冻结 v0.5 clean baseline、迁移末端、版本边界和 v0.6 feature flags |
| QUEST-01 | 服务端 AI question + 持久 rubric + hard-evidence fingerprint + deterministic fallback |
| EVAL-02 | 持久 submission、rubric 逐点评估、服务端 reducer、证据化反馈 |
| UX-06 | 首次验证与复习的独立 question-first Focus 会话、assistance 与恢复 |
| CARD-02 | 带 reason code 的 card quality report 与最多一次条件式修复 |
| SCHED-02 | `discrete-v2` 单一正式策略、key-point 维度 trace、FSRS shadow |
| AIQ-02 | 三类新黄金集、评分器、PR Mock gate、RC 真实 Provider gate |
| QLT-06 / REL-06 | RLS、迁移、导出恢复、故障、三视口 E2E、灰度与发布证据 |

### 5.2 Should

- compare / diagnose 两种开放题，仅在 Question Gold 达标后开启；
- 到期前预生成下一条题目，避免用户在 Review Focus 中等待；
- “判定有问题”的轻量结构化信号和自动冻结升级影响；
- Owner 可查看去内容化的 question/evaluation/repair 质量与成本摘要；
- provider request ID、prompt/completion tokens 与估算成本完整回填；
- 针对 answer repetition、关键词堆砌和 prompt injection 的对抗样本扩展。

### 5.3 Could

- 内部 AIQ 样本审阅器；
- question/evaluation 失败完成通知；
- 对修复 trigger 进行 prompt A/B，但不得在同一 RC 混用未记录版本；
- Firefox 之外的额外浏览器矩阵。

### 5.4 删减线

如容量不足，按以下顺序裁剪：

1. 所有 Could；
2. compare / diagnose；
3. 预生成和 Owner 摘要；
4. card soft-trigger repair，只保留 hard-trigger repair；
5. FSRS shadow 的产品分析面，只保留 append-only 数据与离线报告。

QUEST-01、EVAL-02、question-first 泄漏边界、统一正式调度、硬质量门禁和安全/迁移门禁不可裁剪。

## 6. 领域模型与数据设计

### 6.1 Canonical 学习单位

v0.6 的验证与调度单位固定为：

`(workspace_id, user_id, key_point_id)`

card 仍是阅读和导航容器；question、rubric、validation、review attempt 与 pending schedule 必须能落到具体 key point。新 schedule 使用显式 `key_point_id`，旧 `subject_type/subject_id` 暂时保留兼容。

### 6.2 `validation_questions` 扩展

建议新增：

- `user_id`：问题按当前学习者及其 evidence override 隔离；
- `artifact_id`、`generation_job_id`；
- `generator_kind`：`ai | deterministic`；
- `status`：`active | stale | superseded | expired | legacy_unrubriced`；
- `rubric_version`；
- `source_fingerprint`；
- `superseded_at`、`stale_reason`；
- `last_used_at`、`use_count`。

保留现有 card、key point、note version、question type、question、created by 和 expires at。v0.6 每个 `(workspace,user,key_point,source_fingerprint)` 最多一条 active question；多题并存和题库去重留给 v0.7。新可信读取必须同时校验 user、`status=active`、`expires_at > transaction_timestamp()`、fingerprint 和 hard evidence。正确性不依赖定时任务：start、resume、submit 和评估写结果都要锁 question 并执行到期门禁；发现已到期时原子执行 `active → expired`，并把进行中的 submission 置为 stale。`legacy_unrubriced` 永远不能进入可信读取或产生升级。

### 6.3 新增 `validation_question_rubric_items`

AI 题目使用 2～5 个 rubric item；确定性 fallback 允许 1 个 required item：

- `id`、`workspace_id`、`question_id`、`ordinal`；
- `criterion`：用户回答应满足什么；
- `expected_concept`：评估端使用，提交前不返回客户端；
- `weight`：1～3；
- `required`；
- `evidence_id`；
- `evidence_snapshot`：note version、block、quote、alignment、用户 override 结论；
- `created_at`。

每项必须绑定一条当前用户有效 hard evidence。模型只使用本次请求中由服务端生成的 opaque `evidenceRefId`，Worker 再映射回真实 evidence ID。

### 6.4 新增 `validation_submissions`

它保存首次验证和 Review AI 评估的进行中事实，避免答案只存在于 job payload：

- workspace/user/card/key point；`question_id` 在 `question_preparing/question_retryable` 阶段可空，进入 `ready/answer_saved` 前必须补齐；
- `context`：`initial_validation | review`；
- `review_attempt_id`、`input_schedule_id`（review 场景，两者必须同时存在）；
- `user_answer`、`self_confidence`（三档，可空）；
- `draft_revision`：单调递增；`answer_hash`：服务端带密钥摘要，用于把提交绑定到明确草稿版本；
- `answer_locked_at`、`assistance_snapshot_exposed_at`：提交时在 learning-unit guard 内冻结独立作答资格；
- `assistance_level`：`none | source_viewed`；
- `evidence_revealed_at`；
- `source_fingerprint`；
- `status`：`question_preparing | ready | answer_saved | evaluation_pending | question_retryable | evaluation_retryable | question_blocked | completed | stale | abandoned`；
- `current_generation_job_id`、`current_evaluation_job_id`、`validation_event_id`；
- `failure_stage`、`failure_code`（不得包含 Provider 原始响应或回答正文）；
- `terminal_reason`（如 `user_abandon | later | source_stale | unsafe_fallback`）；
- `start_idempotency_key` 与 timestamps。

`question_blocked | completed | stale | abandoned` 才是终态；两个 `*_retryable` 状态仍属于同一 active submission。同一 `(workspace,user,key_point,context)` 最多一个未终态 submission；相同 start idempotency key 必须返回原 submission。Worker 的自动重试沿用同一 job row 和既有 `jobs.attempts`；达到终态失败后，用户触发的 phase retry 才创建新 job row。新增轻量 `validation_submission_jobs(submission_id, phase, phase_ordinal, job_id, retry_of_job_id, created_at)` 保存全部 lineage，并对 `(submission_id, phase, phase_ordinal)` 与 `(submission_id, job_id)` 唯一；同一去重后的 question generation job 可以绑定多个等待它的 submission，submission 的单值 job 字段只指向当前 job，不能覆盖历史。

#### 6.4.1 Action 级幂等账本

新增 `validation_action_commands`：workspace/user、可空 submission、action、idempotency key、request hash、response status/snapshot 与 timestamps；唯一键 `(workspace_id,user_id,action,idempotency_key)`。start、draft、source/result reveal、submit、unable、retry、later 和 abandon 都必须先查该账本：

- 命中且 request hash 相同，直接回放已保存响应，先于 revision/state 校验；
- 命中但 request hash 不同，返回 `409 idempotency_key_reused`；
- 未命中时，在业务写入同一事务中创建 command 并保存响应快照；
- request hash 使用服务端带密钥摘要，响应快照不含回答正文、原文或未净化 Provider 数据；reveal 只保存受控引用并在每次回放时重新做 RLS/版本校验后取原文，draft command 按隐私保留策略随 submission 清理。

#### 6.4.2 Assistance 暴露账本

新增 user-private `validation_assistance_exposures`：workspace/user/key point/content exposure fingerprint、`last_exposure_kind`（`pre_submit_source | post_result_feedback`）、first/last exposed at、`unassisted_eligible_after`、last origin submission 与可空 input schedule；唯一键 `(workspace_id,user_id,key_point_id,exposure_fingerprint)`。逐次审计事实保留在 action command，聚合行只做单调冷却门禁。任何 source 或答案化 result/feedback 在返回前都要对 canonical learning unit 加锁并单调 upsert，`unassisted_eligible_after` 至少为最后一次暴露后 24 小时。

trusted start/restart 必须在同一 canonical-unit lock 下读取 exposure：冷却期未结束时返回 `blocked: assistance_cooldown` 与 `unassistedEligibleAt`，不创建正式 submission/attempt；abandon、换设备或重开都不能清零。若未来提供显式 `practice_only`，它必须继承 `source_viewed` 且不得创建/消费正式 schedule 或 understanding event。系统只保证受控产品路径中的 assistance 诚实记录，不把它包装成能阻止用户在外部自行查阅资料的防作弊设施。

回答正文属于敏感业务数据，只进入 RLS、导出、删除、备份和恢复范围，不进入日志或遥测。

### 6.5 新增 `validation_point_assessments`

- `workspace_id`、`user_id`，用于直接执行 user-private RLS；
- `submission_id`，作为 initial validation 与 review evaluation 共用的稳定身份；
- `rubric_item_id`；
- `verdict`：`covered | partial | missing | contradicted | not_assessable`；
- `assessment_source`：`ai | user_declared_unable`；
- `confidence`；
- 面向用户的短 `rationale`；
- 可选、已校验确实来自回答的 `answer_excerpt`；
- 不可变 `evidence_snapshot`；
- 唯一键 `(submission_id, rubric_item_id)`；完成后通过 submission 关联 validation event 或 review attempt。

模型不能创建 rubric item 或 evidence。每个输入 item 必须恰好返回一次，否则整次评估失败。

### 6.6 现有表的最小扩展

`validation_events`：

- `submission_id`；
- `note_version_id`、`rubric_version`、`reducer_version`；
- `source_fingerprint`、`source_status`；
- 继续保留当前 feedback JSON，作为逐项结果的 UI 快照，不作为唯一事实来源。

`review_attempts`：

- `evaluation_artifact_id`、`evaluation_status`；
- `assistance_level`、`evidence_revealed_at`；
- `policy_version`、`source_fingerprint`；
- `next_schedule_id` 补自引用完整性约束。

`review_schedules`：

- `key_point_id`、`generation`、`policy_version`、`reason_code`；
- `supersedes_schedule_id`；
- 同一 `(workspace,user,key_point)` 最多一条 pending schedule 的部分唯一索引。

所有 v0.6 新 schedule 使用 `subject_type='key_point'` 且 `subject_id=key_point_id`；`validation_event_id` 只保留触发来源。Review 队列通过 key point 反查当前 active card/note，旧 `card | validation` subject 仅用于兼容历史。

`ai_artifacts`：

- `parent_artifact_id`，用于 draft → repair → final lineage；
- `input_refs` 类型补 question/submission/review attempt/parent artifact；
- 开始真实写入 `input_hash` 与 `cost_tokens`；
- 新输出落库前移除任何自由形式 thinking 字段。

### 6.7 `source_fingerprint`

fingerprint 至少覆盖：

- workspace、user、card、key point ID；
- claim 与 quote 的规范化 hash；
- note version ID 与 content hash；
- 对当前用户生效的 hard evidence ID、block ID、quote hash、alignment 与 override；
- question prompt version、rubric policy version。

不得包含用户答案。提交、Worker 写结果和 schedule 创建前均重新核对 fingerprint。

`exposure_fingerprint` 与完整 `source_fingerprint` 分离：它只覆盖 workspace/user/key point、规范化 claim/quote、note content hash，以及对当前用户生效的 hard evidence 内容/alignment/override；明确排除 question、prompt、model、rubric/policy version 和纯元数据。只升级出题或评分版本不能让看过同一答案内容的用户提前恢复 unassisted 资格；只有答案承载内容或有效 evidence 实质变化才产生新的 exposure key。

### 6.8 FSRS shadow 数据

新增 append-only `scheduling_shadow_decisions`：

- workspace/user/key point；
- source type/id；
- algorithm、algorithm version、parameters version；
- 不含答案正文的 input snapshot；
- predicted due at、stability、difficulty、retrievability；
- created at；
- 同一 source + algorithm + parameter version 唯一。

该表不能被正式 review 查询用于决定 due 状态。

M0 不手写提案中的简化间隔公式，而是 pin 维护中的实现并用 golden vectors 校验；算法语义以 [FSRS 官方算法说明](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm) 和 [官方 benchmark](https://github.com/open-spaced-repetition/srs-benchmark) 为参考。

### 6.9 Schema 镜像与数据治理

所有新增表和字段同步进入：

- `apps/api/src/db/schema/*`
- `packages/db/src/schema/*`
- RLS policy 与受限角色权限；
- workspace export/import、账号删除、note/card 删除级联；
- 备份恢复和 fresh/upgrade migration 验证；
- telemetry privacy scan 与数据保留说明。

## 7. AI 契约与确定性策略

### 7.1 Question Provider 契约

新增 `generateValidationQuestion`：

```ts
type GenerateValidationQuestionOutput = {
  questionType: "explain" | "example" | "apply";
  question: string;
  rubricItems: Array<{
    key: string;
    criterion: string;
    expectedConcept: string;
    weight: 1 | 2 | 3;
    required: boolean;
    evidenceRefId: string;
  }>;
};
```

约束：

- question 不得直接泄露 claim 结论、quote 或 expected concept；
- evidenceRefId 必须来自服务端输入 allowlist；
- AI rubric item 为 2～5 个，key 唯一、权重合法、required 至少一个；
- Worker 必须验证每个 item 的 evidence 为当前用户 hard evidence；
- 输出不含 chain-of-thought。

Question 在写成 `active` 前必须通过版本化 `assessQuestionOutput` hard gate，并把 report 绑定到 artifact。至少检查规范化 quote/claim/expectedConcept 的直接或高重合片段、答案式结论、meta/prompt-injection 痕迹、非法题型与长度边界；命中稳定 reason code 时丢弃 AI 题并转安全的 deterministic template，不能仅靠 DTO 白名单放行模型自由文本。无法用确定性规则证明的语义改写风险由固定对抗集和人工标签门禁控制：硬承诺是“隐藏结构字段泄漏为 0、固定 Question Leakage Gold 中答案泄漏为 0”，不声称对未见过的任意语义改写作形式化零泄漏证明。

第一版 Must 题型为 explain / example / apply。compare / diagnose 只有在 Should 质量门禁通过后加入。

### 7.2 Evaluation Provider 契约

`evaluateValidation` 改为只返回逐项结果：

```ts
type EvaluateRubricOutput = {
  itemResults: Array<{
    rubricItemId: string;
    verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
    confidence: number;
    rationale: string;
    answerExcerpt?: string;
  }>;
  feedback: string;
};
```

模型不返回总体 outcome，不返回新 evidence ref。Worker 校验：

- 输入 item 与输出 result 一一对应；
- 没有未知、重复或遗漏 ID；
- answerExcerpt 是 user answer 的真实子串；
- rationale 只解释可观察判断，不保存隐藏推理；
- feedback 不声称 rubric/evidence 之外的事实。

### 7.3 `rubric-reducer-v1`

评估契约先要求每个 rubric item 恰好存在一个合法 assessment；契约不完整时不运行 reducer，submission 进入 `evaluation_retryable`。对合法全集，总体 outcome 按以下总序纯函数计算，所有 verdict 组合都必须命中且 fail closed：

1. 任一 item（required 或 optional）为 `contradicted` → `misunderstanding`；
2. 无 contradiction，且全部 item 均为 `missing | not_assessable` → `unknown`；
3. 无 contradiction，但任一 required item 为 `missing | not_assessable | partial` → `unclear_expression`；
4. 无 contradiction、全部 required item 为 `covered`，且加权 `(covered + 0.5 × partial) / total ≥ 0.70` → `preliminary_understanding`；
5. 其余情况只要存在 `covered | partial` → `unclear_expression`；
6. 理论兜底 → `unknown`，并记录 reducer invariant violation 供 RC 阻断。

review 映射固定为：

| Validation outcome | Review outcome |
| --- | --- |
| preliminary_understanding | correct |
| unclear_expression | partial |
| misunderstanding | incorrect |
| unknown | unable |

模型 confidence 只作为诊断信息，不改变 reducer 和 schedule。

用户显式选择 unable 时不调用 Provider，但仍在同一事务中为每个 rubric item 写入确定性的 `missing` assessment、`assessment_source=user_declared_unable` 和系统 artifact，再运行同一 reducer 得到 `unknown`。因此 unable 结果仍满足逐项可重算、artifact 绑定和单一 schedule 副作用不变量。

### 7.4 Assistance 门禁

- 用户可以选择“查看原文”，但必须先确认本轮会标记为 `source_viewed`；
- assistance 一旦发生不可撤销，服务端记录时间；
- source_viewed 后仍可提交并获得反馈，但 `understandingEffect=unchanged`，正式 due 不早于 `max(policy now + 1 天, unassisted_eligible_after)` 且 interval 不得增加；
- reveal 同时写入 6.4.2 的 exposure；同一 source fingerprint 在冷却期内 abandon/restart 后仍继承 source_viewed，不能通过重开清零；
- “暂时想不起来”直接形成 auditable unable/unknown 结果；答案化证据仍只通过 action-scoped `reveal-result` 揭示；
- self confidence 只用于用户反思和分析，不成为 outcome 输入。

`reveal-source` 与 `submit/unable` 必须锁同一 submission row，并采用单调状态迁移：

- reveal 只允许在 `ready | answer_saved`；事务先写 `source_viewed/evidence_revealed_at` 并提交，之后才返回原文；
- submit 先取得锁时原子写最终答案并进入 `evaluation_pending`，随后 reveal 返回 `409 submission_locked`；completed 后只能从结果视图查看证据；
- reveal 先取得锁时，后续 submit 必然读到 `source_viewed`，无论客户端请求顺序如何都不能升级；
- unable 与 submit 使用相同锁和幂等边界，任何竞争只产生一个 terminal 结果。

该竞争边界同时覆盖同一 user/key point 的其他 submission 和浏览器标签页：source/result reveal 与 submit/unable 都先取得相同 learning-unit guard。submit 在写最终答案时重新读取 `exposure_fingerprint` 聚合行；若暴露先提交，则原子把 submission 提升为 `source_viewed`，并写 `assistance_snapshot_exposed_at/answer_locked_at`。若 submit 先锁定独立答案，则之后发生的暴露不追溯污染该答案；异步 finalizer 只能使用提交时冻结的 assistance snapshot，不能重新用更晚 exposure 改判。两种锁顺序都必须有并发集成测试。

### 7.5 Question 生命周期

问题进入 stale/superseded 的触发器：

- note version、card 或 key point 被替换；
- card 不再 active；
- evidence 被 reject/downgrade、重新对齐或用户 override 改变；
- source fingerprint 不一致；
- prompt/rubric policy 被标为撤回版本。
- `expires_at <= transaction_timestamp()`；该检查在 start/resume/submit/result-write 的事务内执行，不依赖异步清理任务。

历史 submission/event 保留原问题和 evidence snapshot。stale 问题不能新建可升级 submission；执行中的 submission 在写结果时发现 stale，保存历史但不调度、不升级。

### 7.6 Deterministic fallback

现有 `apps/web/lib/validation-question.ts` 的纯逻辑迁移到共享、服务端可调用的位置：

- AI question 未配置、超时或 schema 失败时生成持久 deterministic question；
- fallback 仍必须有一个绑定 key point claim 与硬证据的 required rubric item、artifact/generator identity 和 fingerprint；
- fallback 可用于学习连续性，但 RC 报告必须分开统计 AI 与 deterministic 结果；
- legacy 客户端自由题面只能记录历史，不能升级。

### 7.7 条件式 Card Repair

把当前 `sanitizeCardOutput` 拆为：

```ts
assessCardOutput(draft, sourceBlocks) => {
  sanitized,
  issues: Array<{ code, severity, keyPointOrdinal? }>,
  usedFallback,
  hardFailure
}
```

建议 reason code：

- `quote_not_in_source`
- `claim_too_short`
- `claim_vague`
- `claim_quote_unrelated`
- `claim_quote_too_similar`
- `duplicate_key_point`
- `insufficient_valid_key_points`
- `coverage_too_low`
- `schema_invalid_bounded`（Provider 返回可安全解析、大小受限但契约不完整的 draft）

触发规则：

- hard trigger：伪造/无原文引用、零有效 key point、`schema_invalid_bounded`、必须使用渐进放宽 fallback；
- terminal schema failure：无法安全解析、字段/大小无界或不可信的输出记为 `schema_unparseable`，直接失败，不进入 repair；
- soft trigger：大量重复、有效 key point 被移除超过冻结阈值、明显低覆盖；
- 每个 generate_card 最多一次 repair；job 持久化 `repair_state=none|claimed|completed`、`repair_attempt_count CHECK (0..1)` 和 draft/final artifact 指针；Worker 在外部调用前以 lease-fenced CAS 执行 `none → claimed`，崩溃或 lease 丢失后不得再次发起 repair，只能保守失败；
- repair Provider 调用显式设置 `maxAttempts=1` 并关闭 SDK/HTTP 自动重试；调用前持久化 request attempt/token，响应是否成功不确定时保持 `claimed` 并 fail closed，不得再次调用；
- repair 使用同一 Provider/model、同一治理上下文，只发送 draft、source blocks 和结构化 issue；
- repair 后重新运行相同 assessor；
- 仍有 hard failure 时 job 失败，不创建 active card；
- 非触发样本绝不进行第二次模型调用。

Draft artifact 在发生修复时保存为 `dismissed`，final artifact 指向 parent；card 只引用 final artifact。不得把某位用户的回答正文用于修复共享卡片。

## 8. Job、API 与事务设计

### 8.1 Job 类型

新增：

- `generate_validation_question`

扩展：

- `evaluate_validation`：payload 只保存 `submissionId`，不复制 question、answer 或 userId；
- `generate_card`：内部执行 assess → optional repair → reassess，不新增独立 repair job。

建议优先级：

```text
evaluate_validation          10
generate_validation_question  9
parse_source                  8
generate_card                 5
align_evidence                1
```

并发幂等键：

- question：workspace + user + key point + source fingerprint；
- evaluation：submission ID；
- card：既有 note version/job quota/lease 边界；
- shadow：source event + algorithm + parameter version。

### 8.2 首次验证 API

建议 API 面：

```text
POST /api/cards/:cardId/validation-sessions/start
  Body: { keyPointId?, idempotencyKey }
  Response:
    { status: "ready", submissionId, question: SanitizedQuestion }
    | { status: "question_preparing", submissionId, jobId }
    | { status: "blocked", reason: "no_key_point" | "no_hard_evidence" | "stale_card" | "assistance_cooldown" | "unsafe_question", unassistedEligibleAt? }

GET /api/validation-sessions/:submissionId
  返回净化后的状态、draft revision 与当前用户 draft；assisted 时返回 sourceAvailable=true，但不内嵌原文
  completed 后只返回 resultAvailable=true；不在普通 GET 内嵌 feedback/rubric/evidence

PATCH /api/validation-sessions/:submissionId/draft
  Body: { answer, selfConfidence?, baseRevision, idempotencyKey }
  Response: { revision, answerHash }
  baseRevision 不一致返回 409 draft_conflict；evaluation_pending/终态拒绝迟到 PATCH

POST /api/validation-sessions/:submissionId/reveal-source
  Body: { idempotencyKey }
  按 7.4 锁行并原子记录 assistance；提交后才返回受权限控制的原文
  已 source_viewed 时允许幂等重取；每次都重新做 RLS/版本校验，不在 command 表复制原文

POST /api/validation-sessions/:submissionId/reveal-result
  Body: { idempotencyKey }
  仅 completed 可用；先记录 post_result_feedback exposure，再返回我的答案、feedback/rubric/evidence result
  该暴露不回改已完成结果，但 trusted start 在冷却结束前被阻断；可选 practice_only 必须继承 assisted

POST /api/validation-sessions/:submissionId/submit
  Body: { answer, selfConfidence?, baseRevision, idempotencyKey }
  Response: { status: "evaluation_pending", jobId }
  在同一锁行事务中写最终答案、新 revision/hash、状态和 job；job payload 只含 submissionId

POST /api/validation-sessions/:submissionId/unable
  Body: { baseRevision, idempotencyKey }
  原子生成逐项 missing assessments、系统 artifact、unknown/unable 结果与调度
  Response: { status: "completed", resultAvailable: true }；不得内嵌证据，统一由 reveal-result 揭示

POST /api/validation-sessions/:submissionId/retry-question
  Body: { idempotencyKey }
  仅 question_retryable 可用；新建有 lineage 的 generation job，返回 question_preparing

POST /api/validation-sessions/:submissionId/retry-evaluation
  Body: { idempotencyKey }
  仅 evaluation_retryable 可用；复用已锁定最终答案/question，新建有 lineage 的 evaluation job

POST /api/validation-sessions/:submissionId/abandon
  Body: { idempotencyKey }
  仅 question_preparing/question_retryable/ready/answer_saved/evaluation_retryable 可用；原子进入 abandoned
  不消费或改写 schedule，不删除 draft，也不删除 assistance exposure；shared generation job 可继续供其他 submission 使用
```

所有 mutation 先按 6.4.1 回放 action command，再校验 revision/state；因此 submit/unable 已提交但响应丢失时，用原 idempotency key 重试会得到原成功响应，而不是 `draft_conflict`。使用新 key 的过期请求仍按正常冲突规则拒绝。

validation/review session、draft、source 与 result 响应统一使用 `Cache-Control: private, no-store` 和认证维度的 `Vary`，不得进入 Service Worker/共享缓存；Focus 路由关闭会触达 card/note/source/result 的自动 prefetch。刷新后的 `assisted_review` 由 GET 恢复 assistance 状态，再通过重复 reveal 安全重取 source。

`unassisted_answering` 的 `SanitizedQuestion` 采用字段白名单，只能包含 question ID、题型、题面、key point ordinal 和进度，不能包含生成卡片/笔记标题、claim、quote、rubric、expected point、evidence 或历史结果。泄漏测试覆盖会话加载期间的所有网络响应、RSC/hydration、预取缓存和最终 DOM，而不只检查该 DTO。

active attempt 可以向同一用户恢复当前未完成 draft；“不泄漏历史答案”特指不得预载已完成的旧 submission 答案或反馈。跨设备编辑依赖 revision 冲突处理，不能以最后写入覆盖。

### 8.3 Review API

保留既有 attempt API 身份，但修改可信模式：

- start 由服务端选择或准备 question，客户端不再先创建任意题面；
- active attempt 返回同一 question 与已保存 draft；
- draft/submit 使用与首次验证相同的 `baseRevision` 与最终答案原子绑定，不接受可推进调度的客户端 outcome；
- unable/later/abandon 保持独立可审计动作；`later` 也使用 action command 和 8.7 锁序，只允许在尚未进入 `evaluation_pending/completed` 时执行；
- `later` 精确锁定 input schedule：若已有 started attempt/submission，则原子把 submission 记为 `abandoned(reason=later)`、attempt 记为 `skipped(reason=later)`；若尚无 attempt，则创建 skipped audit attempt。两种情况都保持同一 schedule 为 pending、interval 不变，只把 `next_review_at` 延后 12 小时，不写 understanding event、不创建后继 schedule；
- review submission 因用户 abandon、`question_blocked` 或 source/expiry stale 进入终态时，绑定的 started attempt 必须在同一事务中进入 `abandoned` 并写 `abandoned_at`，input schedule 保持 pending；再次开始必须创建新的 attempt/submission，active-attempt 查询不能恢复旧记录；
- AI result 完成后由服务端 reducer 得到 canonical review outcome 并原子完成 attempt/schedule；
- legacy self-grade 可在兼容窗口保留，但不得提升间隔。

`POST /api/reviews/attempts/later` 继续接收 `{ reviewScheduleId, submissionId?, idempotencyKey }`；action 回放必须先于 schedule/submission 状态校验，并按上述规则处理现有或尚未创建的 attempt。

### 8.4 轻量质量信号（Should）

仅在 Should 进入时新增最小入口：

```text
POST /api/validation-events/:id/quality-signal
  Body: {
    reason: "question_bad" | "too_strict" | "too_lenient" | "rubric_bad" | "evidence_bad",
    comment?: string
  }
```

v0.6 只保存 user-private 信号、关联版本并避免有争议结果继续被当作高可信样本；完整分流、修正提案和处理后台进入 v0.7。

### 8.5 Question 创建事务

Worker 在模型调用前读取 key point、note version、当前用户有效 evidence 与 fingerprint；模型调用后先运行 `assessQuestionOutput`，失败则切到只使用代码内静态措辞、题型和中性序号构造的 deterministic template，该模板也必须通过同一 hard gate。随后按 8.7 锁序在一个 lease-fenced workspace transaction 中：

1. 重新计算 fingerprint；
2. 变化、evidence 失效或 card/note 已替换时丢弃输出，把所有仍指向当前 job/phase ordinal 的等待 submission 原子置为 `stale`；
3. 写 AI draft/safety report artifact；若使用 fallback，同时写最终 deterministic artifact lineage；
4. 写 validation question；
5. 写全部 rubric items；
6. 对每个等待 submission，仅在 `current_generation_job_id`、phase ordinal 与 `question_preparing` 均匹配时原子推进到 `ready` 并绑定 question；stale/abandoned 等状态跳过；
7. 完成 job。

artifact、question 和 rubric 必须全成或全败。

AI 失败但 fallback 可安全创建时仍进入 ready；瞬时基础设施故障或 fallback 无法持久化时，匹配的等待 submission 进入 `question_retryable`；hard evidence/source 永久失效时进入 `stale`。如果代码内 deterministic template 自身命中 safety hard gate，说明发布内置模板/assessor 存在确定性缺陷：进入非重试终态 `question_blocked`、failure code=`unsafe_fallback`，触发发布级告警且不创建结果/schedule，不能让用户反复重试同一输入。任何失败处理都必须同时更新 current job、lineage/failure code 和 submission，不能留下永久 `question_preparing`。

### 8.6 Submission 与评估事务

API 按 8.7 在 workspace transaction 内取得 learning-unit guard 并锁 submission，校验 question/user/fingerprint、状态和 `baseRevision`，重新读取 content exposure 后冻结 assistance snapshot，再原子写入最终答案、`answer_locked_at`、递增 revision、计算 answer hash、推进 `evaluation_pending` 并创建 evaluation job。Worker payload 只含 submissionId，并只凭 trusted `jobs.requested_by` 和 submission identity 取数据。迟到 autosave 在 `evaluation_pending` 或任一终态必须被拒绝。

Provider 输出先在事务外完成有界解析和完整契约校验；失败则直接进入 `evaluation_retryable`，不写半套 assessment。只有合法全集才能进入统一 `finalizeSubmission(mode=ai)`；unable 使用 `finalizeSubmission(mode=user_declared_unable)`，两者共享以下公共完成事务段：

1. 按 8.7 取得全部 guard/行锁；AI 模式同时验证 job lease，unable 模式验证 action command；
2. 再次校验 fingerprint、question、expiry 和 evidence；
3. AI 模式写 validation feedback artifact；unable 模式写系统 feedback artifact；
4. AI 模式写合法 assessments；unable 模式为全部 rubric items 写确定性 missing assessments；
5. 运行 reducer，再只按提交时冻结的 assistance snapshot 应用 effect policy：`source_viewed → understanding unchanged，正式 due 不早于 max(policy now + 1 天, unassisted_eligible_after)`；否则使用 canonical reducer effect；
6. 仅在步骤 2 全部有效时按 context 进入且只进入一个分支；invalid/stale 立即保存历史并退出，不进入任一 schedule 分支。

`initial_validation` 分支：

1. 断言没有 `review_attempt_id/input_schedule_id`，并锁 canonical learning unit；
2. 若已经存在 pending schedule，判为并发冲突并置 stale，不覆盖既有 schedule；
3. 以 submission 为唯一幂等源写 validation event 与 understanding event；
4. 按 `discrete-v2` 创建首条唯一 pending schedule；
5. 完成 submission/job。

`review` 分支：

1. 断言并锁 `review_attempt_id` 与其精确的 `input_schedule_id`；
2. 校验该 schedule 仍是当前 user/key point 唯一 pending 输入；
3. 幂等写 attempt evaluation/validation event 与 understanding event；
4. 完成该输入 schedule，并按 `discrete-v2` 创建唯一后继 schedule；
5. 完成 submission/job。

若公共步骤 2 失败，允许保存 stale 历史反馈，但两个分支的 schedule 与 understanding 副作用均不得发生。Provider、schema 或契约失败只进入 `evaluation_retryable` 并保留最终答案，不得伪造 `unknown/unable`；重试成功前不写 point assessments、canonical outcome 或正式 schedule。

unable 只允许从 `ready | answer_saved` 进入，必须在同一 learning-unit guard 下重新读取 exposure、冻结 `answer_locked_at/assistance snapshot`，复核 question、fingerprint、expiry 与 hard evidence 后，再走同一 finalizer 和 initial/review 分支。assisted 与 unable 均不得使用旁路直接写 event/schedule。

### 8.7 状态迁移与固定锁序

所有 source/card/note/evidence/override mutation、question expiry、start/reveal/submit/unable/later/abandon 和 result-write 采用相同锁序，或在实现前以等价 Serializable/version-CAS 方案通过并发证明：

1. `(workspace,key_point)` canonical-source guard；
2. `(workspace,user,key_point)` learning-unit guard；
3. question；
4. submission；
5. review attempt 与精确 input schedule；
6. card/note version/evidence/override rows。

共享 source mutation 必须先持有第 1 层 guard；result-write 在 schedule/understanding commit 前持有全部相关 guard 和行锁，因此校验后不能插入 source 变更。expiry 在同一保护下执行 `active → expired` 并 stale 所有绑定的非终态 submission。

| 当前状态/事件 | 目标状态 | 原子副作用 |
| --- | --- | --- |
| 无 submission / start | `ready` 或 `question_preparing` | 建 submission；读取并继承 exposure；绑定已有 question 或 generation job |
| `question_preparing` / 合法 question 完成 | `ready` | 仅 current job + phase ordinal 匹配时绑定 question |
| `question_preparing` / 瞬时失败 | `question_retryable` | 保存 failure code；不创建结果/schedule |
| `question_preparing` / deterministic safety gate 失败 | `question_blocked` | `unsafe_fallback` 告警；不可重试；review attempt abandoned、input schedule 保持 pending；不创建结果/后继 schedule |
| 任意非终态 / source、evidence、expiry 失效 | `stale` | 取消正式副作用资格；review attempt 同事务 abandoned；input schedule 保持 pending |
| `ready | answer_saved` / draft | `answer_saved` | revision CAS、保存 draft；action command 可回放 |
| `ready | answer_saved` / submit | `evaluation_pending` | 重新读取 exposure，原子冻结 assistance 与最终答案/revision/hash，创建 evaluation job |
| `evaluation_pending` / Provider 或契约失败 | `evaluation_retryable` | 保留最终答案；无 assessment/outcome/schedule |
| `evaluation_retryable` / retry | `evaluation_pending` | 新 phase job + lineage；答案不可被迟到 draft 改写 |
| `ready | answer_saved` / unable | `completed` | 统一 finalizer + context schedule 分支 |
| `evaluation_pending` / AI success | `completed` | 统一 finalizer + context schedule 分支 |
| review 非评估中状态 / later | submission `abandoned`、attempt `skipped` | input schedule 保持 pending/interval 不变并延后 12h；无后继/understanding |
| `question_preparing | question_retryable | ready | answer_saved | evaluation_retryable` / abandon | `abandoned` | review attempt 同事务 abandoned；不消费/改写 input schedule，不删除 draft/exposure；shared job 可继续 |
| `completed` / reveal-result | `completed` | 写 post-result exposure；不回改已完成 outcome/schedule，影响后续 effective start |

Worker 状态落点必须以 lease token、current job ID、phase ordinal 和 source fingerprint 共同 fencing；迟到 Worker 不能覆盖 retry、stale 或 abandon 后的状态。

## 9. UX 方案

### 9.1 卡片详情页

卡片详情保持阅读和证据核对，不再同屏承载可升级验证：

- 主 CTA：`开始验证`；
- key point 可提供 `验证这个要点`；
- 无 hard evidence 时 CTA 改为 `先核对证据`；
- 历史/superseded card 只能查看历史，不能开始新可信验证；
- 移除当前 `ValidationPanel` 提交前挂载 evidence 的路径。

新 Focus 路由：

`/cards/[id]/validate?keyPoint=...`

### 9.2 验证会话状态

```text
eligibility-check
  → question_preparing
      ↘ question_retryable → question_preparing
      ↘ question_blocked
  → answering
  → answer_saved
  → evaluation_pending
      ↘ evaluation_retryable → evaluation_pending
  → completed | stale | abandoned
```

作答阶段只渲染：

- 返回/结束本轮；
- 中性标签（如“验证任务 2/5”或“复习任务 3”）、要点序号与题型；
- 问题正文；
- 回答文本框；
- `不确定 / 较确定 / 很确定` radio group；
- `提交回答`、`暂时想不起来`、次要入口 `查看原文`。

不得出现或预加载生成卡片标题、笔记标题、claim、quote、expected points、evidence、已完成的旧答案或历史反馈；当前 active submission 的 draft 可以在同一用户恢复时显示。

### 9.3 结果页

页面先通过 action-scoped `reveal-result` 记录答案化反馈暴露，再按以下顺序展示：

1. 已基本掌握 / 还差一点 / 存在理解偏差 / 暂无法判断；
2. 一句行动性总结；
3. 我的回答；
4. 已覆盖 / 待补充 / 需纠正；
5. 一条最相关硬证据、来源位置和打开原文入口；
6. 本次对理解状态和 interval 的影响；
7. 下一次具体日期与 reason code 的自然语言解释；
8. `验证下一个要点`、`返回学习卡`、`补充回答`；进入 Should 时再显示 `判定有问题`。

补充回答必须创建新 submission，不能覆盖历史；由于用户已经看过结果，正式“补充回答”在 exposure 冷却结束前不可用并显示可用时间。若实现即时 `practice_only`，它不得写 understanding 或改 schedule。confidence 只以次要的“系统判定把握”展示，不显示“理解度 87%”。

### 9.4 Review 队列与 Focus 会话

- `/review` 收敛为安全队列，只显示中性的“复习任务”编号、到期原因和当前间隔，不显示生成卡片/笔记标题、claim/quote/block content；
- Review 的正式可开始时间为 `max(next_review_at, unassisted_eligible_after)`；冷却仍有效时明确显示“刚查看过原文/反馈”和下一次可独立验证时间，禁用正式开始；可选辅助练习不得创建 attempt 或修改 schedule；
- 新 Focus 路由 `/review/[scheduleId]`；
- 有 active attempt 时显示继续/明确放弃并重开；
- UI 不再预先让用户选择“掌握/部分掌握/未掌握”；
- AI 评估完成后停留在结果页，由用户显式点击“下一条”；后台完成不得跨页自动导航或抢夺焦点；
- 题目生成瞬时失败显示“重试出题”；`unsafe_fallback` 显示不可重试的“题目暂不可用”并提供返回入口；评估失败显示“重试评估”，保留最终答案、计划不变并允许离开和恢复，所有失败都不伪造 unable。

### 9.5 移动端与无障碍

- Focus 会话隐藏底部导航，使用 `100dvh`、sticky action bar 和 `safe-area-inset-bottom`；
- 390×844 与软键盘打开时文本框、提交按钮可达且无横向溢出；
- 开始时焦点移到问题标题；仅当用户仍停留在当前会话且刚提交后，结果出现才移到结果标题，后台完成不跨页抢焦点；错误使用 `role=alert`；
- `Cmd/Ctrl+Enter` 提交，Enter 保留换行；
- 触控目标至少 44×44；状态不只依赖颜色；
- 支持 200% zoom、reduced motion、屏幕阅读器和纯键盘路径。

## 10. 核心工作包与 DoD

### 10.1 FDN-06：基线与契约冻结

- [ ] v0.5 clean accepted SHA、迁移末端、版本源和未完成门禁已记录；
- [ ] 当前工作树的多工作区/图片/安全能力已有明确版本归属；
- [ ] v0.5 计划、实施登记册与证据索引的 Must/DoD 口径已按同一快照统一；
- [ ] `docs/project-overview.md`、图片设计/runbook 与旧 v0.6 路线引用已在计划获批后统一为 baseline candidate 或 post-v0.6 candidate；
- [ ] ADR-0010 与本计划 Approved；
- [ ] question、rubric、submission、assessment、reducer 和 schedule 契约已冻结；
- [ ] 质量数据集、标签指南、阈值和真实 Provider 预算已批准；
- [ ] 新 migration 使用 baseline 后的下一个可用编号，不在本计划阶段预占数字。

### 10.2 QUEST-01：Question + Rubric

- [ ] 新 AI provider 方法在 Mock、DashScope、OpenAI-compatible 中实现；
- [ ] 题目、rubric item、artifact、job 与 user/evidence fingerprint 原子落库；
- [ ] 服务端净化 DTO 不泄露 expected concept/evidence；
- [ ] 每条 active question 都绑定确定性 safety report；命中泄漏 reason code 时只允许安全 fallback；
- [ ] 无 hard evidence 时 fail closed；
- [ ] deterministic fallback 可用且与 AI 结果分桶；
- [ ] deterministic fallback 若违反自身 safety gate，进入不可重试 question_blocked 并告警；
- [ ] `expires_at` 在 start/resume/submit/result-write 全部 fail closed，legacy/expired question 不能升级；
- [ ] card/evidence/note/override 变化正确标记 stale；
- [ ] legacy client-authored question 不能产生升级。

### 10.3 EVAL-02：逐点评估

- [ ] 用户答案在 enqueue 前进入受 RLS 保护的 submission；
- [ ] 每个 rubric item 恰好一个合法 assessment；
- [ ] outcome 和 review outcome 可由纯 reducer 重算；
- [ ] reducer 对全部 verdict 组合为全函数，任一 contradiction 与 required 非 covered 均不能误升级；
- [ ] unable 为每个 rubric item 生成确定性 assessment 与系统 artifact；
- [ ] false-mastery 对抗集达标；
- [ ] stale/assisted/provider failure 不产生升级或 interval 延长；
- [ ] AI、assisted 与 unable 共用 finalizer/context 分支，不存在旁路 schedule；
- [ ] source mutation、expiry、submit 与 result-write 共享固定锁序，无校验后变更的 TOCTOU；
- [ ] event、attempt、schedule 和 understanding side effects 幂等、事务一致；
- [ ] 用户可看到 evidence-grounded feedback，但 Owner 不能读取成员个人回答。

### 10.4 UX-06：Question-first 会话

- [ ] card validation 与 review 都有独立 Focus route；
- [ ] `unassisted_answering` 隐藏结构字段在全部网络响应、RSC/hydration、预取缓存和 DOM 中泄漏为 0，Question Leakage Gold 的答案泄漏为 0；
- [ ] refresh/跨设备恢复同一 submission/attempt/question 和 draft；
- [ ] draft revision 冲突、迟到 PATCH 与 submit 最终答案绑定不会静默覆盖；
- [ ] reveal/submit 并发锁测试证明 assistance 不可逆且永久阻止升级；
- [ ] source reveal → abandon → restart/换设备，以及 result reveal → 立即补充回答，在 24 小时 exposure 窗口内均阻断 trusted start；可选 practice 不产生正式副作用；
- [ ] 另一标签页 exposure 与既有 active submission submit 的双顺序竞争正确冻结 assistance；
- [ ] prompt/model/rubric 版本变化不能改变 content exposure fingerprint 或清除冷却；
- [ ] action command 对响应丢失、双击和 retry 可回放，且命中先于 revision/state 校验；
- [ ] session/source/result 全部 `private, no-store`，敏感 route prefetch 与 Service Worker cache 为 0；
- [ ] unable、later、abandon、question/evaluation retry、question_blocked、stale 和 job failure 有明确状态与 API；
- [ ] unable 只返回 resultAvailable，答案化内容一律经 reveal-result；Review abandon/stale 同步关闭 started attempt；
- [ ] 三视口、键盘、axe/WCAG、200% zoom 和移动软键盘 E2E 通过。

### 10.5 CARD-02：条件式修复

- [ ] `assessCardOutput` 返回稳定、版本化 reason code；
- [ ] 非触发样本第二次 Provider 调用为 0；
- [ ] 同一 job 最多一次 repair；
- [ ] repair claim/count 跨 Worker、lease lost 和 job retry 持久有效；unparseable schema 不进入 repair；
- [ ] repair Provider/SDK 传输层 `maxAttempts=1`，不发生隐式自动重发；
- [ ] repair 后再次运行同一 assessor；
- [ ] hard failure 不激活 card；
- [ ] draft/final artifact lineage、prompt/model/usage/cost 可追溯；
- [ ] existing citation/coverage AIQ 不回归。

### 10.6 SCHED-02：统一调度与 FSRS shadow

- [ ] Worker 中独立 `intervalForOutcome` 被单一 `discrete-v2` 策略替代；
- [ ] partial 不推进，incorrect/unable/source_viewed 的 due 不早于 `max(policy now + 1 天, unassisted_eligible_after)`，stale/provider failure 不改正式 schedule；
- [ ] 每个 user/key point 最多一个 pending schedule；
- [ ] initial 只创建首条 schedule，review 只完成锁定的输入 schedule 并创建一个后继；
- [ ] Review effective start 使用 `max(next_review_at, unassisted_eligible_after)`；later 幂等延后同一 pending schedule 且不创建后继；
- [ ] schedule before/after、reason code、policy version 和后继 ID 完整；
- [ ] FSRS golden vectors 与 pinned implementation version 通过；
- [ ] shadow 对正式 schedule 写入为 0；
- [ ] FSRS 结果不进入普通用户 UI。

### 10.7 AIQ-02 / QLT-06 / REL-06

- [ ] 固定数据集、标签、scorer、prompt/provider 配置全部版本化；
- [ ] PR 使用 Mock/fixture，不访问付费网络；
- [ ] RC 固定真实 Provider 配置完整运行两轮并保留原始报告摘要和 digest；
- [ ] migration fresh、v0.5 representative upgrade、重复迁移、备份恢复通过；
- [ ] 新表 RLS、导出/导入、删除和隐私扫描通过；
- [ ] Worker 双实例、lease lost、重复 job、Provider 超时/schema failure 故障矩阵通过；
- [ ] release manifest 绑定 commit、tag、migration、prompt/dataset/scorer version 和镜像 digest；
- [ ] 无未关闭 P0/P1。

## 11. 里程碑与 Gate

> 本节 checkbox 表示正式 Gate 是否关闭，不等同于“代码已经存在”。截至 2026-07-26，M0-M6 为代码候选并已完成登记的定向验证；在 clean SHA、完整 RC、真实 Provider 与 Alpha 证据绑定前，不把这些 checkbox 批量改为已发布完成。增量证据见本计划顶部链接的审查记录。

### M0：基线与决策冻结

工作项：

- v0.5 clean baseline 和遗留门禁；
- ADR-0010、本计划、数据契约、隐私分类；
- 黄金集标签指南、阈值、预算；
- feature flags 和回滚边界。

Gate：

- [ ] Base SHA、migration end、Owner、预算和证据路径明确；
- [ ] v0.6 Must/Should/Could 与删减线获批；
- [ ] 不存在另一份可编辑 v0.6 范围文档。

### M1：Schema、RLS 与纯策略

工作项：expand migration、schema mirror、submission/rubric/assessment、source fingerprint、reducer、discrete-v2、export/delete/restore。

Gate：

- [ ] fresh/upgrade/repeat/restore migration 通过；
- [ ] RLS 多 workspace/多 user 矩阵 0 泄漏；
- [ ] reducer、assistance 和 schedule 表驱动测试全绿。

### M2：Question + Rubric

工作项：provider contract、job、fallback、lifecycle、净化 DTO、question gold。

Gate：

- [ ] question/rubric 原子性和 stale 并发测试通过；
- [ ] Question/Rubric Gold 达标；
- [ ] 客户端题面不能产生升级。

### M3：逐点评估与 Review 集成

工作项：submission、evaluation contract、point assessments、reducer、initial/review transaction、quality signal。

Gate：

- [ ] Evaluation Gold 和 false-mastery 门禁通过；
- [ ] Provider/job/fingerprint 失败不会错误升级或丢答案；
- [ ] validation 与 review 共用相同 reducer/scheduling policy。

### M4：Question-first UX

工作项：卡片验证 Focus、review Focus、队列收敛、结果揭示、恢复、移动/无障碍。

Gate：

- [ ] 未辅助提交前全部网络/RSC/hydration/预取/DOM 隐藏结构字段为 0，Question Leakage Gold 答案泄漏为 0；
- [ ] 首次验证、复习、查看原文/结果、unable、later、blocked、重试、冷却和恢复 E2E 全绿；
- [ ] 390/768/1440、键盘、200% zoom 和 WCAG 门禁通过。

### M5：Card Repair 与成本观测

工作项：quality report、trigger policy、repair provider path、artifact lineage、usage/cost、repair gold。

Gate：

- [ ] 非触发 0 二次调用；hard failure 0 激活；
- [ ] Repair Gold 与既有 90/85/85 指标达标；
- [ ] 成本、延迟和 repair 触发率可按 provider/model/prompt 分桶。

### M6：FSRS Shadow 与回放

工作项：pinned adapter、golden vectors、append-only decisions、离线 compare 报告。

Gate：

- [ ] 正式 schedule 影响为 0；
- [ ] 相同历史重放产生相同 shadow hash；
- [ ] 报告明确样本量、校准、模拟工作量和 `insufficient_data`。

### M7：RC、灰度与 14 日观察

发布顺序：内部 workspace → 1～2 个 Alpha workspace → 全部受邀 Alpha。

Gate：

- [ ] 全量 release-check、两轮真实 Provider AIQ、迁移/恢复和 E2E 全绿；
- [ ] 48 小时无安全不变量、虚假升级或未归属 dead job；
- [ ] 7 日运行 SLO 达标或样本不足明确记录；
- [ ] 14 日产品/质量/成本复盘完成；
- [ ] v0.7 只选择一个主方向，或明确暂不立项。

## 12. 迁移、兼容与灰度

### 12.1 迁移顺序

1. Expand：新表、nullable 字段、索引和 `NOT VALID` FK；
2. Backfill：只回填能可靠绑定的 note version/key point/question；歧义记录标记 legacy，不猜测 rubric；
3. Dual-write：新 submission/assessment 与旧 event 快照并存；
4. Compare：对旧 outcome 与 reducer outcome 只读比较；
5. Switch：可信 UI 和 schedule 只接受新 question/submission；
6. Validate：FK、唯一 pending schedule 与新写入 check；
7. Cleanup：旧客户端路径至少保留一个兼容窗口，遥测确认无调用后删除。

### 12.2 Feature flags

建议：

- `AI_QUESTION_V1_ENABLED`
- `RUBRIC_EVALUATION_V1_ENABLED`
- `QUESTION_FIRST_UI_ENABLED`
- `CARD_REPAIR_V1_ENABLED`
- `SCHEDULER_POLICY_VERSION=discrete-v1|discrete-v2`
- `FSRS_SHADOW_ENABLED`

关闭 flag 时必须 fail closed：可以回到只读卡片、确定性题目或旧 schedule 展示，但不能恢复客户端题面/outcome 的升级权力。

### 12.3 Legacy 数据

- 旧 validation event 和 review attempt 是历史事实，不改写；
- 旧 question 标记 `legacy_unrubriced`，可显示历史但不能用于新升级；
- 无法可靠回填 key point/fingerprint 的 pending schedule 保持旧策略并进入 quarantine 报告；
- 新 card/key point 不自动继承旧相似 key point 的掌握资格；
- 回滚以前向补偿和 flag 切读为主，不删除新历史。

## 13. 测试矩阵

### 13.1 Unit / Contract

- question/rubric schemas、opaque evidence refs、question safety reason codes 与答案泄漏检测；
- reducer 全 verdict/weight/required 组合、totality 与 fail-closed 边界；
- assistance、stale、legacy、provider failure；
- unable 的确定性 assessments/artifact/reducer 路径；
- discrete-v2 全 interval 与时间注入；
- card assessor reason code、repair trigger、单次上限与 Provider transport `maxAttempts=1`；
- FSRS golden vectors 与正式写入禁令。

### 13.2 PostgreSQL Integration

- question artifact/rubric 原子提交；
- submission + job 原子创建；
- 同一去重 generation job 可多对多绑定 initial/review 等多个等待 submission；
- 双 Worker 同一 submission/fingerprint 竞争；
- reveal-source 与 submit/unable 并发锁次序；
- source reveal → abandon → restart/换设备、result reveal → trusted start 阻断与 24 小时边界；
- 既有 active submission 与另一标签页 source/result exposure 的双顺序竞争及 assistance snapshot；
- prompt/model/rubric 版本变化不改变 content exposure fingerprint；
- draft revision 冲突、迟到 autosave、submit 最终答案原子绑定；
- start/draft/source-result reveal/submit/unable/retry/later/abandon 的 action command 响应丢失与 key 重用；
- question/evaluation retry job lineage 与 repair-at-most-once lease lost；
- 全状态迁移的 current job/phase/lease fencing，迟到 Worker 不覆盖 stale/abandon/retry；
- evaluation/event/attempt/schedule 幂等与唯一 pending；
- initial 首条 schedule 与 review 精确输入/后继 schedule 的互斥分支；
- review submission abandon/stale 原子关闭 started attempt，later 只延后同一 pending schedule；
- `max(next_review_at, unassisted_eligible_after)` 边界不产生连续 assisted 循环；
- question 到期并发 `active → expired` 与 submission stale；
- evidence override/realign、card regenerate、note delete/restore 的 stale 传播；
- source mutation/expiry 与 result-write 并发时固定锁序阻断 TOCTOU；
- RLS 同 workspace 不同 user 与跨 workspace；
- fresh、representative v0.5 upgrade、repeat、backup/restore。

### 13.3 Web / E2E

- card CTA → Focus → answer → feedback → next review；
- review queue → resume attempt → answer → result → next item；
- pre-submit 全部网络响应、RSC/hydration、预取缓存、DOM 无隐藏答案结构或生成标题；
- reveal source 后不升级，活跃会话内来源链接不能绕过 assistance，刷新/重复 reveal 可安全恢复 assisted source；
- session/source/result 的 `private, no-store`、无敏感 prefetch/Service Worker cache；
- generation timeout/fallback/retry、evaluation timeout/retry、unable、abandon、stale 均展示正确状态；
- unsafe deterministic fallback 展示不可重试 blocked；unable/result 只能经 reveal-result 查看答案化内容；
- Review 结果由用户显式进入下一条，后台完成不导航、不抢焦点；
- refresh/跨标签页/跨设备恢复；
- 390/768/1440、软键盘、键盘、200% zoom、reduced motion、axe。

### 13.4 AI Quality

- 固定 Mock PR gate；
- question leakage、rubric evidence support、prompt injection；
- evaluation false mastery、遗漏 critical point、因果倒置、关键词堆砌；
- repair trigger precision、hard-gate non-regression；
- RC 两轮真实 Provider 与上一个 accepted baseline 比较。

## 14. 风险与控制

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| v0.5 尚未形成 clean baseline | v0.6 migration、版本和证据不可复现 | M0 阻断；不改版本号；先完成能力归属 |
| 题目泄露答案 | 虚假理解升级 | 独立 Focus、字段白名单、question safety hard gate、固定对抗集与全部网络/RSC/hydration/预取/DOM 测试 |
| 模型 rubric 本身错误 | 逐点评估看似结构化但基础不可信 | 每项 hard evidence、Question Gold、用户 quality signal、stale/revoke |
| 模型自由决定 outcome | 结果漂移、不可回放 | 逐项 verdict + 版本化 deterministic reducer |
| 评估误把关键词复述当理解 | false mastery | 对抗样本、false-mastery ≤ 5%、任一 contradiction 阻断升级、required 全 covered |
| 用户跨标签页查看原文/结果后仍被升级 | 主动回忆被破坏 | content exposure fingerprint、learning-unit guard、submit assistance snapshot、24h trusted-start 冷却 |
| 第二次模型调用成本失控 | 生成更慢、更贵 | reason-code trigger、最多一次、非触发 0 调用、usage/cost gate |
| 修复放宽硬门禁 | 激活伪造引用或空卡 | 同一 assessor 重跑，hard failure 直接失败 |
| 两套调度继续漂移 | 相同学习结果产生不同 due | shared discrete-v2、删除 Worker 独立映射、表驱动测试 |
| FSRS 被提前用于正式 schedule | 难以解释和回滚 | append-only shadow 表、正式写入禁令、独立 v0.7 ADR |
| 新用户级表泄漏给 Owner | 隐私违规 | user-bound RLS、Owner 只看去内容化聚合、导出/删除测试 |
| source 在 AI 调用中变化 | 旧题/旧评估污染新版本 | 调用前后 fingerprint、stale 历史保存但无正式副作用 |
| Provider 不支持稳定结构化输出 | job 失败率高 | Mock 契约、Zod；出题走 deterministic fallback，评估保留答案并重试，卡片仅修复 bounded schema；分 Provider 门禁 |

## 15. v0.7 交接

以下能力进入 `AI学习系统-v0.7-方向性预期-2026-07-22.md` 的候选池，不在 v0.6 偷跑，也不承诺全部在 v0.7 实现：

- Concept Graph 与跨卡片语义关系；
- Embedding evidence/概念候选；
- Vision、OCR、PDF/图片引用锚点；
- 流式交互；
- 多模型路由；
- 完整结构化反馈、修正提案与可重算后台；
- 多题变体、进一步难度自适应和更多题型；
- FSRS 正式接管与个体参数优化。

v0.6 观察期结束后只选择一个产品主方向。RLS、迁移、质量、E2E、备份恢复和发布治理属于持续门禁，不得包装成“延后到 v0.7”。

## 16. M0 开放决策与默认建议

| 决策 | 默认建议 | 截止点 |
| --- | --- | --- |
| v0.6 Base SHA | v0.5 clean accepted SHA，不使用当前 dirty worktree | M0 |
| Question 题型 | Must 只做 explain/example/apply；compare/diagnose 为 Should | M0 |
| Question 有效期 | fingerprint 优先；时间 expiry 作为次级保护，默认 30 天 | M1 |
| Rubric item 数量 | AI 题 2～5；deterministic fallback 1；每项一条 hard evidence，至少一项 required | M1 |
| Reducer 阈值 | `covered + 0.5*partial` 加权覆盖 ≥ 70%，且全部 required 必须为 covered；任一 contradiction 阻断升级 | M0 |
| 自信度 | 三档，仅 UI/分析，不影响 outcome | M0 |
| 查看原文 | 允许但本轮永久标记 assisted；正式 due 不早于 max(policy now + 1 天, exposure 冷却结束) | M0 |
| Card repair | 最多一次，同 Provider/model；hard trigger 必做，soft trigger 可裁剪 | M0 |
| FSRS 实现 | M0 选择维护中的库并 pin 精确版本；只 shadow | M0 |
| FSRS rating | 独立作答的 correct→Good、partial→Hard、incorrect/unable→Again；assisted/invalid/provider failure 不作为有效训练事件；不虚构 Easy | M1 |
| 轻量质量信号 | Should；若实现，只冻结争议影响，不建设完整工单后台 | M4 |

## 17. 实施启动清单

详细方案获批后，实施前必须：

- [x] 将本计划状态改为 Approved 并记录批准证据；
- [x] 创建 `docs/plans/v0.6-implementation-register.md`；
- [x] 创建 `docs/evidence/v0.6/README.md` 与 milestone gate；
- [x] 记录 Base SHA、目标分支和 migration end；
- [x] 冻结数据集/标签/scorer/prompt/reducer/policy 版本；
- [x] 指定 Product、Learning Loop、AI Quality、Security/Data、Web UX 和 Release Owner；
- [ ] 确认真实 Provider 凭据、revision 取证与 RC 成本预算；
- [ ] 从 M1 expand migration 开始，不直接在生产式数据库试错；
- [x] M0-M6 阶段性 Gate 证据已绑定（`docs/evidence/v0.6/m{0..6}-gate.md`）；2026-07-25 的 2634 个测试为历史全量检查点，2026-07-26 修复后已完成登记的定向验证；完整 RC/真实 Provider/Alpha 证据仍由 M7 阻断

## 18. 文档变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-07-22 | Repository owner 选择方向 A；建立 v0.6 可信掌握闭环、v0.7 方向性预期、question/rubric/evaluation/card repair/discrete-v2/FSRS shadow 的正式 Draft |
| 0.2 | 2026-07-24 | 计划状态从 Draft 进入 Approved；冻结 Base SHA=`40fdf1c`、分支=`v0.6-implementation`、迁移末端=`0039`；创建实施登记册与证据索引 |
| 0.3 | 2026-07-25 | M1-M3 实施七轮审查修复完成；修复 evaluate-rubric 事务内 question 重读、noteVersionId 缺失、startValidationSession 非终态 submission 检查、artifact inputRefs 一致性、review schedule generation 递增共 5 项 |
| 0.4 | 2026-07-25 | M1-M3 实施第八轮审查修复完成；修复 submitAnswer/unableToAnswer 缺少 source fingerprint 校验、question 未用 FOR UPDATE 锁、inputSchedule 未用 FOR UPDATE 锁、generate-validation-question noteVersionId 使用 pre-tx 快照共 4 项 |
| 0.5 | 2026-07-25 | M1-M3 实施第十轮审查修复完成；修复 initial_validation 缺少 pending schedule 冲突检查、understanding event 在调度前置检查前写入、review 分支缺少 review attempt 锁定、review 分支缺少 input schedule PENDING 状态校验、exposure 查询缺少 workspaceId 过滤共 5 项 |
| 0.6 | 2026-07-25 | M1-M3 实施第十一轮审查修复完成；修复 revealResult exposure 查询缺少 workspaceId 过滤、review 上下文中 review attempt 未标记为 completed、artifactTypeSchema 缺少 v0.6 新增类型共 3 项 |
| 0.7 | 2026-07-25 | M1-M3 实施第十二轮审查修复完成；修复 revealResult/getValidationSession 不允许 STALE 揭示结果、startValidationSession 绑定已有题目未校验 source fingerprint、调度前置检查失败时未设置 validationEventId、已有题目查找要求 expiresAt 非空共 4 项 |
| 0.8 | 2026-07-25 | M1-M3 实施第十三轮审查修复完成；修复 submitAnswer/unableToAnswer 不重新读取 exposure 聚合行（跨 submission exposure 检测）、submitAnswer 不写 assistanceSnapshotExposedAt、getValidationSession 对 STALE 返回 draftAnswer、unableToAnswer hasValidServerQuestion 缺少 fingerprint 校验、fingerprint 校验使用前置条件而非 fail closed 共 6 项 |
| 0.9 | 2026-07-25 | M5 审查修复完成；修复 card repair 状态未持久化（jobs 表新增 repair_state/repair_attempt_count + CAS none→claimed→completed）、CARD_REPAIR_V1_ENABLED flag 未门禁所有 repair 行为、draft/final artifact lineage 未接线（parent_artifact_id）、repair 调用未单独记录 logAICall 共 4 项；确认 Review later 动作已有 idempotency 和 FOR UPDATE 锁定 |
| 1.0 | 2026-07-25 | M1-M3+M5+M6 第十五轮审查修复完成；修复 artifact type 使用错误：evaluate-rubric.ts AI 评估 artifact 使用 VALIDATION_FEEDBACK 而非 RUBRIC_EVALUATION、generate-validation-question.ts 题目 artifact 使用 QUESTION 而非 VALIDATION_QUESTION/DETERMINISTIC_QUESTION、session-service.ts unable 路径 artifact 使用 VALIDATION_FEEDBACK 而非 RUBRIC_EVALUATION 共 3 项 |
| 1.1 | 2026-07-25 | M1-M3+M5+M6 第十六轮审查修复完成；修复 evaluate-rubric hasHardEvidence 使用 pre-tx 快照（§8.6 违规）、fsrs-shadow 头部及函数注释 Rating 枚举值错误、evaluate-rubric shouldMutateSchedule 缩进不一致、fsrs-shadow computeFSRSShadowDecision 未文档化 currentIntervalDays 限制、fsrs-shadow retrievability 访问方式错误、fsrs-shadow 未使用 State import 共 6 项 |
| 1.3 | 2026-07-25 | M1-M3+M5+M6 第十八轮审查修复完成；修复 submitAnswer 中 question.status !== ACTIVE 未标记 submission 为 STALE（§7.5 违规）共 1 项；确认 rubric-reducer、fingerprint、scheduling-policy-v2、question-safety、deterministic-question、generate-validation-question、evaluate-rubric、session-service（10 个端点）、card-quality、handlers/index.ts（card repair）、fsrs-shadow 全部审查项无需修复 |
| 1.2 | 2026-07-25 | M1-M3+M5+M6 第十七轮审查修复完成；修复 revealSource/revealResult exposure upsert 竞争条件（§6.4.2 违规，find-then-update/insert 改为 onConflictDoUpdate 原子 upsert）、revealResult exposure update 未设置 lastOriginSubmissionId 共 2 项 |
| 1.4 | 2026-07-25 | M1-M3+M5+M6 第十九轮审查修复完成；修复 evaluate-rubric.ts understanding event 在 hasHardEvidence 检查前写入（§4.1 违规：0 次无当前用户有效硬证据的理解升级），将 txRubricItems 查询移到 understanding event 之前，hasHardEvidence 为 false 时降级 eventType 为 "seen" 共 1 项 |
| 1.5 | 2026-07-25 | M1-M3+M5+M6 第二十轮审查修复完成；修复 unableToAnswer hasHardEvidence 使用事务开始时加载的 rubric items 快照而非重新读取（§8.6 违规）、unableToAnswer question.status !== ACTIVE 的 failureCode 不一致、unableToAnswer understanding event payload 缺少 hasHardEvidence 共 3 项 |
| 1.6 | 2026-07-25 | M1-M3+M5+M6 第二十一轮审查完成（事务包装器与 Job Lineage 终审 — 0 项修复）；确认 withWorkspaceTransaction 底层回滚正确、Advisory Lock 语义正确、retryQuestion/retryEvaluation Job Lineage 追踪完整、evaluate-rubric.ts 与 unableToAnswer 调度前置检查和 FSRS shadow 对齐；更新 M5/M6 里程碑状态为进行中 |
| 1.7 | 2026-07-25 | M4 启动 — Question-first UX 前端实现；新增 ValidationFocus 组件（~550 行）、validation-focus.css、卡片验证 Focus 路由 /cards/[id]/validate、Review Focus 路由 /review/[scheduleId]、v0.6 API 客户端（10 个方法 + 12 个类型）、卡片详情页 CTA 更新；Linter 无 ERROR |
| 1.8 | 2026-07-25 | M4 继续 — Review Context、Queue 收敛与 Feature Flag；完成 review context session start（§8.3: startValidationSession 扩展 context=review + reviewScheduleId、schedule FOR UPDATE 锁定、review attempt 创建/resume、effective start 检查）、review queue 收敛（§9.4: /review 页面替换为中性安全队列，不显示卡片标题/claim/quote）、feature flag 门禁（§12.2: NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED 条件渲染、feature-flags.ts 工具模块）；Linter 无 ERROR |
| 1.9 | 2026-07-25 | M4 继续 — 服务端 Feature Flag 门禁与统一调度；新增 packages/shared/src/feature-flags.ts（5 个服务端 flag 集中化）、packages/shared/src/scheduling-unified.ts（discrete-v1/v2 统一分发器）；generate-validation-question.ts 门禁 AI_QUESTION_V1_ENABLED（false→deterministic fallback）、evaluate-rubric.ts 门禁 RUBRIC_EVALUATION_V1_ENABLED（false→fail closed evaluation_retryable）、handlers/index.ts 使用 isCardRepairEnabled()；session-service.ts 和 evaluate-rubric.ts 调度切换到 calculateSchedule()、policy_version 动态适配；新增 62 个单元测试（shared 35 + web 27）含 SanitizedQuestion DTO 泄漏检测 |
| 2.0 | 2026-07-25 | M4 继续 — Review 安全端点与泄漏检测；新增 SanitizedReviewItem/SanitizedReviewMeta 接口、listSanitizedReviews/getSanitizedReviewMeta 服务函数、GET /reviews?sanitized=true 和 GET /reviews/:scheduleId/sanitized 端点（Cache-Control: private, no-store）；Review Focus 页面改用 getReviewFocusMeta 替代 listReviews()、Review 队列页面改用 listSanitizedReviews；修复 v0.6 key_point schedule 不出现在复习队列（EXISTS 查询新增 key_point 分支 + 数据解析逻辑）；新增 12 个泄漏检测测试；Linter 无 ERROR |
| 2.1 | 2026-07-25 | M4 继续 — 安全契约测试；新增 fingerprint-invariant.test.ts（26 个测试：exposure fingerprint 跨版本不变性、冷却门禁不变性、source vs exposure 对比）、v06-cache-control-contract.test.ts（9 个测试：全 10 条 session 路由 Cache-Control: private, no-store 覆盖验证、review sanitized 路由验证）、v06-session-contract.test.ts（20 个测试：action command 幂等回放、draft revision CAS 冲突 409、unable 响应最小化、submit 响应最小化、reveal-source 响应、blocked 状态响应、abandon 幂等）；覆盖 §10.4 中可在无运行服务器条件下验证的安全不变量；Linter 无 ERROR |
| 2.2 | 2026-07-25 | M4/M5/M6 继续 — 数据治理补全；完成 §6.9 导出/导入（exportWorkspace/restoreWorkspace 新增 8 张 v0.6 新表查询/恢复 + 现有表 v0.6 字段扩展：validation_questions 11 字段、validation_events 6 字段、review_schedules 5 字段、review_attempts 6 字段、ai_artifacts parentArtifactId + dry-run 引用完整性校验）、§6.6 input_hash 真实写入（generate-validation-question.ts + evaluate-rubric.ts artifact 插入新增 SHA-256 inputHash）、§10.5 Provider maxAttempts=1 确认（postJsonToPublicEndpoint/callOnce 均原生 HTTP 无重试）、§4.1 遥测隐私扫描（新增 v06-telemetry-privacy-scan.test.ts 4 个测试：Worker/API logger 不泄漏题面/答案/quote/expectedConcept、metrics 标签不含敏感字段、logAICall 参数不含答案/题面）；Linter 无新增 ERROR |
| 2.3 | 2026-07-25 | M4/M5/M6 继续 — Provider Usage Tracking + FSRS Compare Report + Source Inspection Tests；完成 §6.6 cost_tokens 真实写入、§10.6 FSRS shadow 离线对比报告、§9.5/§10.4 CSS/组件源码级无障碍契约测试；Linter 无新增 ERROR |
| 2.4 | 2026-07-25 | M0-M6 Gate 证据绑定完成；修复 fsrs-compare-report.test.ts 1 个失败测试（v0.6 FSRS 新卡片限制导致 meanIntervalDiff 比较逻辑修正）、review-attempt-db-extra.test.ts mock 缺少 validationActionCommands（Review later 迁移后 mock 补全）、v06-dom-leakage.test.ts 过度禁止 post-reveal 合法字段引用（quoteText/claim/rubricItems 在结果揭示阶段合法使用）；创建 m1-gate.md ~ m6-gate.md Gate 证据文件；更新证据索引 README；2513 测试全绿（Shared 352 + API 1361 + Web 263 + Worker 537） |
| 3.0 | 2026-07-25 | 代码可实施剩余任务推进完成 — M1/M2/M3/M4/M5/§10.7；新增 RLS 矩阵集成测试（`v06-rls-matrix-postgres.integration.ts`：8 张表 RLS enabled + 8 条 policy + 同 workspace 不同 user 隔离 + 跨 workspace 隔离 + 无 user_id 返回零行，需 PostgreSQL 运行）、Migration fresh/upgrade/repeat/restore 集成测试（`v06-migration-fresh-upgrade-repeat.integration.ts`：新表/索引/约束/列扩展/幂等性/legacy 标记/备份恢复/类型验证，需 PostgreSQL 运行）、AI Quality 黄金集 fixture（`packages/ai-quality/src/v06/`：Question/Rubric Gold 60 样本 + Evaluation Gold 120 样本 + Card Repair Gold 30 样本 + 三套评分器 + 25 个单元测试全绿）、导出/导入验证测试（`v06-export-import-coverage.test.ts`：19 个测试全绿 — 8 张新表导出/恢复 + manifest + 依赖顺序 + 隐私扫描 + CASCADE + 现有表扩展）、Playwright E2E 框架（安装 @playwright/test + @axe-core/playwright + Chromium，3 个 spec 文件：card-validation/review-flow/accessibility，含泄漏检测/键盘/触控/200%zoom/reduced-motion/axe WCAG 2.2 AA）；更新实施登记册与证据索引；新增 44 个测试全绿（ai-quality v06 gold 25 + api export-import 19） |
| 3.1 | 2026-07-25 | 代码质量提升 — TypeScript 类型检查全绿 + 锁序契约测试 + E2E 种子数据；修复全部三个包共 31 个 TypeScript 类型检查错误（apps/web 16 + apps/api 14 + packages/shared 1：未使用变量/导入/类型转换/缺少键）；新增 `v06-lock-ordering-contract.test.ts`（25 个测试全绿 — §8.7 固定锁序/§6.4.2 原子 upsert/§7.4 exposure 重新读取/§8.6 fingerprint fail-closed/§6.4.1 action command 幂等先于状态校验/§4.1 不接受客户端 outcome 的源码级验证）；新增 `seed-e2e-v06.ts` 种子数据脚本（用户+工作区+笔记+卡片+key points+evidence+review schedule+validation question，固定 UUID 供 E2E 导航）；2634 测试全绿（Shared 352 + AI Quality 77 + API 1405 + Web 263 + Worker 537）；tsc --noEmit 全部 0 错误 |
| 3.2 | 2026-07-25 | 第二十二轮审查修复 — TypeScript noUnusedLocals 合规性修复；发现并修复 apps/api 中 9 个 TS6133 错误（v06-lock-ordering-contract.test.ts 2 个 + v06-rls-matrix-postgres.integration.ts 3 个 + v06-export-import-coverage.test.ts 4 个，均为文档性 `_` 前缀变量被 noUnusedLocals 标记）；修复方法：移除 `_` 前缀 + 添加 `void` 引用语句；2634 测试全绿，tsc --noEmit 全部 0 错误 |
| 3.3 | 2026-07-25 | 第二十三轮审查修复 — Repair costTokens + 时间戳一致性 + monorepo 同步；发现并修复 3 个问题：(1) handlers/index.ts card repair logAICall 缺少 costTokens（§10.5 违规，成功和失败两处均添加 costTokens）、(2) repair logAICall dataSizeBytes 使用修复后输出而非原始 draft（在 repairCard 调用前捕获 repairInputSize）、(3) evaluate-rubric.ts hasValidServerQuestion 使用 new Date() 而非事务内统一时间戳（引入 schedulingNow 变量）；附带修复 monorepo 依赖同步（workers/ai-worker/node_modules/@ailearn/shared 过期导入）；2634 测试全绿，tsc --noEmit 全部 0 错误 |
| 3.4 | 2026-07-26 | 实施审查与附加修复 — 新增 0042/0043 并修复 artifact enum、RLS runtime GUC、持久化错误净化和 ready 检查；统一 effective hard evidence；AIQ scorer 2.0.0 改用独立 prediction 与真实 QWK；Provider/Handler 分层超时；修复 Milkdown 生命周期竞态和终态 Job 会话恢复；PostgreSQL 集成 38/38、Web 49/49、API 恢复 3/3、Worker 41/41、AIQ 32/32 定向验证及相关 typecheck/build/lint 通过。M7 仍未开始，正式版本保持 0.5.0 |
| 3.5 | 2026-07-26 | 审查收口 — 终态恢复改为当前 Job 指针 CAS 并保持 RLS transaction/锁序；补齐 ValidationFocus 安全重试文案、Review mock、RLS migration 断言和调度 fail-closed 测试；新增串行 PostgreSQL 集成脚本。修复后全量单元测试 2717/2717，6 个 package typecheck、Web lint、API/Worker build 通过；浏览器恢复路径无 DOM 敏感字段且 console 0 错误。本地 Worker 退出 137，因此真实 Provider 最终链路仍由 M7 阻断 |
