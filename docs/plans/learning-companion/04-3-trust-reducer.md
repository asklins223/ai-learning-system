# 决策记录 04-3：Artifact Trust、EpisodeTrustDecision 与 reducer（§7.2/§7.3/§7.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 04（W3）任务 04-3
> 日期：2026-08-08
> 来源：`04-w3-voice-artifact-assessment.md` 任务 04-3（原方案 §7.2/§7.3/§7.4）
> 约束级别：trust 只由服务端签发；assisted/stale 结果 0 升级、0 延长 interval；同 artifact 重放 hash 一致。

---

## 1. 交付物

- `packages/shared/src/learning-trust-contracts.ts`：`EpisodeTrustDecision`、
  `RubricAssessment`、`ReducerResult`（pass | partial | fail | not_assessable）、
  `RubricSessionResult` 常量与 zod strict schema（`episodeTrustDecisionSchema` /
  `rubricAssessmentSchema` / `reducerResultSchema`）。`TrustClass` 复用
  `learning-session-contracts.ts`（01-2 §7.3 单一来源），`RubricVerdict` 复用
  `enums.ts`，本模块不重复定义同名导出。
- `apps/api/src/modules/learning-sessions/trust-service.ts`：`computeEffectiveTrustClass`
  （多条件取最保守）、`issueEpisodeTrustDecision`（decisionHash 确定性）、
  `runRubricSessionReducer`（四态纯函数）、`applyFacetToMasteryPolicy`（七条固定规则）、
  `artifactEligibilityFilter`（只收 assistance 前 trusted locked，practice 不参与）。
- `apps/api/src/modules/learning-sessions/trust-service.test.ts`：单测（51 例，
  node:test + node:assert/strict）。
- 本文件：决策记录。

## 2. 核心不变量（验收）

- **trust 只由服务端签发**：Agent 只能请求 `requestedTrustClass`；Scene policy 冻结
  `templateTrustCeiling`；`computeEffectiveTrustClass` 只从服务端事实推导，不接收、
  不读取任何客户端提交的 effective 值。客户端/Agent 不能提交或覆盖 effective。
- **assisted/stale 结果 0 升级、0 延长 interval**：assistance 激活或 attempts 超限 →
  `practice_only`；stale/integrity 失败 → `not_assessable`（fail closed，无正式副作用）；
  `applyFacetToMasteryPolicy` 对 assisted/stale 的 required Scene（`anyRequiredSceneBlocked`）
  一律 `allowed=false` 且 `scheduleSideEffect="none"`。
- **同 artifact 重放 hash 一致**：`decisionHash = SHA-256(prefix + stableStringify(冻结字段))`，
  `sourceArtifactIds`/`reasonCodes` 排序幂等；相同冻结输入 → 相同 hash，
  `verifyEpisodeTrustDecision` 可重建校验（篡改不通过）。

## 3. computeEffectiveTrustClass（服务端 lock 时，§7.3）

Trust Class 保守度：`not_assessable < practice_only < diagnostic_only < facet_eligible
< mastery_eligible`。多条件取最低（最保守）等级：

1. `stale` / `integrityFailure` / `inputUnreliable` → `not_assessable`（fail closed，
   可无损重试）；
2. `assistanceActivated` / `attemptsExceeded` → `practice_only`（0 升级）；
3. 其余取 `requestedTrustClass` / `templateTrustCeiling` / `disclosureMaxProvable` /
   `planKindCeiling` 中最保守者（requested 超过 ceiling 自然被 ceiling 截断）。

`disclosureMaxProvable` 由 `disclosureProfileHash` 解析（01-2 §3.2/§6.3 三对象），
`planKindCeiling` 由 `formalPlan.kind` 决定（practice→practice_only、facet_only→
facet_eligible、voice_mastery/structured_mastery_bundle→受 ceiling 约束）。本层只算
单 Artifact 的 effective 值，**不写掌握/schedule 真值**（COMMIT 在 W5）。

## 4. issueEpisodeTrustDecision（服务端签发，§6.3）

字段：`episodeId`、`effectiveClass`、`sourceArtifactIds`、`frozenProbeSetHash`、
`requiredRubricCoverageHash`、`bundlePolicyVersion?`、`assistanceSnapshotHash`、
`reasonCodes`、`decisionHash`。

- `decisionHash` 排除自身字段，对冻结字段做 `stableStringify`（键排序、数组保序、
  undefined 属性跳过）+ SHA-256，前缀 `episode-trust-v1:` 隔离其他 hash 域；
- `sourceArtifactIds`/`reasonCodes` 排序后参与哈希（幂等）；`bundlePolicyVersion`
  参与哈希（存在与否影响 hash）；
- COMMIT 只消费冻结 Artifact 集与 `EpisodeTrustDecision`；单 Scene 的
  `facet_eligible` 不会被回写成 `mastery_eligible`。

## 5. rubric-session-reducer-v2（§8.4 四态纯函数）

先输出 `pass | partial | fail | not_assessable`，再由 validation/review domain
adapter 映射到现有 canonical outcome 枚举；**本任务不承载映射**。confidence 不进
入 reducer/mastery（§9）。

规则总序（全部组合 fail closed，绝无未命中分支）：

1. 任一 item（required 或 optional）为 `contradicted` → `fail`；
2. 任一 required 为 `not_assessable` → `not_assessable`（fail closed，可无损重试）；
3. 全部 item 为 `missing | not_assessable` → `not_assessable`（无法评估）；
4. 任一 required 为 `missing` → `fail`；
5. 全部 required 为 `covered` 且加权覆盖 ≥ 0.70 → `pass`；
6. 全部 required 为 `covered` 但覆盖 < 0.70 → `partial`；
7. 其余（有已评估内容但 required 未全 covered，如 required 为 partial）→ `partial`。

输出含 `weightedCoverage`、`hasContradiction`、`allRequiredCovered`、`missingRequired`、
`notAssessableRequired`、`reducerVersion="rubric-session-reducer-v2"`、
`invariantViolation`（理论兜底，绝不允许发生）与 `reasonCodes`。结构性非法输入
（空/无 required/非法 verdict/非法 weight）throw `ReducerError`，不静默放行。

## 6. facet-to-mastery-policy-v1 七条固定规则（01-2 §8.3）

`applyFacetToMasteryPolicy` 输出 `{allowed, maxTrustClass, scheduleSideEffect,
ruleHits, reasonCodes}`。`scheduleSideEffect ∈ {create_initial, consume_pending,
none}`（`record_only`/`no_effect` 是预冻结授权，本身即「不写 schedule」，故归 `none`）。

| 规则 | 判定 | 效果 |
| --- | --- | --- |
| R1 | `effectiveClass=facet_eligible` 时 | 只写 facet evidence；`scheduleSideEffect="none"`（不消费/不延长），即使 authorizedAction=consume_pending 也不能例外 |
| R2 | `facet_eligible` 且 `planKind≠facet_only` 或 Episode 未完整 | `allowed=false`（不能 commit facet evidence） |
| R3 | `structured_mastery_bundle` 且未完整 | `allowed=false`，已完成 Scene 仅 support artifact |
| R4 | `voice_mastery` 且 reducer ≠ pass | `maxTrustClass` 降至 `facet_eligible`（覆盖不全不能签发 mastery） |
| R5 | `structured_mastery_bundle` 且 `structuredProofEligible=false` | `maxTrustClass` 降至 `facet_eligible`（缺互补场景联合覆盖/Gold Gate 不能 mastery） |
| R6 | 任一 required Scene 未完成/stale/assisted/not-assessable/未通过 | `allowed=false`、`scheduleSideEffect="none"`（不能消费 input schedule） |
| R7 | 等价 Gate 未通过 → 结构 Scene 最高 `facet_eligible`；`record_only`/`no_effect` → schedule 写入 0 | 降级 + 0 写 |

mastery 完整路径（全部规则通过且 `effectiveClass=mastery_eligible`）：允许
`create_initial`/`consume_pending` 恰一 schedule 副作用。practice plan：一律
`allowed=false`、无副作用（01-2 §5.2 practice→no_effect）。

## 7. artifactEligibilityFilter（多 artifact 正式归约前过滤，§7.5）

只消费 content assistance 前、effective trusted（`mastery_eligible`/`facet_eligible`）
且 `locked` 的 bindings；practice artifact 不参与正式归约。拒绝原因逐条给出：

`practice_plan_excluded`、`not_locked`、`stale_fingerprint`、`assisted`、`not_trusted`。

- lock 先赢：lock 冻结 `capturedBy="lock" && contentAssisted=false` 的 pre-exposure
  snapshot，之后 reveal 不追溯污染已锁 artifact（仍合格）；
- assistance 先赢：snapshot `capturedBy="assistance"` → 一律拒绝（practice-only）；
- stale：`fingerprintMatch=false` → 拒绝，无正式副作用。

assistance/stale 的 learning-unit guard 固定锁序与竞态分支由任务 02-8
`exposure-service.ts`（`acquireExposureGuard` → `lockProbeRow`）提供，本任务以
snapshot 与 fingerprint 事实输入归约层，不重复实现锁。

## 8. 收口迁移

`packages/shared/src/index.ts` 暂未 re-export `learning-trust-contracts.ts`（由主代理
统一收口追加 `export * from "./learning-trust-contracts.ts"`）。在此之前
`trust-service.ts` 本地声明同型接口（structural 兼容）；收口后改为从
`@ailearn/shared` 导入 `EpisodeTrustDecision`/`RubricAssessment`/`ReducerResult`/
`RubricSessionResult`。

## 9. 验证

- `npm run typecheck --prefix packages/shared` 通过；
- `npm run typecheck --prefix apps/api` 通过；
- `npm test --prefix apps/api` 通过（含 51 例 trust-service 单测）。
