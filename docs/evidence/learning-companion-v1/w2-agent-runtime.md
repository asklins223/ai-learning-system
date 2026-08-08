# W2 证据：Learning Agent 运行时、四阶段外壳与可信归约

> 对应任务 11-2 证据文件 4。佐证 DoD 4、6、17、19、20、22、23、24。
> 决策记录：`docs/plans/learning-companion/03-w2-session-supervisor-runtime.md`（任务 03-1~03-6）与 `03-2-prepare-session-lifecycle.md` ~ `03-6-budget-epoch-kill.md`、`04-3-trust-reducer.md`、`06-3-disposition-coverage.md`。
> 状态：**Frozen** ｜ 执行：阶段 11 / W11 任务 11-2 ｜ 日期：2026-08-08

## 1. learning-agent 运行时核验（路径存在）

`workers/ai-worker/src/learning-agent/` 下各单元均落盘（runtime/session/budget/orchestrator/policies 以模块文件存在，gateway 位于 `tools/` 子目录，roles 为角色目录，与 03-w2 任务 03-1 落地形态一致）：

| 单元 | 路径 | 职责 | 对应任务 |
| --- | --- | --- | --- |
| runtime | `workers/ai-worker/src/learning-agent/runtime.ts` | 有界 Loop 运行时（role/tool/provider/budget 与 Generation 完全独立，LearningProviderAdapter 注入） | 03-1 |
| session | `workers/ai-worker/src/learning-agent/session.ts` | Session loop 状态机、typed actions、checkpoint、wait/resume/cancel | 03-2 |
| budget | `workers/ai-worker/src/learning-agent/budget.ts` | BudgetEnvelope（不可借用）、context/turn deadline/inactivity/pause TTL | 03-6 |
| orchestrator | `workers/ai-worker/src/learning-agent/orchestrator.ts`（+ `orchestrator.test.ts`） | 四阶段外壳编排 | 03-3 |
| gateway | `workers/ai-worker/src/learning-agent/tools/gateway.ts`（+ `gateway.test.ts`）、`tools/tool-manifest.ts` | actor 分离 tool allowlist、public DTO serializer、prompt-injection 边界 | 03-4 |
| policies | `workers/ai-worker/src/learning-agent/policies.ts`（+ `policies.test.ts`） | runtimeEpochSnapshot + episodeEpoch 政策、kill 语义 | 03-6 |
| roles | `workers/ai-worker/src/learning-agent/roles/`（session-supervisor、scene-author、rubric-scene-critic、assessment-critic、grounded-answer-critic、grounded-tutor） | specialist Agents 角色边界 | 03-1/03-4 |

## 2. 四阶段外壳（03-3，佐证 DoD 4、6、20）

- `orchestrator.ts` 显式实现 **PREPARE → SESSION_AGENT → INDEPENDENT_ASSESS → COMMIT** 外壳；`RUBRIC_AND_SCENE_PREPARE` 子流程（解析 RubricTarget → Scene Author 草案 → deterministic schema/safety → 独立 Rubric/Scene Critic → 确定性激活 immutable contracts）在首个 formal probe 展示前执行、不向用户展示。
- Agent Loop 硬边界落地：Session Supervisor turns ≤8、trusted 内容性 follow-up=0、Encounter 2~5、同时 active 会话每用户 1、单次 turn deadline ≤120s、inactivity 30min（只结束 active UI，不回滚已 commit Episode）、Pause TTL 恢复重查 stale（03-2/03-3）。
- Supervisor 产物全部为 `LearningStagingResult`（`canonicalWrite:false`，类型 + 注释双重保证）；Agent 只能请求 `requestedTrustClass`，不能签发 effective trust（佐证 DoD 20）。
- `session.ts` 的 `confirm_continue_session` 用户 checkpoint：只有用户确认才 PREPARE 下一 Episode，无倒计时默认选择（佐证 DoD 26 的编排侧，完整验收见 `w5` 证据）。

## 3. Trust / reducer（04-3，佐证 DoD 19、20）

- `apps/api/src/modules/learning-sessions/trust-service.ts`：`computeEffectiveTrustClass` 只从服务端事实推导（disclosure/attempts/assistance/stale/integrity），客户端与 Agent 均不能提交或覆盖 effective 值；`issueEpisodeTrustDecision` 服务端签发 `EpisodeTrustDecision`（episodeId/effectiveClass/sourceArtifactIds/frozenProbeSetHash/requiredRubricCoverageHash/bundlePolicyVersion/assistanceSnapshotHash/reasonCodes/decisionHash），decisionHash 排序幂等、可重建校验。
- `packages/shared/src/learning-trust-contracts.ts` 为 EpisodeTrustDecision/RubricAssessment/ReducerResult/RubricSessionResult 单一来源契约；`packages/shared/src/rubric-reducer.ts` 实现 `rubric-session-reducer-v2`（pass | partial | fail | not_assessable）与 `facet-to-mastery-policy-v1` 七条固定规则（assisted/stale 0 升级、0 延长 interval）。
- Silent bundle 整体 trust 由不可变 `EpisodeTrustDecision` 签发，不通过修改单 Artifact trust 升级（佐证 DoD 19）；完整 voice/artifact 管线证据见 `w3` 证据。

## 4. disposition 全覆盖（06-3，佐证 DoD 17、22、23、24）

- `apps/api/src/modules/learning-sessions/disposition.ts`（+ `disposition.test.ts`）实现 `EpisodeCommitDispositionV1` 全覆盖：`canonical_mastery`（create/consume 后恰好一个 active schedule）、`canonical_unable`（按冻结 unable policy 恰好一个 active schedule）、`canonical_facet_observation`（唯一 canonical facet fact + outbox，0 overall outcome/0 review attempt/0 schedule）、`practice_or_diagnostic`（0 canonical projection/0 schedule）、`operational_only`（not-assessable/provider failure/stale/cancel → retryable/terminal operational state，0 学习副作用）。
- Formal、Facet、Diagnostic、Practice、Not-assessable 在 disposition 矩阵中数据、视觉与副作用彻底分离（佐证 DoD 17）；create/consume 语义与 COMMIT 单事务 CAS 的验收见 `w5` 证据（06-2/06-4）。

## 5. 判定层证据

- 决策记录 `03-2`~`03-6`、`04-3`、`06-3` 头部状态均为 **Frozen（已冻结）**；阶段 03 退出 Gate 5 项全部勾选（越权写 0、无限 loop 不可达、生命周期完整、Global Shell 解耦、staging 0 canonical write）。
- 本阶段判定层测试全绿：`orchestrator.test.ts`、`policies.test.ts`、`tools/gateway.test.ts`、roles 下各 `*.test.ts` 均为判定层测试；四包最终基线全绿（apps/api 2942、packages/shared 374、packages/db 5、apps/web 755，见 `README.md`）。
- 各阶段 security_review 结论均为修复后 pass（详见 `release-manifest.json`）。
