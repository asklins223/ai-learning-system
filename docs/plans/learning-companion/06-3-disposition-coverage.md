# 决策记录 06-3：disposition 全覆盖（§7.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 06（W5）任务 06-3
> 日期：2026-08-08
> 来源：`06-w5-vertical-slice-scheduler.md` 任务 06-3（原方案 §7.4 disposition 表、
> §8.4 reducer 映射、§8.5 EpisodeCommitDispositionV1 矩阵、§8.6 优先级链）
> 约束级别：consume-pending 最多消费一次；create/consume 后恰好一个 active schedule；
> record-only/facet/practice/operational 0 调度副作用。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/disposition.ts`：`deriveEpisodeCommitDisposition`
  （五类判定，§8.6 优先级链互斥无未命中）、`deriveSideEffectSignature`（副作用签名，
  单一事实来源）、`mapReducerResultToValidationOutcome` / `mapReducerResultToReviewAttemptOutcome`
  （§8.4 reducer 四态 → 现有 canonical outcome 映射）、`planScheduleCommit`（schedule
  副作用请求描述）、`ScheduleCommitPort` / `ScheduleCommitRequest`（06-2 集成层端口）。
- `apps/api/src/modules/learning-sessions/disposition.test.ts`：单测（node:test）。
- 本文件：决策记录。

## 2. 核心不变量（验收）

- **consume-pending 最多消费一次**：`consumeAtMostOnce=true` 且幂等键绑定精确
  `(episodeId, inputScheduleId, inputScheduleGeneration)`（`commit:consume:…`）；同
  generation 重放幂等键恒等，generation 不同幂等键不同（不重复消费不同代）。
- **create/consume 后恰好一个 active schedule**：`requireExactlyOneActiveSchedule` 仅当
  `scheduleSideEffect ∈ {create_initial, consume_pending}` 为 true；`planScheduleCommit`
  只对 canonical_mastery / canonical_unable 且调度授权产出非 "none" 请求。
- **record-only/facet/practice/operational 0 调度副作用**：`canonical_facet_observation`
  0 overall outcome、0 review attempt、0 schedule（已有 pending 保持不变）；
  `practice_or_diagnostic` 0 canonical projection、0 schedule；`operational_only` 0 学习副作用。

## 3. 优先级链（01-2 §8.6，互斥无未命中）

`deriveEpisodeCommitDisposition` 顺序判定，每个分支 return 后不可能落入其他分支，
最终 else 无条件 fail closed 为 operational_only：

1. **operational_only**：stale / cancelled / killed / provider failure /
   `incompleteSilentBundle`；或缺 required artifact、reducer=null、
   reducer=not_assessable、trust=null、trust=not_assessable。用户明确 unable 是独立
   用户事实（现有 unable 路径 no AI call），跳过 reducer/trust 检查交给优先级 3，
   但 stale/cancel/kill/bundle/provider failure 操作层事实仍优先。
2. **practice_or_diagnostic**：assisted、formalPlan.kind=practice、
   authorizedAction=no_effect、trust ∈ {practice_only, diagnostic_only}。
3. **canonical_unable**（强信号）：userDeclaredUnable + authorizedAction ∈
   {create_initial, consume_pending} → 按冻结 unable policy 恰好一个 active schedule，
   不写"已掌握"（mastered=false）；否则（unable + record_only/no_effect）归入
   practice/diagnostic，**绝不落 facet/mastery**。
4. **canonical_mastery**：trust=mastery_eligible + 调度授权 + episodeComplete +
   reducer 非 not_assessable → 写现有 validation event（review origin 同时写 review
   attempt/outcome）。
5. **canonical_facet_observation**：authorizedAction=record_only + formalPlan.kind=
   facet_only + episodeComplete + trust ∈ {facet_eligible, mastery_eligible} → 写
   `validation_point_assessments` 作为唯一 canonical facet fact + outbox。
6. **fail closed**：其余组合 → operational_only + `invariantViolation=true`
   （contract invariant violation）。契约不变量前置检查：consume_pending 缺
   inputScheduleId/generation、record_only 配非 facet_only、no_effect 配非 practice、
   create/consume 配 practice plan → 直接 fail closed。

## 4. 分派（facts + outbox + schedule）

- `canonical_mastery`：facts = `validation_event`（pass→preliminary_understanding、
  partial→unclear_expression、fail→misunderstanding，mastered=true）+ review origin
  时 `review_attempt`（correct/partial/incorrect）；outbox = validation.event
  （validated/misunderstood）+ review.attempt（reviewed）；schedule = 授权动作。
- `canonical_unable`：facts = `validation_event`（outcome=unknown，mastered=false）+
  review origin 时 `review_attempt`（outcome=unable，skipReason=unable）；schedule =
  授权动作（冻结 unable policy）；不写"已掌握"。
- `canonical_facet_observation`：facts = `point_assessments`（唯一 facet fact）；
  outbox = facet.observation（02-9 扩展事件类型）；0 overall outcome、0 review
  attempt、0 schedule。
- `practice_or_diagnostic`：facts = `practice_event`（eventKind 由 trust 判定：
  diagnostic_only→diagnostic，否则 practice）；0 canonical projection、0 schedule。
- `operational_only`：facts = `operational_audit`（retryable：provider_failure /
  not_assessable / missing_required_artifact；terminal：stale / cancelled / killed /
  incomplete_silent_bundle / contract_invariant_violation）+ incomplete bundle 时
  `support_artifact_only`；0 学习副作用。

## 5. incomplete silent bundle

`incompleteSilentBundle=true`（structured_mastery_bundle 未完成）在优先级 1 结束：
facts 只含 `support_artifact_only`（已完成 Scene 保留为 support artifact），**绝不因
record_only 落入 facet canonical fact**（`pointAssessments=false`），0 调度副作用。

## 6. 集成契约（06-2 Episode COMMIT）

`deriveEpisodeCommitDisposition` 只做互斥推导与分派描述，不触库。06-2 集成层注入
`ScheduleCommitPort`（`createInitial` / `consumePending`，幂等键见 §2）与
`planScheduleCommit` 描述执行；幂等键在数据库唯一约束 / target-level idempotency
上落为最终兜底（详见 06-4 决策记录）。
