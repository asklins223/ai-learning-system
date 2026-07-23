# ADR-0010：v0.6 可信掌握闭环与版本路线重排

- Status: Proposed
- Owner: Product / Learning Loop / AI Quality Owner
- Approver: repository owner `@asklins223`
- Date: 2026-07-22
- Decision evidence: repository owner 在 Codex 任务中选择 v0.6 方向 A，并要求其余 AI 能力进入后续版本预期；本文技术细节仍待随 v0.6 计划一并批准
- Records accepted route change: ADR-0009 中“v0.6 以多工作区为产品主线”的版本分配已由 repository owner 撤回
- Supersedes on acceptance: ADR-0004 Decision 4 中 `partial` 前进间隔的规则；ADR-0002、ADR-0003 与 v0.5 计划中“v0.6 以多工作区/图片扩展为主线”的版本分配引用
- Retains on acceptance: Personal Workspace First、workspace/user 数据隔离、session 切换与 RLS；当前工作树中的多工作区能力仅作为 baseline candidate 待 M0 归属
- Related: ADR-0004（Review Attempt 与离散调度）、ADR-0005（AI 质量门禁）、ADR-0009（个人工作区与多工作区模型）

## Context

当前系统已经形成“资料 → 笔记版本 → 学习卡与证据 → 验证 → 复习”的主链，但 AI 仍存在三个直接影响可信度的断点：

1. `validation_questions` 虽然已持久化，题面实际仍由前端生成并提交给服务端，缺少 AI 生成身份、评分 rubric 与证据约束；
2. 验证模型每次临时拆解 claim，并自由输出总体 outcome 与字符串形式的 evidence refs，结果不能从持久化逐点评估确定性重算；
3. 学习卡只有一次模型生成与确定性清洗，清洗发现严重问题后只能丢弃内容或使用渐进放宽 fallback，缺少受控的按需修复阶段。

同时，首次验证与后续 Review Attempt 使用两套调度入口。FSRS 可以用于对照研究，但当前没有足够、干净且统一的真实复习历史支持其直接接管正式到期时间。

多工作区、个人工作区、图片上传等原规划能力已经大量进入当前工作树。它们目前只是 baseline candidate，需要完成归属、迁移、安全与发布验收，不能在绑定 clean accepted SHA 前称为已发布基线，也不再作为 v0.6 的产品主卖点。

## Decision

### 1. v0.6 的唯一产品主线

v0.6 定义为“AI 可信掌握闭环”：

```text
当前硬证据
  → 服务端生成并持久化问题与 rubric
  → 用户在答案与证据不可见的独立会话中作答
  → AI 对 rubric 逐项判定
  → 服务端确定性汇总 outcome
  → 展示证据化反馈
  → 统一离散策略安排下一次复习
```

版本成功不以“增加更多 AI 功能”衡量，而以判断是否可追溯、可重算、可保守降级衡量。

### 2. v0.6 Must

1. **AI 问题与 rubric**：题目由服务端选择或生成，绑定 user、card、key point、note version、AI artifact、rubric version、有效硬证据和 source fingerprint。客户端提交任意题面不得获得理解升级资格。
2. **证据化逐点评估**：模型只判定既有 rubric item，不得新造评分点、证据或最终 outcome；最终 outcome 由全覆盖、fail-closed 的版本化纯函数汇总。任一 contradiction 阻断升级，required item 只有全部 covered 才可能升级；用户显式 unable 也必须生成逐项确定性 assessment 与系统 artifact。
3. **Question-first 会话**：首次验证和复习均使用独立 Focus 会话；`unassisted_answering` 阶段的全部网络响应、服务端渲染/预取数据和 DOM 不得包含生成标题、claim、quote、expected points、evidence refs 或历史答案。显式查看原文后进入不可逆的 assisted 状态，本轮不得升级；同一答案内容的原文或结果暴露记录至少保留 24 小时，放弃、重开、立即补答、换设备或只升级 prompt/rubric 版本都不能清零，trusted start 在冷却结束前阻断。
4. **条件式卡片修复**：继续使用“一次生成 + 确定性质量检查”，只在明确 reason code 触发时最多调用一次同 Provider 修复；修复后仍必须重新通过同一确定性检查。
5. **统一正式调度**：首次验证和 Review Attempt 共用 `discrete-v2` 策略与 reason code，但事务分支明确隔离：首次验证只创建首条 schedule，Review 必须锁定并完成精确输入 schedule 后创建一个后继；`partial` 不再推进间隔，辅助后回答或无可信题目/证据时不得升级。
6. **FSRS 影子运行**：版本固定、参数固定、append-only 记录，只生成对照结果，不修改正式 schedule、不进入用户 UI、不在线拟合个人参数。
7. **版本化质量门禁**：问题、rubric、逐点评估、卡片修复各自有固定数据集、人工标签、评分器版本和 RC 证据。

### 3. 可信升级的必要条件

任何理解升级或正式间隔延长必须同时满足：

- server-issued question 有效且未 stale；
- question 的 source fingerprint 在提交和写结果时仍一致；
- 每个 required rubric item 绑定当前用户有效的 hard evidence；
- submission 的 assistance 状态为 `none`；显式查看答案、claim、quote 或证据后该状态不可逆；
- 评估结果通过契约校验和确定性 reducer；
- 业务写入、attempt/event 与下一 schedule 在受 lease/idempotency 保护的事务内完成。

任一条件不满足时，回答仍可作为历史保存并向用户展示，但 `understandingEffect` 必须为 `unchanged`，不得伪造掌握提升。

### 4. Question 与 Evidence 的边界

- Embedding 或模型语义只能在未来用于候选发现；v0.6 的可信 rubric 必须引用数据库中已确认的硬证据。
- 模型使用服务端临时生成的 opaque evidence ref，不能直接生成或猜测数据库 evidence ID。
- 未辅助作答阶段只返回题型、题面和必要的中性进度信息，不返回生成卡片/笔记标题。rubric、expected concept、evidence snapshot 只能在评估端读取；显式 reveal 必须先原子标记 assisted，或在提交完成后按权限揭示。
- 模型题面本身在激活前必须通过版本化的确定性 leakage hard gate；命中 claim/quote/expectedConcept 重合、答案式结论或 prompt-injection reason code 时只允许安全 deterministic fallback。结构字段泄漏和固定对抗集可作零泄漏门禁，但不宣称对任意未见语义改写完成形式化证明。
- AI 输出契约不请求、不返回、不持久化自由形式 chain-of-thought；只保存必要的逐项 verdict、简短 rationale 与面向用户的反馈。

### 5. 卡片修复边界

- 修复仅针对本轮生成 draft 的确定性质量问题，不由用户答错自动修改共享卡片。
- 同一次 `generate_card` 最多一次修复调用，沿用发起用户选择的同一 Provider/model 与隐私策略；repair claim/count 必须在外部调用前以 lease-fenced CAS 持久化，Worker 崩溃或重试不得再次调用，SDK/HTTP 自动重试也必须关闭。
- 只有安全可解析且大小受限的 schema 问题可触发 repair；无法安全解析的 Provider 输出直接失败。
- 不在 v0.6 给卡片增加“AI 自评难度”“概念图关系”等未经验证的事实字段。
- 修复后若仍存在伪造引用、零有效要点或 schema hard failure，job 失败且不得激活低质量卡片。

### 6. 正式调度与 FSRS

正式策略固定为可解释的 `discrete-v2`：

- 初次 `preliminary_understanding`：3 天；
- 初次 `unclear_expression | misunderstanding | unknown`：1 天；
- Review `correct`：在 `[1, 3, 7, 14, 30, 60]` 中前进一档；
- Review `partial`：保持当前档，不升级；
- Review `incorrect | unable`：回到 1 天；
- `later`：保持档位，仅短暂延后 12 小时；
- 看过原文按 unable 的调度语义安排重试且不升级，正式可开始时间不早于 `max(policy now + 1 天, unassisted_eligible_after)`；self-grade fallback、题目/证据 stale 或 Provider 失败不延长间隔，Provider 失败优先保留未完成 attempt 供幂等重试。

FSRS 只作为 shadow adapter。具体实现版本与参数在 v0.6 M0 锁定，并使用维护中的官方生态实现；是否转正必须在后续版本另立 ADR。

### 7. 版本路线重排

- 多工作区与 Personal Workspace First 保留为当前工作树的 baseline candidate 和持续安全门禁；M0 决定版本归属，不再占用 v0.6 产品主线。
- 概念图谱、Embedding 语义候选、Vision、流式响应、多模型路由、完整结构化反馈处理、自适应题库和 FSRS 正式接管进入 v0.7 方向性预期。
- v0.7 预期不是 Approved scope；v0.6 完成观察和复盘后必须重新选择一个主方向，不默认并行实施全部候选。

## Consequences

### Positive

- 用户看到的掌握判断可以追溯到问题、rubric item、证据和版本化 reducer；
- AI 漂移不会直接改写 outcome 规则或调度规则；
- 题面和答案泄漏从 UI 约定提升为 API/DOM 硬边界；
- 卡片第二次模型调用只在有明确收益信号时发生，成本和延迟可测；
- FSRS 可以积累真实对照数据，而不会在 Alpha 数据不足时破坏现有复习计划。

### Costs

- 需要新增 question/rubric/submission/point-assessment 数据结构和迁移；
- Worker Provider 契约、验证事务和两套前端验证入口都要升级；
- 问题与逐点评估需要新的人工黄金集，RC 的真实 Provider 成本增加；
- source fingerprint、stale 和恢复路径会增加状态机复杂度。

## Alternatives

- **四条 AI 主线同时作为 Must**：拒绝。调度、生成、图谱和多模态同时推进会让 v0.6 无法形成一个可验收的用户结果。
- **FSRS 直接替换正式调度**：拒绝。当前事件语义和历史数据尚未统一，直接切换无法证明收益，也不利于回滚。
- **固定两次模型调用生成所有卡片**：拒绝。成本翻倍且同模型自审不等于质量提升。
- **继续由客户端生成题面并自报 outcome**：拒绝。客户端可以看到或构造答案上下文，无法成为可信掌握依据。
- **v0.6 直接建设自动概念图谱**：延后。自动合并、依赖和矛盾边会累积幻觉，必须先有可靠评测和确认机制。

## Migration / Rollout

1. 先冻结 v0.5 clean accepted SHA，并明确当前工作树能力的版本归属；
2. Expand 新表和 nullable 字段，不切换旧读写；
3. 新问题、新 submission 和新逐点评估 dual-write，legacy question 不再具备升级资格；
4. 通过 feature flag 分别开启 AI question、rubric reducer、question-first UI、card repair 与 FSRS shadow；
5. 固定数据集与真实 Provider 两轮门禁通过后，先在内部 workspace 灰度；
6. 保留旧事件与旧 schedule，只以前向补偿修正，不覆盖历史。

## Rollback / Forward-fix

- UI 可退回只读卡片与复习队列，但服务端不恢复客户端题面或客户端 outcome 的升级能力；
- AI question 失败时使用服务端持久化的确定性 fallback，仍需绑定 rubric 和硬证据；
- AI evaluation 失败时保存用户答案并允许幂等重试，正式掌握状态和 schedule 保持不变；
- card repair 可单独关闭，恢复“一次生成 + hard gate”，不能恢复放宽后自动激活不可信卡片；
- FSRS shadow 可随时关闭，不需要修复正式 schedule，因为它从未写入正式调度。
