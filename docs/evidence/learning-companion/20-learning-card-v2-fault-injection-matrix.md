# 方案 20 §28.2 故障注入矩阵（R36）

> 目标：证明任何故障都不发布未经门禁内容、不重复 canonical fact、
> 不错误推进 mastery/schedule、不丢历史（§28.2 末句）。
> 本文把计划 §28.2 的每一项映射到已实施的测试/机制；未覆盖项给出明确
> 依赖与验收前置，不以 mock 或 fixture-only 冒充证据（§29.7）。

## 矩阵

| # | 故障注入场景（§28.2） | 状态 | 证据/机制 |
|---|---|---|---|
| 1 | provider timeout / rate limit / partial JSON | ✅ 已覆盖 | `workers/ai-worker/src/__tests__/handler-abort-budget.test.ts`（嵌套超时中断不扩散）；`generation-failure-policy.test.ts`（budget/deadline 耗尽 → 停止，绝不 partial publish）；LLM 响应 strict zod parse fail-closed（`providers.ts` + `card-generation-v2-handler.ts` `CardGenerationProviderErrorLike`）；handler abort 预算在四阶段共用 |
| 2 | worker crash 于 source seal / Author / Critic / activation 前后 | ✅ 机制层 | source seal 在 API 事务内完成（seal 后 worker 才被唤醒，幂等 `evidenceSnapshotId` 跳过）；run 状态机（`cardGenerationRunsV2.status`）驱动 worker 入口状态门闩；outbox job lease（0163 部分唯一约束 + lease token/expiry）保证 crash 后重投；activation 单事务 + 幂等键（`card_activation_receipts_v2`） |
| 3 | DB deadlock / serialization retry | ⚠️ 机制层 | 事务全部经 drizzle `withWorkspaceTransaction`；§13.3 行锁按稳定 evidence ID 排序（R36）防死锁；drizzle 默认 serialization retry 由 postgres.js 连接层处理；完整 deadlock 注入需 DB 级 fault 注入器（生产压测项，见 #11） |
| 4 | outbox publish failure / duplicate delivery | ✅ 已覆盖 | `card-generation-v2-sse-outbox.test.ts`（cursor 恢复 + payload 白名单）；worker 消费 `(eventId, consumerName)` 幂等（§17.7）；0163 部分唯一约束（plan/post_activation 单例，重复投递 ON CONFLICT DO NOTHING）；`cardGenerationPostActivationConsumptions` 对账（0162） |
| 5 | SSE 断开、刷新、跨设备继续 | ✅ 已覆盖 | `getGenerationRunEventsV2` cursor 恢复（`event_seq > afterSeq` + sanitize）；`card-generation-v2-sse-outbox.test.ts` 1/1 |
| 6 | stale Candidate revision 与并发 merge | ✅ 已覆盖 | activation/review CAS（expectedRevision + expectedRevisionHash → 409 stale_revision）；edit/merge 重跑门禁（R14）；lineage 防循环 + 父子 revision 唯一（§18.1）；`card-generation-v2-activation-service.test.ts` 状态守卫用例 |
| 7 | `cardContentEpoch` 在 in-flight Run 中提升 | ✅ 已覆盖 | activation 校验 `expectedCardContentEpoch` → 409 stale_epoch（`card-generation-v2-activation-service.test.ts`）；PREPARE 冻结 epoch（`target-snapshot-adapter.ts`）；C8 停写 epoch bump 后 V1 guard 409（`card-generation-v2-c8-shutdown.integration.ts`） |
| 8 | evidence asset 删除 / 权限变化 | ✅ 已覆盖 | `evidence-redaction-service`：tombstone + eligibility revoked/epoch+1（R34）；activation §13.3 FOR UPDATE + vector hash 闭包 → 409 stale_evidence（R36）；`card-generation-v2-redaction-quota.integration.ts` 2/2 |
| 9 | Critic abstain 与 contradictory reports | ✅ 已覆盖 | Grounding `verdict !== "pass"` 或 hardIssues>0 → fail（`critic-service.ts:107`）；abstain → failed（handler:1757）；`card-generation-v2-c2c3-author-critic.test.ts`（critic 失败 → 不发布）；R29 真实证据判定 |
| 10 | Target 在 PREPARE、submission lock、Commit 各竞态点 archive/supersede | ⚠️ 机制层 | Archive 先赢 → 后续 Run/Commit stale（§16.7 锁序）；`revalidateV2CommitEpochs`（objective lifecycle epoch + evidence eligibility epoch 复验，`run-processing-tick.ts:1018-1023`）；C42 机制层覆盖（`trusted-commit-acceptance.md` §8：schedule 锁 + C30 archive lifecycle）；完整双锁竞态注入需 Commit 运行时环境 |
| 11 | 生产级 DB/网络故障注入（deadlock、connection loss、磁盘满） | 🔶 待上线 | 需 production-like 环境 + chaos 工具（§23.7 production 侧门槛）；确定性侧已通过 `card-generation-v2-*` 全部 IT（42 个 IT 文件） |

## 不变量证明（每项故障均满足）

1. **不发布未经门禁内容**：任何 Critic 非 pass / gate 非通过 → 0 发布（§13.4 禁止"尽量产出"；R35 no_cards 独立成功终态）；
2. **不重复 canonical fact**：幂等键 + 部分唯一约束 + `(eventId, consumerName)` 幂等（§17.7）；
3. **不错误推进 mastery/schedule**：activation 不创建 Schedule（§17.5 事务 13 步）；personal projection 0 变化（0162 消费台账只读对账）；IVR 不是 Schedule（§17.3）；
4. **不丢历史**：active/historical 对象 FK RESTRICT 不级联删除（§18.5）；redaction 单调 overlay 不重写 snapshot（§14.1）；card/objective revision immutable（R36 §18.2 新增 `learning_card_revisions_v2`）。

## R36 新增/强化

- §13.3 eligibility 行锁 + vector hash 闭包（fault #8 的 epoch 漂移检测）；
- §17.7 domain events 通道 + 幂等键（fault #4 的 lifecycle 事件幂等）；
- §18.2 learning_card_revisions_v2 不可变 revision 行（fault 后历史不丢的物理保证）。

## 缺口与前置（不阻塞设计冻结，§30.2）

- #3/#11 的 DB 级 deadlock/serialization/connection 故障注入：需 production-like 压测环境（§23.7），确定性侧以锁序 + 事务边界测试替代；
- #10 完整 Commit 竞态注入：需 Commit 运行时（LLM 评估旅程上线后，见 evidence-package §6.4）。
