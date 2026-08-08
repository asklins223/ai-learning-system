# 决策记录 10-4：5% workspace-stable canary（§18.2 第 3 步）

> 状态：**Frozen（已冻结）**
> 执行：阶段 10（W9）任务 10-4
> 日期：2026-08-08
> 来源：`10-w9-rollout-public-beta.md` 任务 10-4（§18.2 第 3 步）+ 冻结记录 01-7
> （§18.1 flag/bundle 依赖图）+ 08-4（metrics-schema：p95 成本 / soft error /
> hard incident 硬 Gate 口径）+ 09-2（门槛冻结与 fail closed 判定模式）
> 约束级别：**5% 档达到冻结 Gate（样本量、soak、hard incident=0、soft error
> budget、p95 成本）**；门槛为 W9 冻结常量，不允许运行时调低。

---

## 1. 交付物

- `apps/api/src/modules/companion-shell/canary-stage.ts`：canary 档位**纯逻辑**
  （无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）——档位模型（5%/25%）、
  workspace-stable 选择（确定性哈希 + 稳定性信号）、canary 内容清单、合批规则、
  Gate 达标判定（RolloutStageGateV1）、25% 档 hard-kill drill 证据校验。
- `apps/api/src/modules/companion-shell/canary-stage.test.ts`：单测
  （node:test + assert），32 例全绿。
- 本文件：决策记录。

## 2. 决策：档位模型与 workspace-stable 选择（§18.2 第 3 步）

- 两档递增：`pct-5`（5%）→ `pct-25`（25%）；`CANARY_TIER_ORDER` 冻结，
  「样本不足不能进入下一档」由 `canEscalateFrom5To25`（5% 档 verdict 必须
  passed 才能进入 25% 判定）落地。
- **workspace-stable**：分配单元是 workspace 而非用户——`workspaceStableScore`
  对 `workspaceId` 做确定性 FNV-1a 哈希（同一 workspace 恒同分值），分值
  < 0.05 候选 5% 档、< 0.25 候选 25% 档、≥ 0.25 不入档；同一 workspace 内
  所有用户体验一致。
- **稳定性信号**（`isWorkspaceStable`）：至少 1 活跃用户 + 3 个已 commit
  Session + 近期 hard incident=0 + soft error rate ≤ 0.2（有样本时才可判定）。
  候选入档但稳定性不达标 → 不入选（`selectWorkspaceForCanary` 合并语义）。

## 3. 决策：canary 内容清单（§18.2 第 3 步）

`CANARY_5PCT_CONTENTS` 冻结为 8 项（internal atomic core、voice、silent
bundle、learning-session companion、card/review 入口、star map v2 回写、
origin-aware completion、current-target Tutor）；25% 档内容与 5% 一致
（`CANARY_25PCT_CONTENTS` = 5% 副本，扩量不扩能力；Should flags 独立
shadow/canary，不属于本档内容）。

## 4. 决策：合批规则（§18.2 第 3 步「可合批/不可拆」）

- 七个**原子 bundle**（`ATOMIC_BUNDLES`，对应 01-7 §4 原子内容）不允许拆开
  上线：`credential_safe`（auth manifest + credential 页 allowlist）、
  `onboarding_zero_side_effect`（sample 隔离 + demo renderer + CAS 状态机）、
  `formal_practice`（formal probes + practice entries）、`dual_critic`
  （scene critic + assessment critic）、`commit`（existing-domain commit +
  outbox）、`scheduler_adapter`（official scheduler adapter）、`rls`。
- `checkAtomicBundleIntegrity`：proposed 与某 bundle 成员交集非空但未包含全部
  成员 → 判违规（拆开上线）；不在任何 bundle 成员内的相邻低风险 flag 可合批；
  空 proposed 合规（无操作）。

## 5. 决策：RolloutStageGateV1 达标判定（冻结门槛）

`FROZEN_CANARY_GATES` 冻结两档门槛（§18.2 概述「每档最低 Session/Episode、
用户、workspace 数，voice/silent/text 与 Provider/ASR 覆盖，最短 soak 时长，
hard incident=0、soft error budget、p95 成本预算和数据置信区间」+ 08-4/09-4
口径）：

| 门槛项 | pct-5 | pct-25 |
| --- | --- | --- |
| minSessions / minEpisodes | 300 / 400 | 1500 / 2000 |
| minUsers / minWorkspaces | 60 / 25 | 300 / 125 |
| minSoakDays | 3 | 7 |
| maxHardIncidents | **0** | **0** |
| softErrorBudget | 0.05 | 0.02 |
| minCoverage（voice/silent/text/provider/asr） | 0.8 | 0.9 |
| p95CostCaps（llmCalls/input/output/asr/tts/storage/tutor） | 40 / 20k / 8k / 300s / 4k / 10MB / 50 | 同左（成本上限不随档位放宽） |
| requireConfidenceInterval / minConfidenceLowerBound | true / 0.8 | true / 0.9 |
| requireHardKillDrill | false | **true** |

判定函数 `evaluateCanaryGate(tier, input, thresholds?)` 逐项检查：samples /
soak / hard_incidents / soft_error_budget / coverage / p95_cost /
confidence_interval / hard_kill_drill；任一不通过 `passed=false`。p95 成本
复用 `metrics-schema` 的 `checkP95CostCap` / `computeUserCostPercentile`
（R7 线性插值，无随机）。**25% 档强制** hard-kill drill 完成证据
（completed=true 且 evidenceRef 非空），5% 档不要求。

## 6. 决策：门槛冻结（fail closed）

`assertGateThresholdsFrozen` 拒绝任何低于冻结值的注入（样本量/soak/soft
error budget/覆盖/CI 下界不可调低，hard incident 上限不可抬高，25% 档
requireHardKillDrill 不可改 false），违规抛 `CanaryStageError`；与 09-2
release qualification 的冻结阈值模式一致。

## 7. 验收映射

- [x] 档位模型：5%/25%、顺序、百分比、类型守卫；
- [x] workspace-stable：确定性哈希、候选档位子集关系（5% ⊆ 25%）、稳定性信号；
- [x] canary 内容清单：5% 档含 §18.2 第 3 步全部 8 项；25% 与 5% 一致；
- [x] 合批规则：低风险可合批；七个原子 bundle 任一拆开即违规；整组合规；
- [x] Gate 判定：样本量/soak/hard incident=0/soft error budget/覆盖/p95 成本/
      置信区间全部检查；5% 档达标样本全过、各违规样本分别拒绝；
- [x] 25% 档强制 hard-kill drill 证据（缺失/未完成拒绝），5% 档不要求；
- [x] 门槛冻结：注入低于冻结值抛 `CanaryStageError`；
- [x] 5% 档达标后才可进入 25% 档判定；
- [x] 纯函数可测：数据源注入，无 IO；
- [x] 本文件（10-4 决策记录）与 `10-6-canary-25pct.md`（25% 档）分开记录。

## 8. 验证记录

```text
$ cd apps/api && node --import tsx --test src/modules/companion-shell/canary-stage.test.ts
# tests 32 / suites 8 / pass 32 / fail 0

$ npm run typecheck --prefix apps/api
# canary-stage.ts / canary-stage.test.ts 0 错误
#（注：并行任务 10-5 的 rollback-drill.test.ts 类型错误不属本任务文件）
```

## 9. 后续衔接

- 5% 档 Gate 达标是 10-6（25% canary）的前置（`canEscalateFrom5To25`）；
- hard-kill rollback drill（任务 10-5）完成证据是 25% 档 `hardKillDrill`
  输入的来源；drill 证据引用指向任务 10-5 的 drill 记录；
- 真实样本/soak/成本数据由上层采集管线注入，本模块只做确定性判定。
