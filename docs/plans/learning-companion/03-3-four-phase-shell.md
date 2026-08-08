# 决策记录 03-3：四阶段外壳与有界 SESSION_AGENT（§4.3/§4.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 03（W2）任务 03-3
> 日期：2026-08-08
> 来源：`03-w2-session-supervisor-runtime.md` 任务 03-3（原方案 §4.3/§4.4）
> 约束级别：无限 loop 不可达；trusted 阶段无内容性动态出题；越权写为 0。

---

## 1. 交付物

- `workers/ai-worker/src/learning-agent/orchestrator.ts`：四阶段外壳编排器
  （纯逻辑 + 可注入 Scene Author / Rubric/Scene Critic 端口）：
  `runPhase`、`runRubricAndScenePrepare`、`defaultRoute`/`alternateRoute`、
  `trustedControlSignals`、`loopGuard`、`stagingPlan`。
- `workers/ai-worker/src/learning-agent/index.ts`：追加 orchestrator re-export。
- `workers/ai-worker/src/learning-agent/orchestrator.test.ts`：31 例单测
  （node:test + assert）。
- 本文件：决策记录。

实现边界：**外壳编排 + staging 落点**；Scene 具体实现（Scene DSL 渲染、safety 细则、
scene-safety-v1 完整清单）由 W4（任务 05）完成；turn/评估/COMMIT 内容由 03-6/W5 完成。
本模块全程 **0 canonical write**，不写掌握 / schedule / Card 真值，不替用户完成答案。

## 2. 四阶段确定性外壳（runPhase）

```
prepared → session_agent → independent_assess → committed
任意进行中 ──→ cancelled / stale；cancelled / stale 无出边；committed 的 commit 幂等
```

- 与 03-2 sessionLoop 状态机对齐：typed 动作 `begin_session_agent` /
  `lock_answer` / `commit_episode` / `cancel` / `mark_stale`；
- **phase 无独立 DB 落点**（同 03-2 §2）：prepared/session_agent/independent_assess
  语义保持 episode `status='active'`，committed→completed、cancelled/stale 原样映射；
- `runPhase(phase, context)` 是纯状态推进函数：显式传入 phase，非法迁移返回
  `allowed=false`（不抛错），**无限 loop 不可达**由迁移矩阵 + loopGuard 双重保证；
- fail closed：推进上下文必须携带 session/episode 身份、planHash 与非负 epoch，
  缺一拒绝推进（0 副作用）。

## 3. RUBRIC_AND_SCENE_PREPARE 子流程（首个 formal probe 展示前、不向用户展示）

顺序固定（01-1 §4，单测断言 `order` 数组）：

```
解析 RubricTarget → Scene Author 提出草案 → deterministic schema/safety 校验
→ 独立 Rubric/Scene Critic → 确定性激活 immutable private/public contracts
```

- **冻结项**（每个 RubricTarget，01-2 §5）：criterion、server-only expected
  target/hash、weight、required、facet、target、逐项 evidence refs、
  semantic-support report；激活产出 `FrozenProbeRef`（probeId、scene 三对象
  独立 hash、sceneSafetyReport、templateTrustCeiling、disclosureProfileHash）；
- **deterministic schema/safety**（scene-safety-v1 的确定性部分）：模板在
  allowlist（不允许模型任意生成界面）、public/secret hash 分离、allowlisted
  IDs 无重复、evidence refs ⊆ RubricTarget.evidenceRefIds（01-2 §9 子集规则）、
  trust ceiling 在 allowlist；不满足 → 不调 Critic、不激活；
- **独立 Rubric/Scene Critic**：mandatory；拒绝时最多一次修复轮（01-2 §3.3），
  仍失败 → `question_retryable/blocked`，0 副作用；
- **确定性激活**：唯一激活权限属于 deterministic Scene Activation Service
  （Author/Supervisor/Critic/Companion 都没有 activate_scene_contract 权限）；
  前置条件 fail closed（safety=valid 且 Critic=approved 才激活）；
- **冻结全部 trusted probes 和分支**：公测 v1 同一 formal Episode 首次回答前
  全部冻结；`planHash` 追加 frozenProbeHashes（`extendPlanHashWithFrozenProbes`，
  01-2 §5.3 / 03-2 §3 第 4 步）；
- Supervisor 只能请求 `requestedTrustClass`，**不能签发 effective trust**
  （effective trust 由服务端 lock 时按 disclosure/attempts/assistance/stale 计算）。

## 4. 默认路线与「换一个」备选

- `defaultRoute`：根据目的地（keyPointId）与显式偏好**默认提议一条路线**，
  不生成备选列表；过滤 Encounter 2~5、排除 avoid 模板，按确定性排序
  （匹配显式 Encounter 偏好 > 匹配偏好模板 > routeId 字典序兜底）；
- `alternateRoute`：**只在用户明确「换一个」时调用**，排除当前 routeId 与
  已看过 seenRouteIds，取下一条；耗尽返回 null（不自动造新路线、不进入无限聊天）；
- route 无 route-level mastery 或总体 schedule 副作用（01-1 §2）。

## 5. trusted 阶段控制信号白名单

trusted 阶段（session_agent）**不读取内容性 gap 动态出题**，只能接收无答案控制信号：

```
continue / stop / not_assessable / switch_modality
```

- 白名单之外（答案、内容性信号，如"再解释一下答案"）一律 `allowed=false`；
- 非 SESSION_AGENT 阶段一律拒绝；
- 内容性 assessment gap 只在正式答案锁定并完成 Independent Assess 后
  供结果解释或 practice 使用；practice 阶段可自适应追问但 artifact 全为
  practice-only（trusted 内容性动态 follow-up = 0，W0 冻结）。

## 6. Agent Loop 硬边界（loopGuard，fail closed）

| 维度 | 上限 | loopGuard 违反即阻断 |
| --- | ---: | --- |
| Session Supervisor turns | ≤8 | `maxSessionSupervisorTurns` |
| trusted 内容性动态 follow-up | =0（公测 v1，全部 formal probe 预冻结） | `trustedContentFollowUp` |
| 每条路线 Encounter | 2~5 | `routeEncounter` |
| 同时 active 学习会话 | 每用户 1 | `maxConcurrentActiveSessionsPerUser` |
| 单次 Agent turn deadline | ≤120s（Provider/ASR policy 冻结） | `turnDeadlineMs` |
| Session inactivity expiry | 30min（只结束 active UI，不回滚已 commit Episode） | `inactivityExpiryMs` |
| Pause TTL 恢复 | 必须重查 source/policy/assistance stale，stale 禁止继续 | `pauseTtlStaleRecheck` |

预算策略默认值取自 `LEARNING_LOOP_BOUNDS`（budget.ts，W0 冻结）；PREPARE 冻结的
`LearningBudgetPolicy` 运行期间不可修改（01-2 §5.3）。

## 7. Supervisor staging plan（0 canonical write）

- `stagingPlan` 产出全部 `LearningStagingResult`（kind="learning_staging"、
  `canonicalWrite=false` **字面量类型**）——编译器在类型层面禁止把 staging 结果
  当 canonical 结果消费；
- canonical 事实（mastery / schedule / published semantic relation / canonical
  Card / review outcome / validation_point_assessments）只允许由 deterministic
  COMMIT（01-1 §5 固定锁序 + 完整 CAS，03-6/06）投影产生；
- 本模块不写掌握 / schedule 真值、不替用户完成答案、不新增评分目标（03-3 验收：
  越权写为 0）。

## 8. 验收标准

1. `npm run typecheck --prefix workers/ai-worker` 通过；
2. `orchestrator.test.ts` 31 例通过：四阶段推进、RUBRIC_AND_SCENE_PREPARE 顺序
   （author→safety→critic→activate + fail closed）、默认路线与"换一个"、
   trusted 控制信号越界拒绝、loop 硬边界（turns 超限阻断等）、staging 全
   canonicalWrite=false；
3. 无限 loop 不可达（迁移矩阵 + loopGuard 双保证）；trusted 阶段无内容性动态出题
   （白名单拒绝）；越权写为 0（类型 + 值断言）。

## 9. 后续衔接

- 03-4：actor 工具网关执行 Scene Author/Critic staging 写入与 verdict 落库
  （本任务仅提供端口接口）；
- 03-6：epoch 重比较接入 runPhase/loopGuard 的落库路径、inactivity/pause TTL
  驱动 stale；
- W4（05）：Scene 具体实现（Scene DSL、scene-safety-v1 完整清单、Scene Activation
  落库）；
- W5/06：INDEPENDENT_ASSESS 与 COMMIT 内容实现。
