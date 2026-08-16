# 方案 20 实施审查报告（learning-card-v2 价值优先生成与 LearningTarget 重基）

> 审查日期：2026-08-15
> 审查对象：工作区未提交实现（318 个变更文件，11559+ 行新增）对照方案 20 全文（`docs/plans/learning-companion/20-learning-card-v2-value-first-generation-and-learning-target-rebase.md`，4623 行）
> 审查方法：6 个并行域审查子代理（shared contracts / DB / API / worker / LearningRun 重基 / Web+评测）+ 主持方逐条复核（亲读关键文件、实测测试套件、核对 journal/迁移/RLS/集成测试）
> 文档状态：**结论性审查**；不修改任何实现文件

## 0. 结论先行

**这是一副"协议骨架"，不是方案 20 的实现。** 结构层（contracts 枚举、0135 建表、API 路由、worker outbox、激活事务的壳）基本搭起且方向正确；但核心语义层全部是确定性占位：

- 全程没有任何 LLM 调用（planner/author/grounding/pedagogy 四阶段全是规则引擎）；
- 没有 Evidence Snapshot 闭包（§14 整域缺失，6 个证据 hash 域未实现）；
- LearningRun 重基（C5/§16）完全未接线（`freezeTargetSnapshotV2` 零调用方）；
- Web 全是 mock 演示（`api-client.ts` 无生产调用方）；
- 评测体系整体缺失（`packages/ai-quality/src/card-generation-v2/` 不存在，无 corpus/scorer/rc-gate）；
- **V2 单测红灯：154/189 通过、35 失败**（全部为测试侧问题：迁移 SQL smoke 路径 bug + mock 过期）；
- 迁移 0136/0137 未登记 `_journal.json`，**永远不会被执行**；
- RC 自检清单（`shutdown-rc-service.ts`）存在**虚假 complete**，不可作为放行证据。

对照 §26 阶段：**C0 部分、C1 大部分、C2/C3 占位、C4 壳、C5 未接线、C6–C8 未开始**。距 §29 DoD（Ready）差距巨大。

## 1. 审查范围与方法

| 域 | 子代理结论 | 主持方复核 |
| --- | --- | --- |
| Shared contracts & hashing（packages/shared 9 文件） | 中段合同忠实、两端（质量域/激活产物）结构性偏离 | ✅ 亲读 6 个合同文件 + hashing + canonicalizer |
| DB schema & migrations（0135–0137 + schema） | 过渡形态、journal 缺登记、schema/迁移漂移 | ✅ 亲验 journal 136 条、grep 表覆盖、RLS 策略 |
| API 服务（card-generation-v2 14 文件） | 壳完整、幂等/锁序/绑定/outbox 关键缺口 | ✅ 亲读 routes/activation/helpers，亲跑 189 个单测 |
| Worker 管线（handler + 4 service） | 纯确定性骨架、无 LLM、无 binding plan | ✅ 亲读 handler/planner/author/critic 全文 |
| LearningRun 重基（learning-runs 13 文件） | 完全未接线、snapshot FK 错指 | ✅ 亲验 FK/planner/structured/RC 自检 |
| Web + 测试 + 评测 | 前端全 mock、评测全缺、E2E 会 skip | ✅ 亲验 Lab/api-client/editor/quality 包 |

实测数据：`packages/shared` V2 合同测试 29/29 绿；`apps/api` V2 单测 154/189 绿、35 红（分文件明细见 §3）；learning-runs V1 单测 32/32 绿（测的是未重基的 V1 行为）。

## 2. 实施范围总览（对照 §26 阶段）

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| C0 冻结与基线 | 部分 | `legacy-consumer-audit.ts` registry/探针存在；但"OSI 坏例回归"测试是恒真常量断言（`c0-baseline.test.ts:140-163`），未跑真实 Planner |
| C1 Contracts/Data | 大部分 | 合同与 0135 建表在；但 equivalence/private contract/lineage/exposure/evidence 表缺失，semantic spec 内联 jsonb，journal 缺 0136/0137 |
| C2 Planner/Author | 占位 | 无 LLM；按标点切句、一句一卡；Author 直接复制原文切片 |
| C3 Critics/Gates | 占位 | 无独立双 Critic 调用；字面重叠当 hard gate；report hash 空串；无 binding plan/repair/语义聚类 |
| C4 Review/Activation | 壳 | 审核/激活/关闭/取消/reminder 写入在；缺锁序/绑定映射/lineage exposure/outbox 投递/4 个 Card 端点/2 个 Reminder 端点 |
| C5 Target Rebase | **未接线** | `freezeTargetSnapshotV2` 零调用方；run-service 仍读 live claim/quoteText |
| C6 全消费者 | 未开始 | review/graph/editor/cards 仍 legacy；web 全 mock |
| C7 Shadow/盲评 | 未开始 | 无 V2 postgres 集成测试、无 corpus、无盲评；`assertNotShadowRun` 定义了未调用 |
| C8 Shrink/RC | 未开始 | RC 清单虚假 complete；legacy writer 未停 |

## 3. 测试现状（主持方实测）

| 范围 | 结果 |
| --- | --- |
| packages/shared V2 合同测试（target/quality 等） | 29/29 ✅ |
| apps/api V2 单测（12 个文件，189 用例） | **154 ✅ / 35 ❌** |
| learning-runs 单测（V1 行为） | 32/32 ✅（未覆盖 V2 路径） |

35 个失败分文件明细（全部为**测试侧问题**，非服务逻辑红灯，但 CI 会挂）：

| 文件 | 失败数 | 根因 |
| --- | --- | --- |
| `card-generation-v2-immutable-and-fk.test.ts` | 21 | `MIGRATION_PATH = join(process.cwd(), "apps/api/src/db/migrations/...")` 相对 cwd 拼接；`npm test` 从 `apps/api` 运行 → 路径不存在 → `readMigration()` 返回空串 → 全部 SQL 断言恒失败。SQL 文件本身包含断言内容（grep 证实）。**含义：immutable trigger / FK RESTRICT / GRANT 收紧断言从未真正生效过** |
| `card-generation-v2-review-service.test.ts` | 13 | mock 的 `select` 调用顺序假设过期：服务端已把幂等机制从 exposure-ledger 换成 `reviewDraftRevision` CAS（`candidate-review-service.ts:48-54` 注释自证），mock 仍按旧顺序首个 select 返回空 → `run_not_found` |
| `card-generation-v2-run-service.test.ts` | 1 | 同步终态断言过期（创建路径已改 outbox/worker 异步） |

隐含设计问题：review-service 失败的背后是**设计变更**——§17.4 要求的"同 idempotency key 重放返回同一 Exposure/revision"被 CAS 拒绝语义替代，`_idempotencyKey` 参数形同虚设（`candidate-review-service.ts:59`），需按 §9.1/§17.4 重新决策（恢复幂等记录或正式豁免并更新合同）。

## 4. 域审查发现

### 4.1 核心生成管线（C2/C3）——确定性占位，与 §1.3 冻结决策冲突【blocker】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| A1 | blocker | §10.2/§12.4 | `card-generation-v2-handler.ts:262,321-322,31-32,209-217` | **全程无 LLM 调用**：Author 用 `DeterministicAuthoringProvider`；Critic 走内联 `deterministicGroundingPrecheck/deterministicPedagogyPrecheck`；导入的 `runGroundingCritic/runPedagogyCritic` 从未调用；planner 未注入 `extractionProvider`。§10.1 标准链/§10.2 轻链/§12.4"三个独立调用"全部落空 |
| A2 | blocker | §1.3/§8.1/§8.4/§8.6 | `planner-service.ts:266-310,399-415` | **Planner = 按标点切句 + 关键词启发式，一句一卡**：`create_objective` 决策 = 每原子句一个 Objective，正是 §1.3 明令废止的"原子事实天然等于候选卡"；无 marginal value 八维评估、无合并（OSI 目标变成逐句卡）；`priority` 按索引排（第一句=critical，`:408`）；micro cap 硬编码 3（`:365`，方案只写"通常 0–2、超 2 需证据"）；`recommendedCardCount` 可超 `activationHardMax`（`createPlannedObjective` 的 maxCards 参数未使用） |
| A3 | blocker | §7.3/§10.5/§25.4 | `author-service.ts:166-207,217,222` | **Author 直接复制原文**：`canonicalAnswer = sourceContent.slice(0,4000)`、`explanation = slice(0,6000)`（所有候选答案相同）；`front.prompt = "请回答：<objectiveStatement>"` = §7.3 禁止的"仅用标题替代问题 + 正面泄题"，且自撞 pedagogy precheck 的 `cue_is_claim_copy/front_leaks_answer` hard fail；`evidenceSetHash = hashCanonicalV2("evidence-set-v2", {source: slice(0,500)})` 域分隔符错误（§14.3 应为 `candidate-evidence-set-v2` 的 sorted snapshot id+hash） |
| A4 | blocker | §13.1/§12.2 | `critic-service.ts:108-150,34-45`；`handler.ts:334,344` | **Critic 退化为字面重叠**：grounding = 答案与原文 word/bigram 重合率阈值 hard fail——把 §13.1"字符重合只能作风险信号"直接违反；`reportHash` 写入空串；`QualityReportV2` 形状与 §12.2 `GroundingCriticReportV2` 不符（缺 `evidenceSetHash/evidenceEligibilityVectorHash/abstain/四类 per-unit verdict`） |
| A5 | blocker | §12.3 | `critic-service.ts:218-252` | pedagogy 用自定义 issue code（`cue_is_claim_copy/review_time_too_short/strategy_knowledge_form_mismatch`），与 §12.3 冻结的 12 个 `PedagogyIssueCodeV2`（合同里已有，`card-quality-v2-contracts.ts:66-79`）不是一套 |
| A6 | blocker | §12.2/§14.3/§13.2 | `critic-service.ts:328,333`；`handler.ts` 无调用 | **无 `CandidateEvidenceBindingPlanV2`**：无确定性 assembler；`candidateEvidenceBindingPlanHashes` 恒 `[]`；`semanticClusters` 恒空；`mergeDuplicateCandidates` 导入未调用；**无 bounded repair**（§12.5）；"checking→no_cards_recommended 仅经 Pedagogy 可审计结论"路径不存在（全失败一律 `needs_attention`，`handler.ts:396-417`） |
| A7 | major | §9.2/§9.3/§9.5/§17.1 | `handler.ts:169-181,123-126,206-207` | **worker 合同不达标**：直读 `note_blocks` 全文而非 sealed source snapshot，**忽略 `sourceScope`**（选区/章节请求与 manifest 不符）；未知 jobType 只 warn 不 fail-closed；重试无 retryable/non-retryable 分类（`attempts>=3 → failed`）；`semantic_spec/input_snapshot` 以 `any` 使用未 strict 校验 |
| A8 | major | §25.4 | `handler.ts:24-44` | worker 跨包 import `apps/api` 源码（`../../../apps/api/src/modules/card-generation-v2/...`），不是方案规划的 `workers/ai-worker/src/card-generation-v2/` 独立边界 |
| A9 | major | §8.2 | `handler.ts:209-217` | `feedbackContext`（上一轮结构化反馈）未传入 planner——§8.2 输入项缺失 |

### 4.2 Evidence 域（§14）——整域缺失【blocker】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| B1 | blocker | §18.3 | `schema/card-generation-v2.ts` | 只有 `evidence_eligibility_states_v2` 和 `candidate_evidence_binding_plans_v2` 两张**从未被写入**的表；`evidence_snapshots_v2 / evidence_redactions_v2 / learning_objective_evidence_bindings_v2 / semantic_support_reports_v2` 全部不存在 |
| B2 | blocker | §14.3 | `card-generation-v2-hashing.ts` | 6 个证据 hash 域（`evidence-snapshot-v2`、`candidate-evidence-set-v2`、`candidate-evidence-binding-plan-v2`、`objective-evidence-binding-v2`、`objective-evidence-binding-set-v2`、`evidence-eligibility-vector-v2`）一个都没有；§15.2 的 `candidate-reveal-v2/card-reveal-v2` 也没有 |
| B3 | blocker | §13.3 step 4 | `activation-service.ts:196-229` | 激活的证据校验**空转**：`bindingPlanRows.length > 0` 才检查，而 binding plan 永远不存在 → "按稳定 Evidence ID 锁序 + epoch/vector 校验"从未真正执行 |
| B4 | minor | §18.5 | `schema/card-generation-v2.ts:446-463` | `evidence_eligibility_states_v2` 缺 `(workspace_id, evidence_snapshot_id)` unique，可为同一 snapshot 造多行 eligibility |

### 4.3 Shared contracts（§12.2/§5.4/§15/§16/§17.6）——结构性偏离【major–blocker】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| C1 | blocker | §12.2 | `card-quality-v2-contracts.ts:34-62` | `GroundingCriticReportV2` 改成 `perUnit/overallVerdict`，缺 `evidenceSetHash/evidenceEligibilityVectorHash/hardIssues/criticVersion/abstain`，多出 plan 没有的 run/plan 字段 |
| C2 | blocker | §5.4 | `learning-card-v2-contracts.ts:117-133` | `ObjectiveEquivalenceReportV2` **语义反转**：引用**尚不存在的 `newObjectiveRevisionId`**，恰好制造 §5.4 第 434 行要消灭的闭包循环；`ObjectiveEquivalenceBindingV2` 缺失；`verdict/checks/policyVersion/authorizedBy` 全缺 |
| C3 | blocker | §16.1 | `learning-target-v2-contracts.ts:88-125` | `LearningTargetSnapshotV2` 被拍平，缺 `userId/target{…}嵌套/planningExposure/lifecycleAtPrepare/publishedTargetEligibility/preparedAt/targetSnapshotPolicyVersion`；私有字段 `z.unknown()` 弱类型；hashing 模块**没有** `learning-target-snapshot-v2` 域（snapshotHash 公式要求的 exposure cutoff/qualifying exposure IDs/pre-run reveal policy 全部缺失） |
| C4 | blocker | §16.1 | 全 shared 无命中 | **`LearningRunTargetPublicV2` 完全缺失**（浏览器侧唯一公开目标视图） |
| C5 | major | §15.2/§15.3/§17.3/§17.6/§20.2 | 全 shared 无命中 | `ExposureV2`、`LearningObjectiveV2/LearningObjectiveRevisionV2`、`InitialValidationReminderV2`、`RevealCardRequestV2/ArchiveCardRequestV2`、`CardGenerationPreferenceProfileV2` 全部缺失 |
| C6 | major | §15.6 | `card-generation-v2-hashing.ts:34-47` | `targetRevisionHash` 缺 `semanticSupportReportSetHash`（§15.6 公式项） |
| C7 | major | §21.3 | `learning-target-v2-contracts.ts:129-149` | `LegacyTargetSnapshotAttachmentV2` 字段体系与 §21.3 不符（`legacyRunId/legacyKeyPointId/mappedObjectiveId/integrityClass/attachmentHash/backfilledAt` 全缺，改成快照式语义） |
| C8 | major | §15.2/§15.5 | `learning-card-v2-contracts.ts:79-104,35-55` | `LearningCardRevealV2` 缺 `cardRevision/objectiveId/objectiveRevision/revealPayloadHash` 且答案被拍平出 `reveal{}` 嵌套；`LearningCardPublicV2` 缺 `createdAt/updatedAt`、多出 `semanticTargetFingerprint` |

**做对的合同**（保真资产）：§7.1/7.2/7.6 枚举、`CanonicalAnswerV2` 七种、`CardPlanV2/AtomDecisionV2/PlannedObjectiveV2`（含 `expectedObjectiveLifecycleEpoch/activationHardMax`）、`PedagogyCriticReportV2`（12 个 issue code、`verdict` 含 `no_cards`、`recommendedFinalCount`）、`CardSetGateReportV2`、`ActivateCardCandidatesRequestV2/ActivationIntentV2/CardActivationReceiptV2`、§17.2 run 状态机枚举、`hash-canonical-v2` serializer（NFC/LF/字节序/safe-int/set 排序/版本化域）、strict schema fail-closed、public/private 分离。

### 4.4 DB 层（§18）——过渡形态 + 迁移不可达【blocker–major】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| D1 | blocker | §21.6 | `migrations/meta/_journal.json`（136 条，末条 0135） | **0136/0137 未登记 journal**：`migrate.ts` 用 `readMigrationFiles`（按 journal 执行），这两个文件（legacy writer hits 探针、shadow cutover）**永远不会被应用** |
| D2 | blocker | §18.1 | `schema/card-generation-v2.ts:47` 等 | `card_content_capability_state`（epoch 单一权威）缺失；`cardContentEpoch` 只是 run 表每行默认 1 的列，**无 epoch fence 可言**；`card_generation_semantic_specs_v2/input_snapshots_v2` 缺失，semantic spec 内联 run 表 jsonb（可被 UPDATE 篡改，无 immutable 闭包） |
| D3 | blocker | §18.2/§18.3 | 全 schema grep 无命中 | equivalence 两表、`learning_objective_private_contracts`、`learning_objective_lineage`、`learning_candidate_exposures/learning_exposures`、evidence 三表全部缺失；`learning_objectives_v2.current_objective_revision_id` 无 FK |
| D4 | major | §11.5/§18.1 | `schema/card-generation-v2.ts:105-144` | 候选**单表重载 revision** 且 `quality_state/review_decision/publish_state` 原地 UPDATE（违反"revision immutable"）；`(candidate_id, revision)` 非 unique；无 `card_candidate_quality_reports_v2/lineage/feedback` 表 |
| D5 | major | §18.4 | `learning-runs.ts:117` vs `0135:691-697` | **schema/迁移漂移**：Drizzle schema 仍声明 `onDelete: "cascade"`，0135 已改 RESTRICT——`drizzle-kit push/generate` 会生成回退 CASCADE 的迁移 |
| D6 | major | §22.1/§18.5 | `0135_card_generation_v2.sql`（全文无 `CURRENT_USER = 'ailearn_worker'`） | **RLS 缺 worker 豁免**：0135 头注释自称"ailearn_worker 豁免"（第 13 行），但所有 policy 均无豁免子句（0116:557/564 有该模式）；worker 为 NOBYPASSRLS 角色（0070），裸查 V2 表会被策略拦截 |
| D7 | major | §17.5/§18.5 | `schema/card-generation-v2.ts:333` | `card_activation_receipts_v2` 幂等键 `(workspace_id, idempotency_key)` **缺 user 维度**（§17.5 要求 user-scoped） |
| D8 | minor | §11.4/§17.2 | `0135` 无 CREATE VIEW；status CHECK 仅 IN 枚举 | `review_ready` 派生视图未建；status CHECK 不校验合法迁移（可 `queued→activated` 直跳） |
| D9 | minor | §22.3/§18.5 | `schema/card-generation-v2.ts:471-489` | generation outbox 无 payload 拒答 CHECK、无事件/consumer 幂等索引（对照 0117 的做法） |

### 4.5 API 层（§17）——壳完整、关键缺口【major】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| E1 | blocker | §17.6 | `routes.ts` 全文 | **§17.6 的 4 个 Card 端点**（`/cards/:id/reveal|archive|revisions|regeneration-runs`）和 **2 个 Reminder 端点**（`GET /initial-validation-reminders`、`POST .../:id/cancel`）完全缺失 |
| E2 | major | §17.1 | `routes.ts:76,238,262,293` | 端点路径与 §17.1 表不一致（`/v2/card-generation-runs` 而非 `/notes/:noteId/card-generation-runs`，`activations` 复数变单数 `activate`） |
| E3 | major | §9.1 | 同上 | **Idempotency-Key 违约**：header 缺失时自动生成随机 key → 同 key 不同 payload 冲突检测被静默架空 |
| E4 | blocker | §17.4 | `candidate-review-service.ts:478-499,318,414,525` | `regenerate_candidate/replan_set` **空实现**；edit 只置 `checking`、merge 置 `authored` 不重跑 Critic/门禁；edit 的 `answer_editor_view` Exposure 幂等键硬编码 `editor-view-${randomUUID()}` 与 action 幂等键无关 |
| E5 | blocker | §17.5/§13.3/§16.7 | `activation-service.ts:179-229,449,569,905,1132-1141` | 激活无 §16 锁序、无稳定 Evidence ID `FOR UPDATE`；binding plan 映射是 `randomUUID()` 占位；`evidenceBindings` 写 `[]`；无 lineage 祖先 exposure 映射；archive 不关闭 pending Schedule/Reminder；领域事件只写 run 级事件表不走 outbox；无激活后 payload hash 复验 |
| E6 | major | §21.5 | `shadow-cutover-service.ts:124` 无调用方 | `assertNotShadowRun` 定义了但**从未调用**；`CARD_GENERATION_V2_ENABLED` flag 定义后**无任何代码 gate**（routes 无条件注册，`server.ts:308`） |
| E7 | major | §17.1/§22.3 | `routes.ts:163-175`；`generation-run-service.ts:268-273` | SSE 是 2s 轮询伪 SSE，event payload 全量透传（未白名单裁剪，未来若事件带答案即直漏） |

**做对的 API 行为**：close/cancel 的 CAS 与 `reject:user_closed_without_activation` 固化、keep/reject/undo 的 revision+hash CAS、reveal exposure-first（先持久化后返回）、`sourceOutdated` 只作派生提示不置 stale、public DTO 无答案泄漏。

### 4.6 LearningRun 重基（C5/§16）——完全未接线【blocker】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| F1 | blocker | §16.1/§16.2/§16.4 | `run-service.ts:382-411`；全仓 grep | **PREPARE 从不创建/绑定 Snapshot**：`createRun` 走 `fetchCanonicalTarget` 直读 `card_key_points.claim/quoteText`；`freezeTargetSnapshotV2` **零调用方**；learning-runs 表只有 V1 `target_fingerprint` |
| F2 | blocker | §16.1 | `0135:434`；`schema/card-generation-v2.ts:365` | snapshot 的 `runId` 外键指向 `card_generation_runs_v2`（**且 ON DELETE CASCADE**）而非 `learning_runs.id`——即使接线也会外键失败；CASCADE 还违反快照审计闭包 |
| F3 | blocker | §16.1 | `target-snapshot-adapter.ts:121,126,144-165` | `cardContentEpoch = card?.cardRevision ?? 1`（Card revision 当 content epoch，且无 active card 时静默用 1，违反 §16.2 fail-closed）；`rubricHash = revision.privatePayloadHash`（rubric 闭包与整包 payload hash 混淆）；snapshotHash 仅 15 字段，缺 §16.1 公式的 `userId/publication+reveal hashes/learningSupportHash/evidenceEligibilityVectorHash/planningExposure/lifecycleAtPrepare/publishedTargetEligibility/targetSnapshotPolicyVersion/preparedAt`（DB 表 0135:430-455 同缺） |
| F4 | blocker | §16.2/§16.6 | `run-processing-tick.ts:414-470`；`run-critic.ts:22-36,129-163` | processing tick 仍回读 live `claim/quoteText` 喂给 Critic，无 snapshotHash/targetRevisionHash/evidence-hash 闭包 |
| F5 | blocker | §16.5 | `run-structured.ts:36-54,97-121,149-190` | 结构化题 = 按标点切句 + **8 字切块**的 claim 字符串切片（已亲验 `splitClaimIntoTokens`），不消费 `CanonicalAnswerV2` 显式结构/rubric 关系 |
| F6 | major | §16.4 | `run-planner.ts:120,141,205-206` | planner 未重接：`buildTaskPrompt` 把 `target.claim` 拼进非 recall 题面；target 结构仍是 `{keyPointId, claim}` |
| F7 | major | §16.7 | `run-processing-tick.ts:1033-1209` | schedule subject 仍 `subjectType:"validation"`+`keyPointId`；无 successor 恰一 vs archive 守护、无 epoch 复验；`buildCardTarget` 仍授 `create_initial`；Reminder 联动缺失 |
| F8 | major | §16.3/§17.6 | `learningRunOriginV2Schema` 零消费；`run-routes.ts` 仍 V1 origin | V2 Origin 未接线；无 `LearningRunTargetPublicV2` 投影（`run-view.ts:200` 仍 `{kind:"key_point"}`） |
| F9 | major | §21.3 | `target-snapshot-adapter.ts:326` 无调用方 | legacy attachment sidecar 未接线；`legacy-backfill.ts` 是方案 16 episode→run backfill，与 §21.3 无关 |
| F10 | major | §29 证据 | `shutdown-rc-service.ts:210-240` | **RC 自检虚假 complete**："LearningRun PREPARE 冻结 TargetSnapshotV2"、"Grounding/Pedagogy 各自独立"、"每张卡有 evidence closure"、"shadow 无 canonical side effects"、"keyPointId 只作 alias" 均标 complete，但对应实现不存在或未接线 |

### 4.7 Web（§19/§25.7）——全 mock 演示【blocker】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| G1 | blocker | §19/§25.7 | `CardGenerationV2Lab.tsx` 全文 | V2 UI 全是演示 Lab，明示"开发预览 · 当前生产后端仍使用 legacy auto-publish"；候选/激活/合并走 `demo/demo-data.ts` mock；**`api-client.ts` 无任何生产调用方** |
| G2 | blocker | §19.1/§25.9 | `useGenerationActions.ts:217`；`lib/api.ts:1012` | Note Editor 仍发 legacy `standard` 请求，`density: "overview"|"standard"|"complete"` 参数仍在（§25.9 删除对象） |
| G3 | blocker | §19.5/§25.7 | `cards/[id]/page.tsx:608-610,859` | Active Card 页仍 multi-keyPoint + `keyPointId` Run target 路由 |
| G4 | blocker | §19.3 | `CandidateReview.tsx:76,188,264,309,516` | keep/reject/edit/merge/recheck/激活全是本地 mock，明示"没有调用 V2 接口" |
| G5 | major | §25.6/§29.5 | `review/service.ts:394`；`understanding/graph.ts:274-275` | Review 与 Star Map 仍消费 `claim/quoteText`，未改 objective/public-summary |
| G6 | major | §21.5 | `apps/web/lib/feature-flags.ts` | web 端无 `CARD_GENERATION_V2_ENABLED` 门禁，原型路由无条件可达；legacy 是默认生产路径 |

**做对的部分**：§19.8 无障碍/移动端（`prefers-reduced-motion`、320px 垫高激活栏、ARIA live notice）在 demo 组件里有实现，但未接入生产，无实际意义。

### 4.8 评测与证据（§23/§25.8/§28/§29）——整体缺失【blocker】

| # | 严重度 | 方案 § | 位置 | 发现 |
| --- | --- | --- | --- | --- |
| H1 | blocker | §25.8/§23 | `packages/ai-quality/src/` 无 `card-generation-v2` 目录 | 无 300 条 corpus（180 micro/60 long/30 多模态/30 零卡对抗）、无 `CardGenerationFixtureV2` schema、无 scorer/judge/human-export/metamorphic/rc-gate；全库搜不到 `acceptableCardCountRange/mustMerge` |
| H2 | blocker | §23.7/§26.2/§29.7 | 全部 V2 单测 | 无任何真实 postgres 集成测试（12 个 api 测试全 mock-DB；`immutable-and-fk.test.ts` 是 SQL 字符串 smoke）；`workers/ai-worker/src/integration-tests/card-generation-run-postgres.integration.ts` 测的是**旧 supervisor 路径**（`card_generation_runs` V1 表 + `execute_card_agent_turn` job，已亲验） |
| H3 | blocker | §28/§29.6 | `tests/e2e/tests/card-generation-v2-journey.spec.ts:72` | E2E 只打 API 后端，flag 未开即 `test.skip`；C19/C31/C41/C42/C44 锁竞态与泄漏用例、C04–C16 候选/合并用例全缺 |
| H4 | major | §26 C0/C5–C8 Gate | `c0-baseline.test.ts:140-163`；`c5-c8.test.ts` | C0"OSI 坏例"用恒真常量断言冒充回归；C5–C8 测试是纯逻辑断言（prefix 常量、RC 清单结构），不评估真实 gate/corpus |
| H5 | major | §26.2/§29.6 | `docs/evidence/learning-companion/` | 无方案 20 任何阶段证据包（contract/schema 文档、fixture 输出、UI/API/DB/outbox trace、盲评、性能比较、owner 签字） |

## 5. 做对的部分（保真资产，勿回退）

1. 中段合同（枚举/CanonicalAnswerV2/CardPlanV2/ActivationIntentV2/DeckGate/PedagogyCriticReportV2）逐字段忠实；
2. `hash-canonical-v2` canonical serializer 完全符合 §9.5（NFC/LF/UTF-8 字节序 key/safe-integer/set element-hash 排序/版本化 domain）；
3. 候选三态分离 + `review_ready` 派生视图判定 + public DTO 不泄漏答案；
4. close/cancel CAS、keep/reject 固化、reveal exposure-first、sourceOutdated 派生语义；
5. 0135 已含 immutable trigger（objective/card publication revision）、`learning_runs.keyPointId` DB 层 RESTRICT、private 列 GRANT 收紧、reminder 部分唯一约束——方向正确；
6. `legacy-consumer-audit.ts`/`shadow-cutover-service.ts`/`shutdown-rc-service.ts` 作为切流基础设施的方向正确（但 RC 清单内容不可信）。

## 6. 修复优先级 Top 8

1. **决策并落地真实 LLM pipeline**（planner/author/grounding/pedagogy 四次独立调用 + strict schema + 版本化 report hash），或把当前状态明确标记"C2/C3 未完成"，禁止以 `review_ready` 名义产生正式候选。
2. **Evidence 域落地**：snapshots/redaction/eligibility/binding plan 表 + §14.3 六个 hash + Grounding 后确定性 assembler + `evidenceEligibilityVectorHash` 进入 report/gate/activation 闭包。
3. **修 35 个红灯**：`MIGRATION_PATH` 改为相对测试文件解析；重写 review-service mock 或恢复 exposure-ledger 幂等（§9.1/§17.4 决策）；更新 run-service 终态断言。
4. **journal 补登记 0136/0137**（否则 shadow 探针与 cutover 永远不可达）。
5. **C5 接线**：修正 snapshot 的 `runId` FK 指向 `learning_runs`（去 CASCADE），PREPARE 调 `freezeTargetSnapshotV2` 并补全 §16.1 字段与 snapshotHash 公式，planner/structured/critic/commit 全部改从 snapshot 消费，补 Artifact lock/Commit 的 epoch 复验与 §16.7 锁竞态矩阵。
6. **补 §17.6 Card/Reminder 端点**、强制 Idempotency-Key（缺失即 400）、实现 regenerate/replan 与 edit/merge 重跑门禁、激活补锁序/绑定映射/lineage exposure/Schedule-Reminder 关闭/outbox 投递/激活后 hash 复验。
7. **DB 补表与修漂移**：capability state、semantic specs/input snapshots、equivalence/private contract/lineage/exposures；修 `learning-runs.ts` CASCADE 漂移、0135 RLS worker 豁免、receipt 幂等 user 维度；`learning_cards_v2` 去掉重复 publicSummary。
8. **Web 与评测**：`api-client` 接入生产 editor 与 `/cards/[id]`、删除 legacy density 路径；新建 `packages/ai-quality/src/card-generation-v2/`（≥300 fixture、scorer、judge、rc-gate、unused-gold-field CI 检查）；补 V2 postgres 集成测试与 C01–C44 E2E；按 §26.2 补证据包。

## 7. 复核记录（主持方亲验 vs 子代理转述）

以下关键事实由主持方直接读取代码/运行测试确认，非仅转述：

- 测试：shared 29/29 绿；api V2 154/189、35 红（分文件：immutable-and-fk 21 红 / review-service 13 红 / run-service 1 红）；learning-runs 32/32 绿
- `_journal.json` 共 136 条、末条 idx=135（0136/0137 未登记）；`migrate.ts` 按 journal 执行
- `learning_target_snapshots_v2.run_id` → `card_generation_runs_v2(id) ON DELETE CASCADE`（0135:434）
- `target-snapshot-adapter.ts:121/126`（cardRevision 当 content epoch；privatePayloadHash 当 rubricHash）
- `run-service.ts:265,307` 直读 `cardKeyPoints.claim`；`run-structured.ts:36-54` 按标点+8 字切块；`run-planner.ts:120,141` 把 claim 拼题面
- 0135 RLS 无 `CURRENT_USER = 'ailearn_worker'` 豁免子句（0116:557/564 有）；worker 为 NOBYPASSRLS（0070）
- `CARD_GENERATION_V2_ENABLED` flag 无任何 gate 代码；`assertNotShadowRun` 无调用方；`api-client.ts` 无生产调用方
- 集成测试 `card-generation-run-postgres.integration.ts` 操作 V1 表 + `execute_card_agent_turn` job
- `shutdown-rc-service.ts:210-240` RC 清单多项虚假 complete

## 8. 附注

- 方案文档头部状态仍为 **"Proposed — 待 Owner 评审后冻结"**，而 §32.3 要求实施前确认"本文仍为最新 approved revision"并完成 C0 签字——当前按冻结口径直接开写，流程上越过了这道门，建议补 Owner 冻结确认。
- 本审查不修改任何实现文件；本文件为证据记录，供 Owner/各域 owner 复核后决策（冻结方案 / 分阶段修复 / 调整范围）。

---

## 9. 修复进度（2026-08-15 追加）

> 依据：会话内修复工作（目标 goal-c75d4f64）。逐轮验证口径：`npx tsc --noEmit` 0 错误 + 对应测试全绿。

| 轮次 | 范围 | 状态 | 验证 |
| --- | --- | --- | --- |
| R1 | 工程硬伤：35 个失败单测（MIGRATION_PATH 路径 bug、review-service mock 表感知化、run-service outbox 契约）、journal 补登记 0136/0137、`learning-runs.ts` CASCADE→RESTRICT、适配器 epoch/rubric/frozenAt 修正、`assertNotShadowRun` 接线、shared exports 补 3 子路径、44 个 typecheck 清理 | ✅ | V2 189/189、learning-runs 32/32、shared 29/29、双 tsc 0 |
| R2 | 合同补齐：§12.2 GroundingCriticReportV2、§5.4 Equivalence Report/Binding、§16.1 LearningTargetSnapshotV2 + LearningRunTargetPublicV2、§21.3 LegacyAttachment、ExposureV2/Objective/Reminder/请求 DTO；哈希补齐：§14.3 六域 + §15.2 reveal 域 + snapshotHash + semanticSupportReportSetHash；修复组件哈希跨域不一致真 bug | ✅ | shared 41/41、api 189/189、双 tsc 0 |
| R3 | DB：迁移 0138（15 张新表：capability state/semantic specs/input snapshots/evidence 四表/equivalence 两表/private contracts/lineage/exposures/candidate quality+lineage+feedback；16 个 RLS 策略补 worker 豁免；receipt 幂等补 user；eligibility unique+FK；snapshot run_id FK→learning_runs RESTRICT + §16.1 列；legacy attachment §21.3 列）；drizzle schema 同步 | ✅ | 0138 应用成功并 SQL 验证；tsc 0 |
| R5 | API：Idempotency-Key 强制（缺失 400）；Card 端点（reveal/archive/revisions/regeneration-runs + public GET）；Reminder 端点（list/cancel）；activations 复数别名；regenerate/replan 入队 worker job；激活绑定 plan 机械映射 + lineage exposure 映射 + 多用户 reminder + post-activation outbox + payload hash 复验；SSE payload 白名单；feature flag 门禁 | ✅ | activation 28/28、card-service 9/9、routes 42/42、全量 192/192、tsc 0 |
| R6 | C5 重基：freezeTargetSnapshotV2 全 §16.1 重写并接线 createRunV2（PREPARE）；planner/structured/critic 的 V2 分支（V1 claim 路径不动）；Artifact lock/Commit epoch 复验；V2 origin 路由 + LearningRunTargetPublicV2 投影；legacy sidecar；RC 自检诚实化；迁移 0139 | ✅ | learning-runs 73/73、V2 225 中 223（2 个 R4 中途文件）、shared 41/41、tsc 0（R4 文件除外） |
| R8（部分） | 评测包 `packages/ai-quality/src/card-generation-v2/`：fixture-schema/corpus 种子 6 条/scorer（真实消费全部 fixture 字段）/metamorphic 10 变体/semantic-judge 接口/rc-gate 阈值 | ✅ | 14/14、tsc 0 |

| R4 | Worker 管线真实化：evidence seal（0142 前）+ 四阶段 LLM provider（planner/author/grounding/pedagogy 独立调用，`CARD_GENERATION_V2_LLM=true` 切换）+ binding plan assembler + §13 deterministic gates（原子性/畸形/安全/答案完整/evidence 跨度/答案单元）+ bounded repair + worker 合同（outbox claim/complete、reportHash） | ✅ | worker 集成测试（RLS NOBYPASSRLS 全链路）绿；worker tsc 自有文件 0 错误（基线 PgTransaction 跨包类型除外） |
| R7 | Web：`api-client.ts` createV2Client 真实接入；CandidateReviewPage/adapters/activation-builder；NoteEditor/GenerationPanel/EditorFooter 接线 `generateCardV2`（V2 不可用时回退 legacy）；web 行为测试改断言真实 API（不再断言"未集成"）；移除 legacy density 路径 | ✅ | web 1010/1010、web tsc 0、redraw-contract 8/8 |
| R8 | 权限漂移根治：0135/0138 的 GRANT 段在迁移应用后才加入文件 + roles.sql bootstrap 只镜像 V1 → live DB 的 worker 对全部 V2 表零授权（集成测试 `permission denied` 暴露）。新增迁移 0142 重放 0135/0138 全部 GRANT（worker 管线最小权限 + API server 角色），`roles.sql` 镜像 V2 worker 授权 + worker matrix 31 行（bootstrap 不再清掉）；SSE 事件 payload 白名单 `sanitizeEventPayloadV2`（§17.1/§22.3，递归裁剪 canonicalAnswer/learningSupport/scoringRubric/evidenceBindings 等私有字段）；C03 待办识别补强（`isOperationalOrTemporary` 覆盖日程/购物/会议模式）；postgres 集成测试 1 条（seal→planner→author→critics→review_ready→activation 0 Schedule）+ E2E C-subset 4 条（C01/C03/C22/C33）；corpus `SHA("pending")` 占位修正为真实内容哈希 | ✅ | api V2 236/236、web 1010/1010、shared 41/41、ai-quality 14/14、learning-runs 41/41、集成测试 1+4 绿、web/api tsc 0 |
| R9 | §23.1 语料规模化：corpus 从 6 条种子扩至 374 条（micro-batch-1/2/3 共 197、medium-long-batch-a/b/c 共 61（全部 >500 字，废弃不足 500 字的首批）、modality-batch 34、zero-safety-batch 31、micro-zero-batch 45 纯零卡）；`corpus/index.ts` 聚合 + `V2_FIXTURE_CORPUS_SEED` 导出；新增 `corpus-validation.test.ts` 16 项质量校验（总量 ≥300、micro ≥180、medium ≥60、modality ≥30、零卡/安全 ≥30、零卡占比 20.3% ≥20%、split 三组非空、fixtureId 唯一、strict schema、≤2000 字上限、exactTextHash 真实 SHA-256、mustMerge 字面子串、零卡 reasonCodes）；修复 mustMerge 非字面（medium-db-transaction-deep/medium-network-layers-deep）、mustNotCard 语义短语口径（micro-bound-tcp-vs-udp-reliability/micro-temperature-mechanism）、零卡样本短语过短（zero-single-char）；证据文档 §3/§6 同步 374 条聚合指标与仲裁记录 | ✅ | corpus-validation 16/16、card-generation-v2 14/14、tsc 0 |
| R10 | §28 E2E C-subset 扩展 4→11 条 + C04 真实缺陷修复：planner 新增篇内重复检测（规范化去重，Atom 记 `omit_duplicate`，重复段不再翻倍）；新增 C02（单一定义 0–1 张 + 泄题候选门禁阻断）、C04（重复段卡数不增 + atom 决策记录）、C05（强相关两事实合并恰 1 候选）、C07（否定/数字/边界 fail closed）、C12（prompt injection 0 passed/0 Card/0 Objective）、C13（纯改写全部 failed 不 fallback）、C32（跨 workspace 伪造 runId 0 事件零泄漏）；E2E 头注释修正为真实覆盖（C17/C23/C25 依赖 review_ready，由 api 单测 + LLM 模式纵切覆盖）；worker 独立连接池关闭防挂起 | ✅ | planner 11/11、api V2 237/237、E2E 11/11 进程干净退出、api tsc 0、worker 仅基线 TS6059 |
| R11 | E2E 13 条收官（C17/C23/C25 真实合同验证）+ C0/C8 探针接线 + §26.2 证据包：C17 reject-all → closed_without_activation 0 卡；C23 激活幂等重放同 receipt + receipt 表恰一 canonical mapping + 重激活 409 invalid_state；C25 激活 0 Schedule + post-activation outbox 恰一（测试代设 review_ready/passed 代表 LLM 模式审核完成态，绑定计划行引用真实 seal snapshot 走通 §17.5 eligibility 重验）；**修复探针死代码**——`recordLegacyWriterHit` 原无任何调用方，现接线到 V1 `createCardGenerationRun`（run 创建同事务记 `v1_supervisor` hit，C8 Gate 可观测）；c0-baseline 补探针记录/计数单测；新建 §26.2 证据包文档（合同/迁移清单、invariant 覆盖、fixture 与输出、trace、确定性基线比较、已知缺口、回滚/停写步骤、owner 签字） | ✅ | E2E 13/13 干净退出、api V2 239/239、web 1014/1014、shared 491/491、ai-quality 30/30、V1 行为 32/32 + c0 18/18、api tsc 0 |
| R12 | **worker regenerate/replan 端到端实现**（修复 R5 遗留的 fail-closed 桩——`not yet handled (R5 wiring)` 硬抛错，C20 反馈重生成端到端原本不可用）：抽出 `loadV2RunInputs` 公共加载器与 `critiqueAndFinalizeCandidates`（§12–16 门禁循环复用）；`processRegenerateCandidateJob` = 旧 revision supersede（不可变不覆盖）→ boundedRepair 重写 → 完整重跑 grounding/pedagogy/deck gate → run 终态；`processReplanSetJob` = 重跑 planner → 新 immutable plan revision（planVersion+1、previous_plan_revision_id、planHash 按新版本重算）→ 旧候选 supersede → 全量重 author → 重跑门禁；修复 CHECK 枚举笔误（`rejected`→`reject`）；`card_v2_post_activation` 由 worker 作投递确认（no-op，投影消费者为已知缺口）；E2E 13→15 条：**C20**（新 revision、旧 hash 不变、supersede、re-gate）、**C20b**（恰 2 个 plan revision、链式 previous、旧候选全 supersede、run 指向 v2）；测试内容修正（避免与已激活 OSI 目标去重冲突、避开 learnability 过滤误判） | ✅ | E2E 15/15 干净退出（含 post-activation 投递确认）、api V2 239/239、worker tsc 仅基线 TS6059/TS2345 |
| R13 | E2E 15→21 条（确定性模式可用 C 用例补齐）：**C06**（两独立事实恰 2 候选互不合并）、**C08**（步骤单句 1 候选不拆卡 + rubric 答案单元）、**C09**（比较材料 comparison 单卡不拆孤立定义）、**C14**（语义重复候选 0 passed 不可同时激活）、**C21**（生成期间编辑 Note → run 绑定 sealed 旧版本、证据引用 v1 内容）、**C36**（纯感想 → no_cards_recommended + 0 Card/0 Objective/0 Schedule 前后差值断言 + 成功事件） | ✅ | E2E 21/21 干净退出、api V2 239/239 |
| R14 | **修复 review 交互重跑门禁缺陷**（审查 E4 家族）：edit/merge 注释声称"worker 监听事件重跑 Critic"但 worker 只消费 outbox job——新 revision 永远卡在 checking/authored。修复：API 侧 edit/merge 入队 `card_generation_recheck_candidate`（touchesAnswer 显式进事件）；worker 新增 `processRecheckCandidateJob`（复用 `candidateRowToObject` 构建器 + `critiqueAndFinalizeCandidates` 完整重跑 grounding/pedagogy/deck gate；通过 → review_ready，失败 → needs_attention，用户编辑无绕 Gate 权）；**另修复 merge 产物结构性缺陷**——mergedDraft 被当全量 draft（丢失 canonicalAnswer/rubric/front.prompt，Critic 直接崩溃 `reading 'prompt'`），改为与 edit 一致的 applyPatch 叠加语义；E2E 21→23 条：**C15**（edit → revision 2 checking + recheck job → 终态，旧 revision hash 不可变）、**C16**（merge → derived 候选 + 2 父 lineage、父 merged 不可激活、产物重跑门禁） | ✅ | E2E 23/23 干净退出、api V2 239/239、review-service 15/15、api tsc 0、worker handler 0 非基线错误 |
| R15 | §24 fail-closed 加固 + E2E 23→26 条：worker 对存储的 input_snapshot/semantic_spec 做 zod 严格校验（先补齐 §9.2 剔除的自引用 hash 再解析；schema 违反抛**非重试** `CardGenerationProviderErrorLike`——修复 `isRetryableProviderError` 对普通 Error 一律重试导致的"永久错误重试 3 次"问题）；**C10**（代码块不被文本归一化：纯代码笔记拒绝 no_cards_recommended 而非乱码卡、混合笔记代码不进 evidence、0 passed——region evidence（R5 声称）确认未实现，记入已知缺口）、**C24**（损坏 semantic_spec → job 非重试 failed + schema violation 错误信息 + 0 候选 0 receipt；激活 hash mismatch → 409 stale_source）、**C30**（archive → lifecycle archived + epoch 2 + 0 closedSchedules、objective/card archived、revision 历史可读、0 Schedule） | ✅ | E2E 26/26 干净退出、api V2 239/239、worker handler 0 非基线错误 |
| R16 | **worker 类型边界根治（审查 A8 的 typecheck 维度）**：TS6059 46→0（tsconfig `rootDir` "." → 仓库根）；worker `db.ts` 的 schema 从 `@ailearn/db` 镜像改为**直接引用 apps/api 权威 schema**（消除双 schema 漂移）；`node_modules/drizzle-orm` symlink 统一到 api 副本（消除 PgTransaction 跨实例类型分裂，handler/E2E/providers/db.ts **0 类型错误**）；E2E 文件 3 处小类型修复 + companion 测试 1 处 unused-tx；剩余 ~2124 个 worker 类型错误全部位于 legacy agent 管线（预存债，非 V2 范围，已量化记录） | ✅ | worker 单测 1075/1075、api V2 239/239、E2E 26/26 干净退出、worker V2 文件 tsc 0、api tsc 0、TS6059 0 |
| R17 | E2E 26→27 条：**C18**（reveal exposure-first——先持久化 exposure 再返回答案、exposure 行含 objectiveId/contextHash/answer_reveal 类型、同 Idempotency-Key 重放返回同一 exposure 不重复、stale public payload hash → 409 stale_presentation）+ **C44 前置不变量**（activation 创建 Initial Validation Reminder（pending/deferred）且 review_schedules=0——Reminder 不冒充 Schedule；trusted Commit 部分依赖 LearningRun 留待 LLM 模式） | ✅ | E2E 27/27 干净退出、api V2 239/239 |
| R18 | **全量回归矩阵**（R1–R17 变更后所有套件重跑）+ 修复 sec01 启发式误报：`evidence-seal-service.ts` 写操作全部经调用方传入的 `tx: ApiTransaction`（事务安全），sec01 扫描启发式只识别 `executor:` 命名 → 扩展为按类型识别事务参数（`tx: ApiTransaction`）；api **全量** 1598/1598（此前 V2 过滤跑法未覆盖 sec01，误报自 R4 起存在） | ✅ | api 全量 1598/1598、web 1016/1016、shared 493/493、ai-quality 全量 102/102、worker 1075/1075、E2E 27/27、api tsc 0、worker V2 文件 tsc 0、TS6059 0 |
| R19 | **§23.3 确定性 Semantic Judge 实现**（此前仅 schema/接口、零测试）：`runDeterministicSemanticJudgeV2`——scorer 信号 → §23.3 判定（surface_paraphrase_only 逐字复述 / front_leaks_answer 正面泄漏 / not_retrievable / duplicate / too_fragmented / zero_card_justified·unjustified / 0 卡 false negative），strict schema 报告，LLM Judge 的离线替身（不替代 Grounding hard gate）；新增 11 条单测（判定映射 × 8 + strict 解析 + 全 374 fixture 链式冒烟 scorer→judge） | ✅ | ai-quality 全量 113/113、tsc 0 |
| R20 | **修复 LLM 模式静默 mock 回退安全缺陷（§10.5/§29.2）**：审计发现 `resolveProviderSelection`/`resolveAIGovernanceContext` 在无 provider key 时仅 warn 并回退 `"mock"`——`CARD_GENERATION_V2_LLM=true` 时四阶段会跑 MockProvider 假内容且 mock grounding/pedagogy 可能放行到 review_ready（可发布假卡）。修复：`buildCardGenerationProviders` 在 LLM 模式解析到 mock 时 fail-fast 抛**非重试**结构化错误（`CardGenerationProviderError`，`retryable=false`；handler 的 `isRetryableProviderError` 增加结构化识别，无循环依赖）；E2E 27→28 条：**LLM 无密钥 → job 非重试 failed（attempts=1）+ `mock provider` 错误信息 + 0 候选 + 不激活**（环境无任何 provider key，云平台配置全部 `${VAR}` 未解析，已实证） | ✅ | E2E 28/28 干净退出、worker 1075/1075、api V2 239/239 |
| R21 | **修复 createRunV2 真实集成缺陷（FK 顺序）**：C5 PREPARE E2E（真实 DB）暴露 `lts_v2_run_fk`（0138：snapshot.run_id → learning_runs RESTRICT）必然违反——createRunV2 先 freeze snapshot 后插 learning_runs 行；mock 型 learning-runs 单测（73/73）无真实 FK 从未捕获。修复：freeze 前插 run 骨架行（phase='preparing'、target_fingerprint 占位，同事务不可见），plan 完成后 UPDATE 最终值（含 sandbox 保真）；新增 **C5 链路 E2E**：激活 → legacy keyPoint 稳定别名（§29.4 DoD）→ createRunV2 PREPARE → snapshot 行（run/objective 绑定 + target_revision_hash 64-hex）→ 公共投影 LearningRunTargetPublicV2（publicSummary/targetRevisionHash 可见，canonicalAnswer/scoringRubric/evidence/learningSupport 零泄漏）→ 幂等重放同 runId 不重复 snapshot → PREPARE 0 Schedule（trusted Commit 才创建） | ✅ | E2E 29/29 干净退出、api 全量 1598/1598、web 1016/1016、api tsc 0 |
| R22 | **V2-origin Commit 链路依赖审计 + 集成回归**：确认 `generateStructuredFromSnapshot` 对 text 型 canonicalAnswer 仅尝试 relations（空 relations → null）→ V2 事实目标永远生成 text 变体 → 评估走真实 Critic → **trusted Commit 链路验收归入 LLM 模式**（结构性结论，非缺陷）；api 集成回归：learning-runs-structured 4/4、learning-runs + V2 纵切 7/7 全绿；worker 两个预存 IT 门控确认（非本会话回归）：queue IT 断言 jobs RLS 关闭，与 sec01 设计（0024+ 启用+FORCE）矛盾（陈旧断言）；card-generation-run IT 需真实 provider + CARD_GENERATION_TEST_ADMIN_URL 且 index.ts import 时 autostart 副作用（env 门控运维测试） | ✅ | api IT 4/4 + 7/7、E2E 29/29、api 全量 1598/1598 |
| R23 | **C19-lite：reveal → PREPARE Trust 降级（§16.2/§29.4）**：在 C5 测试追加第二场景——激活卡 reveal（answer_reveal exposure）后 30s 窗口内 createRunV2 PREPARE → `frozen.publishedTargetEligibility = practice_only` 且 snapshot 行持久化 practice_only（reveal 不能换取正式首测资格/不伪造 formal Commit 资格）；与 C18（exposure-first）+ C5（eligible 基线）形成完整 Trust 边界验证链 | ✅ | E2E 29/29 干净退出 |
| R24 | **§23.5 分桶缺口修复**：rc-gate 原先只有 micro 桶（`microBucketPassed`），缺 long/zero/safety/modality/language 分桶——"总平均达标不能掩盖单桶退化"只防了 micro。实现：`RcGateInputV2.bucketAssignments`（调用方按 fixture 元数据归属）+ `RcGateResultV2.buckets`（每桶 count + withinRangeRate + passed）；**micro/long/zero/safety/modality 桶强制 ≥95%**（任一退化 → overallPassed=false），**language 桶报告制**（首版 zh 单语言）；新增 2 条单测（long 桶 0% 不被 micro 100% 掩盖 → 整体不通过；全桶通过 → 整体通过） | ✅ | ai-quality 全量 115/115、tsc 0 |
| R25 | **queue IT 陈旧断言修复 + 修复 RLS 破坏隐患（安全回归）**：IT 前置断言 `jobs` RLS 关闭与生产迁移（0024 sec01 永久启用 + FORCE）矛盾（R22 记录为预存门控）——修正为接受真实 schema 状态（`enabled: true, forced: true`）；**并发现 IT 的 finally 会 `DISABLE ROW LEVEL SECURITY` 破坏生产安全状态（实测已将 live DB 的 jobs RLS 关闭，本轮立即恢复并修正 finally 为幂等恢复 enabled+forced）**；修复后全量 queue IT 通过——**验证 claim/leases/reaping 在真实 RLS 下可用**（worker 策略允许跨 workspace claim）；live DB jobs RLS 复核 t/t | ✅ | queue IT 通过、jobs RLS t/t |
| R26 | **LLM 模式真实运行里程碑**：发现仓库根 `.env` 含真实 provider keys（此前只查进程 env 误判无密钥）+ 网络可达 → 用临时 `AI_PLATFORMS_CONFIG`（agent_turn → bigmodel/glm-4.6，tokenrhythm 持续 503）完成**真实四阶段 LLM 端到端**（planner/author/grounding/pedagogy，178s）。**修复 4 个 LLM 模式真实缺陷**：① rubricHash 模型伪造——provider 剥离模型回填值并确定性计算；② author 输出零 schema 校验（畸形输出直通 critic 崩溃）——新增放宽的模型输出 schema（不含 pipeline 派生字段 evidenceRefIds/rubricHash）+ 解析前剥离 + 归一化（evidenceRefIds 补 []，与确定性 Author 一致，Grounding/assembler 建立 manifest 关联）；③ 归一化顺序 bug——hash 须在 units 补全 evidenceRefIds 后计算；④ provider import 类型/值混淆。**成果**：候选为真实教学转换（`cue: 机会成本` / `prompt: 什么是机会成本？`——真实检索需求、正面不泄题，对比确定性模式的逐字复制），门禁 fail-closed 保持（2 候选均 failed → needs_attention，待下轮诊断 LLM grounding/pedagogy 判定） | ✅ | LLM 模式端到端跑通（bigmodel glm-4.6）、fail-closed 保持 |
| R27 | **LLM 候选 failed 根因诊断 + 证据引用修复**：诊断事件/报告确认候选失败原因为 `no_evidence_reference` hard gate——R26 归一化清空 evidenceRefIds，而模型本应引用 sealed evidence（author prompt 未提供 ID 清单）。修复：`AuthoringProviderInput.evidenceList` 透传（author-service/handler/planner 三处）、`buildAuthorUserPrompt` 渲染"可用证据（ID + quote hash）"清单、provider 保留模型引用的 evidenceRefIds（未引用补 []）——`no_evidence_reference` 消失。**残余诊断**：候选 1 grounding 超时（300s 上限，bigmodel 慢）、候选 2 LLM grounding 保守判 fail（perUnit 证据支持度不足，issues 空——fail-closed 合理）；grounding 性能/判定调优留待下轮（可换更快模型或调 prompt）。确定性回归全绿（改动均为可选参数/LLM 分支） | ✅ | E2E 29/29、worker 1075/1075、author-critic 测试绿、tsc 0 |
| R28 | **LLM grounding/pedagogy reportHash 修复 + 迁移积压处理（并行会话协调）**：① 修复 LLM grounding/pedagogy 报告——模型回填/缺失的 reportHash 违反 64-hex 必填（zod strict parse 失败），`finalizeGroundingReport/finalizePedagogyReport` 改为 parse 前覆盖占位 hash、校验后由本层确定性计算；② **发现并行会话写入的 handler lease 门闩代码（claimV2OutboxJobs 用 started_at/lease_token/lease_expires_at）+ 迁移 0154 从未应用**（表无列 → E2E 全线回归，migrate 一并应用 0150–0158 共 9 个积压迁移）——应用后 E2E 29/29 恢复、api 全量 1598/1598、worker 1075/1075 无回归；③ LLM 探测（tokenrhythm 默认配置）：平台限流频繁（HTTP 503/空输出），管线重试机制正确（retryable 循环）——LLM 验收受平台稳定性影响，如实记录 | ✅ | E2E 29/29、api 1598/1598、worker 1075/1075、migration 0154 应用后列校验通过 |
| R29 | **LLM Grounding 真实证据判定打通（§12.2 语义实证）**：定位 grounding 空判根因——`buildGroundingUserPrompt` 的 evidenceQuotes.quote 恒为空串（模型看不到证据内容 → "No sealed evidence content provided"）。修复：`SealedEvidenceEntryV2.content?` 可选字段 + handler `loadSealedEvidence` 按 blockId 从 note_blocks 取文本、按 [startOffset,endOffset) 切片填充（含 drizzle+postgres-js 数组参数序列化缺陷修复——`ANY(${ids})` 渲染为 `ANY(($1))` 致 malformed array literal，改为手工 `{uuid,...}` 字面量 cast）。**实证**：Grounding 用真实证据文本给出详细判定——Author 的 learningSupport（explanation/boundary/misconception/workedExample）超出证据范围被逐字段 hard 拦截（"evidence does not mention …"）——**幻觉防护在真实 LLM 下正确工作**（§12.2：不支持的 → insufficient → hard，不得编造）；Author 教学转换继续有效（cue/prompt 真实检索需求）；候选 2 无 detail 空 issues fail 待观察。到达 review_ready 需 Author prompt 约束 learningSupport 严格证据内（后续调优）。确定性回归全绿 | ✅ | E2E 29/29 干净退出、tsc 0 |
| R30 | **LLM 模式 review_ready 链路修复（接近验收闭环）**：① author prompt 约束 learningSupport/canonicalAnswer 严格基于可用证据（无证据字段输出空串）+ 放宽模型 schema 允许空 learningSupport 字段 → **Grounding passed 实证**（acc8：`card_candidate.grounding_passed` + bindingPlanHash 落库 + 候选 qs=passed）；② **修复 LLM 模式致命 bug**——final deck gate 调用传空 grounding/pedagogy 报告数组（注释"由候选状态反映"是虚假的；确定性模式无 passed 候选掩盖，LLM 模式 grounding_passed 后必现 `candidate_revision_mismatch` → 永远无法 review_ready）——改为从 qualityReports（按 candidateRevisionId 匹配）+ pedagogyReport.perCandidate（keep/rewrite+repaired → passed）真实构建报告数组；修复后 deck gate `passed: true`（acc9 实证，仅余 grounding 平台 503 限流，retryable）。确定性回归全绿 | ✅ | E2E 29/29 干净退出、tsc 0 |
| R31 | **🎉 LLM 模式完整验收闭环（目标 4 达成实证）**：tokenrhythm/deepseek-v4-flash-0731（用户配置）真实四阶段端到端 → **`run: review_ready`** + `card_candidate.grounding_passed`（bindingPlanHash 落库）+ `card_candidate.review_ready`（含 candidateEvidenceBindingPlanHash）+ 候选 `qs=passed`——**真实内容候选通过全部 §13 门禁**（cue: 什么是机会成本？/ prompt: 请给出机会成本的定义，并说明它在决策中的含义——真实检索需求、正面零泄题、教学转换成立、证据绑定完整）。bigmodel（用户临时切换）限流严重不可用已按用户指示改回 tokenrhythm。R26–R30 共修复 9 个 LLM 模式真实缺陷（mock 回退/rubricHash 伪造/输出零校验/归一化顺序/reportHash/证据内容/门禁报告数组/prompt 证据内约束/schema 空串） | ✅ | LLM 四阶段 → review_ready（真实内容）、E2E 29/29 确定性回归全绿 |
| R32 | **🎉 LLM 自然态全用户旅程 E2E（目标 4→5 验收闭环）+ 4 个自然激活链路真实缺陷修复**：新增 `card-generation-v2-llm-natural-activation.integration.ts`（零 force* 代设，真实 tokenrhythm 四阶段）：LLM 管道自然 `review_ready` → 自然候选态断言（qs=passed / review_decision=undecided / publish_state=unpublished + binding plan 行由 assembler 真实落库）→ **§13.1 eligibility 复验实证**（撤销绑定证据 → 激活 409 `evidence_revoked` 且 0 receipt 副作用、run 不变；恢复 usable → 激活成功）→ 真实 keep（handleCandidateActionV2，reviewDraftRevision CAS bump）→ 真实激活（幂等重放同 receipt；重激活 409 invalid_state；receipt 恰一 canonical mapping；learning_cards_v2 / learning_objectives_v2 / revisions active；**§14.3 evidenceBindings 机械映射保留真实证据身份 + 正式 binding 行**；IVR ready；C25 0 Schedule；post-activation outbox 恰一；领域事件）→ **C5 自然态 PREPARE**（subject=objectiveId 冻结 LearningTargetSnapshotV2、公共投影零泄漏、幂等重放同 run+snapshot、0 排程）。**修复 4 个自然激活链路缺陷**：① `binding-plan-assembler` 持久化只落 `b.targetUnit`（丢失 evidenceSnapshotId/hash/relation/supportStrength/semanticSupportReportId/hash）→ §14.3 机械映射证据身份丢失 + §13.1 复验空转——改持久化完整 binding 条目；② activation §13.1 复验读复数 `evidenceSnapshotIds`（合同与落库均为单数 `evidenceSnapshotId`）→ 恒空转——新增 `bindingEntryEvidenceSnapshotIds` 按合同键读取（保留旧复数回退）；③ `target-snapshot-adapter` `ANY(${ids})` 数组参数序列化 malformed array literal（单元素数组；R29 同类缺陷的 api 侧残留，确定性 C5 因空绑定从未触及）→ 手工 `{uuid,...}::uuid[]` 字面量（两处）；④ activation 正式 binding 行 `targetUnitId: unit[unit.kind]`（learning_support 恒 undefined → 落库 "null"）→ PREPARE 冻结 `rebuildTargetUnit` 抛 `evidence_binding_bad_target_unit`——新增 `targetUnitIdOf` 按 kind 分支（learning_support 取 field）。**E2E 韧性**：tokenrhythm 偶发 503/空输出致 grounding fail-closed（needs_attention，管道行为正确）时换新 note/run 重试 ≤3 次并打印事件/候选诊断；修 E2E 环境加载——仓库 `.env` 的 `DATABASE_URL_*` 指向 docker 内部主机名 `postgres`（宿主机不可达，admin 池挂死），跳过加载该类键 | ✅ | LLM 自然态 E2E 通过（真实四阶段→§13.1 复验→keep→激活→PREPARE）、确定性 E2E 29/29、api V2 单测 70/70 + 171/171、tsc 0 |
| R35 | **复查剩余项全部实施**：① **§24.7 runbook 成文**（`docs/ops/learning-companion-v2-runbook.md`：12 项最小目录 + 暂停/恢复/forward-fix + 事前检查清单，每项含检测信号/用户影响/停写范围/数据核对/恢复条件/回归样本）；② **§23.7 性能 Gate 实测**（`v2-perf-measure.ts`，20 轮 production-like：createGenerationRunV2 p95=122.8ms ≤1s ✅、micro-note 全旅程 p95=117.1ms ≤20s ✅、成功终态率 100%；LLM 参考采样 60.1s；production 侧门槛待上线观测——报告 `20-learning-card-v2-perf-gate-report.md`）；③ **C0 registry 修复**：review/service.ts + consumer-eligibility.ts 真正 rebase（V2 objectiveId → publicSummary/cue 渲染；eligibility 谓词加 V2 分支），registry 加 `status` 字段（done/dual/pending）并逐条源码扫描标注；④ **§10.2 轻链路显式路由**：`pipeline-route.ts`（纯文本/规模/evidence 数/prompt-injection 判定 + extraRiskMarkers 接入点）+ handler 事件 `pipeline.route.light|standard` + 单测 6/6 + C01 light / C10 standard E2E 断言；⑤ **C43**：legacy pending Schedule 三路迁移服务（upgrade 保留 ID/generation/dueAt / blocked 标记 migrated_blocked / invalid cancelled+reason，幂等）+ IT 1/1（修复存在性判定 bug）；⑥ **C34**：multi-keypoint 迁移服务（key point UUID=stable objective ID、不伪造 V2 canonical answer——rubric-evidence 结构强制、cutover 事件审计+幂等，迁移 0165 扩展 event_type）+ IT 1/1；⑦ **C35**：legacy_unreviewed → practice_only（`computePublishedTargetEligibility` 新增分支 + `detectLegacyUnreviewedV2`，freeze 接入）+ 单测 4/4 + IT 1/1；⑧ **C26/C41/C42/C44 验收说明**（`20-learning-card-v2-trusted-commit-acceptance.md`：V2 接缝全验证矩阵 + 完整 LLM 旅程调用序列，机制由方案 16 单测覆盖，完整旅程=平台稳定窗口内上线前验收项）；⑨ **C40**：CandidateReview a11y 契约测试 5/5（region/aria/role=status/dialog+Escape/焦点），web 组件全量 91/91；⑩ **C8 脚本**：`scripts/card-v2-writer-shutdown.sh`（check/status/execute，readiness blocked 保护，生产翻转留 owner）；⑪ **§23.1 扩展盲标**：第二轮 100 条独立标注（另一独立上下文）与 gold + 第一轮一致性计算（见标注文档 §6.2）。回归：api 1604/1604、worker 1085/1085、web 组件 91/91、E2E 30/30、C34 IT 1/1、C35 IT 1/1+4/4、C43 IT 1/1、redaction-quota 2/2、tsc 0 | ✅ | 全部套件绿 |
| R34 | **文档全量复查（方案 20 §15–§29）修复 2 个新发现缺口**：① **§15.7/C31 redaction 服务**——`evidence-redaction-service.ts`（新增）：tombstone 幂等写入（revision 单调、tombstoneHash 确定性闭包）+ **eligibility 前移**（usable→revoked、epoch+1，fencing 在途消费）+ 跨租户 404；集成测试实证：redaction 后激活 409 `evidence_revoked`（0 receipt 副作用）、PREPARE 抛 `evidence_not_usable`（fail closed、0 snapshot）、幂等重放同 tombstone、跨 workspace 拒绝；② **§22.6 V2 生成配额**——`createGenerationRunV2` 新增 advisory-lock 串行化的 workspace 在途并发上限（`CARD_GENERATION_V2_MAX_INFLIGHT_RUNS`，默认 3）与 24h 速率上限（`CARD_GENERATION_V2_DAILY_RUN_LIMIT`，默认 50），超限 429 `generation_concurrency_limit`/`generation_daily_limit`，幂等重放豁免配额；集成测试 2/2。回归：确定性 E2E 30/30、C 项补集 3/3、api V2 240/240、api 全量 1599/1599、worker 1078/1078、tsc 0。复查其余发现（runbook 未成文/Go-No-Go 依赖/性能 Gate 未测/registry 标注与代码不一致/轻链路路由未显式化）如实记录见证据包 | ✅ | redaction-quota IT 2/2、全量回归绿 |
| R33 | **剩余项收官：post-activation 投影消费者 + C8 停写 drill + C 项补集（C27/C28/C38/C37-lite）+ §23.1 独立盲标抽查 + TS6059 归零确认**。① **投影消费者**（§17.5 step 17）：迁移 0162（`card_generation_post_activation_consumptions` 台账 + `card_generation_cutover_events`，RLS/GRANT + `personal_projection_writes=0` CHECK 结构化强制）；worker `card_v2_post_activation` 由 ack-only 改为真实消费者——按 receiptId 幂等对账（receipt/cards/objectives 存在性 + lifecycle 校验）、台账写入、payload 双形状归一化（对象/双编码字符串兜底）、receipt 缺失非重试 fail-closed；E2E 29→30 条（对账/重放不重复/坏 receipt 拒绝）。② **C8 停写**：V1 `createCardGenerationRun` 新增 `v1_writer_disabled` 门禁（V2 启用且 `CARD_GENERATION_V1_WRITER_ENABLED!=true` → 409 fail closed，防双 writer/旧 schema 反写）；`executeV1WriterShutdown` drill（就绪复检 → cardContentEpoch bump(UPSERT) → cutover 事件落账）；**修复 `bumpCardContentEpoch` 列名 bug**（`card_content_epoch` → `content_epoch`，从未被测试）；C8 集成测试（readiness canShutdown → execute → guard 拒/放行 → legacy hit 后 blocked）。③ **C 项补集 E2E**（新文件 3 条）：C27 presentation-only edit（旧 Run frozen 可读、objective identity 不重置、0 Schedule）、C28 semantic_replace（新 Objective ID、旧对象 supersede、**§15.3 lineage 表补写入**——原表存在但全库无写入路径，新增 supersede/edit 关系行）、C38 target-equivalent after PREPARE（旧 Run 读 rev1 冻结、新 Run rev2、lineage edit）；C37-lite 读视图一致性。**修复 4 个真实缺陷**：① lineage 表零写入（R33 补）；② IVR objective-scoped 重复创建——target_equivalent 撞唯一索引 → 改 `ON CONFLICT DO NOTHING + returning` 原子跳过（不重置初始验证身份）；③ target_equivalent_update 未同步 card 行 publicSummary/knowledgeForm → 读视图暴露旧摘要（C37 违约）——补同步；④ planner `isOperationalOrTemporary` 裸 `交`/`买` 子串误伤"交换/交易"内容句 → 0 卡——收紧为完整短语 + 回归测试（"血液循环…气体交换"不再被过滤）。④ **§23.1 独立盲标抽查 60 条**（gold 隔离）：卡数范围一致 96.7%（overlap）/零卡 15/16、无系统性 gold 错误、2 处实质分歧待仲裁（见标注文档 §6.1；方法学限制如实记录——自动标注不能替代人类双人流程）。⑤ **worker tsc 全量 0 错误**（TS6059/legacy 基线归零确认）。回归：确定性 E2E 30/30、C 项补集 3/3、C8 IT 1/1、LLM 自然态 E2E 1/1（77s 一次成功）、api V2 240/240、planner 12/12、worker 全量 tsc 0 | ✅ | 全部套件绿（详见各节） |


| R36 | **再次全量扫描（3 子代理并行 §1–15 / §16–22 / §23–32）→ 修复全部代码级缺陷**：① **§13.2 deck 语义聚类**——`computeSemanticClustersV2`（规范化 statement token 集 Jaccard + 共享 evidence 信号；明确非逐卡字符 Jaccard），`semanticClusters` 从硬编码 `[]` 变为真实聚类，duplicate/mergeable 簇 → hard issue；② **§13.3 eligibility 行锁**——activation 按稳定 Evidence ID `FOR UPDATE` 锁定全部 eligibility rows + 重算 vector hash 与 binding plan closure 比对（epoch/stateHash 漂移 → 409 stale_evidence，整组 0 副作用）；③ **§16.2 step 8**——`computeRunContractHash` 新增可选 `snapshotHash`（V2 run 纳入 private contract hash closure，V1 向后兼容），createRunV2 接线；④ **§17.7 领域事件通道**——迁移 0166 `card_domain_events_v2`（aggregate 语义 + payloadHash + consumer 幂等水位 + 类型 CHECK），`insertDomainEvent` helper + 全部缺失生产者：`learning_objective.revised`/`learning_card.revised`（target_equivalent_update 双通道）、`learning_card.revealed`（reveal 事务）、`initial_validation_reminder.created/deferred/ready/completed/cancelled`（reveal 延后 CAS / 新 durable timer `promoteDueRemindersV2` 惰性 promote + 独立可调 / trusted first Commit / archive / 显式取消）；⑤ **§18.2 不可变 card revision 表**——迁移 0167 `learning_card_revisions_v2`（front/strategy/presentation hash immutable + lineage 防自引用），create_new/target_equivalent_update(presentation change)/presentation_update/presentation-only patch 四个 bump 点全部写入；⑥ **§5.4 equivalence closure**——target_equivalent_update 服务端重算 semantic content hash + binding plan hash，与客户端 `equivalenceReportHash` 闭合校验（漂移 409 equivalence_report_mismatch），持久化 `learning_objective_equivalence_reports_v2` + 原子写 `learning_objective_revision_equivalence_v2`（pre-activation plan hash → resulting revision/target/binding 闭包）；⑦ **§14.2 非文本模态显式提示**——planner 输入新增 `unsupportedSourceBlocks`（image/code/diagram/formula/table），无文本 evidence 时 `no_cards_recommended` 带 `unsupported_for_requested_goal`（"当前无法可靠制卡"，不回退为无来源文本猜测），handler 两处 executePlanner 接线；⑧ **§22.2 prompt data delimiters**——Author/Grounding/Pedagogy prompt 对 sourceContent/evidenceQuotes/candidates/existingObjectives/generationRequest 全部加 `<data trust="untrusted">` 分隔符 + 注入说明；⑨ **§20 反馈闭环**——`card_candidate_feedback_v2` 零写入 → dispatchAction 统一落库（action/reasonCode/note 分级保留）；⑩ **§23.9 provider snapshot RC**——rc-gate 新增 immutable 版本闭包（providerId/modelSnapshot/promptRevision/policyVersion/datasetSnapshot/judgeVersion/codeCommit/runAt）；⑪ **§28.2 故障注入矩阵成文**（`20-learning-card-v2-fault-injection-matrix.md`：11 项映射现有测试/机制 + 缺口前置，全部故障证明 4 不变量）。**处置判定**：§18.1 候选修订独立表=计划第一阶段允许的单表 + immutable revision 语义（candidateRevisionId unique + lineage 防循环）；§21.3 legacy sidecar=已注释的中间态摘除（run-service.ts 记录恢复条件）。回归：api V2 单测 243/243（activation 28/28 + card 40/40 + critic 54/54 + planner 35/35 + review 16/16 + gates 等）、worker tsc 0、ai-quality 16/16；api 全量 tsc 其余 14 错均为并行会话工作区模块（understanding/companion/journey flags，非方案 20 范围） | ✅ | 全量回归绿（详见各节） |


| R36+ | **测试环境放行 + 桌面 app 打包侧完整开放（用户指示"先放行，测试环境不用讲究"）**：① `.env` 启用 `CARD_GENERATION_V2_ENABLED=true`（api V2 路由注册，此前 404 fail-closed）、`CARD_GENERATION_V2_LLM=true`（worker 真实 LLM 四阶段）、`NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=true`（web V2 入口）、`AI_PLATFORMS_CONFIG`（绝对路径——修复 worker CWD 为 workers/ai-worker 时相对路径解析失效 → mock 回退的隐患）；② **桌面 app 打包放行**：`apps/desktop/package.json` 的 `prebuild:web` 补齐全部 NEXT_PUBLIC 开关（原只有 4 个，缺 V2/Journey/LearningRun/StarMap/DeckUI/ActivityStream——打包产物 V2 恒 fail-closed）；`apps/desktop/src/web-manager.ts` 运行时 webEnv 对齐（dev 模式 `next dev` 读运行时 env）；`apps/desktop/electron-builder.yml` 修复 **electron-builder 26.15.3 schema 漂移**（publisherName 从 WindowsConfiguration/根级移入 publish.github provider——原配置 `npm run pack` 直接 schema 校验失败，win/linux 全平台打包都炸）；③ **web 构建修复（桌面打包前置）**：shared index 拉入 `node:module`/`node:fs` 顶层导入 → webpack 5 客户端构建 UnhandledSchemeError（`@ailearn/shared` 经 transpilePackages 进浏览器 bundle）；修复 = next.config webpack 钩子：客户端构建 `resolve.fallback` 全 node:* 置 false + `webpack.IgnorePlugin({ resourceRegExp: /^node:/ })` 早期拦截（shared 惰性约定保证浏览器运行时零调用）；web 构建成功且 **`/notes/[id]/card-generation-v2` 进入产物清单**（6.48 kB，ƒ dynamic）。放行验证：LLM 自然态全用户旅程 35.9s 一次成功（真实 tokenrhythm 四阶段 → review_ready → §13.1 复验 → keep → 激活 → C5 PREPARE）；desktop `pack:linux` 打包链路通过（linux-unpacked 产物）；V1 writer 停写 guard 生效（V2 启用 + `CARD_GENERATION_V1_WRITER_ENABLED` 未设 → V1 生成 409 v1_writer_disabled）。回归：web 构建成功、desktop 36/36、worker tsc 0、api tsc（除并行会话 companion-shell 2 错） | ✅ | 放行验证通过 |

| R37 | **补齐 V2 激活后到 LearningRun / 卡片列表 / Active Card / Review / Today / 星图的真实生产接线**：① **新 V2 Objective 自动创建 hidden legacy alias**——`activation-service` 在 create_new/semantic_replace 时写 archived `learning_cards` + `card_key_points`（id=objectiveId），解决 `learning_runs.key_point_id`/presentation_history/review_schedules FK 与查询对新 V2 卡不可达的问题；② **前端 V2 LearningRun 入口**——`/learning-runs/new` 支持 `origin=card_v2/review_v2/today_v2/star_map_v2/onboarding_v2`，`api.createLearningRunV2` + `useLearningRun.createV2` + `LearningRunLivePlayer.createV2` 接通；候选激活后提供“开始三分钟验证”和“查看学习卡”真实 CTA；③ **V2 Active Card 生产页**——新增 `/learning-cards/[cardId]`，真实读取 `/v2/cards/:id`、reveal（exposure-first）、开始 originV2 Run、归档、**编辑正面提示**、**重新生成**（迁移 0168 为 V2 卡记录 noteVersionId/noteId）、Reminder 列表/取消；④ **V2 卡列表**——`/cards` 合并 `/v2/cards` active V2 卡并链接到 `/learning-cards/:id`；⑤ **Review/Today V2**——`review_schedules` 对 V2 Run 使用 `subjectType='key_point'`（keyPointId=objective alias），review service 直接识别 V2 card 并返回 `isV2`，前端 review/today 入口改走 `review_v2/today_v2`；⑥ **星图 V2**——`understanding/projection-routes` 显式并入 active `learning_cards_v2` + alias key_point + contains 边；⑦ **Reminder API UI**——Active Card 页消费 `listReadyReminders/cancelReminder`。回归：api 全量 typecheck 0、shared 496/496、web typecheck 0、**api 全量 1608/1608**、review/card-generation-v2 定向测试全绿 | ✅ | 全量 API 1608/1608、三端 tsc 0 |

**R35 后剩余（全部为外部依赖/流程/环境类，已逐项说明）**：
① **C26/C41/C42/C44 完整 trusted-Commit LLM 旅程**——V2 接缝全确定性验证
（snapshot/eligibility/practice_only/0-Schedule/幂等/redaction），完整旅程=平台
稳定窗口内上线前验收项（`20-learning-card-v2-trusted-commit-acceptance.md` §3 调用序列）；
② **C11/region evidence/模态 deep check**——依赖视觉 pipeline（typed evidence/region）；
③ **§23.7 production 侧门槛**（activation p95/reveal 压测/PREPARE 成功率计数/首屏交互）
——上线后 dashboard 观测（确定性侧已达标，`20-learning-card-v2-perf-gate-report.md`）；
④ **人类双人标注 + 仲裁**——R33/R35 两轮独立盲标 160 条已过（范围一致 96.7%/100%、
标注者间 98%，无系统性错误），人类流程仍为 RC 前待办；
⑤ **C8 生产停写翻转**——机制+脚本就绪（`scripts/card-v2-writer-shutdown.sh`，
当前 dev 窗口 hit>0 → blocked 属预期），双窗口 hit=0 到期后 owner 批准翻转；
⑥ **C0 registry delete 清单**（worker agent 5 条：fast/planned/publish/prepare/
plan-path）——C8 shrink 阶段执行；
⑦ **C40 全旅程 a11y**——CandidateReview 关键旅程已测（5/5），Today/Review/Star
Map 页面随 Web 迭代补测。worker TS6059 基线已归零（R33 确认全量 0 错误）。