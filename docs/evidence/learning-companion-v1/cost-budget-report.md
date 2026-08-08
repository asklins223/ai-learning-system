# 成本预算报告（cost-budget-report）

> 对应任务 11-2 证据文件 13。佐证 DoD 35、36。
> 决策记录：`01-5-metrics-cost-gates.md`（§16.6 冻结）、`02-4-audit-privacy-lifecycle.md`、`03-6-budget-epoch-kill.md`、`08-4-observability-runbook.md`（metrics-schema）、`09-6-real-env-rc.md`、`10-7-final-soak.md`。

## 1. 成本 Gate 冻结基准（01-5 §16.6，W0 冻结）

- 用真实 Provider 冻结每 Episode/Session 的 LLM 调用、输入/输出 token、ASR 秒数、TTS 字符、对象存储与 current-target Tutor 独立预算，以及用户级 p50/p95 成本；阈值在 W0 冻结并在看到 RC 结果前不变，**不得调低**。
- PREPARE 创建**不可借用**的 `BudgetEnvelope`：展示首个 formal Scene 前预留全部 required probes、一次允许的重录/结构修正上限、Assessment Critic 重试与 commit 所需额度；workspace/user 余额不足在作答前以**非惩罚方式**拒绝（03-6 `LEARNING_LOOP_BOUNDS` 复用为 policy bounds 单一来源）。
- 已锁答案使用预留额度完成评估；Provider 故障进入有 W0 冻结 SLA（300s）的 recovery queue，**不能因后续预算耗尽永久卡在 retryable**；超出 SLA 后以 operational failure 结束且 0 学习副作用（09-5 §6）。
- Tutor detour 使用独立 envelope，不能借用 formal reserve；重录、多 Scene 和澄清分别按 contract 上限扣账，**Agent 无权提高**（03-6 policy bounds）。

## 2. 成本口径与判定层（08-4 metrics-schema，单一冻结口径）

`apps/api/src/modules/observability/metrics-schema.ts`（纯函数，无 IO）冻结成本口径：

- **四类指标分离**：`cost` 类含每 Episode/Session 的 `llm_calls / input_tokens / output_tokens / asr_seconds / tts_characters / object_storage_bytes / tutor_budget` 与用户级 `user_cost_p50 / user_cost_p95 / retry_amplification_factor`；`hard-gate` 类为判定对照项。
- **用户级 p50/p95**：`computeUserCostPercentile(userCosts, dimension, p)` 按维度计算（R7 线性插值，无随机/时钟依赖）；分布/比例/成本聚合确定性（同一输入恒得同一输出）。
- **重试放大系数**：`computeRetryAmplification(uniqueRequests, billedCalls)` = 计费调用 / 唯一请求；默认上限 `DEFAULT_RETRY_AMPLIFICATION_CAP = 1.5`（W0 冻结口径，RC 故障注入验证；只能改常量不能改判定逻辑）；同一 provider/job attempt 重复计费调用 0。
- **hidden/off 后新增成本为 0**：`checkHiddenOffZeroNewCost` 对 hidden/off 确认后全部成本样本任一维度 >0 即违规；`cancel_confirmed` 语义覆盖「用户取消被服务端确认后新增调用 0」。
- **Tutor 预算隔离**：`checkTutorFormalBudgetIsolation` 保证 Tutor detour 独立 envelope、不消耗/不借用 formal assessment 预算。
- **p95 成本上限**：`checkP95CostCap` 任一维度 p95 越过冻结上限即停止扩量；以缩减 Critic/证据/A11y 绕过成本上限的上报一律违规。
- **零成本面**：公开认证层、安静锚点、未触发页面 context 注册不产生 Provider 成本。
- alerts 以 hard-gate 与 cost 类为触发源：hidden-off-new-cost / cancel-confirmed-calls / tutor-formal-borrow → P1（立即冻结扩容）；retry-amplification 超 1.5 → P2 故障注入复查；p95-cost-cap 越限 → P1 停止扩量（不得缩减质量项绕过）；privacy-review 违规 → P1。

## 3. 真实环境 RC 成本 Gate（09-6，佐证 DoD 35）

`apps/api/src/modules/learning-sessions/real-env-rc.ts` 冻结上限（`FROZEN_COST_CAPS`，负值一律违规）：

| 维度 | 每 Episode 上限 | 每 Session 上限 | 用户级 p95 上限 |
| --- | --- | --- | --- |
| `llmCalls` | 12 | — | 100 |
| `inputTokens` | 40,000 | — | 300,000 |
| `outputTokens` | 8,000 | — | 60,000 |
| `asrSeconds` | — | 600 | 3,600 |
| `ttsCharacters` | — | 20,000 | 120,000 |
| `objectStorageBytes` | 1,000,000 | — | 5,000,000 |
| `tutorBudgetUnits` | 4 | — | 30 |

- 判定函数：`checkEpisodeBudgetCaps`（LLM/token/存储/Tutor 按每 Episode，scope 隔离）/ `checkSessionBudgetCaps`（ASR/TTS 按每 Session）/ `checkUserP95CostCaps` + `computeStopScaling`（任一 p95 成本或调用数越限 → `stopScaling=true` 立即停止扩量；用户成本样本为空 → 违规，不静默放行）/ `checkNoQualityReductionBypass`（缩减 Critic/证据/A11y 绕过一律违规，即使 p95 在限内）/ `checkTutorBudgetIsolation`（借用 formal 预算 >0 违规）。
- 零调用/零成本 Gate：`checkCancelConfirmedZeroNewCalls`、`checkHiddenOffZeroNewCost`（全维度含 Tutor）、`checkZeroProviderCallSurfaces`（public_auth / quiet_anchor / untriggered_context_registration 三表面逐一判定）。
- 全部为确定性纯函数（零 import、独立可测），42 例单测全绿；测试覆盖「同一输入两次评估结果一致」。

## 4. 最终 soak 成本观察窗（10-7，佐证 DoD 36）

`apps/api/src/modules/companion-shell/final-soak.ts`：

- **RolloutStageGateV1 五档统一 p95 成本预算**（`ROLLOUT_P95_COST_CAP`，扩量不放松成本）：llmCalls=60 / inputTokens=600k / outputTokens=300k / asrSeconds=1800 / ttsCharacters=100k / objectStorageBytes=500MB / tutorBudgetUnits=20。
- **成本观察窗**（复用 metrics-schema 冻结语义，无第二套定义）：用户级 p50/p95（面板观察输入）；p95 上限、重试放大 ≤1.5、hidden/off 后新增成本 0 为**硬 Gate**（违规 → 立即停止扩量，08-4 §5 alerts）。
- `evaluateFinalSoak`（public-beta-default 档）：soak ≥168h、hard incident=0、成本曲线全部在冻结预算内 → `costWithinBudget`；`assertFinalSoakPassed` 0 容忍 fail closed。
- 22 例单测覆盖违规分支：p95 越限、重试放大超限、hidden/off 成本 >0、soft 超预算等。

## 5. 导出 / 删除与隐私生命周期成本侧（02-4，佐证 DoD 13/35）

- `GET /me/companion/audit/export` 导出覆盖率 100%（含活动行与 tombstone 行）；`DELETE /me/companion/audit` 级联删除；`deleteAllUserCompanionAuditAndLedger(userId)` 跨全部 workspace 级联（账号删除/残留扫描钩子）；audit/ledger 只存在本库（无 cache/队列/分析副本），删除后不触发重新邀请、不重建画像。
- audit TTL 30 天 / ledger 原始 entity refs 30 天，到期整行删除或替换为不可逆 content-free tombstone（audit 清空 opaque IDs/hashes、ledger 键替换为 SHA-256 截断键）——成本与调用放大 Gate 之外的隐私成本面（存储/保留）亦受 TTL 约束。

## 6. 判定层证据

- 成本 Gate 全部为纯函数判定：阈值/上限为 W0 冻结常量（只改常量、不改变判定逻辑），同一输入恒得同一输出；真实成本样本（真实 Provider token usage、真实 ASR 秒数等）由 09-6 真实环境 RC 与 10-7 最终 soak 的采集管线注入后复核，「待 RC 执行环境采集后回填」状态在 `release-manifest.json` 如实标注，不虚构样本数据。
- 验证记录：`npm run typecheck --prefix apps/api` 通过；metrics-schema / privacy-review / real-env-rc（42 例）/ final-soak（22 例）单测全绿（随四包全量：apps/api 2942、packages/shared 374、packages/db 5、apps/web 750）。
- 决策记录 01-5、02-4、03-6、08-4、09-6、10-7 状态均为 Frozen（已冻结）。
