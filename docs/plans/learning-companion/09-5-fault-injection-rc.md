# 决策记录 09-5：故障注入与降级 RC（§17.2）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen |
| **执行** | 阶段 09（W8）任务 09-5：故障注入与降级 |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/09-w8-quality-capacity-rc.md` 任务 09-5（§17.2，W8 bullet）+ 冻结记录 01-5 §16.6 |
| **约束级别** | 故障注入全部通过；0 重复副作用；recovery 无死锁；任何 hard invariant 违反进入**立即回滚评估** |

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/fault-injection-rc.ts`：故障注入 RC
  **纯逻辑 + 可注入演练端口**——RC 故障注入矩阵（11 项）、crash/retry/cancel/
  stale/rollback 重复执行、router 与 `CompanionPageCoverageRegistryV1` 100%
  对账、重试放大系数上限、recovery queue SLA、汇总判定。无 DB / 无网络 /
  无时钟 / 无副作用。
- `apps/api/src/modules/learning-sessions/fault-injection-rc.test.ts`：单测
  （node:test），106 例全绿。
- 本文件：决策记录。

实现边界：本模块通过**注入场景端口**（`RcFaultDrillPort` / `RepeatedScenarioPort`）
执行演练——集成层/测试提供「某故障条件下运行一次场景」的实现，本模块只对标准化
观察事实做互斥判定，不触碰领域数据，保证演练可重复。

## 2. RC 故障注入矩阵（11 项，每项重复执行 5 次）

| # | 故障注入项 | expected | hard | 关键断言摘要 |
| --- | --- | --- | --- | --- |
| 1-3 | 星图故障注入（100 / 1K / 5K 节点） | degrade | 否 | 静态路线卡/列表回退；理解内核不受影响；按注入节点规模降级 |
| 4 | 并发 Session | recover | 是（H3） | 会话隔离正确；无跨会话泄漏；每 Session commit/Provider exactly-once |
| 5 | ASR 故障 | degrade | 是（H2） | 关键内容不可辨 → not_assessable；可重录/换模态；无学习副作用 |
| 6 | LLM 故障 | degrade | 否 | evaluation_retryable；不由 Supervisor 替代；trusted 主链仍可完成 |
| 7 | 对象存储故障 | degrade | 是（H2） | 确认前停止 voice lock、可重录/silent bundle；确认后 canonical 不受影响 |
| 8 | 全局壳对首屏/路由性能影响 | degrade | 否 | 不阻塞认证与页面主内容；首屏/路由性能在预算内（超限优先降级角色） |
| 9 | 跨设备恢复 | recover | 是（H3） | 显式接管/只读；未接管设备提交 0；恢复状态一致 |
| 10 | 登录过期 | failClosed | 是（H1/H2） | 过期 token 动作拒绝并提示重登；无学习副作用 |
| 11 | Companion 全故障降级 | degrade | 否 | 手动主路径可完成率 100%；零 Provider 成本；零状态写入 |

hard invariant 判定准则与 08-3 fault-matrix 同源（H1 安全/隐私、H2 学习副作用、
H3 权威一致性、H4 恢复可信度）。**任何 hard 项任何一次重复运行违反 →
`rollbackEvaluationRequired = true`（立即回滚评估）**；缺测（runs 数不足）判 fail，
不静默通过。

## 3. crash/retry/cancel/stale/rollback 重复执行

`REPEATED_SCENARIOS`（5 类）每类重复执行 5 次，断言 100% 通过：

- **crash**：从持久化源恢复；不重做已锁输入；不重复 Provider 与 commit；
- **retry**：同一 provider/job attempt 重复计费调用 0；幂等结果；0 重复副作用；
- **cancel**：取消被服务端确认后新增 Provider 调用 0；0 学习副作用；
- **stale**：stale action/token 被拒绝；0 学习副作用；
- **rollback**：回滚已应用；无残留 partial 状态；不重复 commit；0 学习副作用。

## 4. router 与 CompanionPageCoverageRegistryV1 100% 对账

`checkRouterCoverageReconciliation`（07-2 语义本地复刻，`matchesRoutePattern`
`:name` 匹配单段、无通配符）：

- **方向 A**：每个真实路由必须被至少一个 entry 覆盖（未分类 → 违规）；
- **方向 B**：registry 中无 `manualFallbackTestId` 的具体 entry 必须命中真实路由；
  有手动兜底的 entry 允许不命中。

## 5. 重试放大系数上限（§16.6）

- 同一 provider/job attempt 的**重复计费调用必须为 0**（`checkNoDuplicateBilledCalls`
  逐条判定：计费次数 >1、重复记录键、负值均违规）；
- 重试放大系数 = 计费调用数 / 唯一请求数，上限 **W0 冻结默认 1.5**
  （`DEFAULT_RETRY_AMPLIFICATION_CAP`，与 08-4 同源），由本 RC 故障注入验证；
  唯一请求为 0 时确定性返回 0（不产生非法值）。

## 6. recovery queue SLA（§16.6）

`RECOVERY_QUEUE_SLA_MS = 300_000`（5 分钟，W0 冻结口径默认值；01-5 §16.6 未给
具体毫秒值，本记录按 W0 冻结口径定义默认值——与 08-5
`GLOBAL_OFF_PROPAGATION_SLA_MS` 的处理一致，CI 校准只改常量）。校验项：

- **已锁答案使用预留额度完成评估**：`lockedAnswer && reservedEnvelopeSufficient`
  → outcome 必须为 `evaluated`，不得停在 pending/retryable 或转
  operational_failure；
- **不得永久卡在 retryable**：超过 SLA 仍 retryable → 违规；因后续预算耗尽超过
  SLA 仍未结束 → 违规（`checkRecoveryNoBudgetDeadlock`）；
- **超出 SLA 以 operational failure 结束**：超 SLA 后 outcome 必须为
  `operational_failure`（或已 evaluated）；
- **operational failure 0 学习副作用**：`learningSideEffects` 必须为 0。

`checkRecoveryQueuePolicy` 对每个 job 全量校验上述四条。

## 7. 验证记录

```text
$ npm run typecheck --prefix apps/api
# 通过（0 错误）

$ npm test --prefix apps/api
# tests 2613
# suites 461
# pass 2613
# fail 0
#（含 fault-injection-rc.test.ts 106 例与 capacity-perf.test.ts 24 例）
```

## 8. 约束级别与回滚评估

- **约束**：故障注入全部通过；0 重复副作用；recovery 无死锁；router 与 coverage
  registry 100% 对账；重试放大系数不越限；
- **回滚触发**：任何 hard invariant 违反（矩阵或 crash/retry/cancel/stale/
  rollback 重复执行）→ `rollbackEvaluationRequired = true`，进入**立即回滚评估**，
  不得带着未通过的 hard invariant 进入阶段 10；
- **可重复性**：演练为纯函数 + 注入端口，任意次数重复执行结果一致（测试覆盖
  「同一端口两次演练结果一致」与「重复执行 5 次 hard invariant 100%」）；
- **关联契约**：08-3 fault-matrix（judgeDrill/runMatrixDrill 编排模式与 H1-H4
  判定准则）、07-2 page-coverage-registry（router 对账）、06-4 race-rollback、
  03-6 policies（budget/recovery queue 语义）、08-4 observability（重试放大系数）。
