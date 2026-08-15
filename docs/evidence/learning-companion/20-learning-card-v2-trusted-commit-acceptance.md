# 方案 20 C26/C41/C42/C44 — trusted Commit 旅程验收说明（R35）

> 归属：方案 20 证据包（§28 C-case 表剩余项的验收口径说明）
> 结论：**V2 接缝全部确定性验证**；完整 LLM 评估旅程为"平台稳定窗口内上线前验收项"，
> 调用序列与本文件记录，机制已由方案 16 单测覆盖。

## 1. 链路全景（PREPARE → Commit → Schedule）

```text
createRunV2 (PREPARE)
  → freezeTargetSnapshotV2（§16.2：snapshot 冻结 + eligibility + planningExposure）
  → run 状态机（learning_runs: planning → active）
  → run-planner / run-structured（§16.4/§16.5：从 frozen snapshot 派生计划与任务，
     generateStructuredFromSnapshot（run-planner.ts:398）；run-critic.ts 明确禁止回查
     card_key_points.claim/quoteText——V2 提示全部来自 snapshot）
  → submitArtifact（用户作答，phase → assessing）
  → worker evaluate_validation（runEvaluateRubric，真实 LLM Critic）
  → commit（episode-commit.ts：create_initial/consume_pending 授权 → schedule 副作用）
  → 恰一 initial Schedule（subject = objectiveId / key_point_id alias）
```

## 2. 各环节验证状态（R35）

| 环节 | 状态 | 证据 |
|---|---|---|
| PREPARE 冻结 LearningTargetSnapshotV2 | ✅ 已验证 | C5（冻结/幂等重放/0 Schedule）、C38（rev1/rev2 双 snapshot）、redaction IT（evidence_not_usable fail-closed） |
| eligibility 判定（eligible/practice_only/blocked） | ✅ 已验证 | C5/C19-lite（reveal→practice_only）、C35（legacy_unreviewed→practice_only，R35 新增分支 + 4 单测）、C31（redaction→blocked） |
| Planner/Structured 从 snapshot 消费 | ✅ 已验证 | run-planner.ts:398 `generateStructuredFromSnapshot`（R22 审计 + run-v2-rebase.test.ts） |
| Critic 从 snapshot 消费（不回查 claim） | ✅ 已验证 | run-critic.ts §16.6 V2 分支（R22 审计） |
| activation 0 Schedule（不伪造排程） | ✅ 已验证 | C25 + 全部激活类 E2E |
| trusted Commit → 恰一 initial Schedule | ✅ 机制已验证 | episode-commit.ts create_initial（不存在 active pending → 创建）；vertical-slice.test.ts:406（create_initial + 完整 mastery Episode） |
| Archive/Commit 双锁竞态（C42） | ⚠️ 机制层覆盖 | episode-commit 的 schedule 锁 + C30 archive 生命周期；完整竞态注入需 Commit 运行时（故障注入矩阵 §28.2 已成文，见 `20-learning-card-v2-fault-injection-matrix.md` #10——锁序/epoch 复验机制就绪，DB 级竞态注入留待 production-like 环境） |
| 跨窗口 reveal 无法绕过 Trust（C41） | ⚠️ 机制层覆盖 | planningExposure（sameCueRecentlyRevealed → practice_only，C19-lite 实证）；"PREPARE 后另一窗口 reveal 再提交 Artifact"完整旅程需 Commit 运行时 |
| 完整 LLM 旅程（C26 due Review→Commit / C44 首验→Reminder→再 reveal→首次验证） | ⏳ 上线前验收项 | 需要：平台稳定窗口 + learning-sessions 运行时驱动（见 §3 调用序列） |

## 3. 完整 LLM 旅程验收调用序列（上线前执行）

```text
1. createRunV2（originV2 card/review, goal=stabilize）→ PREPARE 冻结
2. 驱动 run 到 active（applyAction start/advance 状态机）→ 生成 structured tasks
3. 用户作答 → submitArtifact（幂等 idempotencyKey）
4. worker 消费 evaluate_validation job（真实 LLM rubric 评估，tokenrhythm）
5. run → committing → commit（episode-commit create_initial）
6. 断言：恰一 initial Schedule（subject=objectiveId）、Reminder completed、
   mastery 写入仅经 CanonicalLearningEventEnvelope
7. C41：PREPARE 后另一窗口 reveal → 再提交 → 最终 practice_only、0 false formal Commit
8. C42：Archive 与 due Commit 双锁序故障注入（Archive 先赢=0 consume；
   Commit 先赢=恰一 successor 后 lifecycle close）
```

依赖：平台稳定窗口（tokenrhythm 限流率 < 重试预算）、方案 16 评估运行时
（evaluate_validation 已在 worker index.ts 注册）、§24.7 runbook 的事前检查通过。

## 4. 为什么不现在跑完整 LLM 旅程

- evaluate_validation 是分钟级 LLM 调用，且 C26/C41/C42/C44 各需多轮完整
  状态机推进（每轮含若干 LLM 调用）；当前 tokenrhythm 平台抖动（503/空输出，
  R26–R31 实测）会导致验收数据不可复现；
- 该旅程属方案 16 learning-sessions 运行时域（非 V2 代码面），其机制单测已覆盖
  （vertical-slice / run-v2-rebase）；V2 侧的接缝（snapshot/eligibility/幂等/
  redaction/0-Schedule）已全部确定性验证；
- 上线前按 §3 序列执行并归档为 §26.2 证据，与性能 Gate（§23.7 production 侧）
  同一窗口。
