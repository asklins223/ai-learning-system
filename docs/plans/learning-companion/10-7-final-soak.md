# 决策记录 10-7：最终 soak 与成本观察窗（§18.2 第 6 步 + §16.6）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen（已冻结） |
| **执行** | 阶段 10（W9）任务 10-7：最终 soak 与成本观察窗 |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/10-w9-rollout-public-beta.md` 任务 10-7（§18.2 第 6 步 + §16.6）；冻结记录 01-5（§16.6 成本与调用放大 Gate）、08-4（metrics-schema 成本监控） |
| **约束级别** | **soak 期无 hard incident**；**成本曲线在冻结预算内**（p50/p95、重试放大系数、hidden/off 后新增成本为 0） |

---

## 1. 交付物

- `apps/api/src/modules/companion-shell/final-soak.ts` —— 最终 soak 与成本观察窗
  **纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：
  - `RolloutStageGateV1` 类型 + `ROLLOUT_STAGE_GATES` 冻结门槛表（§18.2 前置：
    每档最低 Episode / 用户 / workspace 数、voice/silent/text 与 Provider/ASR
    覆盖、最短 soak 时长、hard incident=0、soft error budget、p95 成本预算、
    数据置信区间；档位：shadow / internal / canary_5pct / canary_25pct /
    public_beta_default）；
  - `validateRolloutStageGates`：Gate 表确定性自检（stage 合法、数值非负、
    hardIncidents 恒 0、p95 预算覆盖全部成本维度）；
  - `computeCostObservation`：成本与调用放大观察窗（用户级 p50/p95、重试放大
    系数、hidden/off 后新增成本 0）——**复用** 08-4 metrics-schema 冻结语义，
    不重复定义成本口径；
  - `evaluateRolloutGateV1`：单档 Gate 判定（确定性、fail closed）；
  - `evaluateFinalSoak`：最终 soak（public-beta-default 档）——soak 时长达标、
    **hard incident=0**、**成本曲线全部在冻结预算内**（p95 各维度、重试放大
    ≤ 1.5、hidden/off 后成本 0），组合输出 `noHardIncident` 与
    `costWithinBudget`；
  - `assertFinalSoakPassed`：0 容忍 fail closed（供阶段 11 收尾 Gate 消费）。
- `apps/api/src/modules/companion-shell/final-soak.test.ts` —— 单测 22 例。
- 本文件：决策记录。

## 2. 决策：RolloutStageGateV1 冻结定量门槛

W0 冻结的定量 `RolloutStageGateV1` 由本任务落地为可判定的常量表（数值为冻结
常量，**只能改常量、不能改判定逻辑**；接线 harness 注入观察记录后由
`evaluateRolloutGateV1` 判定）：

| 档位 | min Episodes | min Users | min Workspaces | min Soak(h) | hard incident | p95 成本 |
| --- | --- | --- | --- | --- | --- | --- |
| shadow | 500 | 50 | 20 | 24 | 0 | `ROLLOUT_P95_COST_CAP` |
| internal | 2 000 | 200 | 80 | 48 | 0 | 同上 |
| canary_5pct | 10 000 | 1 000 | 400 | 72 | 0 | 同上 |
| canary_25pct | 50 000 | 5 000 | 2 000 | 120 | 0 | 同上 |
| public_beta_default | 150 000 | 15 000 | 6 000 | 168 | 0 | 同上 |

- **p95 成本预算**（§16.6 冻结上限，全档位统一封顶，扩量不放松成本）：
  `llmCalls=60 / inputTokens=600k / outputTokens=300k / asrSeconds=1800 /
  ttsCharacters=100k / objectStorageBytes=500MB / tutorBudgetUnits=20`；
- **重试放大系数**上限默认 `1.5`（W0 冻结，复用 metrics-schema
  `DEFAULT_RETRY_AMPLIFICATION_CAP`）；
- **数据置信区间**：显著性水平 α、误差边界与最小评估样本数逐档收紧
  （public_beta_default：α=0.05、margin≤0.05、n≥1000）；
- 每档必须产出**引用该 Gate 的证据**，样本不足不能进入下一档；hard incident
  单次违规立即判定失败（停止扩量并回滚，见 10-8）。

## 3. 决策：最终 soak 与成本观察窗（§18.2 第 6 步 + §16.6）

- **最终 soak**固定以 `public_beta_default` 档冻结 Gate 判定：soak 时长
  ≥ 168h、样本量与覆盖达标、**hard incident=0**、soft 错误在预算内；
- **成本与调用放大监控**：用户级 **p50/p95 成本**（逐维度，R7 线性插值）、
  **重试放大系数**（计费调用 / 唯一请求，上限 1.5）、**hidden/off 后新增成本
  为 0**（§16.6 硬 Gate，任一维度 >0 即违规）；`hidden_off` 语义同时覆盖
  `cancel_confirmed`（08-4）；
- **观察 vs 硬 Gate 分离**：p50/p95 成本是成本面板观察输入；p95 上限、重试
  放大上限、hidden/off 零成本是硬 Gate，违规 → 立即停止扩量（08-4 §5 alerts）；
- 成本观察窗与 Gate 判定全部复用 `metrics-schema.ts` 纯函数（单一成本口径，
  无第二套定义）。

## 4. 验收与证据

- [x] 最终 soak 判定：soak 时长 / 无 hard incident / 成本曲线在冻结预算内；
- [x] 成本与调用放大监控：p50/p95、重试放大系数、hidden/off 后新增成本 0；
- [x] 单测 22 例全部通过（干净样本 + 违规样本双断言：样本量不足、soak 不足、
      模态/Provider/ASR 覆盖不足、hard incident=1、soft 超预算、p95 越限、
      重试放大超限、hidden/off 成本>0、置信区间不达标、未知档位 fail closed）；
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。

## 5. 约束级别与关联

- **约束**：soak 期无 hard incident；成本曲线在冻结预算内。
- **关联契约**：01-5（§16.6 成本与调用放大 Gate）、08-4（metrics-schema /
  alerts / runbook）、10-w9（§18.2 第 6 步）、10-8（Gate 通过后设公测默认）。
- **不做的边界**：本任务不实现埋点 / 采集器 / 时间窗统计（接线 harness 在
  09-2 / 09-5 / 09-6 与阶段 11 注入观察记录）；不新增数据库表；不修改其它
  任何文件。
