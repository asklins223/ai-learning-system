# 决策记录 10-8：公测默认与旧入口退休（§18.2 第 7~8 步）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen（已冻结） |
| **执行** | 阶段 10（W9）任务 10-8：公测默认与旧入口退休 |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/10-w9-rollout-public-beta.md` 任务 10-8（§18.2 第 7~8 步）；冻结记录 01-7（§18.1 Must/Should bundle）、01-5（§5.3 自主性硬 Gate）、10-7（最终 soak 与 RolloutStageGateV1） |
| **约束级别** | **Must capability bundle 成为正式公测默认**；**旧文本主入口退出默认**；**Should flags（问题标记 / workspace Tutor / semantic relationships）保持独立 flag 状态**，在主列车外单独 shadow/canary，不阻塞第 8 步 |

---

## 1. 交付物

- `apps/api/src/modules/companion-shell/public-beta-default.ts` —— 公测默认与旧
  入口退休**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：
  - `evaluatePublicBetaGate`：**Gate 通过判定（引用 `RolloutStageGateV1`）**——
    以冻结的 `public_beta_default` 档判定最终 soak，达标才允许设正式公测默认
    （§18.2 第 7 步前置；委托 final-soak.ts `evaluateFinalSoak`）；
  - `validateConfigLegal`：配置合法性校验（01-7 §5 fail startup 规则——onboarding
    开而 global shell 关、Session Companion 开而 trusted core 关、Scene 开而
    Critic/commit 关、map 开而 projection 关、Tutor 开而 Grounded Answer Critic
    关等，按 bundle 依赖表通用校验）；
  - `applyPublicBetaDefaults`：**Must bundle 设默认**——单 config revision 把
    9 个 Must flags 全部置 enabled；Should flags 保持原独立状态；发布前校验
    合法性（非法组合不发布）；
  - `retireLegacyTextEntryDefault`：**旧文本主入口退休**——旧文本主入口退出
    默认地位，companion guided 成为新默认；旧入口能力**保留可访问**（退休的是
    「默认地位」，不是入口本身）；
  - `evaluateShouldFlagsIndependence`：**Should flags 独立**——问题标记 /
    workspace Tutor / semantic relationships 保持独立 flag 状态，主列车外单独
    shadow/canary，**不阻塞第 8 步**；
  - `evaluateHardInvariantViolation`：**任何 hard invariant 单次违规立即停止
    扩量并回滚相关 flag**（§15 W9）——违规类别映射回滚目标，并以**单 config
    revision 原子关闭**相关 flag 的全部反向依赖闭包（引用 rollback-drill
    `applyAtomicOffClosure`）；
  - `runPublicBetaDefaultSequence`：公测默认序列编排（Gate → Must 默认 → 旧入口
    退休 → Should 独立；任一 hard invariant 违规 → 序列不通过）。
- `apps/api/src/modules/companion-shell/public-beta-default.test.ts` —— 单测
  25 例。
- 本文件：决策记录。

## 2. 决策：Gate 通过后才设正式公测默认

- **Must capability bundle 成为正式公测默认**的前提是 `RolloutStageGateV1` 的
  `public_beta_default` 档全部达标（样本量 / soak ≥168h / 覆盖 / hard incident=0
  / soft budget / p95 成本 / 重试放大 / hidden-off 零成本 / 置信区间）——
  `evaluatePublicBetaGate` 引用冻结 Gate 常量，未达标不发布默认；
- 发布是**单 config revision** 的 Must-bundle 默认化：9 个 Must flags 全部
  enabled，非法组合（bundle 依赖被关而自身开）fail closed 不发布。

## 3. 决策：旧文本主入口退休（默认地位）

- 第 8 步退休的是**旧文本主入口的默认地位**：默认入口从 `legacy_text_first`
  切换为 `companion_guided`；
- 旧入口**保留可访问**（`legacyEntryAvailable` 保持 true），不隐式删除或替换
  旧能力——避免破坏既有 question-first 验证与 Review Queue（见 10-5 回落语义）；
- 幂等：若默认已是 `companion_guided`，不重复操作。

## 4. 决策：Should flags 独立 shadow/canary

- 问题标记（`learning_question_markers`）、workspace Tutor
  （`tutor_workspace_expansion`）、semantic relationships
  （`semantic_relationships`）在**主列车之外单独 shadow/canary**，不属于本阶段
  DoD（10-w9 阶段退出 Gate）；
- 它们**保持独立 flag 状态**（enabled / degraded / disabled），不并入 Must
  默认 bundle，任何状态**不阻塞第 8 步**；
- Must 默认发布不强制改变 Should flags 的状态。

## 5. 决策：hard invariant 单次违规立即停止扩量

- 违规类别与回滚目标映射（§15 W9「回滚相关 flag」）：
  | 违规类别 | 回滚相关 flag |
  | --- | --- |
  | privacy | `trusted_multimodal_core`、`understanding_universe_v2` |
  | tenant | `trusted_multimodal_core` |
  | answer_leak（答案泄漏） | `trusted_multimodal_core`、`current_target_tutor`、`structured_proof_v1` |
  | trust | `trusted_multimodal_core`、`current_target_tutor` |
  | critic | `current_target_tutor`、`structured_proof_v1` |
  | schedule_invariant | `journey_routes`、`structured_proof_v1` |
- `stopScaling` 为字面量 `true`（单次违规即停止扩量）；回滚通过 rollback-drill
  的单 revision 原子关闭（相关 flag 及其反向依赖闭包一次性回滚）；同一违规重复
  演练结果一致（确定性）；
- 公测默认序列中任一违规注入 → 序列不通过（不得继续扩量、不得设默认）。

## 6. 验收与证据

- [x] Gate 通过判定引用 `RolloutStageGateV1`（public_beta_default 档）；
- [x] Must capability bundle 成为正式公测默认（单 revision、Should 独立、
      非法组合 fail closed）；
- [x] 旧文本主入口退休默认地位（保留可访问、幂等）；
- [x] Should flags 保持独立 flag 状态、不阻塞第 8 步；
- [x] hard invariant 单次违规 → 停止扩量 + 原子回滚相关 flag；
- [x] 单测 25 例全部通过；`npm run typecheck --prefix apps/api` 通过
      （TypeScript 严格模式）。

## 7. 约束级别与关联

- **约束**：Must capability bundle 成为正式公测默认；旧文本主入口退出默认；
  Should flags 保持独立 flag 状态。
- **关联契约**：10-7（RolloutStageGateV1 最终 soak）、10-5（原子关闭闭包 /
  回落语义）、01-7（Must/Should bundle）、01-5（§5.3 自主性硬 Gate）、09-7
  （hard invariants 收口）。
- **不做的边界**：本任务不接入 HTTP 路由 / 接线（能力 API 与前台状态由 10-1 /
  接线任务落地，本模块提供确定性判定与默认发布计划）；不修改其它任何文件。
