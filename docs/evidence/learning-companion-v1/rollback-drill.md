# 回滚演练（rollback-drill）

> 对应任务 11-2 证据文件 14。佐证 DoD 33、34、36。
> 决策记录：`08-3-fault-matrix-drills.md`（§17.2 故障矩阵）、`09-5-fault-injection-rc.md`（RC 故障注入）、`10-5-rollback-drill.md`（§18.2 第 4 步 / §18.3）、`01-7-feature-flags-capability-bundles.md`、`03-6-budget-epoch-kill.md`。

## 1. 交付文件核验

- `apps/api/src/modules/companion-shell/rollback-drill.ts`：三类回滚演练**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）——soft drain（`applyAtomicOffClosure` / `applyAtomicOff` / `decideEpisodeDrain` / `coreAssessCommitUnaffected` / `historyUntouched`）、hard kill（`executeHardKill`，固定顺序）、legacy reader matrix（`evaluateLegacyReaderMatrix`，drift replay / 观察窗口）；统一编排 `runRollbackDrillSuite` 汇总 `allPassed`（含 bundle 图冻结闭包对账 `assertCapabilityGraphValid`）。
- `apps/api/src/modules/companion-shell/rollback-drill.test.ts`：单测 **49 例**全绿（每类演练干净样本 + 违规样本双断言）。
- 演练日期：2026-08-08。

## 2. 三类演练的边界与判定准则

### 2.1 soft drain（UI 动画 / overlay / Tutor 展示故障）

- **控制面单一 config revision 原子关闭**：关闭目标 flag 时同时关闭其反向依赖闭包（01-7 §6 冻结闭包：`global_companion_shell off → companion_onboarding_v1 → learning_session_companion → current_target_tutor`；`trusted_multimodal_core off → learning_session_companion → multimodal_voice → structured_proof_v1 → journey_routes → understanding_universe_v2 → current_target_tutor`）。任一节点无法应用 → 整次配置变更回滚（不部分应用、revision 不变）。
- **可 drain 判定**（`decideEpisodeDrain`）：required capability closure 不含被关 flag 的已锁 Episode → drain（继续正常 core assess/commit 完成）；包含被关 flag 的可选分支 → 停止调用并降级/取消；required 被命中的 Episode 取消/标记 stale（0 学习副作用）；**终态不回滚、epoch 失配不 drain**。
- soft rollback 不提升 epoch、不启用 killSwitch → **健康 core assess/commit 不受影响**（`coreAssessCommitUnaffected`）。
- **Global Shell / onboarding 故障按依赖闭包关闭**：未登录页回**标准认证 UI**（不得临时用自由 Agent 或 DOM 抓取补位，演练注入违规补位标记即 fail）；authenticated 页面保留原生导航与手动入口；onboarding 状态 **forward-only 保留**（consumed 不回退、不重放）。
- **回落与保留**：关闭 companion/scene/tutor/map 展示后回**既有 question-first 验证和 Review Queue**；新 Artifact 不得隐式转换为旧 submission（提示手动重录，遵守 legacy-adapter 唯一消费矩阵）；新表 / events / artifacts / projections **forward-only 保留**，已产 canonical validation/review 结果继续有效；practice 航迹关闭展示后仍保留用户导出/删除。
- **回滚不修改历史**：`historyUntouched` 快照深比较——不修改 schedule / attempt / understanding history / active Card Set（佐证 DoD 33 的 cancel/rollback 语义）。

### 2.2 hard kill（privacy / tenant / 答案泄漏 / trust / Critic / schedule invariant 触发）

固定顺序（03-6 §5，先隔离再收尾，不可交换）：

```
① bump runtime epoch（先隔离：旧 snapshot 全部失配，之后任何写入 fail closed）
→ ② 启用 commitKillSwitch 并 fence 全部未 commit Episode（active → cancelled；已 committed / stale / cancelled 终态保留）
→ ③ 取消未完成外部 job
→ ④ 禁止 trusted 恢复（trustedRecoveryAllowed / stagingWritten 均字面量 false）
```

- `executeHardKill` 只产出内存结果对象，不写任何领域真值；`trustedRecoveryAllowed` 与 `stagingWritten` 用字面量 `false` 在类型层禁止恢复可写 staging（佐证 DoD 34 的 hard epoch kill）。

### 2.3 legacy reader matrix（佐证 DoD 34、36）

- projection（understanding_universe_v2 / star map）关闭时，**旧 reader 仍读 pending schedule、attempt 和结果**（数据 forward-only 保留即读得到）；
- 回滚不修改现有 schedule / attempt / understanding history / active Card Set（快照深比较）；
- 再开启投影时执行 **drift replay** 与**观察窗口**（`driftReplayRequired` / `observationWindowRequired`）。

## 3. 演练结果记录（2026-08-08，单测 49 例全绿）

| # | 演练 | 判定要点 | 结果 |
| --- | --- | --- | --- |
| 1 | soft drain：Tutor 展示故障 | 单 revision 原子关闭目标+闭包；可 drain 判定；core 不受影响；question-first / Review Queue 回落；forward-only 保留；practice 导出/删除；历史不变 | PASS |
| 2 | soft drain：Global Shell/onboarding 故障 | 标准认证 UI；无自由 Agent / DOM 补位；原生导航+手动入口；onboarding forward-only | PASS |
| 3 | hard kill | epoch+1、killSwitch、fence 未 commit、取消 job、禁止 trusted 恢复（固定顺序） | PASS |
| 4 | legacy reader matrix | 旧 reader 可读；forward-only；drift replay + 观察窗；不修改历史 | PASS |
| 5 | 违规注入 | 补位违规 / 原子失败 / 历史被改 / 终态重复 fence 全部拒绝 | PASS（fail closed） |

## 4. 与故障矩阵 / 故障注入 RC 的交叉核验

- **08-3 fault-matrix（§17.2，佐证 DoD 33）**：22 项故障全部演练 PASS、hard invariant 18 项通过率 100%、`rollbackEvaluationRequired = false`——其中与回滚直接相关的条目：#3 stale action fail closed、#6 hidden/off late response noSideEffect、#15 cancel/断线 recover（不重复 Provider/commit）、#21 privacy/trust/scheduler hard incident（bump epoch + fence + 取消 job + 禁止 trusted 恢复，固定顺序与 rollback-drill hard kill 同源）、#22 late result after hard kill（仅低敏审计摘要、不写可恢复 staging）。
- **09-5 fault-injection-rc（佐证 DoD 35）**：crash/retry/cancel/stale/**rollback** 五类重复执行 5 次断言 100%——rollback 断言「回滚已应用；无残留 partial 状态；不重复 commit；0 学习副作用」；11 项注入矩阵中 hard 项任何一次违反 → `rollbackEvaluationRequired=true`（立即回滚评估）。
- **10-4/10-6 canary**：25% 档 Gate 强制 hard-kill drill 完成证据（`completed=true` 且 `evidenceRef` 非空，引用本 drill 记录）；rollback drill 在进入 25%（10-6）前完成。
- **10-8 公测默认**：hard invariant 单次违规 → `stopScaling` 字面量 true + 经 `applyAtomicOffClosure` 单 revision 原子回滚相关 flag（违规类别 → 回滚目标映射冻结：privacy/tenant/answer_leak/trust/critic/schedule_invariant）。

## 5. 判定层证据

- 全部为纯函数 + 注入场景端口（接线 harness 提供软/硬/legacy 三种场景观察），同一输入恒得同一输出；测试对每类演练提供干净样本 + 违规样本双断言；每次 RC 分别演练三类（`runRollbackDrillSuite` 汇总 `allPassed`）；bundle 图自检对账 01-7 §6 冻结闭包（含顺序）。
- 验证记录：`cd apps/api && node --import tsx --test src/modules/companion-shell/rollback-drill.test.ts` → tests 49 / pass 49 / fail 0；`npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。
- 决策记录 08-3、09-5、10-5 状态均为 Frozen（已冻结）。
