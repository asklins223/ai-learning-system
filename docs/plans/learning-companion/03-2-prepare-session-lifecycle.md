# 决策记录 03-2：PREPARE 与 Session 生命周期（§4.3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 03（W2）任务 03-2
> 日期：2026-08-08
> 来源：`03-w2-session-supervisor-runtime.md` 任务 03-2（原方案 §4.3）
> 约束级别：Session 生命周期完整；取消后当前与未开始 Episode 零副作用、已 commit Episode 保留。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/session-service.ts`：PREPARE（createSession）、
  多 Episode checkpoint（continueSession / resolveCheckpoint）、cancel
  （cancelSession）、origin-aware completion（endSession）、public view
  （buildSessionPublicView）。
- `apps/api/src/modules/learning-sessions/session-routes.ts`：POST /learning-sessions、
  POST /learning-sessions/:id/continue、POST /learning-sessions/:id/end、
  GET /learning-sessions/:id、DELETE /learning-sessions/:id（preHandler requireSession）。
- `session-service.test.ts`：候选生成 / planHash 确定性 / checkpoint / cancel /
  origin / BudgetEnvelope / loop 状态机单测（node:test + assert，DB 走内存 repo）。
- 本文件：决策记录。

## 2. Session 生命周期与 phase projection

`learning_sessions` 是用户可见航程容器（串联 1~5 个 Episode，无 route-level mastery
或总体 schedule 副作用）；`learning_episodes` 是单 Key Point target 的 Episode
contract 落点。四阶段外壳对每个 Episode 独立执行。

```
session:  active ──→ ended（用户停止/返回/全部结束，origin-aware completion）
          active ──→ cancelled（用户取消）
          active ──→ stale（fingerprint/epoch 失配，03-6 驱动）

episode phase: prepared → session_agent → independent_assess → committed
               任意进行中 ──→ cancelled / stale
```

- `phase` 只用于从已持久化 Episode 状态构建 public view；生命周期服务没有通用的
  `sessionLoop` action API。
- **phase 无 DB 落点**（迁移 0074 `learning_episodes.status` CHECK 约束只允许
  draft/active/completed/stale/cancelled）：`prepared` 语义的 Episode 落
  `status='active'`；`session_agent`/`independent_assess` 同样保持 `active`，
  `committed → completed`、`cancelled → cancelled`、`stale → stale`。进行中 phase
  由实际编排/评估链路持有，精确持久化（如 probe 表状态推断）由 03-3/03-6 完善。
- **0 canonical write**：本任务只做 PREPARE 与生命周期状态，不写掌握/schedule/
  Card 真值；评估与 COMMIT 不由生命周期壳直接伪造 completed 状态。

## 3. PREPARE 冻结项清单

createSession（POST /learning-sessions）按序执行：

1. **入口解析**（`resolvePrepareEntry`）：
   - `key_point` → originRef `{type:"key_point", id}`，intent stabilize，
     prioritySource user_selected；
   - `temporary_question` → originRef `{type:"question_suggestion", id}`（ephemeral
     只作 originRef，01-2 §5.4），intent clarify，prioritySource canonical_gap；
   - `review_entry` → originRef `{type:"review_schedule", id}`，intent transfer，
     prioritySource official_due。
2. **候选生成**（`deriveEpisodeCandidates`）：official scheduler（due reviews，
   consume_pending 绑定精确 scheduleId+generation）、needs-repair（repair
   revalidation）、active canonical 内容（canonical_gap / user_selected）。
   合法性：每个候选必须可绑定一份 active canonical 内容（cardId/cardRevision/claim/
   evidence/fingerprint 为 required 字段，02-6）；无 canonical 的源跳过（不静默
   造题）；optional（semanticSupport）缺失 → `sceneFallbackRequired=true`（已验证
   安全 Scene fallback）。优先级 user_selected > official_due/overdue/repair >
   canonical_gap；同 rank 按 keyPointId 字典序，确定性。
3. **冻结**并写入 learning_episodes：
   - formal eligibility（formalEligibilityKind）；
   - typed scheduling decision（OfficialSchedulingDecisionV1：decisionRef/Hash、
     authorizedAction、inputScheduleId/Generation、prioritySource、policyVersion/
     Epoch、reasonCodes；`create_initial`/`consume_pending`/`record_only`/`no_effect`
     按 01-2 §5.2 与 formalPlan.kind 配对）；
   - Episode/content exposure 身份（keyPointId、contentExposureKey 由 02-8
     computeContentExposureKey 计算：H(ws,user,kp,publishedRevision,claimHash,
     sortedEvidenceContentHashes)）；
   - 用户偏好（user_learning_preferences workspace 级优先、account 级回退的显式
     偏好快照 hash）与 assistance snapshot（learning_unit_exposure 当前
     assistanceSnapshot 的只读视图，无行 = none）——两者无独立列，以 hash 进入
     planHash 覆盖；
   - 不可借用 BudgetEnvelope（见 §5）；
   - capability closure（requiredCapabilityIds 排序 + capabilitySnapshotHash）、
     runtime epoch snapshot（03-6 接入 learningRuntimeEpoch，当前冻结 0）、
     episode epoch（同 Session 内递增，首 Episode = 1）；
   - policy versions（assistance/rubric/scene/assessment/mastery/scheduler/provider/
     commit-policy-v1）。
4. **planHash**（01-2 §5.3）：覆盖 scheduling decision、formal plan、episode/
   content exposure 身份、runtime/episode epoch、commit policy、required capability
   closure、budget ref/hash、用户偏好 hash、assistance snapshot hash 与全部 frozen
   probe hash（frozenProbeHashes 由 03-3 RUBRIC_AND_SCENE_PREPARE 冻结后追加）；
   相同冻结输入恒等（确定性）。
5. **阻断点**（都在用户作答前）：无合法候选 → 409 PREPARE_NO_CANDIDATES；
   每用户同时 active 学习会话 ≥ 1（01-1 §6）→ 409 SESSION_LIMIT_REACHED；
   预算不足 → 409 BUDGET_INSUFFICIENT。

**可见性边界**（01-2 §5.4）：GET /learning-sessions/:id 只返回 public Session view
（不含 schedulingDecision / rubricTargets / frozenProbes / assistanceSnapshot /
solution）；`buildSessionPublicView` 显式 allowlist 字段。PREPARE 不把含答案的
评分合同返回客户端。

**候选源抽象**：`SessionRepository` 可注入；PG 实现 `createPgSessionRepository`
（wraps ApiTransaction）：active Card Set → Card → Key Point → evidences（cardRevision
取 card_generation_runs.generation_epoch，02-6 权威字段），due reviews 读
review_schedules pending 且 next_review_at ≤ now。needs-repair 无权威落点（W5
scheduler 接入前返回确定性空结果），候选源接口已预留。

## 4. 多 Episode checkpoint 规则

- 本 Episode 真实结果必须先落终态（completed/stale/cancelled）才能确认下一站；
  未终态时 /continue 拒绝（409 EPISODE_NOT_TERMINAL）。
- 只有用户命令 `confirm_continue_session` 才能 PREPARE 下一 Episode；
  `change_route` 重新生成候选（换一个/缩短剩余路线）。
- **无倒计时默认选择**：用户不动作 → `return_to_origin`（结束并返回来源）。
- 下一 Episode PREPARE 排除已用 keyPoint（同一 Session 不重复路线）；
  `learning_episodes_session_active_unique_idx` 兜底同 Session 至多一个未终态
  Episode。
- origin-aware completion 在用户停止、选择返回或全部 Episode 明确结束时执行，
  不在 Episode 之间强制跳页（`resolveOriginReturnTarget`：card→card_detail、
  review→review_queue、star_map→star_map、now→current_page）。

## 5. BudgetEnvelope 预留规则（不可借用，01-2 §5.3 / §16.6）

```
BUDGET_UNITS = { unitsPerProbe: 1, maxReRecordOrStructuralFix: 2,
                 assessmentCriticRetries: 1, commitAllocation: 1, groundedTutorUnits: 2 }
reserved.requiredProbes        = estimatedRequiredProbes × unitsPerProbe
reserved.maxReRecord...        = 2   （一次允许的重录/结构修正上限）
reserved.assessmentCriticRetries = 1
reserved.commitAllocation      = 1
requiredTotal = 上述之和
sufficient    = availableUnits ≥ requiredTotal（不足 → 用户在作答前被阻断）
```

- `nonBorrowable: true` 是字面量类型：类型层面禁止与 generation run 预算混用、
  也禁止 Learning 各角色间互相借用额度；
- practice detour 使用独立 envelope（`groundedTutorEnvelopeRef`，Tutor 不借用本
  envelope）；
- `envelopeRef` / `envelopeHash` 确定性生成，绑定 (workspaceId, keyPointId,
  planKey=sourceFingerprint, runtimeEpoch)，同一 PREPARE 输入恒等。

## 6. cancel 语义（03-2 验收）

- 取消当前（active）与未开始（draft）Episode：只改状态为 `cancelled`（零副作用，
  不写掌握/schedule、不触发 outbox）；
- **已 commit（completed）Episode 保留**；已终态（stale/cancelled）不动；
- session → `cancelled`；`cancelSession` 不允许 cancelled session 下残留孤儿未终态行。

## 7. 验收标准

1. `npm run typecheck --prefix apps/api` 通过；
2. `npm test --prefix apps/api` 通过；
3. 取消后当前与未开始 Episode 零副作用、已 commit Episode 保留（单测覆盖）；
4. 预算不足在用户作答前阻断（BUDGET_INSUFFICIENT 单测覆盖）；
5. PREPARE 不返回含答案评分合同（public view allowlist 单测覆盖）。

## 8. 后续衔接

- 03-3：RUBRIC_AND_SCENE_PREPARE 冻结 frozenProbes → planHash 追加 frozenProbeHashes，
  `estimatedRequiredProbes` 精确化为 formalPlan.requiredProbeIds；
- 03-6：runtimeEpochSnapshot 接入 learningRuntimeEpoch、inactivity/pause TTL 与
  stale 驱动；
- W5：needs-repair 权威表接入 `SessionRepository.listNeedsRepair`。
