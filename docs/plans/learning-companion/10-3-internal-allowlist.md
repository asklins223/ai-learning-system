# 决策记录 10-3：internal allowlist（§18.2 第 2 步）

> 状态：**Frozen（已冻结）**
> 执行：阶段 10（W9）任务 10-3
> 日期：2026-08-08
> 来源：`10-w9-rollout-public-beta.md` 任务 10-3（原方案 §18.2 第 2 步）+ 冻结记录 01-7（capability bundle 依赖图 / flag 列表）+ 02-5（auth-surface manifest）+ 07-1（onboarding 零副作用）
> 约束级别：**internal 用户全流程可用；0 学习写入。**

---

## 1. 交付物

- `apps/api/src/modules/companion-shell/internal-allowlist.ts`：internal allowlist 纯逻辑（数据源注入、无 IO）。
- `apps/api/src/modules/companion-shell/internal-allowlist.test.ts`：单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 启用清单（§18.2 第 2 步）

internal allowlist 中启用四项，全部为**非学习** companion shell 能力（引用 01-7 §2/§4 冻结 flag 与 bundle 原子内容）：

| 启用项 | 对应 01-7 / 冻结记录 | 原子内容 |
| --- | --- | --- |
| `global_companion_shell` | 01-7 §4 `global_companion_shell`（Must flag） | credential-safe auth manifest + 全路由 coverage registry + 全局角色/锚点/侧板 + trigger rule/双预算 + 控制状态；不依赖 learning core，无学习写入或自由模型能力 |
| `auth_manifest` | 02-5 auth-surface manifest | 随构建签名静态公开文案；credential-safe、零采集、无 Provider/ASR/TTS |
| `onboarding` | 01-7 §4 `companion_onboarding_v1`（依赖 global_companion_shell） | CAS 状态机 + 隔离 `onboarding_sample:*` + 静态 demo map；对 exposure 与全部 learning facts 为 0 副作用 |
| `static_fallback` | 01-7 §4 / 02-5 | 动画/角色静态 fallback 与 credential-safe 静态帮助；不发起 Provider/ASR/TTS |

- `INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES` 固定为以上四项；
- `resolveInternalAllowlist` 语义由 `evaluateInternalAllowlist` 实现：请求的 capability 必须是启用清单子集，清单外能力（尤其 learning Agent）一律拒绝。

### 2.2 learning Agent 与学习写入保持关闭（fail closed）

- `LEARNING_AGENT_FLAG_IDS` 引用 `./rollback-drill.ts` 的 `MUST_BUNDLE_FLAG_IDS`（01-7 §2 冻结 Must flag 列表）中的 learning 侧：
  `trusted_multimodal_core`、`learning_session_companion`、`multimodal_voice`、`structured_proof_v1`、`journey_routes`、`understanding_universe_v2`、`current_target_tutor`；
- `assertLearningAgentDisabled`：以上 flag 全部必须为 `disabled`；任一 `enabled` 或未声明（unknown）→ fail closed；
- `assertZeroLearningWrites`：本次 internal 流程产生的学习写入种类必须为空（validation/review/understanding 事件、schedule、mastery、outbox、episode_commit）→ 0 学习写入。

### 2.3 internal 用户全流程可用（§18.2 第 2 步验收）

`isInternalUserFullFlowAvailable` 判定 internal 用户的完整旅程：

- `auth_manifest_available`（credential-safe auth-surface manifest 可用）
- `global_shell_available`（全局角色/锚点/侧板 + coverage registry 可用）
- `onboarding_available`（CAS 状态机 + 示例可用）
- `static_fallback_available`（静态 fallback 可用）
- `manual_main_path_available`（原生导航与手动入口可用）

任一步骤不可用或未认证 → 全流程不可用。

### 2.4 组合判定（fail closed）

`evaluateInternalAllowlist` 全部通过才 `allowed=true`：

- internal 用户命中 allowlist；
- 请求能力 ⊆ 启用清单；
- learning Agent 全部 disabled；
- 0 学习写入；
- 全流程可用。

## 3. 决策点

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 启用清单范围 | 仅 global_companion_shell / auth manifest / onboarding / 静态 fallback | §18.2 第 2 步原文；全部无学习副作用（01-7 §4） |
| learning Agent 判定 | 引用 rollback-drill Must flag 子集；enabled/unknown 均 fail closed | 01-7 flag 图单一冻结来源；「保持关闭」强断言 |
| 学习写入 | 7 类 canonical 写路径全部为 0 | 验收「0 学习写入」 |
| 全流程可用 | 5 步骤逐项判定 + 认证前置 | 验收「internal 用户全流程可用」 |
| 纯函数 | 数据源注入、无 DB/网络/时钟/副作用/随机 | 与 companion-shell 既有模块一致 |

## 4. 验收映射

- [x] internal allowlist 启用 global_companion_shell、auth manifest、onboarding 与静态 fallback（单测断言四项清单与类型守卫）；
- [x] learning Agent 与学习写入保持关闭（`assertLearningAgentDisabled` / `assertZeroLearningWrites` fail closed；单测覆盖 enabled/unknown 违规与各学习写入拒绝）；
- [x] internal 用户全流程可用（`isInternalUserFullFlowAvailable` 5 步骤单测；缺失步骤 / 未认证均不可用）；
- [x] 0 学习写入（组合判定 + 独立断言双覆盖）；
- [x] 常量自检 `validateInternalAllowlist` 通过（learning Agent 关闭清单引用合法 Must flag；启用项不与关闭清单冲突）；
- [x] 纯函数可测：数据源注入，无 IO；
- [x] `npm run typecheck --prefix apps/api` 通过；新增测试在 `npm test --prefix apps/api` 全量中通过。

## 5. 后续衔接

- 本任务关闭 W9 阶段退出 Gate 的「internal allowlist 达到冻结 RolloutStageGateV1」条目（该档 Gate 门槛判定复用 final-soak `ROLLOUT_STAGE_GATES.internal`）；
- internal 用户身份来源由上层接线接入（本模块只判定 allowlist 逻辑）；learning Agent 与学习写入保持关闭直到 10-4 canary 档才放开。
