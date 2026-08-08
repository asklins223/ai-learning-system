# 决策记录 09-2：最终 release qualification（冻结 RC Gold 两轮）（§16.2）

> 状态：**Frozen（已冻结）**
> 执行：阶段 09（W8）任务 09-2
> 日期：2026-08-08
> 来源：`09-w8-quality-capacity-rc.md` 任务 09-2（原方案 §15 W8 bullet + §16.2）+ 冻结记录 01-5 §3（§16.2）+ 05-6（W0 阈值不可降、模态间同 facet）
> 约束级别：**两轮 qualification 全部达标；任何变更（模型/prompt/profile/阈值）从第一轮重跑。** W0 冻结阈值不得降低；本记录为最终 release gate，样本不足不视为达标。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/release-qualification.ts`：最终 release qualification 纯逻辑（数据源注入、无 IO）。
- `apps/api/src/modules/learning-sessions/release-qualification.test.ts`：单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 W0 冻结阈值（01-5 §3 §16.2，作为代码常量单一来源）

`W0_FROZEN_THRESHOLDS`：

| 指标 | 冻结值 |
| --- | --- |
| `minDoubleLabelAgreement`（相同 facet 人工双标一致性） | 0.80 |
| `minCriticUpgradePrecision`（Critic upgrade precision） | 0.95 |
| `minCriticUpgradeRecall`（Critic upgrade recall） | 0.90 |
| `minSamplePerLayer`（分层最小可判样本量） | 3 |

- 注入的阈值低于任一冻结值 → `ReleaseQualificationError`（禁止调低）；
- `meta.thresholdAdjustmentAllowed` 恒为 `false`；`meta.isReleaseQualification` 恒为 `true`。

### 2.2 冻结 RC Gold 两轮（W4 从未见过）与严格口径

- `w4UnseenFrozenRcSet` 必须为 `true`（W4 未见声明）；为 `false` 拒绝生成；
- 两轮 `round=1/2` 各自按**严格口径**判定：每项阈值对比必须 `passed===true`（含样本量充足）；`passed=null`（样本不足）同样视为未达标——release 是最终 gate，与开发轮「null 不判定」的监控语义不同；
- 固定对抗集答案泄漏必须为 0（复用 gold-rounds 的 `checkAdversarialLeak`）。

### 2.3 变更从第一轮重跑

- 配置快照 `RerunConfigSnapshot`：模型 / prompt / profile registry / 阈值版本；
- 任一变更后必须从第一轮重跑，因此重跑后的两轮必须使用同一配置：两轮配置不一致即 `config_changed_between_rounds` 违规（fail closed）；
- `rerunFromFirstRoundPerformed` 作为声明记入 meta。

### 2.4 silent mastery bundle 一致性（人工 / voice 路径 + 置信区间）

- 人工一致性：silent_bundle 可判定样本中 `systemVerdict` 与 **gold 共识**（人工双标达成一致后的共识）一致的比例；
- voice 路径一致性：按 `itemId` 配对同一被评估项的 voice 与 silent 可判定样本，比较两路径系统判定是否一致；
- 双标规则：只统计有 gold 共识的样本；无共识样本不进入一致性统计；
- 最小样本量 `minSilentBundleSamples`、阈值 `minSilentHumanAgreement` / `minSilentVoiceAgreement` 注入（W0 冻结）；
- 置信区间：**Wilson score 区间**（`normalQuantile` 为 Acklam 近似，精度 ~1e-9）；`requireCILowerBoundAboveThreshold=true` 时要求区间下界 ≥ 对应一致性阈值。

### 2.5 缺 eligible profile 为 0 与 family 覆盖率

- 被路由到 silent mastery 但缺少 eligible `SilentProofProfile`：必须为 0，否则 `missing_eligible_profile` 失败；
- 整体覆盖率 = eligible 被路由目标 / 全部目标 ≥ `minOverallSilentMasteryCoverage`；
- 各内容 family（procedure / causal-boundary / concept-application）覆盖率 ≥ `minCoveragePerFamily` 且样本量 ≥ `minSamplesPerFamily`（不足则该 family 未覆盖）。

### 2.6 模态间只比较相同 facet

- 跨模态表复用 `compareVoiceToSilent`：仅按 `(rubricId, facet)` 配对 voice 与 silent_bundle 层，任一侧缺失 `comparable=false`；
- 不要求单个排序 Scene 与开放讲解提供相同信息量（01-5 §9 补全说明）。

## 3. 决策点

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| release 判定口径 | 每项阈值对比 `passed===true`（样本不足也失败） | 最终 gate 必须确凿达标，杜绝「样本不足伪通过」（§16.1 无 placeholder/skip/insufficient-data 伪通过） |
| 阈值处理 | 冻结常量 + 注入低于冻结值即抛错 + `thresholdAdjustmentAllowed=false` | 01-5 §3「W0 冻结、RC 后不得降低」 |
| 变更重跑 | 两轮配置一致才合规（不一致 → 违规） | 「任一变更从第一轮重跑」的可验证执行方式 |
| 正类定义 | Critic precision/recall 以 upgrade 为正类 | 与 05-6 / 01-5 §3 对齐 |
| silent 一致性 | 基于 gold 共识（双标规则）+ Wilson 区间 | 01-5 §3「一致性阈值、最小样本量、双标规则和置信区间 W0 冻结复核」 |
| 覆盖与缺 profile | missingEligibleProfile 必须 0；整体与 family 覆盖率门槛 | 01-5 §3 |
| 模态间 | 只比较相同 facet | 01-5 §9 补全 |

## 4. 验收映射

- [x] 使用 W4 从未见过的冻结 RC Gold 两轮最终 release qualification（`w4UnseenFrozenRcSet=true`，两轮严格口径全过 → `verdict.passed`）；
- [x] 模型/prompt/profile/阈值任一变更从第一轮重跑（两轮配置不一致 → 违规失败，单测逐字段断言）；
- [x] 相同 facet 人工双标一致性和 Critic precision/recall 阈值（W0 冻结）复核：低于冻结值注入被拒、`thresholdAdjustmentAllowed=false`；
- [x] silent mastery bundle 与人工判断、voice 路径的一致性阈值、最小样本量、双标规则和 Wilson 置信区间复核（单测覆盖达标/样本不足/低一致性/路径不一致/CI 下界）；
- [x] 被路由到 silent mastery 但缺少 eligible `SilentProofProfile` 为 0；整体与各内容 family 覆盖率达到 W0 冻结门槛（单测覆盖缺 profile、family 样本不足、family 覆盖率低）；
- [x] 模态间只比较相同 facet（`crossModality` 仅按 `(rubricId, facet)` 配对）；
- [x] 纯函数可测：数据源注入，无 IO；
- [x] `npm run typecheck --prefix apps/api` 通过；新增测试在 `npm test --prefix apps/api` 全量中通过。

## 5. 后续衔接

- 本任务关闭 W8 退出 Gate 的「冻结 RC Gold 两轮最终 release qualification」条目；
- 真实 RC 数据采集由上层调用方接入（本模块不实现采集管线）；任一配置变更后重新执行本模块从第一轮重跑。
