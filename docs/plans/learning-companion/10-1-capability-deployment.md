# 决策记录 10-1：capability 部署与非法组合校验（§18.1）

> 状态：**Frozen（已冻结）/ 执行**
> 阶段 10（W9）任务 10-1
> 日期：2026-08-08
> 来源：冻结记录 `01-7-feature-flags-capability-bundles.md`（§18.1 Feature Flags 与 capability bundle）；`10-w9-rollout-public-beta.md` 任务 10-1
> 约束级别：root capability 关闭的反向依赖闭包、单 config revision 原子 apply/rollback、任一节点失败整体回滚通过；运行中从不暴露非法 flag 组合。

## 1. 交付物

本任务冻结以下交付物：

- `packages/shared/src/capability-bundle.ts` —— capability bundle 契约（单一事实来源）
- `apps/api/src/modules/companion-shell/capability-deployment.ts` —— capability 部署核心（纯函数可测）
- `apps/api/src/modules/companion-shell/capability-deployment.test.ts` —— 单测
- 本决策记录

## 2. Capability 枚举（冻结）

共 18 个 capability（01-7 §2 + §4/§5 内部原子能力）：

- **Must bundle flag（9）**：`trusted_multimodal_core`、`global_companion_shell`、`companion_onboarding_v1`、`learning_session_companion`、`multimodal_voice`、`structured_proof_v1`、`journey_routes`、`understanding_universe_v2`、`current_target_tutor`
- **Should flag（3）**：`learning_question_markers`、`semantic_relationships`、`tutor_workspace_expansion`
- **内部原子能力（6）**：`scene`、`critic`、`commit`、`map`、`projection`、`grounded_answer_critic` —— 不是 rollout flag，是 bundle 原子内容与非法组合校验所需的原子（01-7 §4/§5）

## 3. bundle graph 依赖边（冻结）

完整图 `CAPABILITY_DEPENDENCY_EDGES`（直接 requires，传递闭包由部署层计算）：

| capability | requires |
| --- | --- |
| `trusted_multimodal_core` | — |
| `global_companion_shell` | — |
| `companion_onboarding_v1` | `global_companion_shell` |
| `learning_session_companion` | `global_companion_shell`, `trusted_multimodal_core` |
| `multimodal_voice` | `trusted_multimodal_core` |
| `structured_proof_v1` | `trusted_multimodal_core`, `scene` |
| `journey_routes` | `trusted_multimodal_core` |
| `understanding_universe_v2` | `trusted_multimodal_core`, `projection` |
| `current_target_tutor` | `learning_session_companion`, `trusted_multimodal_core`, `grounded_answer_critic` |
| `tutor_workspace_expansion` | `trusted_multimodal_core`, `grounded_answer_critic` |
| `scene` | `critic`, `commit` |
| `critic` / `commit` | `trusted_multimodal_core` |
| `map` | `projection` |
| `projection` | `trusted_multimodal_core` |
| `grounded_answer_critic` | `trusted_multimodal_core` |
| `learning_question_markers` / `semantic_relationships` | — |

**原子包含**（01-7 §4「原子包含…不可拆分」，bundle 开则子能力必须开）：
`trusted_multimodal_core ⊃ {critic, commit}`；`structured_proof_v1 ⊃ {scene}`；
`understanding_universe_v2 ⊃ {projection, map}`；`current_target_tutor ⊃ {grounded_answer_critic}`。

**Must bundle 图**（`MUST_BUNDLE_DEPENDENCY_EDGES`）只保留 Must 之间的边，用于根关闭闭包计算，保证与 01-7 §6 冻结闭包逐字节一致；Should 独立（不进任何 Must 关闭闭包）。

## 4. 非法组合 fail startup（01-7 §5 / §18.1）

启动时解析 bundle graph 并校验配置合法；以下非法组合必须 fail startup（`failStartupIfIllegal` 抛错 / `validateStartup` 返回 ok=false）：

- onboarding 开而 global shell 关（`companion_onboarding_v1 requires global_companion_shell`）；
- Session Companion 开而 trusted core 关（`learning_session_companion requires trusted_multimodal_core`）；
- Scene 开而 Critic/commit 关（`scene requires {critic, commit}`）；
- map 开而 projection 关（`map requires projection`）；
- Tutor 开而 Grounded Answer Critic 关（`current_target_tutor requires grounded_answer_critic`）；
- 原子包含不可拆分（bundle 开而原子子能力关）。

`fail startup` 只是防御未知非法配置的最后防线，**不是** rollout 或事故回滚机制（01-7 §7）。

## 5. required capability closure 与 runtime epoch 验证（01-7 §5）

每次外部 tool/Provider 调用及结果落库前，调用 `verifyCapabilityAccess`：

- 展开 required capability closure（完整图传递闭包，含内部原子）；
- 校验闭包内全部 capability 非 disabled；
- 校验 runtime epoch：`config.epoch` 与期望 epoch / contract snapshot epoch 一致（epoch 提升 = hard rollback）。

关闭相关 flag 后，在途 Agent 的 contract snapshot（revision + epoch + requiredCapabilities）重新验证必然失败，**不能继续该能力调用和成本**。无关 soft flag（如 `tutor_workspace_expansion`）变化不阻断 core assess/commit drain（其 closure 不含 soft flag）。

## 6. root off 反向依赖闭包与单 config revision 原子发布（01-7 §6/§7）

运行中关闭 root capability：先计算反向依赖闭包，再用**同一 config revision** 原子发布。冻结闭包：

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

`atomicOffClosure(target)` = target + Must 反向闭包 + 原子子能力 + **依赖被关能力的 Should flags**（Should 独立仅指不进冻结闭包断言 / 不被 Must 默认发布强制；依赖关闭时 Should 必须跟随，否则产生非法组合）。

同一 revision 同时更新 **capability API（states）、Provider/tool fence、前台状态**（三个发布目标 adapter，`applyAtomicCapabilityChange`）；任一节点无法应用 → 整次配置变更回滚（已应用节点逐个 rollback，返回原配置、原 revision）。

## 7. capability API（01-7 §5）

`computeCapabilityApiView` 返回每个 capability 的 `enabled / degraded / disabled + reason + policyVersion`：

- `disabled`：显式关闭（reason 透传）；
- `degraded`：显式降级，或 enabled 但 required closure 中有 degraded（传递降级）；
- `enabled`：自身与 required closure 全部非 disabled。

**运行中从不暴露非法 flag 组合**：非法配置拒绝生成 API 视图（抛内部错误），发布前非法 next 配置拒绝发布；关闭 root 后的配置始终通过 `validateConfigLegal`。

## 8. 验收证据

- `npm run typecheck --prefix apps/api` 通过（strict / noUnusedLocals / noUnusedParameters）；
- `npm test --prefix apps/api` 通过（含本任务新增 `capability-deployment.test.ts` 28 用例：非法组合 fail startup、closure 验证、反向依赖闭包、原子回滚、运行中不暴露非法组合）。

## 9. 接线说明

部署核心是纯函数（无 DB / 无网络 / 无副作用）；真实接线（DB 事务持久化 config、Provider/tool fence 下发、前台状态推送）通过 `CapabilityPublishAdapter` 注入。`packages/shared/src/index.ts` 由主代理收口导出 capability bundle 契约；收口后部署核心的相对导入可替换为 `@ailearn/shared`（semantics 不变）。
