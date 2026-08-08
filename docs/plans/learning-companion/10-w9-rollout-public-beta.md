# 阶段 10（W9）：Shadow、Canary 与公测默认

> **第一层执行顺序第 10 步**
> 前置：阶段 09（W8 RC 达标）
> 后置：阶段 11（收尾：DoD 与发布证据）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W9」；规范依据：§18（Feature Flags、Rollout 与回滚）、§13.5（降级）、§17.2（故障）。

---

## 本阶段目标

按 W0 冻结的定量 `RolloutStageGateV1` 分档扩量，每一步都必须达到门槛而不是只完成开关操作，最终把 Must capability bundle 设为正式公测默认并退休旧文本主入口默认地位。

## 前置：RolloutStageGateV1 门槛（§18.2）

W0 冻结定量 `RolloutStageGateV1`：每档最低 Session/Episode、用户、workspace 数，voice/silent/text 与 Provider/ASR 覆盖，最短 soak 时长，hard incident=0、soft error budget、p95 成本预算和数据置信区间。每档必须产出引用该 Gate 的证据，样本不足不能进入下一档；hard-kill rollback drill 在进入 25% 前完成，25% 后完成最终 soak 才能设为默认。

## 可并行执行的任务（第二层）

> 说明：10-1 必须先完成；10-2~10-5 有先后依赖（shadow → internal → 5% → drill）；10-6~10-8 依序。每档内部的多项检查可并行执行。

### 任务 10-1：capability 部署与非法组合校验（§18.1）

**交付物**：服务启动 bundle graph 解析；capability API（`enabled/degraded/disabled + reason + policyVersion`）；root off 反向依赖闭包与单 config revision 原子 apply/rollback。

**任务内容（原文 §18.1）**：

- 服务启动时解析 bundle graph；非法组合（onboarding 开而 global shell 关、Session Companion 开而 trusted core 关、Scene 开而 Critic/commit 关、map 开而 projection 关、Tutor 开而 Grounded Answer Critic 关等）必须 fail startup；
- 每次外部 tool/Provider 调用及结果落库前重新验证 contract 的 required capability closure 与 runtime epoch；关闭相关 flag 后在途 Agent 不能继续该能力的调用和成本，无关 soft flag 变化不阻断 core assess/commit drain；
- 运行中关闭 root capability 时先计算反向依赖闭包，再用同一个 config revision 原子发布：

```text
global_companion_shell off
  → companion_onboarding_v1
  → learning_session_companion
  → current_target_tutor

trusted_multimodal_core off
  → learning_session_companion
  → multimodal_voice
  → structured_proof_v1
  → journey_routes
  → understanding_universe_v2
  → current_target_tutor
```

- 同一 revision 同时更新 capability API、Provider/tool fence 与前台状态；任一节点无法应用则整次配置变更回滚。

**验收**：root capability 关闭的反向依赖闭包、单 config revision 原子 apply/rollback、任一节点失败整体回滚通过；运行中从不暴露非法 flag 组合。

---

### 任务 10-2：replay / shadow（§18.2 第 1 步）

**交付物**：只生成计划和 assessment 对比，不写 canonical。

**任务内容（原文 §18.2，第 1 步）**：数据/contract 与事件投影，UI 全关；shadow route/assessment 只生成计划与对比，不写 canonical。

**验收**：shadow 输出 0 canonical 写；对比数据达到 Gate 门槛。

---

### 任务 10-3：internal allowlist（§18.2 第 2 步）

**交付物**：internal global shell + auth manifest + onboarding/static fallback；无 learning Agent 与学习写入。

**任务内容（原文 §18.2，第 2 步）**：internal allowlist 中启用 `global_companion_shell`、auth manifest、onboarding 与静态 fallback；learning Agent 与学习写入保持关闭。

**验收**：internal 用户全流程可用；0 学习写入。

---

### 任务 10-4：5% workspace-stable canary（§18.2 第 3 步）

**交付物**：5% workspace-stable canary（internal atomic core + voice + silent bundle；learning-session companion + card/review 入口）。

**任务内容（原文 §18.2，第 3~5 步）**：

- 5% workspace-stable canary：internal atomic core + voice + silent bundle；
- learning-session companion + card/review 入口；
- star map v2 回写 + origin-aware completion；
- current-target Tutor 进入 canary；
- 相邻低风险 flag 可合批，但 credential-safe、onboarding 零学习副作用、Formal/Practice、双 Critic、commit、scheduler adapter 和 RLS 不允许拆开上线。

**验收**：5% 档达到冻结 Gate（样本量、soak、hard incident=0、soft error budget、p95 成本）。

---

### 任务 10-5：hard-kill rollback drill（§18.2 第 4 步 / §18.3）

**交付物**：soft drain、hard kill 和 legacy reader matrix 全部演练。

**任务内容（原文 §18.3 回滚，W9 bullet）**：

- UI 动画、overlay 或 Tutor 展示故障属于 soft rollback：控制面以单一 config revision 原子关闭目标及其反向依赖闭包；required capability closure 不含该 flag 的已锁 Episode 可以 drain，包含它的可选分支停止调用并降级/取消，不能影响仍健康的 core assess/commit；
- Global Shell/onboarding 故障时按依赖闭包关闭：未登录页回到标准认证 UI，authenticated 页面保留原生导航与手动入口，onboarding 状态 forward-only 保留；不得临时用自由 Agent 或 DOM 抓取补位；
- privacy、tenant、答案泄漏、trust、Critic、schedule invariant 属于 hard rollback：提升 `learningRuntimeEpoch`/启用 `commitKillSwitch`，fence 所有未 commit Episode，取消外部 job，且禁止恢复为 trusted；
- 关闭 companion/scene/tutor/map 展示后可回到既有 question-first 验证和 Review Queue；不能把新 Artifact 隐式转换成旧 submission；
- 新表、events、artifacts 和 projections forward-only 保留；已产生的 canonical validation/review 结果继续有效；practice 航迹关闭展示后仍保留用户导出/删除能力；
- 回滚不得修改现有 schedule、attempt、understanding history 或 active Card Set；
- projection 关闭时旧 reader 仍能读取 pending schedule、attempt 和结果；再开启时执行 drift replay 和观察窗口；
- 每次 RC 必须分别演练 soft drain、hard kill 和 legacy reader matrix。

**验收**：三类回滚演练全部通过并留档；rollback drill 在进入 25% 前完成。

---

### 任务 10-6：25% canary（§18.2 第 5 步）

**交付物**：25% workspace-stable canary。

**任务内容（原文 §18.2，第 5 步）**：25% canary 档按冻结 Gate 验证。

**验收**：25% 档达到冻结 Gate（含 hard-kill drill 已完成的证据）。

---

### 任务 10-7：最终 soak 与成本观察窗（§18.2 第 6 步）

**交付物**：最终 soak 与成本观察窗。

**任务内容（原文 §18.2，第 6 步 + §16.6）**：最终 soak 与成本观察窗；成本与调用放大监控（p50/p95 成本、重试放大系数、hidden/off 后新增成本为 0）。

**验收**：soak 期无 hard incident；成本曲线在冻结预算内。

---

### 任务 10-8：公测默认与旧入口退休（§18.2 第 7~8 步）

**交付物**：Gate 通过后设为正式公测默认；再退休旧文本主入口的默认地位。

**任务内容（原文 §18.2，第 7~8 步）**：

- 7. Gate 通过后设为正式公测默认；
- 8. 再退休旧文本主入口的默认地位；
- 问题标记、workspace Tutor 和 semantic relationships 在主列车之外单独 shadow/canary，不阻塞第 8 步；
- 任何 hard invariant 单次违规立即停止扩量并回滚相关 flag（§15 W9）。

**验收**：Must capability bundle 成为正式公测默认；旧文本主入口退出默认；Should flags 保持独立 flag 状态。

---

## 阶段退出 Gate（10 / W9）

- [x] replay/shadow、internal allowlist、5%、25% 各阶段均达到冻结的 `RolloutStageGateV1`；
- [x] rollback drill 通过并完成最终 soak；
- [x] Must capability bundle 成为正式公测默认；
- [x] Should flags（问题标记、workspace Tutor、semantic relationships）独立 shadow/canary，不属于本阶段 DoD。

通过后进入阶段 11（收尾）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：10-1~10-8 全部实施并签署（capability 部署/shadow/internal/5%/drill/25%/soak/公测默认/决策记录均落盘）
- 验证：apps/api 2942/2942、packages/shared 374/374、packages/db 5/5、apps/web 750/750、workers typecheck、git diff --check 全部通过
- security_review：1 轮 warn（2 MEDIUM：adapter.apply 异常无回滚 / 双图定义漂移 + 2 LOW）→ 修复后复查 **pass**（异常视为节点失败整次回滚、shared 图与 rollback-drill 交叉对账 fail startup）
- 承接：阶段 11（收尾：DoD 核验与发布证据）
