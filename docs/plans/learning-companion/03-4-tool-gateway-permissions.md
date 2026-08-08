# 决策记录 03-4：Tool Gateway 与权限隔离（§12.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 03（W2）任务 03-4
> 日期：2026-08-08
> 来源：`03-w2-session-supervisor-runtime.md` 任务 03-4（原方案 §12.4）
> 约束级别：actor 越权尝试全部被网关拒绝；prompt-injection 对抗集通过；public DTO 零 private 字段。

---

## 1. 交付物

- `workers/ai-worker/src/learning-agent/tools/gateway.ts`：LearningToolGateway 完善——
  - `executeTool` 增加 **epoch 重比较**（执行前从 epochProvider 重新读取
    runtimeEpoch + episodeEpoch，缺失/失配 → `epoch_mismatch`，fail-closed）；
  - public DTO serializer：`serializePublicSceneContract` / `serializePublicSessionView`
    （显式 allowlist 输出）+ 通用 `sanitizePublicPayload`；
  - prompt-injection 防护：`validateToolArguments`（ID 字段 allowlist + HTML/JS
    脚本形态标记拒绝）。
- `workers/ai-worker/src/learning-agent/tools/gateway.test.ts`：34 例单测
  （node:test + assert，`node --import tsx --test` 全绿）。
- 本文件：决策记录。

实现边界：真实工具副作用 executor（staging 写入、幂等键、tool-result 事件同事务记录，
01-3 §5）仍由后续任务实现；`executeTool` 对合法工具返回 `not_implemented`，
**全程 0 canonical write**（epoch 校验与 DTO 序列化为完整实现）。

## 2. actor 工具 allowlist 矩阵（9 角色 × 允许工具摘要）

网关执行顺序（03-4/03-6）：**① allowlist 校验（默认拒绝）→ ② epoch 重比较 →
③ 幂等键要求 → ④ 副作用 executor（当前 not_implemented）**。越权与未知工具在 ①
被确定性拒绝；forbidden product actions 对任意 actor 一律拒绝。

| # | actor | 允许工具摘要（allowlist） | 核心禁止项 |
|---|-------|--------------------------|-----------|
| 1 | Session Supervisor | `read_purified_contract_summary`、`propose_bounded_route`、`propose_probe`、`propose_episode_ready`、`propose_end`、`focus_nodes`/`draw_route`/`stage_scene` | lock/submit/enter-practice/commit、读 hidden rubric/solution/evidence、读内容性 gap 后继续 formal、代签评估、签发 trust、直接写 mastery/schedule/Card |
| 2 | Scene Author | `read_published_claim_evidence`、`read_private_rubric_staging`、`submit_scene_staging`（0 canonical write） | 读用户回答、激活/展示 Scene、跨 target 检索、签发 trust/outcome、写 canonical Card/relation/schedule |
| 3 | Session Companion Renderer | **无工具 allowlist**（不注册为可执行 actor，仅呈现 public typed actions / 收集 nonce / 恢复 origin） | 读 private contract/solution、自由发工具、替用户确认 |
| 4 | Grounded Tutor | `read_current_target_evidence`、`render_evidence_card`、`render_current_target_scene`、`offer_short_explanation` | formal assessment、跨 target 无限搜索、写 mastery/schedule/Card/relation、读 hidden rubric/solution/个人理解状态 |
| 5 | Grounded Answer Critic | `read_tutor_segment`、`read_allowlisted_evidence_premises`、`read_support_mode`、`submit_support_verdict` | 扩大检索、改写回答、formal assessment、写学习事实 |
| 6 | Rubric/Scene Critic | `read_private_scene_staging`、`submit_scene_critic_verdict` | 展示给用户、辅导/出题、签发生效业务 outcome、修改 staging/artifact、跳过本 Critic |
| 7 | Assessment Critic | `read_locked_artifact`、`read_rubric_target`、`read_evidence_refs`、`submit_assessment_verdict` | 生成 probe、修改 artifact、输出 mastery/interval/总体 outcome |
| 8 | Scene Activation Service（deterministic） | `activate_scene_contract`（唯一激活权限，exactly-once） | 内容生成、修复、跳过 Critic、改变 trust ceiling |
| 9 | Deterministic Core（deterministic） | `dispatch_independent_assess`、`lock_response_artifact`、`run_rubric_reducer`、`existing_domain_commit`、`record_outbox`、`consume_schedule` | 开放式生成、替用户表达意图 |

跨 actor 通用禁止（01-3 §4 / 03-4）：任意 SQL/shell/文件系统/HTTP/插件不在 manifest
中网关层面不可达；伴星后台截屏/环境监听/持续麦克风/DOM/credential/clipboard 读取禁止；
动态生成并执行前端代码禁止（模型只能返回 typed spatial actions，§5.3）；读取跨
workspace/user artifact 禁止；child Agent 再 spawn Agent 禁止；提高预算/延长无限会话/
跳过 Critic 禁止。

落地：六个 LLM 角色 allowlist 来自 `roles/*.ts` 工厂的 `allowedToolIds`；两个
deterministic 角色内联在网关；forbidden product actions 来自 `types.ts`
`FORBIDDEN_LEARNING_TOOL_IDS`（`enter-practice`/`confirm-and-lock`/`submit`/`commit`）。

## 3. public DTO 边界（零 private 字段）

- **私有字段集合** `PUBLIC_DTO_FORBIDDEN_FIELDS`：`expectedTargetRef`、
  `privateSolutionHash`、`rubricTargets`、`schedulingDecision`、`assistanceSnapshot`
  —— 任何 public DTO 绝不输出（Private Episode、RubricTarget、solution 与 Provider
  policy 只供服务端内部 actor 读取，01-2 §5）。
- `sanitizePublicPayload(payload, allowlistKeys)`：仅输出 allowlistKeys 内字段；始终
  剔除私有字段（即使 allowlistKeys 误含私有字段名也不输出）；缺失（undefined/null）
  即省略。
- `serializePublicSceneContract`：只输出 `PUBLIC_SCENE_CONTRACT_KEYS`（sceneId /
  probeId / sceneTemplate / sceneVersion / publicPayloadHash / disclosureProfileHash /
  templateTrustCeiling）；必需字段缺失 → 抛错（fail-closed，拒绝输出不完整视图）。
- `serializePublicSessionView`：只输出 `PUBLIC_SESSION_VIEW_KEYS`（sessionId / status /
  currentPhase / routeSummary / episodeIds / completedEpisodeCount / lastActiveAt）；
  schedulingDecision / assistanceSnapshot 等私有字段缺失即省略。
- 展示侧不得泄漏 private 字段（含 DOM/RSC/prefetch/cache 泄漏测试见 01-4；本任务在
  序列化层保证零 private 字段）。

## 4. prompt-injection 对抗规则（validateToolArguments）

- **ID/引用字段**（键匹配 `id`/`ids`/`*Id`/`*Ids`/`*Ref`/`*Refs`，如 probeId、
  evidenceRefIds、rubricTargetRef）的值必须属于显式传入的 `idAllowlist`——拒绝任意
  字符串/路径穿越/脚本形态 ID（如 `../etc`、`<script>alert(1)</script>`）；未传入
  allowlist 时任何 ID 一律拒绝（fail-closed）；
- **HTML/JS 脚本形态标记**（大小写不敏感）：任何字符串参数包含
  `<script` / `javascript:` / `data:text/html` 即拒绝（含数组逐元素、嵌套对象递归）；
- 校验结果 `{ ok: true } | { ok: false; reason }`；拒绝信息携带工具名与参数路径，
  便于审计。
- 对抗集（单测断言）：`../etc`、`<script>…</script>`、`javascript:alert(1)`、
  `data:text/html,<svg onload=…>`、`JaVaScRiPt:`（大小写变体）、ID 数组含非法元素、
  嵌套对象内脚本字符串，全部被拒。

## 5. epoch 重比较与 0 canonical write 语义

- **epoch 重比较**（任务 03-6 前置落地）：`executeTool` 在第 ① allowlist 之后从
  `epochProvider` 重新读取当前 contract 的 runtimeEpoch + episodeEpoch，与请求携带的
  `runtimeEpochSnapshot`/`episodeEpoch` 逐项比较；provider 未注入（默认）或任一 epoch
  为 null（缺失）一律 `epoch_mismatch`——fail-closed，hard kill / privacy incident 后
  迟到响应不能以 stale epoch 执行。单测覆盖：runtime 失配 / episode 失配 / provider 为
  null / 字段为 null 四种失配路径。
- **0 canonical write**：`executeTool` 通过 ①②③ 后对合法工具返回 `not_implemented`
  （真实副作用 executor 由后续任务接入），staging 结果类型 `LearningStagingResult`
  （`canonicalWrite: false` 字面量）在类型层面防止把 staging 误当 canonical 消费；
  canonical 事实只由 deterministic COMMIT 投影产生。

## 6. 验收映射

- actor 越权尝试全部被网关拒绝：6 个 LLM 角色互调他角色工具 + 2 个 deterministic
  角色越权 + 4 个 forbidden product actions × 多 actor 全部 `tool_not_allowed`（单测
  1~2 组）；
- prompt-injection 对抗集通过：`validateToolArguments` 单测第 6 组 9 例全绿；
- public DTO 零 private 字段：serializer 单测第 5 组断言 `JSON.stringify` 输出不含任一
  私有字段名；
- 验证命令：
  - `npm run typecheck --prefix workers/ai-worker` 通过；
  - `cd workers/ai-worker && node --import tsx --test src/learning-agent/tools/gateway.test.ts`
    34/34 通过。
