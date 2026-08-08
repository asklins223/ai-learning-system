# 决策记录 04-4：Independent Assessment Critic 逐项 evidence binding（§7.5）

> 状态：**Frozen（已冻结）**
> 执行：阶段 04（W3）任务 04-4
> 日期：2026-08-08
> 来源：`04-w3-voice-artifact-assessment.md` 任务 04-4（原方案 §7.5 + §4.3 INDEPENDENT_ASSESS）+ 冻结记录 01-2 §9、01-4 §13.3
> 约束级别：critic 与人工逐项一致性基线建立；越权输出（mastery/interval）为 0；unknown/duplicate/missing/伪造引用全部 fail closed；ASR 不可靠 100% fail closed。

---

## 1. 交付物

- `workers/ai-worker/src/learning-agent/roles/assessment-critic.ts`：从 03-1 骨架扩展为完整实现
  （`buildAssessmentCriticSystemPolicy` / `deterministicScorer` / `assessRubricItem` /
  `runFailClosedChecks` / `assessRubricSet` / `assessReliability`）。
- `workers/ai-worker/src/learning-agent/roles/assessment-critic.test.ts`：25 个单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 独立 Agent Session、system policy 与模型快照（§7.5 / §4.3）

- `buildAssessmentCriticSystemPolicy(modelSnapshot)` 生成独立 policy：绑定 `ModelSnapshot`
  （provider/model/version/snapshotHash），system prompt 显式声明「不继承 Supervisor 的自由文本判断」；
- `forbiddenOutputs` 明确列出 `overall_outcome`、`mastery`、`review_interval`、
  `shared_graph_truth`、`rc_gold_self_score`——policy 结构本身不携带这些字段，越权输出为 0；
- `allowedToolIds` 与 03-4 网关一致：只读锁定 artifact / 冻结 RubricTarget / 预绑定 evidence，
  加 `submit_assessment_verdict`（无 `activate_scene_contract`、无 mastery 写路径）。

### 2.2 逐项 evidence binding（01-2 §9）

`assessRubricItem` 输出的每条 `RubricAssessment` 对齐冻结类型：
`{ rubricItemId, verdict, responseBindings[{responseArtifactId, answerExcerpt?, interactionRefs?}],
evidenceRefIds, assessmentSource, rationale, confidence }`：

- **responseBindings**：每个 verdict 绑定真实 Response Artifact（`responseArtifactId`）；
- **answerExcerpt**：必须能从锁定 transcript/text 重建（`excerptReconstructible`：transcript 优先，
  segments 拼接兜底；无法重建 → `forged_excerpt`）；
- **interactionRefs**：必须来自 artifact 的 `interactionRefs`（伪造 → `forged_interaction_ref`）；
- **evidenceRefIds ⊆ 预绑定**：先校验 `preboundEvidenceRefIds` 与 `RubricTarget.evidenceRefIds`
  完全一致（`contract_evidence_mismatch`），再校验 claimed ⊆ prebound（`forged_evidence_ref`）。

### 2.3 deterministic modality scorer 优先（01-2 §9）

- `deterministicScorer` 只对 `ordering / graph / typed_repair` 产生逐项 evidence（其余返回 null 交 Critic）；
- `ordering`：完全一致 → covered；保持相对顺序缺项 → partial；集合同顺序异 → contradicted；
  无交集 → missing；空/重复/未知 ID → not_assessable；
- `graph`：完全一致 → covered；缺边 → partial；多选越界/同 (source,target) 异 relation 冲突 → contradicted；
- `typed_repair`：完全一致 → covered；缺操作 → partial；同 target 相反 action → contradicted；
- evidenceRefIds 从 `target.evidenceRefIds` 按期望元素位置选取命中项，因此自动 ⊆ 预绑定集合；
- `rationale` 内容最小化：只存 `verdict:reasonCode:matched/total`（删除/审计时无需扫描内容性复述）。

### 2.4 unknown / duplicate / missing / 伪造引用全部 fail closed（§7.5）

`runFailClosedChecks` 返回失败清单，任一命中即抛 `AssessmentCriticError`（不产出半成品 assessment）：
`artifact_not_locked`、`artifact_unknown_modality`、`artifact_redacted_semantic_audit`、
`unknown_rubric_item`、`duplicate_rubric_item`、`missing_rubric_item`、`unknown_verdict`、
`forged_evidence_ref`、`forged_excerpt`、`forged_interaction_ref`、`duplicate_ref`、
`invalid_confidence`、`contract_evidence_mismatch`。

`assessRubricSet` 聚合层保证**每个冻结 rubric item 恰好一条最终 assessment**：
- unknown：proposal 引用不在冻结集的 item；
- duplicate：同一 item 多条 proposal；
- missing：critic 模式（open_semantic/voice/complex_reasoning）无 proposal（deterministic 模式自动评分）。

### 2.5 ASR 不可靠 100% fail closed（§6.5 / §13.2）

`assessReliability`（纯函数）判定 `reliable`：
- voice：`asrConfidence < 0.7` → `asr_low_confidence`；无 transcript → `asr_no_transcript`；
  `transcriptHash` 重建失配 → `transcript_hash_mismatch`（音频替换 / replay 攻击）→ not_assessable；
- ordering/graph/repair：空、重复、未知 ID → not_assessable；
- critic 声称 covered 但不可靠时**降级** `not_assessable` 且 confidence 强制 0（可无损重试）。

### 2.6 不返回总体 outcome / 不给 RC Gold 打分

- 函数输出面只有 `RubricAssessment`（无 mastery/interval/overall/共享图关系真值字段，测试显式断言 `!("mastery" in assessment)`）；
- policy 禁止 runtime Critic 给自己的 RC Gold 打分（`rc_gold_self_score`）。

## 3. 决策点与收口

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| Critic 判定边界 | deterministic（ordering/graph/repair）vs critic（open_semantic/voice/complex_reasoning） | 冻结 §7.5：确定性可证的 evidence 不进 LLM |
| redacted artifact | `runFailClosedChecks` 直接拒绝 semantic re-audit | 冻结 §13.2：删除后不得宣称可完整语义重审（redaction 细节见 04-5） |
| deterministic evidence refs | 按期望元素位置从 `target.evidenceRefIds` 取命中项 | 结构上保证 ⊆ 预绑定，无需事后过滤 |
| not_assessable confidence | 强制 0 | fail closed 语义：不可靠不携带任何信任 |
| ASR 阈值 | `MIN_ASR_CONFIDENCE = 0.7`（可配置常量） | 与 04-1 voice-service 的 `minOverallConfidence` 方向一致；低于即不可评估 |

## 4. 验收映射

- [x] 独立 policy 绑定模型快照、显式禁止 mastery/interval/overall（单测：`buildAssessmentCriticSystemPolicy`）；
- [x] 每冻结 rubric item 恰好一条最终 assessment；unknown/duplicate/missing 拒绝（`assessRubricSet`）；
- [x] evidence refs ⊆ 预绑定；excerpt 可从锁定 transcript/text 重建；interaction refs 来自 artifact；
- [x] ASR 低置信 / hash 失配 → not_assessable（可无损重试）；
- [x] 越权输出（mastery/interval/overall）为 0（类型面 + 单测断言）。

## 5. 后续衔接

- 04-5 的 redaction 覆盖本实现的 assessment `answerExcerpt` 与 Critic rationale；
- COMMIT 侧（W5）重新验证 source authenticity / semantic support / report hash / fingerprint
  （冻结 §7.5），本模块只保证逐项 assessment 的 evidence binding。
