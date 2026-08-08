# W9 证据：shadow / canary / 公测默认发布

> 对应任务 11-2 证据文件 11。佐证 DoD 34、36。
> 决策记录：`docs/plans/learning-companion/10-1-capability-deployment.md` ~ `10-8-public-beta-default.md`。

## 1. 交付文件核验（路径存在 + 测试全绿）

| 文件 | 对应记录 | 职责 | 测试 |
| --- | --- | --- | --- |
| `apps/api/src/modules/companion-shell/capability-deployment.ts` + `.test.ts` | 10-1 | capability bundle 契约（`packages/shared/src/capability-bundle.ts`）、非法组合 fail startup、required closure + runtime epoch 验证、root off 反向依赖闭包单 revision 原子发布 | `capability-deployment.test.ts` 30 例全绿（含 security_review MEDIUM 修复追加的异常回滚与交叉对账 2 例） |
| `apps/api/src/modules/companion-shell/shadow-mode.ts` + `.test.ts` | 10-2 | replay/shadow：0 canonical 写、UI 全关、RolloutStageGateV1 shadow 档判定 | `npm test --prefix apps/api` 全量通过 |
| `apps/api/src/modules/companion-shell/internal-allowlist.ts` + `.test.ts` | 10-3 | internal allowlist 四项启用、learning Agent 关闭、0 学习写入、全流程可用 | 同上 |
| `apps/api/src/modules/companion-shell/canary-stage.ts` + `.test.ts` | 10-4 / 10-6 | 5%/25% 两档 workspace-stable canary、合批规则、RolloutStageGateV1 达标判定、25% 档 hard-kill drill 证据 | `canary-stage.test.ts` 32 例全绿 |
| `apps/api/src/modules/companion-shell/rollback-drill.ts` + `.test.ts` | 10-5 | 三类回滚演练（soft drain / hard kill / legacy reader matrix） | `rollback-drill.test.ts` 49 例全绿（详见 `rollback-drill.md`） |
| `apps/api/src/modules/companion-shell/final-soak.ts` + `.test.ts` | 10-7 | `RolloutStageGateV1` 冻结门槛表（5 档）、成本观察窗（p50/p95、重试放大、hidden/off 0 成本）、最终 soak 判定 | `final-soak.test.ts` 22 例全绿 |
| `apps/api/src/modules/companion-shell/public-beta-default.ts` + `.test.ts` | 10-8 | 公测默认序列：Gate → Must 默认 → 旧入口退休 → Should 独立；hard invariant 违规即停止扩量 + 原子回滚 | `public-beta-default.test.ts` 25 例全绿 |

## 2. capability 部署（10-1，佐证 DoD 34）

- **18 个 capability 冻结**：9 个 Must flag + 3 个 Should flag + 6 个内部原子能力（scene/critic/commit/map/projection/grounded_answer_critic，非 rollout flag）。
- **非法组合 fail startup**：onboarding 开而 global shell 关、Session Companion 开而 trusted core 关、Scene 开而 Critic/commit 关、map 开而 projection 关、Tutor 开而 Grounded Answer Critic 关、原子包含不可拆分（bundle 开而原子子能力关）——启动时解析 bundle graph 校验，`failStartupIfIllegal` 抛错（fail startup 只是最后防御，不是 rollout 或事故回滚机制）。
- **required capability closure + runtime epoch 验证**：每次外部 tool/Provider 调用及结果落库前 `verifyCapabilityAccess`；关闭相关 flag 后，在途 Agent 的 contract snapshot（revision + epoch + requiredCapabilities）重新验证必然失败，不能继续该能力调用和成本。
- **root off 反向依赖闭包 + 单 config revision 原子发布**：冻结闭包 `global_companion_shell off → companion_onboarding_v1 → learning_session_companion → current_target_tutor`；`trusted_multimodal_core off → learning_session_companion → multimodal_voice → structured_proof_v1 → journey_routes → understanding_universe_v2 → current_target_tutor`。`atomicOffClosure(target)` = target + Must 反向闭包 + 原子子能力 + 依赖被关能力的 Should flags；同一 revision 同时更新 capability API / Provider-tool fence / 前台状态（三个发布目标 adapter），任一节点无法应用 → 整次配置变更回滚（已应用节点逐个 rollback，返回原配置、原 revision）。
- **运行中从不暴露非法 flag 组合**：非法配置拒绝生成 API 视图；关闭 root 后的配置始终通过 `validateConfigLegal`。**佐证 DoD 34 的「root off 以同一 config revision 原子关闭反向依赖闭包，运行中 0 非法组合」**。

## 3. shadow 模式（10-2，佐证 DoD 36）

- shadow 阶段只做数据/contract 与事件投影，**不写 canonical**：`buildShadowPlan` 按 eventId 去重保序生成确定性计划步骤（无写指令）；`ShadowComparison.canonicalWrites` 类型层面为只读空元组（`readonly []`）；`assertShadowZeroCanonicalWrites` fail closed（任何携带 validation/review/understanding 事件、schedule、mastery、outbox 写指令的 shadow 输出判违规）。
- **UI 全关**：`SHADOW_UI_VISIBILITY` 恒 `"all_off"`；`assertShadowUiAllOff` 对任何 UI 展示指令 fail closed。
- **对比数据达到 Gate 门槛**：`evaluateShadowGate` 引用 `ROLLOUT_STAGE_GATES.shadow`（RolloutStageGateV1：最低 Episode 500 / 用户 50 / workspace 20、soak 24h、voice/silent/text 与 Provider/ASR 覆盖、hard incident=0、soft error budget、p95 成本预算、置信区间）；样本不足不能进入下一档。

## 4. internal allowlist（10-3，佐证 DoD 36）

- 启用四项**非学习** companion shell 能力：`global_companion_shell`（credential-safe auth manifest + 全路由 coverage registry + 角色/锚点/侧板 + trigger 双预算 + 控制状态）、`auth_manifest`（02-5 签名静态公开文案，零采集）、`onboarding`（CAS 状态机 + 隔离 `onboarding_sample:*` + 静态 demo map）、`static_fallback`；均不发起 Provider/ASR/TTS。
- **learning Agent 保持关闭（fail closed）**：`LEARNING_AGENT_FLAG_IDS` 引用 rollback-drill 的 Must flag 列表 7 项，任一 enabled 或未声明（unknown）→ `assertLearningAgentDisabled` 失败；`assertZeroLearningWrites`：validation/review/understanding 事件、schedule、mastery、outbox、episode_commit 7 类学习写入必须为空。
- **internal 用户全流程可用**（5 步骤：auth manifest / global shell / onboarding / static fallback / 手动主路径），任一步骤不可用或未认证 → 不可用；组合判定全部通过才 `allowed=true`。

## 5. canary 5% / 25%（10-4 / 10-6，佐证 DoD 36）

- **档位模型**：`pct-5`（5%）→ `pct-25`（25%），`CANARY_TIER_ORDER` 冻结；`canEscalateFrom5To25` 保证 5% 档 verdict passed 才能进入 25% 档判定。
- **workspace-stable 选择**：对 `workspaceId` 做确定性 FNV-1a 哈希（同一 workspace 恒同分值），分值 <0.05 候选 5% 档、<0.25 候选 25% 档；稳定性信号 = 至少 1 活跃用户 + 3 个已 commit Session + 近期 hard incident=0 + soft error rate ≤0.2。
- **canary 内容清单冻结 8 项**（internal atomic core、voice、silent bundle、learning-session companion、card/review 入口、star map v2 回写、origin-aware completion、current-target Tutor）；25% 档内容与 5% 一致（扩量不扩能力）。
- **合批规则**：七个原子 bundle（credential_safe / onboarding_zero_side_effect / formal_practice / dual_critic / commit / scheduler_adapter / rls）不允许拆开上线（`checkAtomicBundleIntegrity` 任一拆开判违规）。
- **RolloutStageGateV1 达标判定（冻结门槛，不允许运行时调低）**：

| 门槛项 | pct-5 | pct-25 |
| --- | --- | --- |
| minSessions / minEpisodes | 300 / 400 | 1500 / 2000 |
| minUsers / minWorkspaces | 60 / 25 | 300 / 125 |
| minSoakDays | 3 | 7 |
| maxHardIncidents | 0 | 0 |
| softErrorBudget | 0.05 | 0.02 |
| minCoverage（voice/silent/text/provider/asr） | 0.8 | 0.9 |
| p95CostCaps | 40 / 20k / 8k / 300s / 4k / 10MB / 50 | 同左（成本上限不随档位放宽） |
| requireConfidenceInterval / minConfidenceLowerBound | true / 0.8 | true / 0.9 |
| requireHardKillDrill | false | **true** |

- **25% 档强制 hard-kill drill 完成证据**：`hardKillDrill.completed === true` 且 `evidenceRef` 非空（引用任务 10-5 drill 记录）；缺失或未完成 → 25% 档 Gate 拒绝；`assertGateThresholdsFrozen` 拒绝任何低于冻结值的注入（违规抛 `CanaryStageError`）。

## 6. 最终 soak 与成本观察窗（10-7，佐证 DoD 36）

- **RolloutStageGateV1 冻结门槛表（5 档）**：shadow（500 Episode / 50 用户 / 20 workspace / 24h）、internal（2,000 / 200 / 80 / 48h）、canary_5pct（10,000 / 1,000 / 400 / 72h）、canary_25pct（50,000 / 5,000 / 2,000 / 120h）、public_beta_default（150,000 / 15,000 / 6,000 / **168h**）；hard incident 恒 0；p95 成本预算全档位统一封顶（`ROLLOUT_P95_COST_CAP`：llmCalls=60 / inputTokens=600k / outputTokens=300k / asrSeconds=1800 / ttsCharacters=100k / objectStorageBytes=500MB / tutorBudgetUnits=20）。
- **成本观察窗**（复用 08-4 metrics-schema 冻结语义，单一成本口径）：用户级 p50/p95（R7 线性插值）、重试放大系数 ≤1.5、hidden/off 后新增成本 0（`hidden_off` 语义同时覆盖 `cancel_confirmed`）——p95 上限、重试放大上限、hidden/off 零成本为硬 Gate，违规立即停止扩量。
- **最终 soak 判定**（`evaluateFinalSoak`，public-beta-default 档）：soak ≥168h、样本量与覆盖达标、**hard incident=0**、soft 错误在预算内、成本曲线全部在冻结预算内 → `noHardIncident` 与 `costWithinBudget` 组合通过；`assertFinalSoakPassed` 0 容忍 fail closed。
- 数据置信区间逐档收紧（public_beta_default：α=0.05、margin≤0.05、n≥1000）。

## 7. 公测默认与旧入口退休（10-8，佐证 DoD 34、36）

- **Gate 通过后才设正式公测默认**：`evaluatePublicBetaGate` 引用 `public_beta_default` 档判定最终 soak（委托 `evaluateFinalSoak`），未达标不发布默认。
- **Must capability bundle 成为正式公测默认**：`applyPublicBetaDefaults` 单 config revision 把 9 个 Must flags 全部置 enabled；Should flags 保持原独立状态；发布前 `validateConfigLegal` 校验合法性（非法组合不发布）。
- **旧文本主入口退休默认地位**：默认入口从 `legacy_text_first` 切换为 `companion_guided`；旧入口**保留可访问**（`legacyEntryAvailable` 保持 true），不隐式删除或替换旧能力——避免破坏既有 question-first 验证与 Review Queue（见 10-5 回落语义）；幂等（已是 companion_guided 不重复操作）。
- **Should flags 独立**：问题标记 / workspace Tutor / semantic relationships 在主列车外单独 shadow/canary，保持独立 flag 状态，**不阻塞第 8 步**（不属于本项 DoD）。
- **hard invariant 单次违规立即停止扩量并回滚相关 flag**：违规类别 → 回滚目标映射（privacy → `trusted_multimodal_core` + `understanding_universe_v2`；answer_leak → core + `current_target_tutor` + `structured_proof_v1`；critic → tutor + proof；schedule_invariant → `journey_routes` + proof 等）；`stopScaling` 字面量 true；回滚经 rollback-drill 单 revision 原子关闭（相关 flag 及其反向依赖闭包一次性回滚）；公测默认序列中任一违规注入 → 序列不通过。

## 8. 判定层证据

- 全部为纯函数判定层交付（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机），数据源/场景端口注入；真实样本（shadow 对比数据、internal 旅程、canary 档位观察、soak 期成本曲线）由接线采集管线注入后复核，样本不足不能进入下一档——「判定层已交付；真实运行样本待 RC 执行环境采集后回填」状态在 `release-manifest.json` 如实标注。
- 验证记录：`npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）；测试计数见 §1 表（capability-deployment 30 / canary-stage 32 / rollback-drill 49 / final-soak 22 / public-beta-default 25 全部全绿）。
- 决策记录 10-1 ~ 10-8 状态均为 Frozen（已冻结）。
