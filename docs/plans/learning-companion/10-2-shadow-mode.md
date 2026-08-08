# 决策记录 10-2：replay / shadow（§18.2 第 1 步）

> 状态：**Frozen（已冻结）**
> 执行：阶段 10（W9）任务 10-2
> 日期：2026-08-08
> 来源：`10-w9-rollout-public-beta.md` 任务 10-2（原方案 §18.2 第 1 步）+ 冻结记录 01-7（RolloutStageGateV1 / capability bundle 依赖图）+ 10-w9 前置「RolloutStageGateV1 门槛（§18.2）」
> 约束级别：**shadow 输出 0 canonical 写；对比数据达到 Gate 门槛。**

---

## 1. 交付物

- `apps/api/src/modules/companion-shell/shadow-mode.ts`：replay/shadow 纯逻辑（数据源注入、无 IO）。
- `apps/api/src/modules/companion-shell/shadow-mode.test.ts`：单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 只生成计划和 assessment 对比，不写 canonical（§18.2 第 1 步）

- shadow 阶段**只做数据/contract 与事件投影**，UI 全关；shadow route/assessment **只生成计划与对比，不写 canonical**；
- `buildShadowPlan` 从事件投影流（replay 输入）生成确定性计划步骤（按 eventId 去重、保序），产出物不含任何写指令；
- `buildShadowComparison` 把 canonical 与 shadow 的计划/assessment 逐项配对生成对比（agree / agreementRate）；
- `ShadowComparison` 的 `canonicalWrites` 字段**类型层面为只读空元组**（`readonly []`），运行时不可写；
- 0 canonical 写强断言 `assertShadowZeroCanonicalWrites`（fail closed）：任何携带 canonical 写指令（validation/review/understanding 事件、schedule、mastery、outbox）的 shadow 输出判违规。

### 2.2 UI 全关

- `SHADOW_UI_VISIBILITY` 恒为 `"all_off"`（UI 全关）；`assertShadowUiAllOff` 对任何非 `all_off` 可见性或任何 UI 展示指令（render_plan / render_comparison / show_suggestion）fail closed。

### 2.3 对比数据达到 Gate 门槛（引用 RolloutStageGateV1）

- 复用 `./final-soak.ts` 的 `ROLLOUT_STAGE_GATES.shadow`（RolloutStageGateV1 冻结档位表，W0 冻结口径：最低 Episode/用户/workspace 数、voice/silent/text 与 Provider/ASR 覆盖、最短 soak 时长、hard incident=0、soft error budget、p95 成本预算、数据置信区间）；
- `evaluateShadowGate` 逐项判定：样本量（episodes/users/workspaces）、soak、模态覆盖、Provider/ASR 覆盖、hard incident=0、soft budget、置信区间（alpha / margin / 样本数）——任一不满足即 fail closed，**样本不足不能进入下一档**；
- 组合判定 `evaluateShadowMode`：Gate 达标 **且** 0 canonical 写 **且** UI 全关才通过（任务 10-2 验收的纯逻辑组合）。

## 3. 决策点

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| shadow 是否写 canonical | 恒不写（类型空元组 + 运行时断言双保险） | §18.2 第 1 步「shadow 只生成计划与对比，不写 canonical」；验收「0 canonical 写」 |
| UI 状态 | 恒 all_off，任何 UI 指令 fail closed | §18.2 第 1 步「数据/contract 与事件投影，UI 全关」 |
| Gate 门槛来源 | 引用 final-soak `ROLLOUT_STAGE_GATES.shadow`（单一冻结来源） | 10-w9 前置「W0 冻结定量 RolloutStageGateV1」，避免多处定义漂移 |
| 判定口径 | 严格口径：任一检查不满足即 fail（样本不足不视为通过） | 09-2 release 严格口径一致；§18.2「样本不足不能进入下一档」 |
| 纯函数 | 数据源注入、无 DB/网络/时钟/副作用/随机 | 与 companion-shell 既有模块（canary-stage/final-soak）一致 |

## 4. 验收映射

- [x] shadow 输出 0 canonical 写（类型空元组 + `assertShadowZeroCanonicalWrites` fail closed；单测覆盖空通过 / 含写违规）；
- [x] UI 全关（`SHADOW_UI_VISIBILITY=all_off`；`assertShadowUiAllOff` 拒绝非 all_off 与 UI 指令）；
- [x] 只生成计划与对比（`buildShadowPlan` / `buildShadowComparison` 单测覆盖去重保序、配对、rate）；
- [x] 对比数据达到 Gate 门槛（`evaluateShadowGate` 引用 RolloutStageGateV1 shadow 档；单测覆盖达标与样本不足/soak/覆盖/hard incident/soft budget/置信区间各拒绝分支）；
- [x] 纯函数可测：数据源注入，无 IO；
- [x] `npm run typecheck --prefix apps/api` 通过；新增测试在 `npm test --prefix apps/api` 全量中通过。

## 5. 后续衔接

- 本任务关闭 W9 阶段退出 Gate 的「replay/shadow 达到冻结 RolloutStageGateV1」条目；
- 真实 shadow 对比数据采集由上层调用方接入（本模块不实现采集管线）；后续 10-4/10-6 canary 档复用 final-soak `RolloutStageGateV1` 统一判定。
