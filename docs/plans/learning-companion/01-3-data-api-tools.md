# 冻结记录 01-3：数据、API 与工具边界（§12）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-3（原方案 §12）
> 约束级别：canonical event ADR 批准；API 方向与权限矩阵冻结；W1（阶段 02）以此实现 schema/RLS/端点。

**交付物**：数据归属矩阵、canonical event ADR 批准、数据对象清单、API 方向、actor 权限 allowlist、事件与幂等规则。

---

## 1. 数据归属矩阵（§12.1）

以下为各类数据的归属域完整列表（要点，完整表格见原方案 §12.1）：

- **published Card / Key Point / Evidence / 血缘** → workspace-owned。
- **onboarding offer/run、`global_off`、存在感与 suppression** → account-scoped user-private（不使用 workspace RLS，跨设备同步）。
- **页面/target 邀请 ledger、任务 resume 与 workspace entity refs** → user-private-in-workspace（跨 workspace 清空）。
- **Companion page/action audit** → user-private（短 TTL、导出/删除、去关联，不进入增长画像）。
- **`temporary_hidden` 与未登录 auth-surface hide** → device-local non-identifying。
- **session contract / probe / response / audio / transcript** → user-private-in-workspace。
- **assessment / assistance / validation / review outcome** → user-private-in-workspace（canonical 结果沿用现有域）。
- **personal mastery / facet projection** → user-private-in-workspace（可重算）。
- **问题标记（Should）与短期 practice 航迹** → user-private-in-workspace。
- **semantic relation candidate / published（Should）** → workspace-owned + 审核权限。
- **Agent task/event** → 按 run/session 隔离，不存 private chain-of-thought。

**Agent 隔离原则**：Generation Agent 无权读 user-private 学习数据；Learning Agent 无权读 generation staging。

---

## 2. 数据对象（§12.2）

W0 必须先批准 **canonical event ADR**；原则是：**Session 对象负责证明过程，现有 validation/review 域继续负责正式学习结果**。

### 2.1 过程对象与唯一 facet 扩展

| 对象 | 归属/职责 |
| --- | --- |
| `user_companion_onboarding` | account-scoped |
| `user_companion_account_state` | account-scoped |
| `companion_runtime_fences / active_surface_leases` | ephemeral |
| `companion_invitation_ledger` | workspace-scoped |
| `learning_sessions` | 过程对象 |
| `learning_episodes` | 过程对象 |
| `learning_session_probes` | 过程对象 |
| `learning_response_artifacts` | 过程对象 |
| `learning_assessment_reports` | 过程对象 |
| 扩展既有 `validation_point_assessments` | `canonical_facet_observation` 的唯一 canonical facet fact |
| `user_capability_projection` | 投影 |
| `user_learning_preferences` | 投影 |

### 2.2 `PageCompanionContextV1` 审计限制

- `PageCompanionContextV1` 是短生命周期页面能力快照，**不作为用户行为录像持久化**。
- 审计最多保留 page/action/entity opaque IDs、context/permission hashes、版本和结果；**不保存整页内容/DOM/截图/凭据/未提交输入**。
- onboarding、audit 与邀请 ledger **不能进入** mastery、official scheduler、路线难度、人格/兴趣画像、增长分群或跨 workspace analytics。
- 所有 entity-bearing Companion audit/ledger 纳入 user-private 导出与分级删除；原始 entity refs 只保留到冷却/idempotency/retry 所需最短期限，**默认上限建议 30 天并在 W0 由 privacy owner 冻结**；到期后删除或替换为不可逆、content-free 的预算 tombstone。
- `suppressedSuggestionClassIds` 作为用户显式选择可持续保存但**不携带 target**；安全保留例外须单独 policy、可见期限和访问审计。

### 2.3 旧域 adapter 规则（`existing-domain-multimodal-adapter-v1`）

- 正式 overall outcome、attempt 和 schedule 必须落入现有 `validation_events`、`review_attempts`、`understanding_events` 及其现行权威表/枚举；facet projection 只读扩展后的 `validation_point_assessments`；两者均通过同事务 outbox 派生 capability/map projection。
- **不得新增 `understanding_evidence_events` 作为平行 canonical 真相**。
- 若 ADR 发现必须替换现有事实，则给出 backfill、双读比对、cutover、回滚和 contract migration，并保持相同 schedule 只由一个写路径消费。
- `existing-domain-multimodal-adapter-v1` 在 W0 冻结：非文本 Artifact 在旧域只存 opaque artifact ref/hash、render summary 和 point assessments，**不把 graph/order/repair JSON 伪装进 `userAnswer`**；历史 API/UI 通过 adapter 展示可读摘要并跳转私有 artifact；input uniqueness 使用 artifact content hash + probe/version；redaction 级联清理旧域中的任何 answer copy。

### 2.4 Should 才新增对象

- `learning_questions`。
- relation candidate / review / version 表。
- 未来 `user_relation_understanding`。
- 旧 question-first 与新 Episode 的 **canonical compatibility matrix 必须在 W0 冻结**；数据库约束保证二者不能同时消费同一 pending schedule。

---

## 3. API 方向（§12.3）

### 3.1 端点清单（原文）

```text
POST   /learning-sessions
GET    /learning-sessions/:id                         # 仅 public view
POST   /learning-sessions/:id/episodes/:episodeId/probes/:probeId/responses
POST   /learning-sessions/:id/episodes/:episodeId/responses/:artifactId/confirm-and-lock
POST   /learning-sessions/:sid/episodes/:eid/probes/:pid/enter-practice
POST   /learning-sessions/:sid/episodes/:eid/probes/:pid/tutor-detours # 当前 target、有界、practice-only
POST   /learning-sessions/:id/continue                 # 用户确认进入下一 Episode
POST   /learning-sessions/:id/end                     # 用户意图；不是 mastery commit
GET    /learning-sessions/:id/stream
GET    /understanding/universe
PATCH  /me/learning-preferences
GET    /me/companion
PATCH  /me/companion                                 # revision CAS；账号级开关/存在感/suppression 与隐私控制
POST   /me/companion/onboarding/:version/transition  # 带 revision/runId CAS；用户动作可跳过、暂停、恢复与重播
POST   /me/companion/runtime-fences                   # 短 TTL device-session fence；不持久化 device-local preference
POST   /me/companion/page-actions/:actionId/confirm  # 导航或写入动作的显式确认；服务端重验页面上下文

# Should flags
POST   /learning-questions
PATCH  /learning-questions/:id
```

- **不存在**脱离 Session 的 `/learning-companion/grounded-answer` 或无限 message API。
- practice/Tutor/confirm-and-lock 请求 body 必须含 `contentExposureKey + baseRevision + userActionNonce + requestHash`，服务端按 URL 身份重算并拒绝不一致。

### 3.2 鉴权作用域拆分规则

- **`/me/companion` 与 onboarding transition**：认证 `user_id` + account authorization + revision CAS，**不进入 workspace transaction/RLS**。
- **runtime-fence**：只接受当前认证 user + device session + 单调 surface epoch。
- **Learning Session 与 workspace-scoped page action**：workspace transaction + user/workspace RLS。
- **account、workspace 或其他领域 page action**：最终由所属 domain service 按真实作用域重新鉴权；**不能统一套 workspace RLS，也不能信任 Shell 声称的 scope**。
- public DTO 使用显式 allowlist、`private/no-store` 与 DOM/RSC/prefetch/cache 泄漏测试。
- 注册/登录页角色与帮助来自随构建签名的 auth-surface manifest，不依赖 authenticated API，不发起 LLM/ASR/TTS/个性化预取。
- 页面 action 请求必须携带 `pageInstanceId + contextVersion + permissionSnapshotHash + impactPreviewHash + userActionNonce + idempotencyKey + requestHash`。

---

## 4. 权限与工具 allowlist（§12.4，禁止清单）

完整 actor 矩阵见原方案，此处为**禁止清单**：

- 任意 SQL、shell、文件系统、HTTP 和插件。
- 全局伴星后台截屏、环境监听、持续麦克风、DOM/credential/clipboard 读取。
- 动态生成并执行前端代码。
- 读取跨 workspace/user artifact。
- Supervisor runtime、Companion、Tutor 和客户端在 trusted 回答前读取或返回 hidden rubric/expected concept/evidence（Scene Author 仅能在隔离 server-side staging 读当前 target 所需字段，无 public action 工具）。
- 直接写 mastery、schedule、published semantic relation 或 canonical Card。
- child Agent 再 spawn Agent。
- 提高预算、延长无限会话或跳过 Critic。

---

## 5. 事件与幂等（§12.5）

- **onboarding offer/run 与 account Companion state** 使用 user + version/revision CAS。
- **context/reason 双预算、`activeSuggestionLease` 与一次性 permit** 在一个事务中原子签发；重复触发/跨设备旧写/迟到 dismiss 不得回退终态或重复展示。
- **session、probe、artifact、tool call、assessment 和 commit 具有稳定幂等键**。
- **一次 provider/job attempt 最多一次外部模型调用**。
- **side-effect tool** 在同一事务记录 tool-result event 和 staging mutation。
- **事件 payload** 只存 schema action、IDs、hash、版本、计数、usage 和安全摘要，**不存 raw chain-of-thought**。
- **相同 canonical event stream 重放**必须得到相同 mastery、facet 和星图投影 hash。
- **onboarding/邀请/页面 action 使用独立产品事件域**，学习事实重放忽略该事件域。

---

## 6. 验收标准

- canonical event ADR 批准。
- API 方向与权限矩阵冻结。
- W1（阶段 02）以此实现 schema/RLS/端点。
