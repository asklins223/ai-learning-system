# 决策记录 03-6：Budget、epoch 与 kill 政策（§4.3/§4.4/§7.7/§13.5）

> 状态：**Frozen（已冻结）**
> 执行：阶段 03（W2）任务 03-6
> 日期：2026-08-08
> 来源：`03-w2-session-supervisor-runtime.md` 任务 03-6（原方案 §4.3/§4.4/§7.7/§13.5）
> 约束级别：epoch 失配、kill、超时路径不产生任何学习副作用。

---

## 1. 交付物

- `workers/ai-worker/src/learning-agent/policies.ts`：budget/epoch/kill 政策执行器——
  `checkEpochsBeforeWrite`、`COMMIT_LOCK_ORDER` + `assertCommitCasValid`、
  `handleHardKillLateResponse` + `buildLateResponseAudit`、`handleHardIncident`、
  `recoverAfterDisconnect`、`enforcePolicyBounds`。
- `workers/ai-worker/src/learning-agent/policies.test.ts`：约 30 例单测
  （node:test + assert，`node --import tsx --test` 全绿）。
- `workers/ai-worker/src/learning-agent/index.ts`：追加 policies re-export。
- 本文件：决策记录。

实现边界：本模块是**纯逻辑 + 可注入端口**（DB / 外部 job / 只读数据源通过接口
注入，单测用内存实现）。真实数据源接入由 03-2 repository / 阶段 06 COMMIT 完成；
本模块**不写掌握 / schedule 真值**（fence 只改 Episode 状态为 cancelled，审计记录
只是内存结果对象，canonical 事实只允许由 deterministic COMMIT 投影产生）。

## 2. epoch 检查点（§7.7 / §4.3）

**规则**：所有 turn / tool / Critic 结果落库前，必须重新读取当前 contract 的
`runtimeEpoch + episodeEpoch`，与 PREPARE 冻结快照逐项比较。

```
checkEpochsBeforeWrite(contract, current):
   current = null                    → 抛 LearningEpochMismatchError（fail closed）
   current 任一 epoch < 0（哨兵 -1） → 抛 LearningEpochMismatchError（缺失 fail closed）
   runtimeEpoch ≠ snapshot           → 抛 LearningEpochMismatchError
   episodeEpoch ≠ 冻结值             → 抛 LearningEpochMismatchError
   ✓ 全部一致                        → 放行（0 副作用）
```

- 冻结快照来源：`learning_episodes.runtimeEpochSnapshot / episodeEpoch`（03-2）；
  当前值来源：runtime-control + learning_episode 行（03-2 `getRuntimeEpoch` 预留，
  03-6 接入 `learningRuntimeEpoch`）；
- 失配后调用方转为 stale / blocked / cancelled，**0 学习副作用**；
- 缺失（provider 未注入 / 当前 epoch 未知）一律按失配处理（fail closed），
  hard kill / privacy incident 后的迟到响应不能以陈旧 epoch 落库。

## 3. COMMIT 固定锁序与完整 CAS（§4.3/§5）

最终 COMMIT 在一个数据库事务内按**固定顺序**锁：

```
runtime-control → learning_episode → authoritative target/version guard
→ keyPoint schedule guard → input schedule（consume 时）
```

（`COMMIT_LOCK_ORDER` 常量；cancel / 显式 stale / Generation publish 替换也经过
相同 guard，不能在 COMMIT 检查与写入之间穿透。）

**单次 CAS**（`assertCommitCasValid`）同时验证：

| # | CAS 项 | 失败处置 |
|---|--------|----------|
| 1 | `runtimeEpoch = snapshot` | LearningEpochMismatchError |
| 2 | `episodeEpoch` 未变 | LearningEpochMismatchError |
| 3 | Episode `active && !cancelled && !stale` | LearningCommitBlockedError |
| 4 | content fingerprint 匹配（冻结一致） | LearningCommitBlockedError（→ stale） |
| 5 | scheduling decision hash 匹配 | LearningCommitBlockedError（→ blocked） |
| 6 | `kill = false` | LearningCommitBlockedError |

任一失败整体回滚为 stale / cancelled / blocked（0 学习副作用）。真实事务 CAS 的
数据库实现（`create_initial` 验证不存在 active pending；`consume_pending` 验证精确
generation 仍 active）由阶段 06 完成，本模块提供纯逻辑校验钩子与锁序常量。

## 4. hard kill 迟到响应语义（§7.7）

**规则**：hard kill 后的迟到 Provider/ASR/Critic 响应：

- **只记录**不含用户内容的审计摘要（安全摘要白名单）；
- **不写** probe / artifact / assessment staging；
- **不能恢复为 trusted**。

实现（`handleHardKillLateResponse` / `buildLateResponseAudit`）：

- 返回值恒带 `stagingWritten: false` 与 `trustedRestored: false`（字面量，类型 +
  值双重保证）；
- 审计摘要白名单 `LATE_RESPONSE_AUDIT_ALLOWED_KEYS`：只允许非内容字段
  （身份/定位、finishReason/tokensUsed、hash/幂等键、结构化安全摘要
  outcomeSummary/verdictSummary）；含用户内容的键（answer / userAnswer /
  transcript / feedback / reasoning 等，同 canonical-events `PAYLOAD_DENIED_KEYS`
  理念）一律抛 `LateResponseAuditError`（fail closed：宁可丢弃整个审计也不允许
  用户内容进入审计记录）；
- 调用方只应传入已剥离的安全摘要字段（raw 答案/音频/评估原文不进本函数）。

## 5. hard incident 语义（§17.2）

privacy / trust / scheduler hard incident 处理（`handleHardIncident`），**固定顺序**
（先隔离再收尾，类比 COMMIT 固定锁序）：

```
① bump runtime epoch（先隔离：旧 snapshot 全部失配，之后任何写入都 fail closed）
→ ② fence 全部未 commit Episode（status → cancelled；已 commit / stale 保留）
→ ③ 取消未完成外部 job
→ ④ 禁止 trusted 恢复（trustedRecoveryAllowed 恒 false）
```

- bump 后的新 epoch 由 `RuntimeControlPort.bumpRuntimeEpoch()` 返回（DB 实现阶段 06）；
- fence 只改 Episode 状态为 cancelled（零副作用，不写掌握/schedule/artifact）；
- 防御性过滤：端口返回的 completed / cancelled / stale 终态不重复 fence。

## 6. 断线恢复规则（§7.7）

**规则**：断线恢复**只读** event / contract / artifact 三个数据源重建上下文，
**不重复 Provider 调用**、**不产生业务副作用**。

实现（`recoverAfterDisconnect`）：

- 只接受只读端口 `DisconnectRecoveryReadPort`（`readEvents` / `readContract` /
  `readArtifacts`）——函数签名不含 provider 端口，类型层面保证零 Provider 调用；
- 返回值恒带 `providerCallMade: false` 与 `sideEffects: false`（字面量）；
- contract 不可读 → fail closed（`ok=false`，拒绝以不完整上下文继续）；
- 上下文从三个数据源重建（`eventCount` / `artifactCount` / `contractPresent` +
  contract content-free 引用），不来自无限增长的 messages；已 commit Episode 由
  事件流保留，不回滚。

## 7. policy bounds 表（§4.4 / §13.5 / 01-1 §6）

`enforcePolicyBounds` 复用 `LEARNING_LOOP_BOUNDS`（budget.ts W0 冻结单一来源），
全量逐项检查全部边界（边界名与 orchestrator `loopGuard` 同源），一次列出全部
违反，并叠加更严格的恒等断言：

| 维度 | 上限 / 规则 | 实现 |
|------|------------|------|
| Session Supervisor turns | ≤ 8 | `maxSessionSupervisorTurns` |
| trusted 内容性动态 follow-up | **恒等 = 0**（-1 / 1 均拒绝） | `trustedContentFollowUp` 恒等断言（比「>0 拒绝」更严格） |
| 每条路线 Encounter | 2 ~ 5 | `routeEncounter` |
| 同时 active 学习会话 | 每用户 ≤ 1 | `maxConcurrentActiveSessionsPerUser` |
| 单次 Agent turn deadline | ≤ 120s（policy 冻结） | `turnDeadlineMs` |
| Session inactivity expiry | 30min（只结束 active UI，不回滚已 commit） | `inactivityExpiryMs` |
| Pause TTL | 过期禁止继续；恢复必须重查 source/policy/assistance stale | `pauseTtlStaleRecheck` + `pauseTtlMs` |
| budget 使用量 | 非负恒等断言（损坏的负数状态拒绝） | 逐角色 / providerCalls / tokens |

任一违反 → `allowed=false` 并列出全部 `violatedBounds`（去重），0 副作用；
全部满足才放行。

## 8. 验收对齐

- epoch 失配、kill、超时路径不产生任何学习副作用：`checkEpochsBeforeWrite` /
  `assertCommitCasValid` fail closed + `handleHardKillLateResponse` 恒
  `stagingWritten=false` + `enforcePolicyBounds` 恒 0 副作用；
- 0 canonical write：本模块全部函数只产出内存结果对象 / 审计记录，不写
  掌握/schedule/Card 真值（阶段 Gate「staging plan 0 canonical write」保持）。

---

## 决策点汇总

1. **epoch 检查点位置**：所有 turn/tool/Critic 落库前 + COMMIT CAS 中，统一走
   `checkEpochsBeforeWrite`（委托 `runtime.ts assertContractEpochValid`），避免
   各落库点各自实现造成穿透。
2. **当前 epoch 缺失语义**：null / 哨兵 -1 = 未知，按失配 fail closed（拒绝以
   陈旧/缺失 epoch 落库）。
3. **迟到响应审计**：fail closed 白名单（拒绝任何含用户内容的键），宁可丢弃整个
   审计也不记录用户内容；staging 与 trusted 恢复用字面量 `false` 在类型层禁止。
4. **hard incident 顺序**：bump（隔离）→ fence（收尾）→ cancel（外部清理）→
   禁止 trusted 恢复，固定不可交换。
5. **断线恢复**：只读三数据源，签名不含 provider 端口，字面量 `false` 保证零
   副作用，contract 缺失 fail closed。
6. **policy bounds**：复用 W0 冻结的 `LEARNING_LOOP_BOUNDS`，全量逐项检查并
   一次列出全部违反（边界名与 orchestrator `loopGuard` 同源），叠加 0 trusted
   follow-up 恒等断言与 budget 非负断言，超限 0 副作用。
