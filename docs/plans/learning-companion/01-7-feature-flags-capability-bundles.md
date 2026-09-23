# 冻结记录 01-7：Feature Flags 与 capability bundle（§18.1）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-7（原方案 §18.1）
> 约束级别：bundle 依赖图冻结；W9 灰度（阶段 10）按此执行。
>
> **2026-09-22 状态更正（doc 34 L34）**：下面这张依赖表**在代码里没有实现**。`packages/shared/src/capability-bundle.ts` 曾按这份记录写过一套 bundle/依赖边/状态机，但 35 个导出里 32 个对外零消费者，真正在门控的是 15 支 `COMPANION_*`/`CARD_*` 环境变量旗标，两边互不映射。那 32 个死导出已删除，只留 IPC 功能名表要用的 19 个 id。因此本文件按**历史决策记录**读，不当作现行机制的说明书；要按它落地需要先重做一次设计（谁取代谁、`CapabilityApiViewV1` 面向的 Web 端是否还存在）。

## 1. 交付物

本任务冻结以下交付物：

- flag 列表
- capability bundle 依赖图
- 根关闭闭包（root capability 反向依赖闭包）
- 服务启动校验规则
- 同一 config revision 原子发布规则

## 2. Flag 列表（原文 §18.1）

```text
trusted_multimodal_core
global_companion_shell
companion_onboarding_v1
learning_session_companion
multimodal_voice
structured_proof_v1
journey_routes
understanding_universe_v2
current_target_tutor

# Should
learning_question_markers
semantic_relationships
tutor_workspace_expansion
```

## 3. 服务端能力真相与未登录 auth-surface manifest 规则

- 服务端是能力与 rollout 的唯一真相；
- authenticated Web 读取 API capability；
- 未登录页**只读**服务端签名的公开 auth-surface capability manifest；
- Web 不拥有独立构建时业务默认。

## 4. Capability bundle 依赖表（原子内容与依赖）

依赖关系固定为：

| capability bundle | 原子内容与依赖 |
| --- | --- |
| `trusted_multimodal_core` | Session/Episode + universal `text_or_mixed` fallback + artifact + 双 Critic + reducer + existing-domain commit + outbox；不可拆分 |
| `global_companion_shell` | credential-safe auth manifest + 全路由 coverage registry + 全局角色/锚点/侧板 + minimal Trigger Context → on-demand Page Context + trigger rule/双预算/lease + 控制状态 + origin/focus 恢复 + context-off/hidden/off 零监听/调用；不依赖 learning core，无学习写入或自由模型能力 |
| `companion_onboarding_v1` | 依赖 `global_companion_shell`；原子包含隔离 `onboarding_sample:*` assets、deterministic demo Card/Scene renderer、静态 demo map 与 CAS 状态机；可跳过/暂停/恢复/重播，对 exposure 与全部 learning facts 为 0 副作用，不依赖正式 Scene/map core |
| `learning_session_companion` | 依赖 `global_companion_shell + trusted_multimodal_core` 与 public typed action gateway；只有该 bundle 可把伴星升级到 Session 动作，不提供 core-off 半可写模式 |
| `multimodal_voice` | 依赖 `trusted_multimodal_core`（已原子包含 text fallback）、ASR/TTS policy 和对象存储；public-beta Must 集合另要求 `structured_proof_v1` 达到 coverage Gate |
| `structured_proof_v1` | 依赖 `trusted_multimodal_core`、Scene safety、deterministic scorer、SilentProofProfile eligibility 和完整 mastery bundle |
| `journey_routes` | 依赖 `trusted_multimodal_core` 与 official scheduler adapter；FSRS shadow 不是依赖 |
| `understanding_universe_v2` | 依赖 `trusted_multimodal_core` 的 canonical outbox projection；projection 关闭不影响 canonical facts |
| `current_target_tutor` | 依赖 `learning_session_companion + trusted_multimodal_core` 的原子 practice transition；原子包含 Grounded Answer Critic + supported-segment filter；不依赖 formal assessment 预算 |
| Should bundles | question marker 独立 user-private；semantic relation 依赖完整 Relationship Governance；workspace Tutor 依赖授权检索与 Grounded Answer Critic |

## 5. 服务启动校验与非法组合 fail startup 规则

- 服务启动**解析 bundle graph**；
- 非法组合**必须 fail startup**，包括（等）：
  - onboarding 开而 global shell 关；
  - Session Companion 开而 trusted core 关；
  - Scene 开而 Critic/commit 关；
  - map 开而 projection 关；
  - Tutor 开而 Grounded Answer Critic 关。
- capability API 返回 `enabled / degraded / disabled + reason + policyVersion`；
- 每次外部 tool/Provider 调用及结果落库前，**重新验证** contract 的 required capability closure 与 runtime epoch；
- 关闭相关 flag 后，在途 Agent **不能继续**该能力调用和成本。

## 6. 根关闭闭包（两个 off 级联图，原文 §18.1）

运行中关闭 root capability 时，先计算反向依赖闭包再用同一 config revision 原子发布：

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

## 7. 同一 config revision 原子发布规则

- 同一 revision **同时更新** capability API、Provider/tool fence 与前台状态；
- 任一节点无法应用，则**整次配置变更回滚**；
- `fail startup` 只是防御未知非法配置的**最后防线**，**不是** rollout 或事故回滚机制。

## 8. 验收标准

- bundle 依赖图冻结；
- W9 灰度（阶段 10）按此执行。
