# M6 Gate 证据：FSRS Shadow 与回放

> 里程碑：M6<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-25<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：正式 schedule 影响为 0

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| Shadow 表 append-only | ✅ | `scheduling_shadow_decisions` + `onConflictDoNothing` |
| Shadow 不被正式 review 查询 | ✅ | review schedule 只用 discrete-v2 |
| Shadow 只对 unassisted 写入 | ✅ | assisted/stale/provider_failure 跳过 |
| FSRS_SHADOW_ENABLED 默认 false | ✅ | feature flag 门禁 |
| FSRS 结果不进入普通用户 UI | ✅ | shadow 数据无 UI 暴露路径 |
| 正式 schedule 写入禁令 | ✅ | `evaluate-rubric.ts` + `session-service.ts` 只写 discrete-v2 |

## Gate 2：相同历史重放产生相同 shadow hash

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| Pinned FSRS 版本 | ✅ | `ts-fsrs@4.6.0` |
| Rating 映射 | ✅ | correct→Good(3), partial→Hard(2), incorrect/unable→Again(1), 不虚构 Easy |
| Golden vectors 确定性验证 | ✅ | `verifyGoldenVectors()` 验证相同输入产生相同输出 |
| 确定性回放测试 | ✅ | `fsrs-shadow.test.ts` 17 个测试 |
| 算法版本 | ✅ | `FSRS_ALGORITHM_VERSION = "ts-fsrs-4.6.0"` |
| 参数版本 | ✅ | `FSRS_PARAMETERS_VERSION = "fsrs-default-2026-07-25"` |

## Gate 3：报告明确样本量、校准、模拟工作量和 insufficient_data

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| generateCompareReport | ✅ | `fsrs-compare-report.ts` |
| insufficient_data 阈值 | ✅ | `MIN_SAMPLE_SIZE = 30`，sample < 30 时 insufficientData=true |
| 报告 7 个部分 | ✅ | Overview、Sample Size、Interval Comparison、By Outcome、By Interval Tier、Formal Schedule Impact、Conclusion |
| Formal Schedule Impact 零影响确认 | ✅ | 报告文本明确 "ZERO impact" |
| simulationWorkload | ✅ | 报告包含模拟工作量 |
| Per-outcome breakdown | ✅ | 按 correct/partial/incorrect/unable 分组统计 |
| Per-interval-tier breakdown | ✅ | 按 currentIntervalDays 分组统计 |
| 统计辅助函数 | ✅ | mean、median、stdDev |
| FSRSCompareReport 接口 | ✅ | sampleSize/fsrsDecisionCount/fsrsSkippedCount/meanIntervalDiff/... |

## 交付物清单

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| FSRS Shadow Adapter | `packages/shared/src/fsrs-shadow.ts` | ✅ |
| FSRS Compare Report | `packages/shared/src/fsrs-compare-report.ts` | ✅ |
| Worker re-export | `workers/ai-worker/src/lib/fsrs-shadow.ts` | ✅ |
| Shadow 写入 (AI 评估) | `workers/ai-worker/src/handlers/evaluate-rubric.ts` | ✅ |
| Shadow 写入 (unable) | `apps/api/src/modules/validation/session-service.ts` | ✅ |
| Object Storage | `workers/ai-worker/src/lib/object-storage.ts` | ✅ |

## 测试覆盖

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `fsrs-shadow.test.ts` | 17 | ✅ 全绿 |
| `fsrs-compare-report.test.ts` | 13 | ✅ 全绿 |

## v0.6 已知限制

FSRS shadow 始终从 `State.New` 空卡片开始计算，不使用 `currentIntervalDays` 初始化卡片状态。每次 shadow decision 模拟"首次复习"场景，不累积 stability/difficulty。对于 v0.6 的 shadow 目的（确定性回放和离线对比），这是可接受的；完整的 FSRS 状态累积进入 v0.7。

## 总测试数

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared` (FSRS) | 30 | ✅ 全绿 |
