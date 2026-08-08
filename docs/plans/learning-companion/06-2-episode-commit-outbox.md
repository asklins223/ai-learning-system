# 决策记录 06-2：Episode COMMIT 与 outbox projection（§4.3/§12.2）

> 状态：**Frozen（已冻结）**
> 执行：阶段 06（W5）任务 06-2
> 日期：2026-08-08
> 来源：`06-w5-vertical-slice-scheduler.md` 任务 06-2（原方案 §4.3 COMMIT + §12.2）
> 约束级别：同事件重放得到相同 disposition 与投影 hash；outbox 派生 projection
> 正确；一个 Episode commit 失败或 stale 不回滚之前已成功的独立 Episode；
> cancel 后已 commit Episode 保留、当前与未开始 Episode 零副作用；重试/断线/
> Worker crash 不得重复 result 或 schedule 副作用。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/episode-commit.ts`：COMMIT 事务编排——
  固定锁序（`COMMIT_LOCK_ORDER`）、单次 CAS（`evaluateCommitCas`）、disposition
  推导（`deriveEpisodeCommitDisposition`，§8.6 六步优先级互斥纯函数）、唯一事实
  落点计划（`planCommitSideEffects`）、幂等提交（`commitEpisode`，写操作经可注入
  `CommitPort`）。
- `apps/api/src/modules/learning-sessions/episode-commit.test.ts`：CAS 各条件、锁定
  顺序、create/consume 独特性、失败回滚归因、独立 Episode 不回滚、重试幂等单测。
- 本文件：决策记录。

## 2. 固定锁序与单次 CAS（§4.3）

```
runtime-control → learning_episode → authoritative target/version guard →
keyPoint schedule guard → input schedule（consume 时）
```

`buildCommitLockPlan(authorizedAction)`：前四步对所有 COMMIT 必需；
`consume_pending` 才追加 `input_schedule` 锁（create_initial/record_only/no_effect
没有输入 schedule 可锁）。

`evaluateCommitCas` 单次同时验证：

- `runtimeEpoch = snapshot`；
- `episodeEpoch` 未变；
- Episode = `active && !cancelled && !stale`；
- current content revision / fingerprint 匹配（以 `episodeTargetFingerprint` 为准；
  contentRevision 在 Episode 上未单独冻结 → null，真实端口读到的同值为 null）；
- scheduling decision hash 匹配；
- `kill = false`；
- `create_initial`：keyPoint 下不存在 active pending；
- `consume_pending`：input schedule 仍 active 且精确 generation 匹配。

任一失败整体归因：`stale`（episode_stale / content revision / fingerprint 失配）
> `cancelled`（episode_cancelled）> `blocked`（epoch/非 active/scheduling hash/
kill/active pending/generation/input schedule 缺失），全部落 `operational_only`，
0 学习副作用，只写低敏审计。

## 3. Disposition（01-2 §8.6 互斥优先级）

服务端签发 `EpisodeTrustDecision` → `rubric-session-reducer-v2` →
`facet-to-mastery-policy-v1` → `deriveEpisodeCommitDisposition` 只返回一个值：

1. stale/cancel/kill/provider failure/not-assessable/缺 required artifact → `operational_only`；
2. assisted、practice plan、diagnostic trust 或 `no_effect` → `practice_or_diagnostic`；
3. `user_declared_unable + create_initial/consume_pending` → `canonical_unable`，否则归 practice；
4. assessable `mastery_eligible + create_initial/consume_pending` → `canonical_mastery`；
5. assessable trusted + `record_only` → `canonical_facet_observation`；
6. 其余 fail closed → `operational_only` + contract invariant violation。

纯函数：相同冻结输入 → 相同 disposition（同事件重放得到相同 disposition 的
保证来源）。`mapReducerToValidationOutcome/ReviewOutcome/ScheduleReason/
UnderstandingEffect` 把 reducer 四态映射到现有 validation/review 枚举
（domain adapter），不建新枚举。

## 4. 唯一事实落点 + outbox 派生 projection（§12.2，不建第二套真相）

`planCommitSideEffects`（纯函数）由 disposition 推导唯一落点：

| disposition | 现有 canonical fact | outbox 派生 | schedule 副作用 |
| --- | --- | --- | --- |
| `canonical_mastery` | review origin → `review_attempts`（idempotencyKey=commitKey，同时写 outcome）；否则 `validation_events`（reducer 映射 outcome） | 同事务 outbox（validation/review 事件 + facetSummaries 安全摘要） | create/consume 后恰一 active schedule；同 generation exactly-once |
| `canonical_unable` | `understanding_events`（eventType=unable，现有 unable domain outcome，不写"已掌握"） | 同事务 outbox | 按 unable policy 恰一 active schedule |
| `canonical_facet_observation` | 扩展 `validation_point_assessments`（唯一 canonical facet fact） | 同事务 outbox 派生 facet/map projection | 0 overall/0 review/0 schedule；已有 pending 不变 |
| `practice_or_diagnostic` | learning session practice/diagnostic event | 0 canonical projection | 0 review attempt / 0 schedule |
| `operational_only` | retryable/terminal operational state + 低敏审计 | — | 0 学习副作用 |

outbox payload 只含白名单安全摘要（`validateCanonicalEventPayload` 兜底），
`projectionHash = computeProjectionHash(workspaceId,userId,eventType,payload)`；
`replayProjection` 重放得到相同 mastery/facet/map 与累计 hash（同事件重放 →
相同投影 hash）。authoritative fact 只落现有表，outbox 只派生 projection。

## 5. 幂等与原子性（重试/断线/Worker crash 不重复副作用）

- `commitKey = epc:<disposition>:<hash>`（hash 覆盖 episodeEpoch + scheduling
  decision hash），disposition 编码使重试幂等命中时无需重跑 CAS 也能还原原结果；
- `commitEpisode` 先查 commitKey：已存在 → `{ idempotent: true }`，不重复任何写；
- 所有副作用（canonical fact + outbox + schedule + commitKey）由 `CommitPort`
  在**同一个数据库事务**内完成：Worker crash → 事务回滚（commitKey 未写入）→
  重试重新执行，无重复；事务成功 → commitKey 已写入 → 重试直接幂等；
- canonical-events 的 canonicalFact 幂等键（review→idempotency_key /
  validation→submissionId 或 card+question+fingerprint）为最终 DB 兜底；
- 独立 Episode 不回滚：`commitEpisode` 单 Episode 幂等，多 Episode 由调用方逐个
  执行，任一失败/stale 不影响其它已 commit Episode。

## 6. 收口

- `EpisodeCommitDispositionV1`、`CommitLockStep`、`CommitAttribution` 等契约当前
  在 `episode-commit.ts` 本地声明（`@ailearn/shared` 尚无该契约导出），注明收口
  迁移至 `@ailearn/shared/episode-commit-contracts`。
- `CommitPort` 的 PG 实现（锁序 + CAS 快照 + schedule 写 + operational 审计）
  在后续任务 06-4/06-5 落实；`scheduleOutput`（intervalDays/nextReviewAt）由
  official scheduler（06-5）冻结，本任务以调用方输入提供。
- 断线恢复只读 event/contract/artifact，不重复 Provider 调用（commitKey 幂等
  已覆盖 result/schedule 侧）。

## 7. 验收

- [x] 同事件重放得到相同 disposition 与投影 hash；
- [x] outbox 派生 projection 正确（facet/map 只读 outbox 安全摘要）；
- [x] 任一 CAS 失败整体回滚为 stale/cancelled/blocked（operational_only，0 学习副作用）；
- [x] 一个 Episode 失败或 stale 不回滚之前已成功的独立 Episode；
- [x] 重试/断线/Worker crash 不重复 result 或 schedule 副作用。
