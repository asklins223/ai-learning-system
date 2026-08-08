# 冻结记录 01-2：Session/Scene/Artifact/Trust 合同（§6+§7）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-2（原方案 §6+§7）
> 约束级别：全部 contract 语义冻结，供 W3/W4/W5 实现；任何字段改动必须回 W0 评审。

**交付物**：`PrivateLearningEpisodeContract`、`OfficialSchedulingDecisionV1`、`FrozenProbeRef`、`RubricTarget`、`ResponseArtifactBase`、`EpisodeTrustDecision`、Trust Class、Scene DSL 与 Scene 三对象拆分、能力切面、`SilentProofProfile` 规则、`EpisodeCommitDispositionV1` 矩阵、assistance/exposure/stale 规则全部冻结。

---

## 1. 统一交互语法（§6.1）

"说、排、连、修、演"是 Supervisor 的内部 Scene 语法，**不是五个全局玩法按钮**：

| 动作 | 典型场景 | 主要验证能力 |
| --- | --- | --- |
| 说 | 语音 Teach-back、向伴星解释、口头举例 | recall、explain、apply、boundary |
| 排 | 重建步骤、流程、时间线和状态迁移 | procedure、依赖顺序 |
| 连 | 构建因果、组成、前置、对比和证据关系 | relate、boundary、causal structure |
| 修 | 找到并修复错误流程、论证、代码轨迹或概念图 | boundary、procedure、misconception repair |
| 演 | 多步情境决策、条件变式、后果预测、反例构造 | apply、boundary、transfer |

文本回答作为兼容和偏好选项存在，但不再决定产品结构。

## 2. 知识结构到互动的路由（§6.2）

`cognitiveType` 是内容路由提示，`CapabilityFacet` 是用户被证明能做什么，两者**不能混为同一枚举**：

| 知识结构 | 优先 Encounter | 备选 |
| --- | --- | --- |
| 概念、原则、定义 | 语音 Teach-back、边界辨析 | 例子/反例构造 |
| 因果、系统关系 | 关系重建、条件变式 | 语音解释、故障修复 |
| 流程、算法、操作顺序 | 步骤排序、状态重建 | 故障定位、语音说明 |
| 比较、易混概念 | 分类、错误连接修复 | 对比讲解、情境判断 |
| 应用型知识 | 多步情境、决策路径 | 语音理由、反例构造 |
| 代码、公式、图表 | 轨迹修复、参数变化、结构操作 | 语音解释；首版按能力逐类开放 |

## 3. Structured Scene DSL（§6.3）

公测首版**不允许模型任意生成界面**，Supervisor 只能选择并填充 versioned Scene schema：

```ts
type LearningScene =
  | VoiceTeachbackScene
  | OrderingScene
  | RelationCanvasScene
  | RepairScene
  | MultiStepScenarioScene
  | CounterexampleScene
  | OptionalTextScene;
```

### 3.1 每个 Scene 必须冻结的字段

- `scene`/`template`/`version`；
- `target` IDs、`source fingerprint` 和 `capability facet`；
- `public payload` 与 `secret solution` 的独立 hash/version；
- `allowed` token/node/edge/option IDs 与 `disclosureProfile`；
- 逐 `rubric` evidence binding；
- `assistance policy`、`template trust ceiling` 和反馈时点；
- `distractor`、`branch` 和最大操作次数；
- `keyboard`、`tap-select-place`、`screen-reader` 和 `reduced-motion` 等价路径。

### 3.2 Scene 三对象拆分

Scene 必须物理拆分为三个对象：

| 对象 | 可见性 | 内容 |
| --- | --- | --- |
| `PublicSceneContract` | 可返回客户端 | 净化题面、opaque token IDs、可见 token 文本、操作协议、A11y 和 `publicPayloadHash` |
| `PrivateSceneSolution` | 仅服务端/评估器 | 正确顺序/关系/branch、distractor 身份、rubric target 和 evidence binding |
| `PrivateLearningEpisodeContract` | 仅服务端 | target/schedule/fingerprint、RubricTargets、policy/model refs、budget 和 plan hash |

结构题允许把完成操作所必需的 token 文本展示在 DOM 中，但**不得返回**正确映射、secret solution、hidden rubric、evidence、历史反馈或答案提示。`disclosureProfile` 决定它最多可证明什么（如展示全部步骤 token 后可验证 procedure/order，不能声明验证无提示 recall）。

### 3.3 scene-safety-v1 与唯一激活权限

每个动态 formal Scene 激活前执行 `scene-safety-v1`：

- schema、public/secret 分离、allowlisted IDs、答案泄漏、可评估性、唯一解或有效多解、distractor 区分度、事实支撑、prompt injection、语言和 A11y 检查；
- **mandatory 调用独立 Rubric/Scene Critic**；
- 只有完全静态且带不可变 certification hash、内容槽位仍通过 deterministic allowlist 的模板可复用历史 Critic approval；
- 失败最多修复一次，仍失败则 `question_retryable/blocked`。

唯一激活权限属于 deterministic **Scene Activation Service**：事务内验证 Scene Author staging、`scene-safety-v1`、Critic=`approved` 或合法静态 certification、public/private/solution/disclosure hashes、`planHash`、epoch 与 BudgetEnvelope，写入一次 immutable active contract。**Author、Supervisor、Critic 和 Companion 都没有 `activate_scene_contract` 权限。**

## 4. 各模态最高可信资格（§6.4）

- 语音讲解 → `mastery_eligible`（Agent 补写、关键 ASR 不可靠、已给内容提示则降级）；
- 无提示排序 → `facet_eligible`（顺序已暴露、反复试对、即时纠错则降级）；
- 无提示拖拽/连线 → `facet_eligible`（吸附正确位、只剩唯一槽位、完整答案 token 已给则降级）；
- 多步情境 → 单 Scene 最高 `facet_eligible`（单次 A/B/C、每步即时揭晓、错误项被排除则降级）；
- 故障修复 → `facet_eligible`（只点出错误未修复或未说明依据则降级）；
- 普通单选/判断/配对 → `diagnostic_only`；
- 提示/原文/答案暴露后互动 → `practice_only`；
- 关键输入无法可靠解析 → `not_assessable`（无正负副作用，可换模态重试）。

预制 option/rationale ID 只能产生 `diagnostic_only`；正式理由必须来自用户语音、文字或主动构建的关系/条件 artifact；多步路径不会因步骤多自动升级 trust。

## 5. Session 容器与 Private Episode Contract（§7.1）

客户端只能获得净化后的 Session/Scene view：

```ts
type PrivateLearningEpisodeContract = {
  version: "private-learning-episode-contract-v1";
  sessionId: string;
  episodeId: string;
  origin: "card" | "review" | "star_map" | "now";
  originRef: {
    type: "card" | "review_schedule" | "key_point" | "question_suggestion";
    id: string;
  };
  intent: "stabilize" | "clarify" | "transfer" | "explore";
  keyPointId: string;
  formalEligibilityKind:
    | "initial_validation"
    | "scheduled_review"
    | "repair_revalidation"
    | "ad_hoc_transfer"
    | "practice";
  formalPlan: {
    kind: "voice_mastery" | "structured_mastery_bundle" | "facet_only" | "practice";
    requiredProbeIds: string[];
    bundlePolicyVersion?: string;
    silentProofProfileId?: string;
    structuredProofEligibilityReportHash?: string;
  };
  schedulingDecision: OfficialSchedulingDecisionV1;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  rubricTargets: RubricTarget[];
  allowedModalities: ValidationModality[];
  frozenProbes: FrozenProbeRef[];
  maxTurns: number;
  assistancePolicyVersion: string;
  rubricPolicyVersion: string;
  scenePolicyVersion: string;
  assessmentPolicyVersion: string;
  masteryPolicyVersion: string;
  schedulerPolicyVersion: string;
  providerConfigId: string;
  modelId: string;
  requiredCapabilityIds: string[];
  capabilitySnapshotHash: string;
  providerPolicyVersion: string;
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
  commitPolicyVersion: string;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  planHash: string;
};

type OfficialSchedulingDecisionV1 = {
  decisionRef: string;
  decisionHash: string;
  authorizedAction: "create_initial" | "consume_pending" | "record_only" | "no_effect";
  inputScheduleId?: string;
  inputScheduleGeneration?: number;
  prioritySource: "official_due" | "official_overdue" | "canonical_gap" | "user_selected";
  policyVersion: string;
  policyEpoch: number;
  reasonCodes: string[];
};

type FrozenProbeRef = {
  probeId: string;
  publicSceneContractId: string;
  publicPayloadHash: string;
  privateSolutionId: string;
  privateSolutionHash: string;
  sceneSafetyReportId: string;
  sceneSafetyReportHash: string;
  templateTrustCeiling: TrustClass;
  disclosureProfileHash: string;
};

type RubricTarget = {
  id: string;
  criterion: string;
  expectedTargetRef: string;
  expectedTargetHash: string;
  weight: 1 | 2 | 3;
  required: boolean;
  capabilityFacet: CapabilityFacet;
  targetKeyPointId: string;
  evidenceRefIds: string[];
  semanticSupportReportId: string;
  semanticSupportReportHash: string;
};
```

### 5.1 注入与敏感字段

- `workspaceId` 和 `userId` 由服务端上下文注入，不接受模型或客户端覆盖；
- Provider 字段只有不可变配置/模型/能力/policy 引用及 hash，**不存 API key、凭据或任意 `object`**。

### 5.2 正式计划/授权规则

`formalPlan.kind`、`schedulingDecision`、全部 `frozenProbes` 和预算 fence 在首个 probe 激活前冻结并进入 `planHash`。

`authorizedAction` 是 official scheduler 的**事前最大授权**：

- `create_initial`：只允许不存在 active pending schedule 的 `initial_validation`；
- `consume_pending`：只允许 official policy 判定的 scheduled review/repair revalidation/early review，必须绑定精确 `inputScheduleId + generation`，提交后恰好一个 successor；
- `record_only`：不消费/不替换/不新增 schedule，只允许 facet observation；
- `no_effect`：只用于事前已声明的 practice/diagnostic 路径（`not_assessable`、provider failure、stale、cancel 是事后 disposition 条件，**不改变预冻结授权**）。

`formalPlan.kind` 约束：

- 用户从 Card/Star 主动选择目标只改变 `prioritySource`，本身不授予 early review；
- `facet_only` 必须配 `record_only`，`practice` 必须配 `no_effect`，二者不得绑定 input schedule；
- `voice_mastery`/`structured_mastery_bundle` 必须预声明全部 required probe；
- **不能在看到答案后升级 formal plan 或 scheduling authorization**。

### 5.3 闭包、预算与 planHash

- `requiredCapabilityIds + capabilitySnapshotHash` 只覆盖该 Episode 的传递闭包；
- `budgetEnvelope` 在展示首个 formal Scene 前预留完成全部 required probe、Assessment Critic 和 deterministic commit 所需额度，**预算不足必须在用户作答前阻断**；
- `planHash` 覆盖 scheduling decision、runtime/episode epoch、commit policy、required capability closure、budget ref/hash 和全部 frozen probe hash。

### 5.4 可见性边界与 ephemeral

- `GET /learning-sessions/:id` 只返回 public Session view 与 active `PublicSceneContract`；
- Private Episode Contract、RubricTarget 和 PrivateSceneSolution 在 network/RSC/prefetch/cache/DOM 中**字段级不可达**；
- ephemeral 问题建议可作为 `originRef`，但正式 target 仍是 Key Point；Must 只在本轮保留 ephemeral 状态。

## 6. Response Artifact 与状态机（§7.2）

```ts
type ResponseArtifactBase = {
  id: string;
  sessionId: string;
  episodeId: string;
  keyPointId: string;
  probeId: string;
  publicSceneContractId: string;
  publicPayloadHash: string;
  privateSolutionId: string;
  privateSolutionHash: string;
  sceneSafetyReportHash: string;
  disclosureProfileHash: string;
  inputSchemaHash: string;
  modality: ValidationModality;
  contentHash: string;
  capturedAt: string;
  answerLockedAt: string;
  assistanceSnapshot: AssistanceSnapshot;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  requestedTrustClass: TrustClass;
  templateTrustCeiling: TrustClass;
  effectiveTrustClass: TrustClass;
  trustPolicyVersion: string;
  trustReasonCodes: string[];
  correctionMethod?: "none" | "re_recorded" | "manual_text_edit";
};
```

该类型是 **server-private record**。客户端只得到 `PublicResponseReceipt {artifactId, revision, contentHash, status}`；private solution/safety hashes、trust reason、assistance snapshot 和 assessment refs 不得出现在 response/RSC/cache/DOM。

- Agent 只能请求 `requestedTrustClass`；Scene policy 冻结 `templateTrustCeiling`；
- 服务端在 lock 时按 disclosure、attempts、assistance、stale 和 integrity 计算单 Artifact 最保守 `effectiveTrustClass`；
- 每个 Artifact 必须逐 hash 匹配 Episode 的 `FrozenProbeRef`；**只有 version 没有 private solution/safety hash 不足以进入评估**。

### 6.1 模态 payload

- `voice`：逐字 confirmed transcript、segment timestamps、ASR provider/model/version/language/confidence、可选短期 audio ref/hash；只有重录后的确认仍属纯 voice；
- `text_or_mixed`：原始文本与 hash；手工编辑 ASR transcript 创建新模态 Artifact 并经 `supersedesArtifactId` 保留来源；
- `drag_graph`：public allowlisted node/token 集、最终 node/edge IDs、relation types、action digest；
- `ordering`：allowlisted item IDs、最终 ordered IDs；
- `repair`：删除/替换/移动/连接 typed operations；
- `scenario`：scenario/version、每步 option ID、用户主动构建理由/条件 artifact refs、branch path；
- 多轮会话只保存多个独立 artifact 引用。

### 6.2 状态机

```text
Probe: draft → safety_check → active → locked | superseded | stale
Voice Artifact: capturing → transcribed → awaiting_confirmation → locked | superseded | stale
Other Artifact: draft → awaiting_confirmation → locked | superseded | stale
Any locked Artifact: locked → redacted（append-only tombstone，不可恢复为 locked）
```

- 重录、手工修正 transcript 或改变结构答案都创建新 revision/artifact 并记录 `supersedesArtifactId`，**不原地修改已哈希行**；
- `correctionMethod` 明确区分重录与手工编辑；
- locked 后迟到 autosave/chunk 一律拒绝；
- 请求必须携带 base revision、public scene hash、user action nonce 和 idempotency key。

### 6.3 EpisodeTrustDecision

结构化 bundle 的 mastery 资格由服务端另行签发：

```ts
type EpisodeTrustDecision = {
  episodeId: string;
  effectiveClass: TrustClass;
  sourceArtifactIds: string[];
  frozenProbeSetHash: string;
  requiredRubricCoverageHash: string;
  bundlePolicyVersion?: string;
  assistanceSnapshotHash: string;
  reasonCodes: string[];
  decisionHash: string;
};
```

COMMIT 只消费冻结 Artifact 集与 `EpisodeTrustDecision`；单 Scene 的 `facet_eligible` 不会被回写成 `mastery_eligible`。

## 7. Trust Classes 与签发规则（§7.3）

| Trust Class | 含义 | 业务效果 |
| --- | --- | --- |
| `mastery_eligible` | 服务端证明完整 required rubric、无辅助且满足 modality/bundle policy | 可进入 canonical outcome；是否写 schedule 只由 typed official decision 决定 |
| `facet_eligible` | 高可信但只证明窄能力 | 只写 allowlisted facet evidence，不能单独消费或延长 Key Point schedule |
| `diagnostic_only` | 有诊断价值，但猜测空间高 | 只影响练习建议，不进入正式调度 |
| `practice_only` | 已获得内容帮助或交互本身泄露答案 | 记录练习，不升级、不延长 interval |
| `not_assessable` | ASR、契约或输入质量不足 | 无正负副作用，可无损重试 |

正式可信 artifact 必须**同时满足**：

- `effectiveTrustClass ∈ {mastery_eligible, facet_eligible}`；
- assistance 合格；
- target/evidence/rubric/scene 非 stale；
- Response Artifact 完整且由用户确认锁定；
- Independent Assessment 完整；
- deterministic modality scorer / `rubric-session-reducer-v2` 成功。

`canonical_mastery` 还必须有 `EpisodeTrustDecision.effectiveClass=mastery_eligible` 且全部 hashes 重建一致；Artifact 合格只是必要条件，**不是 bundle 升格条件**。

## 8. 能力切面、Silent Bundle 与 schedule（§7.4）

### 8.1 v1 能力切面（六个 facet）

- `recall`：无答案线索下主动回忆；
- `explain`：说明概念/原因/机制；
- `apply`：迁移到新情境；
- `boundary`：识别适用条件/反例/混淆项；
- `procedure`：重建步骤和依赖顺序；
- `relate`：在当前 Key Point 冻结知识结构内建立关系；跨节点 published semantic relation 属后续治理能力。

### 8.2 SilentProofProfile 规则

`SilentProofProfile` 是 versioned 资格模板，不是对所有知识通吃的小游戏。初始 family：

- procedure（排序 + 修复）；
- causal/boundary（关系重建 + 条件变式）；
- concept/application（开放构建 + 情境应用）；

实际启用 family 由 W0 corpus audit 与 Gold 决定。

每个 `structuredProofEligibilityReport` 必须证明：

- 全部 required facets 可由未泄漏答案的结构证据覆盖；
- 公开 token 不覆盖所声称的 recall；
- 任务具有足够区分度；
- A11y 等价操作不降低语义要求；
- 该 profile 已通过独立 Gold。

公测 silent route 采用 **Key Point 级激活**：

- 100% 被路由到 structured proof 的目标必须 eligibility=`eligible`；
- W0 基于真实 active corpus 冻结整体和各内容 family 的最低覆盖率，W8 在独立 RC 集复核；
- 未达到覆盖门槛则不宣传 universal silent coverage、不降低 trust；
- 不合格目标仍可 voice 或 `text_or_mixed` canonical 验证。

### 8.3 facet-to-mastery-policy-v1

- 单个 `facet_eligible` 成功或失败只写 facet evidence，不消费/完成/缩短/延长 Key Point schedule；
- 只有预声明为 `facet_only` 的完整 Episode 才能 commit facet evidence；
- `structured_mastery_bundle` 未完成时已完成 Scene 只保留为 support artifact，不写 canonical facet 或 schedule 副作用；
- Voice Teach-back 只有在覆盖全部 required rubric/facets 时才可签发 `mastery_eligible`；
- `structured-proof-v1` 由至少两个预冻结、互补、无中途反馈且高区分度的结构 Scene 组成，必须联合覆盖全部 required rubric，并通过跨模态 Gold 的 false-upgrade/false-downgrade Gate；
- bundle 中任一 required Scene 未完成/stale/assisted/not-assessable/未通过，不能消费 input schedule；
- 等价 Gate 通过前所有结构 Scene 最高只为 `facet_eligible`；
- `create_initial/consume_pending` 的可评估 Episode 恰好产生一个 initial/successor schedule，`record_only/no_effect` 的 schedule 写入必须为 0；
- route/session 没有总体 mastery，也不能消费 schedule。

### 8.4 rubric-session-reducer-v2

`rubric-session-reducer-v2` 先输出 `pass | partial | fail | not_assessable`，再由 validation/review domain adapter 映射到现有 canonical outcome 枚举。

W0 必须冻结 formal eligibility + scheduling authorization + reducer result → commit disposition → domain fact → initial/successor/no-schedule 矩阵。

### 8.5 EpisodeCommitDispositionV1 矩阵

| disposition | 允许的 trust/result 与 scheduling authorization | 唯一事实落点 | schedule / attempt 副作用 |
| --- | --- | --- | --- |
| `canonical_mastery` | Episode trust=`mastery_eligible`，result=`pass/partial/fail`，authorizedAction=`create_initial/consume_pending` | 现有 validation event；review origin 同时写现有 review attempt/outcome | create/consume 后恰好一个 active schedule；同 generation exactly-once |
| `canonical_unable` | 用户明确 `unable`，且 authorizedAction=`create_initial/consume_pending` | 现有 unable domain outcome | 按冻结 unable policy 恰好一个 active schedule；不写"已掌握" |
| `canonical_facet_observation` | assessable trusted point result；formal plan 允许 point observation；trust 至少 `facet_eligible`；authorizedAction=`record_only` | 扩展后的 `validation_point_assessments` 作为唯一 canonical facet fact + outbox | 0 overall validation/review outcome，0 review attempt，0 schedule；已有 pending 保持不变 |
| `practice_or_diagnostic` | practice/diagnostic/assisted | learning session practice/diagnostic event | 0 canonical mastery/facet projection，0 review attempt，0 schedule |
| `operational_only` | not-assessable、provider failure、stale、cancel | retryable/terminal operational state 与低敏审计 | 0 学习副作用 |

Review origin 如果只完成 facet-only Scene，不创建 `review_attempt`，原 pending schedule 保持 active；UI 明确显示"记录了这一项能力，本次复习时间未改变"。任何 consumer 只有在 disposition allowlist 中才能读取相应事实。

### 8.6 Disposition 优先级（互斥纯函数，只返回一个值）

1. stale/cancel/kill/provider failure/not-assessable/缺 required artifact → `operational_only`；
2. assisted、practice plan、diagnostic trust 或 authorizedAction=`no_effect` → `practice_or_diagnostic`；
3. `user_declared_unable + authorizedAction∈{create_initial,consume_pending}` → `canonical_unable`，否则归入 practice/diagnostic；
4. assessable `EpisodeTrustDecision=mastery_eligible + authorizedAction∈{create_initial,consume_pending}` → `canonical_mastery`；
5. assessable trusted point results + authorizedAction=`record_only` → `canonical_facet_observation`；
6. 其余组合 fail closed 为 `operational_only` 并记录 contract invariant violation。

Incomplete silent bundle 在第 1 步结束，只保留 support artifact，**绝不因 `record_only` 落入 facet canonical fact**。

## 9. Assessment、确定性评分与多 Artifact 归约（§7.5）

```ts
type RubricAssessment = {
  rubricItemId: string;
  verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
  responseBindings: Array<{
    responseArtifactId: string;
    answerExcerpt?: string;
    interactionRefs?: string[];
  }>;
  evidenceRefIds: string[];
  assessmentSource: "deterministic" | "critic" | "user_declared_unable";
  rationale: string;
  confidence: number;
};
```

硬要求：

- 每个冻结 rubric item 恰好一条最终 assessment；
- evidence refs 必须是该 RubricTarget 预绑定 evidenceRefIds 的子集；
- COMMIT 重新验证 source authenticity、semantic support=`supported`、report hash 和 fingerprint；
- excerpt 必须能从锁定 transcript/text 重建，interaction refs 必须来自 artifact；
- ordering、固定 graph 和 typed repair 优先由 deterministic modality scorer 产生逐项 evidence，仅开放语义、语音和复杂理由交给 Critic；
- 多个 artifact 只消费 content assistance 前、effective trusted 且 locked 的 bindings，practice artifact 不参与正式归约；
- 公测 v1 不在 locked 回答后进行内容性 trusted 追问，不存在"后答覆盖前答"；
- 任一 required contradiction 按 reducer 表处理，confidence 不进入 reducer/mastery；
- unknown、duplicate、missing、伪造引用全部 fail closed；
- Critic 不返回总体 outcome；
- runtime Critic 不给自己的 RC Gold 打分。

## 10. Assistance、exposure 与同锁域竞态（§7.6）

不降级的中性辅助：原样 TTS、麦克风/触控/键盘操作说明、重录、撤销未锁输入、无内容性的时间提示和无障碍呈现。

必须先降级为 `practice_only` 再提供：内容提示、关键词、例子、source/quote/claim/expected target、排除选项、即时红绿、吸附正确位置、Agent 补句/润色和答案揭示。

### 10.1 fingerprint 与 exposure key

`episodeTargetFingerprint` 用于判断本 Episode 的 Card/Rubric/Scene/policy 是否 stale；assistance 不能使用它作为身份键。稳定的：

```text
contentExposureKey = H(workspaceId, userId, keyPointId,
  publishedContentRevision, normalizedClaimHash, sortedEvidenceContentHashes)
```

不得包含 Scene、rubric、provider、model 或 assistance policy 版本。

### 10.2 同锁域竞态规则

- `enter-practice/reveal` 与 `confirm-and-lock/submit` 必须锁同一 `(workspaceId, userId, contentExposureKey)` learning-unit guard 和当前 probe row，固定锁序并使用 user action nonce：
  - **lock 先赢**：冻结 pre-exposure snapshot，之后 reveal 不追溯污染已锁 artifact 但写 exposure/cooldown；
  - **assistance 先赢**：事务提交后才允许返回任何内容，之后 lock 必须看到 practice-only；
- exposure 跨页面、设备、Session、Scene/policy rollover 和重开持久，共享 evidence 通过确定性 dependency ledger 传播到受影响 content exposure keys；
- 旧 question-first 与新 Episode 读写同一 `learning_unit_exposure` aggregate 和 guard，**不能靠切换入口重置**；
- Agent 只能呈现"切换到一起学习"的建议，不能自主执行 enter-practice、lock 或 submit。

## 11. Stale、取消与 Episode 提交（§7.7）

- start、probe activate、artifact lock、assess 和 commit 均检查 `episodeTargetFingerprint` 与独立 `contentExposureKey`；
- fingerprint 使用 canonical serialization，至少覆盖 published Card/Key Point revision、逐项 RubricTarget/hash、每项 evidence source+semantic-support hashes、Scene policy 和 assistance policy；
- Provider/model/budget ref 由 contract 冻结但不属于内容 fingerprint，无关配置变化不能使已锁答案 stale，原 Provider 不可用时进入 retryable 或显式新 Episode；
- Key Point/Evidence/Rubric/Scene policy 任一内容失配则 Episode stale，无正式副作用；
- cancel 终止当前和未开始 Episode，之前已 commit 保留；
- 所有 turn/tool/Critic 结果落库前重新比较 contract 的 `runtimeEpochSnapshot + episodeEpoch`；
- COMMIT 使用 §4.3 四类固定锁与完整 CAS；
- hard kill 后迟到 Provider/ASR/Critic 响应只记录不含用户内容的审计摘要，不写 probe/artifact/assessment staging，也不能恢复为 trusted；
- 断线恢复只读 event/contract/artifact，不重复 Provider 调用和业务副作用；
- 同一 pending schedule 不能同时被旧 question-first submission 与新 Episode 消费，数据库唯一约束和 target-level idempotency 为最终兜底。

## 12. 验收标准

以上全部 contract 语义冻结，供 W3/W4/W5 实现；任何字段改动必须回 W0 评审。
