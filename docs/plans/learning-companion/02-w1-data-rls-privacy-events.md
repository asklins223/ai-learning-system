# 阶段 02（W1）：数据、RLS、隐私与事件底座

> **第一层执行顺序第 2 步**
> 前置：阶段 01（W0 冻结）
> 后置：阶段 04（W3）与阶段 06（W5）的数据前置（Generation → Learning Handoff Gate 与 multimodal legacy adapter Gate 通过）
> 可与阶段 03（W2 Runtime）并行
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W1」；规范依据：§12（数据/API/工具）、§13.3（RLS）、§5.4.3（onboarding 状态）、§5.8（记忆）、§0.3（handoff contract）、§7.6（exposure）、§5.2（动画引擎 spike）。

---

## 本阶段目标

把 W0 冻结的合同落到 schema、RLS、迁移、事件底座与两个 adapter 上，让后续 W3/W5 有可依赖的数据层。

## 可并行执行的任务（第二层）

### 任务 02-1：数据 schema 与迁移（§12.2）

**交付物**：account/workspace/device 三类状态表、session/episode/probe/artifact/assessment/prefs schema、migration fresh/upgrade/repeat/restore。

**任务内容（原文 §12.2，W1 bullet）**：

- account-scoped onboarding/Companion state、workspace-scoped invitation/resume ledger、session/episode/probe/artifact/assessment/prefs schema，以及 device-local hide + ephemeral runtime-fence contract；
- 数据对象清单（W0 已冻结）：`user_companion_onboarding`（account-scoped：version、monotonic offer status/disposition、revision CAS、active run、scoped resume token 与主动重播记录）、`user_companion_account_state`（account-scoped：revision/epoch CAS、global enabled/off、presence、suggestion pause/suppression、动画/语音和通知边界）、`companion_runtime_fences / active_surface_leases`（ephemeral：user + device session + surface/account epoch + TTL；不存 page/entity/content）、`companion_invitation_ledger`（workspace-scoped：`stablePageContextKey/contextBudgetKey/reasonBudgetKey`、bounded reason、cooldown epoch、展示与 dismiss）、`learning_sessions`、`learning_episodes`（单 Key Point target、input schedule generation、runtime/policy epoch、commit key 和状态）、`learning_session_probes`、`learning_response_artifacts`（不可变多模态 payload、hash、lock、assistance snapshot）、`learning_assessment_reports`（Critic version、逐 RubricTarget artifact/evidence binding 和 verdict；是支撑证据不是第二套 canonical outcome）、扩展既有 `validation_point_assessments`（probe、artifact、facet、trust、assessment report、interaction refs；`canonical_facet_observation` 的唯一 canonical facet fact）、`user_capability_projection`、`user_learning_preferences`（显式学习偏好与建议偏好分离；不与 account-scoped Companion 开关或 device-local hidden 混表）；
- `PageCompanionContextV1` 是短生命周期页面能力快照，不作为用户行为录像持久化；审计最多保留 page/action/entity opaque IDs、context/permission hashes、版本和结果，不保存整页内容、DOM、截图、凭据或未提交输入；
- migration fresh/upgrade/repeat/restore 全部覆盖。

**验收**：fresh/upgrade/repeat/restore 迁移通过；字段与 W0 冻结语义一致。

---

### 任务 02-2：RLS 矩阵与权限边界（§13.3）

**交付物**：workspace-owned 与 user-private RLS 矩阵、account-scoped 表授权、device-local 不落库。

**任务内容（原文 §13.3 + §12.1）**：

- 共享知识真值继续使用 workspace-owned 策略；
- account-scoped Companion 表（onboarding、account state）只按认证 user_id 授权，禁止 workspace actor 和其他用户读取；不使用 workspace RLS，跨设备同步；
- workspace-scoped Companion/学习表（邀请 ledger、resume、session/episode/probe/artifact/assessment、prefs/projection）使用 workspace_id + user_id 双条件 RLS；
- device-local hide 不写持久表；runtime-fence 仅保留 user/device session/surface epoch/TTL（ephemeral）；
- `PageCompanionContextV1`、页面 manifest 和 action token 做 schema、版本、签名/来源、workspace、permission snapshot、contextVersion 与 allowlist 校验；页面切换后 stale action fail closed；
- workspace/角色切换原子清空全局任务上下文；跨 workspace entity refs、onboarding resumeRef 和邀请 key 不得复用；
- 数据归属矩阵（§12.1）逐表落库：published Card/Key Point/Evidence/血缘 → workspace-owned；onboarding/global_off/存在感/suppression → account-scoped；邀请 ledger/resume → user-private-in-workspace；Companion audit → user-private + 短 TTL；`temporary_hidden`/auth-surface hide → device-local non-identifying；正式 outcome → 现有 canonical 域。

**验收**：account/workspace/device 三类状态权限正确；跨 workspace/user 泄漏为 0。

---

### 任务 02-3：onboarding 状态机与跨设备同步（§5.4.3 + §12.5）

**交付物**：`CompanionOnboardingStateV1` CAS 实现、scoped resume token、manual replay、global off/presence/suppression 跨设备同步、SSE/WebSocket epoch 撤销 + lease fail-closed、device runtime-fence。

**任务内容（原文 §5.4.3 状态定义与规则、§12.5）**：

```ts
type CompanionOnboardingStateV1 = {
  onboardingVersion: string;
  revision: number;
  offerStatus: "not_offered" | "offered" | "consumed";
  offerDisposition?: "completed" | "skipped";
  activeRun?: {
    runId: string;
    entryMode: "first_run" | "manual_replay" | "migration_intro";
    runStatus: "in_progress" | "paused";
    stepId: string;
    resumeTokenRef: string;
    resumeWorkspaceRef?: string;
    expiresAt: string;
  };
  lastRun?: {
    entryMode: "first_run" | "manual_replay" | "migration_intro";
    disposition: "completed" | "skipped" | "abandoned";
    at: string;
  };
  updatedAt: string;
};
```

规则：自动欢迎资格严格等于 `offerStatus=not_offered` 且未命中 auth-local hide；渲染前必须先 CAS `not_offered → offered` 并取得一次性 display permit，只有获胜设备/标签页可展示；CAS 成功后即使客户端首帧前崩溃，`offered/paused/abandoned` 也不得再次自动展开，只提供被动恢复入口；`offerStatus=consumed` 是该版本单调终态，完成或跳过通过服务端 revision CAS `offered → consumed` 并写 disposition，刷新/重登/前后跳转/并发设备/旧请求不能回退；用户主动重播只创建 `entryMode=manual_replay` 独立 run，绝不改变 consumed；暂停只写 `runStatus=paused` 不会自动展开，至多按独立恢复预算展示一次被动续接入口；`resumeTokenRef` 绑定 user、可选 workspace、onboardingVersion、runId、base revision 与 expiry；跨 workspace 只同步账号级 offer 终态，不复用上一 workspace 的 resume token；新版本只有在核心心智或关键交互实质变化时才允许一次轻量更新说明；首次欢迎预算与普通页面邀请预算分开持久化；麦克风/通知/文件/跨 workspace 检索等权限只在实际动作发生时逐项请求，拒绝后立即提供等价路径。

`companion_onboarding_v1` 原子包含隔离的 sample assets、确定性 Card/Scene renderer 和静态 demo map，不依赖正式 Scene Runtime、Generation Supervisor 或 `understanding_universe_v2`；自己的材料入口仅在对应 import/generation capability 可用时展示，并在跳转前终止 onboarding sandbox。

账号级状态（global off/presence/suppression）跨设备同步、SSE/WebSocket epoch 撤销 + lease fail-closed、device runtime-fence：`temporary_hidden` 的持久布尔值只留设备本地；authenticated 客户端另发送不写账号偏好的短生命周期 `deviceSessionId + surfaceEpoch` runtime-fence，请求服务端取消该设备尚未开始或可取消的 Companion 调用；`global_off` 通过 `/me/companion` 做 account revision CAS 并向全部 active device session 广播 fence；两者的迟到 Companion 结果一律丢弃。

幂等（§12.5）：onboarding offer/run 与 account Companion state 使用 user + version/revision CAS；context/reason 双预算、`activeSuggestionLease` 与一次性 permit 在一个事务中原子签发，重复触发、跨设备旧写和迟到 dismiss 不得回退终态或重复展示；onboarding/邀请/页面 action 使用独立产品事件域，学习事实重放忽略该事件域。

**验收**：onboarding consumed 不回退；邀请双预算不重复；多标签/多设备 CAS 竞争通过；跨 workspace 不越界。

---

### 任务 02-4：Companion audit/ledger 与隐私生命周期（§5.8 + §12.2）

**交付物**：audit/ledger 用途隔离、entity-ref TTL、content-free tombstone、导出/删除与全存储残留扫描。

**任务内容（原文 §12.2 审计规则 + §5.8）**：

- Companion page/action audit 仅用于安全、幂等、预算与用户支持；有短 TTL、导出/删除和去关联边界，不进入增长画像、兴趣推断或跨 workspace analytics；
- 原始 entity refs 只保留到冷却/idempotency/retry 所需最短期限，默认上限建议 30 天并在 W0 由 privacy owner 冻结；到期后删除或替换为不可逆、content-free 的预算 tombstone；
- `suppressedSuggestionClassIds` 作为用户显式选择可持续保存但不携带 target；安全保留例外须单独 policy、可见期限和访问审计；
- 用户删除后对数据库、cache、队列和分析副本做残留扫描；不能因删除 ledger 自动重新邀请或把拒绝行为重建为画像；
- 伴侣记忆边界（§5.8）：允许保存 versioned onboarding 单调 offer consumed/disposition、account-scoped global off/presence/suppression、workspace-scoped 邀请预算、device-local hidden/page control（不做服务端偏好持久化）、显式偏好、canonical 理解投影与复习事实摘要引用、用户主动保存的问题标记（Should）与学习目标、明确喜欢/不喜欢/拒绝的互动方式、已发生的 assistance/stale/exposure 事实；禁止保存 private chain-of-thought、凭据/验证码/token/剪贴板/后台截图/未提交敏感表单、未经确认的心理画像或人格判断、永久学习风格标签、以口音/语速/停顿/操作速度推断能力、通过情绪数据静默改变难度/掌握/调度；
- 短 TTL 的 page/action audit 与 invitation ledger 是安全和幂等记录，不是伴星"记住了用户"；必须进入导出/删除。

**验收**：TTL expiry 与 tombstone 生效；全存储残留扫描通过；导出覆盖率 100%。

---

### 任务 02-5：auth-surface manifest 与 credential 零采集（§12.3 + §13.3）

**交付物**：随构建签名的 auth-surface manifest、credential 页零采集验证、未登录角色不依赖 authenticated API 或任何模型 Provider。

**任务内容（原文 §12.3/§13.3，W1 bullet）**：

- 注册/登录页的角色、公开说明和错误帮助来自随构建签名的 auth-surface manifest，不依赖 authenticated API，也不发起 LLM、ASR、TTS 或个性化预取；
- 任意 `sensitivity=credential` 页面（无论未登录还是已登录）只能使用签名静态 allowlist 和 `static_help/silent_anchor/transitional` surface：`visibleEntityRefs/selectedEntityRefs` 必须为空，LLM/ASR/TTS、Companion 预取、DOM/selection observer 和个性化 context 为 0；字段焦点、长度、粘贴、自动填充、校验时序和输入节奏也不得被收集；伴星最多读取归一化页面状态与不暴露账号是否存在的通用错误码；
- 未登录页为尊重"隐藏伴星"最多保存一个设备本地布尔值，不关联 user/workspace、登录标识、错误历史或学习数据；清除站点数据即可移除；
- 未登录角色不依赖 authenticated API 或任何模型 Provider。

**验收**：credential 页输入值及字段交互元数据进入 Companion DTO、日志、analytics、截图、模型或持久上下文为 0；Provider/observer 调用为 0。

---

### 任务 02-6：Generation → Learning handoff adapter（§0.3）

**交付物**：真实 published row → `PublishedLearningAssetContractV1` 转换器；required 缺失 fail closed；`cardRevision` 来自 active Card Set/revision 权威字段；contract version/hash 与替换/stale 集成测试。

**任务内容（原文 §0.3）**：

- 只消费 required canonical 字段：Card、Key Point、claim、exact evidence、semantic support、source fingerprint、active/superseded 生命周期；`cognitiveType` 与 interaction affordance 只是 optional hint；
- Candidate Ledger、relation hints、private draft 和未 Publish 产物一律 forbidden；optional 字段缺失时只使用通过 Gold 的安全 Scene fallback；
- active Card Set 被替换或 source fingerprint 改变时，所有未提交 Episode stale；历史结果保留原版本引用；
- contract hash、替换/stale 和 forbidden-field 负向测试是 Generation → Learning 集成 Gate。

**验收**：Generation → Learning Handoff Gate 通过（作为 W3/W5 前置）。

---

### 任务 02-7：existing-domain-multimodal-adapter-v1（§12.2）

**交付物**：非文本 artifact ref/摘要、历史 reader、input uniqueness 和 redaction cascade。

**任务内容（原文 §12.2）**：

- 非文本 Artifact 在旧域只存 opaque artifact ref/hash、render summary 和 point assessments，不把 graph/order/repair JSON 伪装进 `userAnswer`；
- 历史 API/UI 通过 adapter 展示可读摘要并跳转私有 artifact；
- input uniqueness 使用 artifact content hash + probe/version；
- redaction 会级联清理旧域中的任何 answer copy；
- 旧 question-first 与新 Episode 的 canonical compatibility matrix 冻结；数据库约束保证二者不能同时消费同一 pending schedule。

**验收**：multimodal legacy adapter Gate 通过；旧 question-first/new Episode schedule 唯一消费约束与读写兼容。

---

### 任务 02-8：learning_unit_exposure aggregate/guard（§7.6）

**交付物**：`learning_unit_exposure` aggregate 与 learning-unit guard，供 legacy question-first 与新 Episode 共同读写。

**任务内容（原文 §7.6）**：

- 稳定的 exposure 键：

```text
contentExposureKey = H(workspaceId, userId, keyPointId,
  publishedContentRevision, normalizedClaimHash, sortedEvidenceContentHashes)
```

不得包含 Scene、rubric、provider、model 或 assistance policy 版本；
- `enter-practice/reveal` 与 `confirm-and-lock/submit` 锁同一 `(workspaceId, userId, contentExposureKey)` learning-unit guard 和当前 probe row，固定锁序并使用 user action nonce；
- exposure 跨页面、设备、Session、Scene/policy rollover 和重开持久；共享 evidence 通过确定性 dependency ledger 传播到受影响的 content exposure keys；
- 旧 question-first 与新 Episode 读写同一 aggregate 和 guard，不能靠切换入口重置。

**验收**：legacy reveal → new Episode lock、new reveal → legacy submit、Scene/Rubric/policy rollover 三组共享 `contentExposureKey` 竞态正确。

---

### 任务 02-9：canonical 事件、投影与重放（§12.2/§12.5）

**交付物**：append-only canonical fact、deterministic projection、drift replay、outbox 派生 projection。

**任务内容（原文 §12.2/§12.5，W1 bullet）**：

- 正式 overall outcome、attempt 和 schedule 落入现有 `validation_events`、`review_attempts`、`understanding_events` 及其现行权威表/枚举；facet projection 只读扩展后的 `validation_point_assessments`；两者均通过同事务 outbox 派生 capability/map projection；不得新增 `understanding_evidence_events` 作为平行 canonical 真相；
- append-only canonical fact、deterministic projection 和 drift replay；
- 事件 payload 只存 schema action、IDs、hash、版本、计数、usage 和安全摘要，不存 raw chain-of-thought；
- 相同 canonical event stream 重放必须得到相同 mastery、facet 和星图投影 hash；
- 若 ADR 发现必须替换现有事实，在编码前给出 backfill、双读比对、cutover、回滚和 contract migration，并保持相同 schedule 只由一个写路径消费。

**验收**：相同事件重放 hash 一致；projection 关闭时旧 reader 仍可读 pending schedule、attempt 和结果。

---

### 任务 02-10：二维角色状态机引擎 spike（§5.2）

**交付物**：Rive 或同等引擎在许可证、包体、帧率、离线缓存、Canvas 叠加、读屏与静态降级上的评估结论。

**任务内容（原文 §5.2）**：

- 首版动画资产使用可交互的二维骨骼/矢量状态机，不是 GIF、长视频或由 LLM 实时生成的角色动作；
- 并行完成引擎 spike，评估 Rive 或同等方案在许可证、包体、帧率、离线缓存、Canvas 叠加、读屏与静态降级上的适配；
- 不让引擎选择反向修改视觉状态合同：`CompanionVisualStateV1`、typed-action 映射和静态 fallback 不能绑定到供应商私有语义；
- `reduced-motion` 下取消飞行、弹性缩放、视差和持续漂浮，改用角色姿态切换、短淡入、描边与静态路线；读屏路径必须提供等价状态文本。

**验收**：引擎选型结论 + 静态 fallback 方案；`CompanionVisualStateV1` 不因引擎改变。

---

## 阶段退出 Gate（02 / W1）

- [x] account/workspace/device 三类状态权限正确，跨 workspace/user 泄漏为 0（任务 02-2：RLS 矩阵 0075 双条件收紧 + account 表 user 隔离 + GRANT 最小权限）。
- [x] onboarding consumed 不回退、邀请双预算不重复（任务 02-3/02-4：CAS 状态机 + 双预算+lease+permit 单事务签发）。
- [x] 相同事件重放 hash 一致（任务 02-9：deterministic replayProjection + drift 检测）。
- [x] Generation → Learning Handoff Gate 与 multimodal legacy adapter Gate 通过（任务 02-6/02-7：contract hash/替换-stale/forbidden 负向测试 + compatibility matrix；作为 W3/W5 前置）。
- [x] 角色动画引擎 spike 完成且不反向修改视觉合同（任务 02-10：Rive 选型 + 降级层，CompanionVisualStateV1 不绑定供应商语义）。

通过后进入阶段 04（W3）前置满足；本阶段与阶段 03（W2）并行完成。
