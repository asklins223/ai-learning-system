# 决策记录 10-6：25% workspace-stable canary（§18.2 第 5 步）

> 状态：**Frozen（已冻结）**
> 执行：阶段 10（W9）任务 10-6
> 日期：2026-08-08
> 来源：`10-w9-rollout-public-beta.md` 任务 10-6（§18.2 第 5 步）+ 任务 10-4
> （`10-4-canary-5pct.md`，5% 档 Gate）+ 任务 10-5（hard-kill rollback drill，
> §18.3）+ 冻结记录 01-7（§18.1 flag/bundle 依赖图）+ 08-4（metrics-schema）
> 约束级别：**25% 档达到冻结 Gate（样本量、soak、hard incident=0、soft error
> budget、p95 成本，含 hard-kill drill 已完成的证据）**；门槛为 W9 冻结常量。

---

## 1. 交付物

- `apps/api/src/modules/companion-shell/canary-stage.ts`：25% 档判定复用
  `evaluateCanaryGate("pct-25", input)`，强制 `requireHardKillDrill=true`；
  `canEscalateFrom5To25` 保证只有 5% 档 Gate 达标后才进入 25% 档判定。
- `apps/api/src/modules/companion-shell/canary-stage.test.ts`：25% 档单测
  （达标样本、缺 drill / drill 未完成拒绝、样本量按档位门槛递增、门槛冻结）。
- 本文件：决策记录。

## 2. 决策：25% 档按冻结 Gate 验证（§18.2 第 5 步）

25% 档是 5% 档的扩量档（内容一致、门槛更严），必须满足 `FROZEN_CANARY_GATES
["pct-25"]`：

| 门槛项 | 冻结值 |
| --- | --- |
| minSessions / minEpisodes | 1500 / 2000 |
| minUsers / minWorkspaces | 300 / 125 |
| minSoakDays | 7 |
| maxHardIncidents | **0** |
| softErrorBudget | 0.02 |
| minCoverage（voice/silent/text/provider/asr） | 0.9 |
| p95CostCaps | 与 5% 档一致（成本上限不随档位放宽） |
| requireConfidenceInterval / minConfidenceLowerBound | true / 0.9 |
| requireHardKillDrill | **true** |

判定检查项与 5% 档相同（samples / soak / hard_incidents / soft_error_budget /
coverage / p95_cost / confidence_interval / hard_kill_drill），且：
- **hard-kill drill 已完成**：`hardKillDrill.completed === true` 且
  `evidenceRef` 非空（引用任务 10-5 的 §18.3 hard-kill rollback drill 记录）；
  缺失或未完成 → 25% 档 Gate 拒绝；
- 25% 档只判定自身 Gate；进入 25% 档的前置是 5% 档 verdict passed
  （`canEscalateFrom5To25`，10-4 决策记录 §7 落地）。

## 3. 决策：5% 档 → 25% 档升级约束

- `canEscalateFrom5To25(fivePctVerdict)`：仅当 verdict.tier === "pct-5" 且
  passed === true 才返回 true；否则拒绝升级（样本不足不能进入下一档，§18.2）。
- 25% 档内容与 5% 一致（`CANARY_25PCT_CONTENTS = CANARY_5PCT_CONTENTS`），
  扩量不扩能力；Should flags 保持独立 shadow/canary，不属于本档。

## 4. 决策：门槛冻结与 evidence 契约

- `assertGateThresholdsFrozen("pct-25", …)` 拒绝：样本量/soak/soft error
  budget/覆盖/CI 下界低于冻结值、hard incident 上限高于 0、
  `requireHardKillDrill` 被改为 false——25% 档必须携带 drill 证据，不允许
  拆掉该要求扩量（违规抛 `CanaryStageError`，fail closed）。
- drill evidenceRef 必须为非空字符串（引用 drill 记录锚点），防止空声明
  冒充证据；真实 drill 执行留档属于任务 10-5 交付物，本模块只校验证据契约。

## 5. 验收映射

- [x] 25% 档达标样本（含 hard-kill drill 证据）全项通过；
- [x] 25% 档缺 hard-kill drill 证据 / completed=false 拒绝；
- [x] 25% 档样本量按档位门槛递增（5% 达标样本不足 25% 门槛 → 拒绝）；
- [x] 门槛冻结：hard incident 上限不可抬高、requireHardKillDrill 不可改 false；
- [x] 5% 档达标后才可进入 25% 档判定（`canEscalateFrom5To25`）；
- [x] 纯函数可测：数据源注入，无 IO；
- [x] 本文件（10-6 决策记录）与 `10-4-canary-5pct.md`（5% 档）分开记录。

## 6. 验证记录

```text
$ cd apps/api && node --import tsx --test src/modules/companion-shell/canary-stage.test.ts
# tests 32 / suites 8 / pass 32 / fail 0（含 25% 档全部用例）

$ npm run typecheck --prefix apps/api
# canary-stage.ts / canary-stage.test.ts 0 错误
#（注：并行任务 10-5 的 rollback-drill.test.ts 类型错误不属本任务文件）
```

## 7. 后续衔接

- 25% 档 Gate 达标后进入任务 10-7（最终 soak 与成本观察窗）与 10-8（公测
  默认与旧入口退休）；
- 25% 档 hard-kill drill 证据来自任务 10-5 的 drill 记录；
- 真实样本/soak/成本数据由上层采集管线注入，本模块只做确定性判定。
