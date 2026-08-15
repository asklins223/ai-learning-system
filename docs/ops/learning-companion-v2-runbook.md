# 学习卡 V2 运营 Runbook（§24.7 最小目录）

> 归属：方案 20（`20-learning-card-v2-value-first-generation-and-learning-target-rebase.md` §24.7）
> 状态：R35 成文（2026-08-15）；每项含检测信号、用户影响、立即停写范围、
> 数据核对、恢复条件、事后回归样本。恢复手段**不得**包含"关闭质量校验"。
> 关联：证据包 `docs/evidence/learning-companion/20-learning-card-v2-evidence-package.md`
> （§7 回滚/停写步骤）、`20-learning-card-v2-implementation-review.md`（R33/R34 变更）。

---

## 0. 通用术语与工具

- **V2 outbox**：`card_generation_run_outbox_v2`（claim/complete/fail 见
  `workers/ai-worker/src/handlers/card-generation-v2-handler.ts`）。
- **停写范围**（V1 旧 writer）：`CARD_GENERATION_V2_ENABLED=true` 且
  `CARD_GENERATION_V1_WRITER_ENABLED != "true"` 时 V1 `createCardGenerationRun`
  直接 409 `v1_writer_disabled`（R33 已实现）。
- **生成配额**（R34）：`CARD_GENERATION_V2_MAX_INFLIGHT_RUNS`（默认 3）/
  `CARD_GENERATION_V2_DAILY_RUN_LIMIT`（默认 50）。
- **检查命令**（从仓库根，dev 环境）：
  ```bash
  # run/outbox/候选状态
  DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
    node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
    workers/ai-worker/src/integration-tests/card-generation-v2-e2e-subset.integration.ts
  ```

---

## 1. provider/model degradation

- **检测信号**：worker 日志 `V2 outbox job failed` + `retryable: true` 且
  `last_error` 含 `503/429/timeout/empty output`；`card_generation_run_outbox_v2`
  出现 `attempts >= 2` 堆积；配置平台（config/ai-platforms.json
  `capabilities.agent_turn`）健康检查失败。
- **用户影响**：生成变慢或失败；review_ready 延迟。
- **立即停写范围**：新生成暂停（见 §12 pause），已开始 job 不杀（30min 租约内
  由 retryable 重试兜底，attempts≥3 自动 failed）。
- **数据核对**：`SELECT status, attempts, last_error FROM card_generation_run_outbox_v2
  WHERE status != 'completed'`；确认无 half-sealed run。
- **恢复条件**：平台健康恢复；重放失败 job（status 置 pending）或让用户重试
  （Idempotency-Key 幂等）。
- **事后回归样本**：`card-generation-v2-e2e-subset.integration.ts`（30 条）；
  LLM 自然态套件 1 条（真实 provider）。

## 2. generation queue backlog

- **检测信号**：outbox pending 行数持续增长（>100）；`processed_at` 停滞；
  poll 间隔内 claim=0 但 pending>0。
- **用户影响**：run 长时间停留在 queued/planning。
- **立即停写范围**：无（只观察）；若 worker 进程异常则重启 worker。
- **数据核对**：`SELECT job_type, status, count(*) FROM card_generation_run_outbox_v2
  GROUP BY job_type, status`；孤儿 processing 由 reaper（lease_expires_at < now()）回收。
- **恢复条件**：worker 恢复消费；积压按 created_at 顺序自然清空。
- **事后回归样本**：C22（幂等重放不重复）+ 全套 E2E。

## 3. Critic/schema widespread failure

- **检测信号**：事件/报告中大量 `candidate_revision_mismatch`、
  `no_evidence_reference`、`reportHash` 校验失败；quality reports 表出现
  同 gateVersion 全失败窗口。
- **用户影响**：候选全部 failed → needs_attention；无低质卡发布（fail-closed 正确）。
- **立即停写范围**：暂停新生成（§12），排查 deterministic-gates / provider schema。
- **数据核对**：`card_candidate_quality_reports_v2` 按 report_type/gate_version
  聚合 verdict 分布。
- **恢复条件**：修复后重放失败 job；regenerate 单候选验证。
- **事后回归样本**：C02/C07/C12/C13/C24（fail-closed 门禁）+ C20/C20b（重跑门禁）。

## 4. answer leakage incident

- **检测信号**：SSE/公共投影/Companion context 中出现 canonicalAnswer、
  scoringRubric、evidence 原文；C33 白名单测试失败；外部报告。
- **用户影响**：答案泄漏（严重隐私/学习有效性事故）。
- **立即停写范围**：**立即暂停全部生成与 reveal**（§12）；停 Web 入口。
- **数据核对**：审计 `card_generation_events_v2` 与 `card_exposure_ledger_v2`
  的 exposure 记录；检查 `serializeCandidatePublic`/`readPublicCardV2` 输出。
- **恢复条件**：定位泄漏面（public payload 组装/SSE 序列化）→ 修复 → 回放
  受影响 run 或按证据包 §7 处置；受影响 exposure 记入 audit。
- **事后回归样本**：C33（SSE 白名单）、C18（reveal exposure-first）、C5 公共投影
  零泄漏断言、C37-lite。

## 5. cross-workspace permission incident

- **检测信号**：跨 workspace 查询返回数据；RLS 策略失效告警；C32 测试失败。
- **用户影响**：租户隔离破坏（严重）。
- **立即停写范围**：立即暂停 API 写入路径；核对 RLS（`pg_policies` +
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` 状态）。
- **数据核对**：`SELECT current_setting('app.workspace_id', true)` 全链路；
  检查 worker setWorkerTransactionContext 是否被跳过。
- **恢复条件**：修复 RLS/上下文设置 → 全量回归。
- **事后回归样本**：C32（跨租户伪造 runId 0 事件）、sec01 静态扫描、
  queue IT（RLS enabled+forced）。

## 6. activation partial/unknown result

- **检测信号**：receipt 存在但 mapping 与 selectedCandidates 不一致；
  激活超时后状态不明；outbox post-activation job 失败。
- **用户影响**：用户看到"已激活"但卡缺失，或重复激活被拒。
- **立即停写范围**：无（激活幂等受 Idempotency-Key + receipt 表保护）。
- **数据核对**：`card_activation_receipts_v2`（requestHash/mappings 回读）、
  `learning_cards_v2`/`learning_objectives_v2` 存在性、post-activation 消费台账
  （`card_generation_post_activation_consumptions`，R33）。
- **恢复条件**：同 Idempotency-Key 重放 → 同 receipt；缺失时按 receipt 手工对账。
- **事后回归样本**：C23（幂等重放/恰一映射）、R33 投影消费者测试（对账/重放）。

## 7. `cardContentEpoch` mixed writer

- **检测信号**：同一 workspace 的 run 出现 epoch 不单调；
  `card_content_capability_state` 与 run.card_content_epoch 不一致；
  V1 writer hit（`card_generation_legacy_writer_hits`）> 0 且 V2 已启用。
- **用户影响**：stale_epoch 409；新旧卡并存。
- **立即停写范围**：**立即停写 V1 writer**（`CARD_GENERATION_V1_WRITER_ENABLED`
  保持未设；确认 V1 409）；按 C8 流程 `executeV1WriterShutdown` drill。
- **数据核对**：`SELECT workspace_id, count(*) FROM card_generation_runs_v2
  GROUP BY workspace_id` epoch 单调性；legacy writer hit 计数。
- **恢复条件**：V1 停写确认 hit=0；epoch 前移后新 run 重建。
- **事后回归样本**：C8 停写 IT（guard 409/放行/blocked）、C39 断言（无双 writer）。

## 8. outbox/projection lag

- **检测信号**：post-activation 消费台账缺失/延迟；投影（Card 列表）与
  receipt 不一致；outbox 行 status='processing' 超租约。
- **用户影响**：激活后列表短暂不可见。
- **立即停写范围**：无。
- **数据核对**：`card_generation_post_activation_consumptions` 对账（reconciled
  counts vs mappings）；reaper 回收孤儿 processing。
- **恢复条件**：worker 恢复消费即自愈；必要时手工重投（同 payload 幂等）。
- **事后回归样本**：R33 投影消费者测试（幂等/重放/fail-closed）。

## 9. target snapshot mismatch

- **检测信号**：PREPARE 抛 `evidence_snapshot_not_found` /
  `evidence_eligibility_missing` / `evidence_not_usable`；snapshot 的
  target_revision_hash 与 objective revision 不一致；`snapshot mismatch` 告警。
- **用户影响**：LearningRun 无法 PREPARE（fail-closed 正确）。
- **立即停写范围**：无。
- **数据核对**：`learning_target_snapshots_v2` vs
  `learning_objective_revisions_v2.target_revision_hash`；eligibility 状态。
- **恢复条件**：redaction/eligibility 前移属预期行为（C31）；非预期 mismatch
  需查 snapshot 冻结代码路径（target-snapshot-adapter）。
- **事后回归样本**：C5（PREPARE 冻结/幂等）、C38（target-equivalent 后新旧
  snapshot）、redaction IT（evidence_not_usable）。

## 10. migration reconciliation failure

- **检测信号**：迁移后对账脚本行数不符；FK/hash closure 校验失败；
  `card_generation_cutover_events` 与预期不符。
- **用户影响**：数据不一致风险。
- **立即停写范围**：暂停相关迁移与写路径。
- **数据核对**：按证据包 §7 迁移清单逐项对账（additive 迁移不编辑已应用文件）。
- **恢复条件**：新增前向修复迁移（不反写旧 schema）；必要时回滚到迁移前备份。
- **事后回归样本**：C34/C35/C43 迁移套件 + api 全量。

## 11. evidence redaction/delete request

- **检测信号**：`recordEvidenceRedactionV2` 调用（R34）；tombstone 行写入；
  用户/合规删除请求。
- **用户影响**：被 redact 证据的 Objective 停止可激活/可 PREPARE（fail-closed）。
- **立即停写范围**：无（redaction 本身即停用）。
- **数据核对**：`evidence_redactions_v2` tombstoneHash 闭包；eligibility
  revoked/epoch 前移；0 新 receipt/snapshot。
- **恢复条件**：redaction 不可逆（合规删除）；如需恢复须走数据恢复流程。
- **事后回归样本**：redaction IT（幂等/evidence_revoked/evidence_not_usable/
  跨租户 404）。

## 12. pause generation / resume / forward-fix

- **暂停**：`CARD_GENERATION_V2_ENABLED` 移除（API 层 fail-closed，路由不注册）
  + `CARD_GENERATION_V1_WRITER_ENABLED` 保持未设（V1 亦拒）→ 双 writer 均停。
- **恢复**：恢复 env 后验证 `pipeline.route.light/standard` 事件与配额门禁。
- **forward-fix**：对已发布错误内容走 archive/supersede（§15.7），绝不反写
  V1 schema（C39）。
- **事后回归样本**：全套 E2E + C8 停写 IT。

---

## 13. 事前检查清单（每次切流/演练前）

- [ ] `card_generation_legacy_writer_hits` 观察窗口（7d + 24h）hit=0；
- [ ] `checkLegacyWriterShutdownReadiness.canShutdown = true`；
- [ ] 配额 env（MAX_INFLIGHT/DAILY）与成本预算一致；
- [ ] 全部 runbook 项 owner 已读并签字；
- [ ] 证据包 §7 回滚步骤可达（V1 代码路径仍在）。
