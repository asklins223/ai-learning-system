# 决策记录 06-4：并发、竞态与回滚（§7.6/§7.7）

> 状态：**Frozen（已冻结）**
> 执行：阶段 06（W5）任务 06-4
> 日期：2026-08-08
> 来源：`06-w5-vertical-slice-scheduler.md` 任务 06-4（原方案 §7.6 同锁域竞态、
> §7.7 stale/取消与 Episode 提交、§4.3 COMMIT 锁序与 CAS）
> 约束级别：consume-pending 最多消费一次；create/consume 后恰好一个 active schedule；
> record-only/facet/practice/operational 0 调度副作用。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/race-rollback.ts`：并发竞态与回滚防护
  （纯函数 + 端口）。纯函数：`evaluatePendingSingleConsumer`（pending 单消费者）、
  `evaluateContentExposureRace`（三组 contentExposureKey 竞态）、
  `evaluateFrozenContentIntegrity`（lock 后冻结内容不可变）、`evaluateCancelSemantics`
  （cancel 语义）、`recompareEpochBeforePersist`（epoch 重比较）、
  `evaluateLateResponseAfterHardKill`（hard kill 迟到响应低敏审计）、
  `buildDisconnectRecoveryPlan`（断线恢复只读）、`deriveContentExposureKey` /
  `computeExposureLockKey`（复用 exposure-service 冻结公式）。端口：
  `PendingScheduleConsumerPort`、`LearningUnitGuardPort`、`LowSensitivityAuditPort`。
- `apps/api/src/modules/learning-sessions/race-rollback.test.ts`：单测（node:test）。
- 本文件：决策记录。

## 2. 核心不变量（验收）

- **同一 pending schedule 只能被一个消费者消费**：数据库唯一约束
  （`review_schedules_pending_unique_idx`，每 (workspace,user,key_point) 最多一条
  pending）与 target-level idempotency 为最终兜底。判定 fail closed：
  idempotency 已消费 / 竞争消费者已持有 / 唯一约束失效且多个 pending → 拒绝。
- **三组共享 contentExposureKey 竞态正确**：legacy reveal → new Episode lock 必须
  看到 practice-only（assistance 先赢）；new reveal → legacy submit 必须被阻止；
  Scene/Rubric/policy rollover → 新 lock 被阻止、已锁 artifact 冻结保留。
  lock 先赢：已锁 artifact 冻结 pre-exposure snapshot，之后 reveal 只写
  exposure/cooldown，不追溯污染。
- **lock 后 rubric/target/evidence 不可变**：Key Point / Evidence / Rubric /
  Scene policy 任一内容失配 → stale，无正式副作用（sideEffects="none"）。
- **cancel 终止当前和未开始 Episode**；已 commit 保留；partial commit 状态明确
  （不静默回滚）。
- **所有 turn/tool/Critic 结果落库前重新比较 runtimeEpochSnapshot + episodeEpoch**；
  缺失 → fail closed（epoch_missing）。
- **hard kill 后迟到响应只记低敏审计摘要**：不写 probe/artifact/assessment staging，
  不能恢复为 trusted；审计 content-free（不含 transcript/answer/rationale）。
- **断线恢复只读**：只读取 event/contract/artifact，不重复 Provider 调用和业务
  副作用（`reissueExternalCalls=false`、`repeatBusinessSideEffects=false`）。

## 3. pending schedule 单消费者

`evaluatePendingSingleConsumer` 判定顺序：idempotency 已消费 → 拒绝；竞争消费者
已持有 → 拒绝；无 pending → 拒绝；唯一约束失效且多个 pending → fail closed；
请求的 schedule 不存在 / 非 pending / generation 不匹配 → 拒绝；否则签发
`consumeToken {scheduleId, generation}`。`PendingScheduleConsumerPort.tryConsume`
实现必须同事务执行「锁 pending → 校验 generation → 置 completed → 写 successor」，
唯一约束冲突/幂等命中返回 consumed=false（06-2 集成层最终兜底）。

## 4. 三组 contentExposureKey 竞态

`evaluateContentExposureRace` 判定顺序：

1. key 为空 → fail closed（rollover_blocks_lock）；
2. Scene/Rubric/policy rollover（policy epoch 失配）且未锁 → 新 lock 被阻止；已锁
   时 artifact 冻结保留（commit 阶段由 stale 兜底）；
3. 新 Episode 已锁且冻结 pre-exposure snapshot → **lock 先赢**；
4. legacy 已 reveal / assistance 已激活且未锁 → **assistance 先赢**
   （lock 必须看到 practice-only，不能靠切换入口重置 exposure）；
5. 新 Episode 已 reveal 且 legacy 未 submit → legacy submit 被阻止；
6. 否则 consistent。

`contentExposureKey` 公式不含 Scene/rubric/provider/model/assistance policy 维度
（§7.6），rollover 后仍命中同一 key（测试验证 evidence 乱序输入幂等）。

## 5. lock 后冻结内容不可变与 stale

`evaluateFrozenContentIntegrity` 按组成部分细粒度比较并报告可审计 mismatch：
assistance_policy → scene_policy → rubric（policy 版本与逐项
rubricTarget.expectedTargetHash/evidenceRefIds）→ evidence（evidenceId→hash 集合）→
fingerprint/key（组成部分全匹配仍失配 → key_point_content）。任一失配 →
`{ok:false, stale:true, sideEffects:"none"}`（无正式副作用）。

## 6. cancel 语义

`evaluateCancelSemantics`：committed → preserved（已 commit 保留）；
partial_commit → `partialCommitMarked`（不静默回滚，明确标记）+ draft/active 同时
terminated；completed 但未 commit（异常状态）→ 防御标记 partial；stale/cancelled →
alreadyTerminal；draft/active 未 commit → terminated（零副作用）。

## 7. epoch 重比较与 hard kill 迟到响应

`recompareEpochBeforePersist`：current 任一 null → epoch_missing（fail closed）；
任一不等于 contract 快照 → epoch_mismatch。

`evaluateLateResponseAfterHardKill`：killFired → 低敏审计（writeProbe/writeArtifact/
writeAssessment 全 false、canRestoreTrust=false）；未 kill 但 epoch 失配/缺失 → 同样
低敏审计（epochMismatch 标记）；epoch 匹配 → persist。审计经
`LowSensitivityAuditPort.record` 落库，`contentFree:true` 约束禁止任何用户内容。

## 8. 断线恢复

`buildDisconnectRecoveryPlan`：contract 未持久化 → terminate（要求重新 PREPARE，
不重放）；终态（completed/stale/cancelled）→ resume_readonly；进行中（draft/active）
→ resume_local，未完成外部调用不重复发起（记审计等超时）。三种动作一律
`reissueExternalCalls=false`、`repeatBusinessSideEffects=false`，只读
events/contract/artifacts。

## 9. 集成契约（06-2 Episode COMMIT）

COMMIT 固定锁序（runtime-control → learning_episode → target/version guard →
schedule guard → input schedule）中复用 `evaluatePendingSingleConsumer`（consume）与
`recompareEpochBeforePersist`（单次 CAS 的 epoch 部分）；每次 turn/tool/Critic
结果落库前调用 `recompareEpochBeforePersist`；kill/cancel/stale/publish 并发事件
先于 COMMIT 到达时，`deriveEpisodeCommitDisposition` 输出 operational_only
（0 学习副作用、0 调度副作用）——详见 06-3 决策记录。
