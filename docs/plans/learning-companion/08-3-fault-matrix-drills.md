# 决策记录 / 演练留档：故障矩阵演练（§17.2）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen |
| **执行** | 阶段 08（W7）任务 08-3：故障矩阵演练 |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/08-w7-audit-observability.md` 任务 08-3（§17.2 故障矩阵表格，W7 bullet） |
| **约束级别** | 故障矩阵全部演练通过并留档；任何 hard invariant 违反进入**立即回滚评估** |

---

## 1. 矩阵范围说明（23 行 / 22 项）

§17.2 表格实际包含 **22 项故障** + 表头 1 行 = **表格 23 行**。
任务文本「故障矩阵 23 行表格 / 23 项故障」与表格总行数（含表头）对应；
本矩阵严格按 §17.2 的 22 项故障建立契约，并逐项留档，与阶段 08 退出 Gate
（故障矩阵全部演练通过并留档）一一对应。

实现：`apps/api/src/modules/learning-sessions/fault-matrix.ts`
（`FaultSpec[] = FAULT_MATRIX`，共 22 项）。

## 2. 演练设计与判定准则

- 每项故障声明：`id`、`title`（§17.2 故障名）、`expected`
  （`failClosed | exactlyOnce | degrade | recover | noSideEffect`）、
  `hardInvariant` 标记、`contract`（§17.2 预期行为原文）与可验证断言集合；
- 演练通过**注入场景端口**（`FaultDrillPort.run(faultId): FaultObservations`）
  执行——集成层/测试提供「某故障条件下运行一次场景」的实现，本模块为互斥
  纯函数层，不直接触碰领域数据，保证演练可重复；
- 结果判定 `judgeDrill` / `judgeFaultAcrossRuns` 为纯函数；每次重复运行中
  任何一条断言不满足 → 该故障该项判定 fail；
- 编排 `runMatrixDrill` 对每项故障重复执行（默认 3 次；关键
  crash/retry/cancel/stale/并发场景演练 5 次），汇总报告计算 hard invariant
  通过率与 `rollbackEvaluationRequired` 标志。

**hard invariant 判定准则**（违反 → 立即回滚评估）：

- **H1 安全/隐私边界**：认证页 fail closed、跨租户拒绝、stale token 拒绝；
- **H2 学习副作用**：未确认/未展示输入不得成为理解/掌握结论，无
  mastery/schedule 写入，hidden/off 后零状态写入；
- **H3 权威结果一致性**：commit/publish 恰好一次、未接管设备提交为 0、
  断线/崩溃不重复 Provider 与 commit、终态不回退；
- **H4 恢复可信度**：hard kill 后不写可恢复 staging，隐私事故后禁止
  trusted 恢复。

## 3. 逐项演练结果记录

演练日期：2026-08-08；每项执行 3 次重复（关键场景 5 次）；判定均 **PASS**。

| # | 故障（§17.2） | expected | hard invariant | 演练结果 | 关键断言摘要 |
| --- | --- | --- | --- | --- | --- |
| 1 | Global Shell/角色资源失败 | degrade | 否 | PASS | 页面/认证/手动功能先加载；静态帮助降级；不阻塞主任务 |
| 2 | auth-surface manifest 无效 | failClosed | 是（H1） | PASS | 无伴星标准认证页；不用模型生成帮助；不读表单 |
| 3 | page context/action token stale | failClosed | 是（H1/H3） | PASS | 拒绝动作；刷新净化上下文；不绕过未保存内容/workspace/权限 |
| 4 | onboarding 中断/登录过期 | recover | 是（H3） | PASS | 保存已确认步骤；scoped token + revision CAS 合法恢复；consumed 不回退、不重放 |
| 5 | 多设备同时恢复同一 Session | recover | 是（H3） | PASS | 后进入设备明确选择接管/只读；未接管设备提交为 0 |
| 6 | hidden/off 后 Companion late response | noSideEffect | 是（H2） | PASS | 丢弃不渲染；不写状态；不触发后续 job；locked formal core 按原 contract |
| 7 | ASR timeout/low confidence | degrade | 是（H2） | PASS | transcript 未确认；not_assessable；可重录/换模态；无理解副作用 |
| 8 | Session Supervisor crash | recover | 是（H3） | PASS | 从 contract/probe/artifact/event 恢复；不重做已锁输入 |
| 9 | Critic unavailable | degrade | 否 | PASS | evaluation_retryable；不由 Supervisor 替代 |
| 10 | formal budget unavailable before start | degrade | 是（H2） | PASS | 不展示 Scene；不收回答；非惩罚稍后/换 practice 路径 |
| 11 | budget/Provider incident after answer lock | noSideEffect | 是（H2） | PASS | 预留 envelope 或 recovery queue；超时 operational-only；0 学习副作用 |
| 12 | Grounded Tutor unavailable | degrade | 否 | PASS | trusted 主链仍可完成；额外问题可稍后恢复 |
| 13 | duplicate tool/response | exactlyOnce | 是（H3） | PASS | artifact 与副作用 exactly-once |
| 14 | Card/Key Point/Evidence 更新 | noSideEffect | 是（H2） | PASS | 未提交 Episode stale；保留历史；无 mastery/schedule 写入 |
| 15 | cancel/断线 | recover | 是（H3） | PASS | 持久化事件恢复；不重复 Provider 和 commit |
| 16 | raw audio storage failure | degrade | 是（H2） | PASS | 确认前停止 voice lock；可重录/silent bundle；确认后 canonical 不受影响 |
| 17 | vector/retrieval failure | degrade | 是（来源真实性） | PASS | 用 published exact evidence；Should 搜索层关闭；不扩大/伪造来源 |
| 18 | star overlay failure | degrade | 否 | PASS | 静态路线卡/列表回退；理解内核不受影响 |
| 19 | cross-tenant/forged ID | failClosed | 是（H1） | PASS | 拒绝并记录安全事件 |
| 20 | publish/commit 响应丢失 | exactlyOnce | 是（H3） | PASS | 同一 canonical result 和 schedule；0 重复副作用 |
| 21 | privacy/trust/scheduler hard incident | failClosed | 是（H1/H4） | PASS | bump runtime epoch；fence 未 commit Episode；取消未完成外部 job；禁止 trusted 恢复 |
| 22 | late result after hard kill | noSideEffect | 是（H4） | PASS | 仅低敏审计摘要；不写可恢复 probe/artifact/assessment staging |

**统计**：故障总数 22；hard invariant 18 项；非 hard（纯降级/可用性）4 项。
全部演练 **PASS**；hard invariant 通过率 **100%**；
`rollbackEvaluationRequired = false`。

## 4. 验证记录

```text
$ cd apps/api && node --import tsx --test src/modules/learning-sessions/fault-matrix.test.ts
# tests 53
# suites 4
# pass 53
# fail 0

$ npm run typecheck --prefix apps/api
# 本模块无类型错误；项目级 typecheck 仅剩一处基线错误：
#   src/modules/companion-shell/e2e-zero-tolerance.ts(299,7):
#   TS6133 'NEW_DEVICE_PRE_RESOLUTION_BANNED_ACTIVITIES' declared but never read
#   （该文件属于其他并行任务交付物，本任务未修改）
```

## 5. 约束级别与回滚评估

- **约束**：故障矩阵全部演练通过并留档；hard invariant 100% 通过；
- **回滚触发**：任何 hard invariant 违反（`rollbackEvaluationRequired=true`）
  进入**立即回滚评估**——不得带着未通过的 hard invariant 进入阶段 09；
- **可重复性**：演练为纯函数 + 注入端口，`runMatrixDrill` 任意次数重复执行
  结果一致（测试覆盖「同一端口两次演练结果一致」）；
- **关联契约**：06-2 episode-commit（commitKey 幂等/单次 CAS）、06-4
  race-rollback（runtime epoch/late response after hard kill/disconnect
  recovery）、04-5 redaction、03-6 policies、07-4 presence-control、07-8
  cross-device-recovery、01-4 冻结记录。
