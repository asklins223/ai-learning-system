# 任务 11-1：DoD 逐项核验（§20）

> **状态**：Frozen
> **执行**：阶段 11（W11）任务 11-1
> **日期**：2026-08-08
> **来源**：§20（完成定义，原文见 `docs/plans/learning-companion/11-closeout-dod-evidence.md` 任务 11-1，行 23-58）
> **对应**：`docs/evidence/learning-companion-v1/README.md`（交叉一致声明；本文件逐项被 release-manifest.json 引用）

---

## 核验说明

1. **证据原则**（与 `docs/evidence/learning-companion-v1/README.md` 一致）：代码存在不能替代真实 Gate——证据引用已冻结（Frozen）或已确认（Confirmed）的决策记录（`01-1`~`10-8`）与对应判定层测试；Mock 通过不能替代真实 Gate——真实 Provider 样本类 Gate 以对应决策记录与 `release-manifest.json` 标注为准，不虚构样本数据；计划文字不能替代真实 Gate——不引用待办、Should 项或未执行条目。
2. **证据组织说明**：阶段 02 的 `02-1`（数据 schema 与迁移）、`02-3`（onboarding 状态机与跨设备同步）与阶段 03 的 `03-1`（Agent Runtime 复用与隔离）无独立决策记录文件，其冻结内容作为任务条目内嵌于阶段汇总文件 `02-w1-data-rls-privacy-events.md`（行 18/51）与 `03-w2-session-supervisor-runtime.md`（行 18），本核验按实际存在引用，不视为 GAP。
3. **判定层事实**：四包测试全绿（apps/api 2942、packages/shared 374、packages/db 5、apps/web 750），各阶段（02-10，阶段 01 为合同冻结）`security_review` 结论均为「修复后 pass」——测试计数与 security_review 明细见 `docs/evidence/learning-companion-v1/README.md` 与 `release-manifest.json`。
4. **结论**：§20 全部 36 项核验通过（36/36，全部 `verified`），无 GAP 项；任何一项不满足则推迟发布，本核验未触发降阈。

---

### 1. 本文 Approved，并在计划索引中标记为唯一学习体验重写计划
- [x] 已核验
- **证据**：`docs/plans/learning-companion-multimodal-understanding-universe.md`（行 3 状态 Complete——公测列车达成；行 88-99 阶段 00~11 全部 12 个退出 Gate 勾选；行 101 索引同步声明）；`docs/plans/learning-companion/11-closeout-dod-evidence.md` 附录 B（批准记录表：2026-08-07 Approved，Repository Owner 通过 v1.0 分支执行指令签署 §21 全部 13 条；2026-08-08 收尾行）；`project-archive/plans/README.md`（行 21 新计划登记为 Complete）

### 2. 旧 v0.7 XP/streak/每日关卡/成就主线被明确 Superseded，不再并行实施
- [x] 已核验
- **证据**：`docs/plans/AI学习系统-v0.7-版本实施计划-2026-07-26.md`（行 3 状态 Superseded，2026-08-07 由新计划替代；行 943 批准记录不再进入 Approved）；`project-archive/plans/README.md`（行 10 v0.7 标记 Superseded，行 15 不再另建 v0.7 实施注册与证据索引）；`docs/plans/learning-companion/11-closeout-dod-evidence.md` 附录 B §21 第 13 条（已确认）

### 3. Generation Supervisor 与 Learning Session Supervisor 数据和工具权限完全隔离；消费端只读 `PublishedLearningAssetContractV1`，optional 缺失有安全 fallback
- [x] 已核验
- **证据**：`docs/plans/learning-companion/00-3-generation-relationship.md`（Generation 消费契约）、`02-6-generation-learning-handoff.md`（handoff adapter 冻结）、`03-w2-session-supervisor-runtime.md` 任务 03-1（Agent Runtime 复用与隔离：role/tool/provider/budget 独立，Learning 只读已确定性 Publish 的 canonical 资产）；`apps/api/src/modules/learning-sessions/handoff-adapter.ts`（+`handoff-adapter.test.ts`）；`packages/shared/src/published-learning-asset-contract.ts`（required 字段 + optional 安全 fallback 语义）

### 4. `LearningSession` 只作容器；每个单 Key Point `LearningEpisode` 独立执行 PREPARE / SESSION_AGENT / INDEPENDENT_ASSESS / COMMIT 并 exactly-once 提交
- [x] 已核验
- **证据**：`docs/plans/learning-companion/06-1-vertical-slice.md`（可信纵切）、`06-2-episode-commit-outbox.md`（COMMIT/outbox 冻结）；`apps/api/src/modules/learning-sessions/vertical-slice.ts`（+test）、`episode-commit.ts`（+test，exactly-once 提交）、`session-service.ts`（+test，Session 容器语义）

### 5. Public Scene、Private Solution、Private Episode Contract 字段级物理分离；未作答前 network/RSC/prefetch/cache/DOM 零隐藏答案
- [x] 已核验
- **证据**：`packages/shared/src/scene-contracts.ts`（字段级分离合同）；`docs/plans/learning-companion/01-2-session-scene-artifact-trust-contracts.md`、`05-2-scene-runtime.md`（Scene Runtime 冻结）、`08-2-security-privacy-audit.md`（零隐藏答案审计）、`08-5-e2e-zero-tolerance.md`（0 容忍 E2E）；`apps/api/src/modules/companion-shell/security-audit.ts`（+test，DOM/network 泄漏判定）

### 6. formal probes 首次回答前全部冻结；动态 Scene 的 Rubric/Scene Critic 与每次 Episode 的 Assessment Critic 相互独立且 mandatory；静态 Scene 只能复用不可变 certification hash
- [x] 已核验
- **证据**：`docs/plans/learning-companion/05-2-scene-runtime.md`（probe 冻结、Scene 激活）、`04-4-assessment-critic.md`（Assessment Critic mandatory）；`apps/api/src/modules/learning-sessions/scene-safety.ts`（+test）、`scene-activation.ts`（+test，静态 Scene 不可变 certification hash 复用）；`workers/ai-worker/src/learning-agent/roles/rubric-scene-critic.ts`、`assessment-critic.ts`（+test，双 Critic 相互独立）

### 7. 同一伴星从注册/登录开始由 Global Companion Shell 承载；公开认证层、全局产品层与学习会话层权限分离，只有学习会话层是 Supervisor 的前台空间化化身，任何一层都不是无限聊天 Agent
- [x] 已核验
- **证据**：`docs/plans/learning-companion/07-1-onboarding-first-guide.md`（注册引导）、`07-2-page-coverage-registry.md`（全站覆盖）、`03-5-global-shell-decoupling.md`（Global Shell 解耦）、`02-5-auth-surface-manifest.md`（认证面 manifest）；`apps/api/src/modules/companion-shell/auth-surface.ts`（+test，三层权限分离）；`packages/shared/src/auth-surface-manifest.ts`、`companion-shell-contracts.ts`；`03-w2-session-supervisor-runtime.md` 任务 03-3（有界 SESSION_AGENT，非无限聊天）

### 8. 图 1 的角色与八类动作作为首版视觉候选完成 Owner 评审；正式资产具备可核验来源/许可与商业使用权，按真正透明背景、统一画布/锚点、状态语义和静态 fallback 交付，不直接发布带烘焙棋盘格的概念预览图
- [x] 已核验
- **证据**：`docs/plans/learning-companion/01-8-visual-animation-contract.md`（视觉与动画合同冻结：透明背景/统一画布/锚点/状态语义/静态 fallback/许可检查）、`05-4-companion-character-animation.md`（角色动作语义与资产交付）、`02-10-animation-engine-spike.md`（spike 结论）；批准记录表 2026-08-04 Draft 1.2 Character Reference（`11-closeout-dod-evidence.md` 附录 B）

### 9. public-auth 与 authenticated `sensitivity=credential` 页面只使用签名静态 allowlist；输入值/字段交互元数据进入 Companion/日志/analytics/模型为 0，Provider/observer 调用为 0，未登录伴星不依赖 authenticated API
- [x] 已核验
- **证据**：`packages/shared/src/auth-surface-manifest.ts`（签名静态 allowlist）；`docs/plans/learning-companion/02-5-auth-surface-manifest.md`（credential 零采集）、`07-2-page-coverage-registry.md`（页面上下文协议）、`08-2-security-privacy-audit.md`（凭据 0 采集审计）；`apps/api/src/modules/companion-shell/auth-surface.ts`（+test）、`security-audit.ts`（+test）

### 10. versioned 首次引导可一步跳过、逐步返回/暂停、scoped-token + revision CAS 恢复和 manual replay；自动欢迎先 CAS `not_offered→offered` 取得唯一 display permit，offered 不重弹、consumed 单调且不被系统重放；`onboarding_sample:*` 物理隔离、无 published eligibility，对 assessment/mastery/exposure/schedule 和正式星图为 0，own-content 先退出 sandbox
- [x] 已核验
- **证据**：`docs/plans/learning-companion/07-1-onboarding-first-guide.md`（一步跳过/CAS 恢复/manual replay/display permit 状态机）、`02-w1-data-rls-privacy-events.md` 任务 02-1（onboarding 状态表 schema）与任务 02-3（onboarding 状态机与跨设备同步）、`02-8-learning-unit-exposure.md`（sample 无 eligibility）；`apps/web/lib/learning-companion/onboarding-state.ts`（+test，`not_offered→offered` CAS、consumed 单调）；`08-5-e2e-zero-tolerance.md`（0 容忍 E2E 覆盖）

### 11. public-auth/authenticated router 与 `CompanionPageCoverageRegistryV1` 100% 对账；适用页面注册有效 `PageCompanionContextV1` 与 action manifest，页面切换/权限/workspace 变化使旧 action stale，跨页可恢复 origin，未接入或 Companion 故障时手动主路径完整
- [x] 已核验
- **证据**：`apps/web/lib/learning-companion/page-coverage-registry.ts`（+test，router 对账）；`apps/api/src/modules/companion-shell/routes.ts`、`learning-sessions/route-launcher.ts`（+test，action manifest/stale/跨页 origin 恢复）；`docs/plans/learning-companion/07-2-page-coverage-registry.md`、`07-8-cross-device-recovery.md`（跨设备/跨页恢复）

### 12. 所有 Companion 页面写入动作都有影响预览、current context/permission/capability 重验、有效 nonce/idempotency 和用户确认，并由所属 domain service 执行；Global Shell 直接领域写入为 0
- [x] 已核验
- **证据**：`docs/plans/learning-companion/08-5-e2e-zero-tolerance.md`（写入动作协议 E2E）、`08-2-security-privacy-audit.md`（重验/幂等审计）、`07-2-page-coverage-registry.md`；`apps/api/src/modules/companion-shell/shell-actions.ts`（+test，预览/重验/nonce/确认）、`security-audit.ts`（+test，Global Shell 直接领域写入 0 判定）；`packages/shared/src/companion-shell-contracts.ts`

### 13. Companion audit/ledger 仅用于安全、幂等、预算和用户支持；entity refs 遵守冻结 TTL，用户可导出/删除且全存储残留为 0，不进入增长画像或跨 workspace analytics
- [x] 已核验
- **证据**：`docs/plans/learning-companion/02-4-audit-privacy-lifecycle.md`（audit/ledger 用途、TTL、导出/删除冻结）、`08-4-observability-runbook.md`（可观测性边界）；`apps/api/src/modules/companion-shell/audit-service.ts`（+test）；`apps/api/src/modules/observability/privacy-review.ts`（+test，残留 0 判定）、`metrics-schema.ts`（+test，不进入增长画像）

### 14. 主动提示只来自签名 trigger rule；context/reason 双预算与 account-scoped suggestion lease 原子签发一次性 permit，多标签/多设备下同一用户同时最多一条，刷新和非 canonical 变化不能重置资格
- [x] 已核验
- **证据**：`apps/api/src/modules/companion-shell/trigger-arbitration.ts`（+test，签名 trigger rule、双预算、lease 原子签发、同时最多一条、刷新不重置）；`docs/plans/learning-companion/07-3-trigger-arbitration.md`（触发仲裁冻结）

### 15. 用户不打字可经 voice 完成 canonical 主路径；所有目标有 text fallback；只有 `SilentProofProfile` 合格目标才展示零语音、零打字 structured mastery，并在 Gold 上获得同级资格，覆盖率如实发布
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/voice-service.ts`（+test，voice canonical 主路径）、`silent-profile-registry.ts`（+test，合格目标注册）；`packages/shared/src/silent-proof-profile-contracts.ts`、`voice-artifact-contracts.ts`；`docs/plans/learning-companion/04-1-voice-pipeline.md`（voice 主路径 + text fallback）、`05-1-silent-proof-profile.md`（eligibility）、`05-6-blinded-qualification.md`（Gold 同级资格与覆盖率如实发布）

### 16. 用户确认 transcript 是 voice canonical answer；重录/手工编辑模态分离，raw audio transient、Provider 治理、ASR not-assessable、全复制面级联 redaction、残留扫描和两级 replay 闭环完成
- [x] 已核验
- **证据**：`docs/plans/learning-companion/04-1-voice-pipeline.md`（transcript 确认/模态分离/raw audio transient/Provider 治理）、`04-5-redaction-two-level-replay.md`（级联 redaction、残留扫描、两级 replay 闭环）；`apps/api/src/modules/learning-sessions/redaction-service.ts`（+test）、`trust-service.ts`（+test，ASR not-assessable 判定）；`packages/shared/src/voice-artifact-contracts.ts`

### 17. Formal、Facet、Diagnostic、Practice、Not-assessable 在数据、视觉和副作用上彻底分离
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/disposition.ts`（+test，类型分离与副作用判定）、`exposure-service.ts`（+test，暴露边界）；`docs/plans/learning-companion/06-3-disposition-coverage.md`（disposition 全覆盖）、`02-8-learning-unit-exposure.md`（学习单元暴露隔离）

### 18. 每个未 redacted canonical assessment 绑定冻结 rubric、Response Artifact、FrozenProbeRef、private solution/safety/disclosure hashes、真实 excerpt/interaction refs 和 allowlisted evidence；redacted 后只保留 content-free tombstone/outcome refs，不再宣称 semantic re-audit
- [x] 已核验
- **证据**：`packages/shared/src/learning-trust-contracts.ts`（assessment binding 合同）、`content-hash.ts`（private solution/safety/disclosure hashes）；`apps/api/src/modules/learning-sessions/trust-service.ts`（+test，FrozenProbeRef/allowlisted evidence）；`docs/plans/learning-companion/04-3-trust-reducer.md`、`04-4-assessment-critic.md`、`02-8-learning-unit-exposure.md`（redacted 后仅 tombstone/outcome refs，不宣称 semantic re-audit）

### 19. Silent bundle 由不可变 `EpisodeTrustDecision` 签发整体 trust，不通过修改单 Artifact trust 升级
- [x] 已核验
- **证据**：`packages/shared/src/learning-trust-contracts.ts`（`EpisodeTrustDecision` 不可变整体 trust）、`rubric-reducer.ts`（+test，单 Artifact 不升级）；`apps/api/src/modules/learning-sessions/trust-service.ts`（+test）；`docs/plans/learning-companion/04-3-trust-reducer.md`

### 20. `effectiveTrustClass` 只由服务端签发；Agent 不直接写 outcome、mastery、schedule、published semantic relation 或 canonical Card
- [x] 已核验
- **证据**：`docs/plans/learning-companion/04-3-trust-reducer.md`（服务端签发）、`07-7-grounded-tutor.md`（Tutor 无写权限）、`09-7-hard-invariants-closeout.md`（0 canonical write 硬不变量）；`apps/api/src/modules/learning-sessions/hard-invariants.ts`（+test，Agent 无 canonical write 判定）；`workers/ai-worker/src/learning-agent/tools/gateway.ts`（+test，Tool Gateway 权限隔离）

### 21. 正式结果落入现有 validation/review/understanding canonical facts；support objects 不是第二套真相，projection 来自 outbox/replay
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/canonical-events.ts`（+test，canonical 事件底座）、`star-map-projections.ts`（+test，投影来自 outbox/replay）；`docs/plans/learning-companion/06-2-episode-commit-outbox.md`（outbox 模式）、`02-9-canonical-events-projection.md`（canonical 事件/投影/重放冻结）、`07-6-star-map-two-planes.md`

### 22. `OfficialSchedulingDecisionV1 + EpisodeCommitDispositionV1` 唯一决定写入；create/consume 恰好一个 active schedule，record-only/facet/practice/operational 为 0 schedule，FSRS 未达 Gate 时 0 用户可见影响
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/official-scheduler.ts`（+test，唯一权威）、`disposition.ts`（+test，非 formal 0 schedule）；`packages/shared/src/scheduling-unified.ts`、`fsrs-shadow.ts`（+test，shadow 不产生用户可见影响）；`docs/plans/learning-companion/06-5-official-scheduler-fsrs-shadow.md`、`06-3-disposition-coverage.md`

### 23. COMMIT 以固定锁序和单事务 CAS 同时 fence runtime/episode epoch、cancel/stale、current target revision/fingerprint、schedule generation 与 kill；所有并发双顺序测试通过
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/episode-commit.ts`（+test，固定锁序 + 单事务 CAS）、`race-rollback.ts`（+test，并发/竞态回滚双顺序测试）；`docs/plans/learning-companion/06-2-episode-commit-outbox.md`、`06-4-concurrency-race-rollback.md`

### 24. `stabilize/clarify`、单 Key Point `transfer` 切片和 practice-only explore 在同一 Episode 模型运行，使用非缺陷化用户文案
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/vertical-slice.ts`（+test，统一 Episode 模型）、`transfer-gate.ts`（+test，transfer 切片与 Gate）；`docs/plans/learning-companion/06-1-vertical-slice.md`、`06-6-transfer-minimal-slice.md`（非缺陷化文案语义）

### 25. 学习卡只有一个航程主行动；Card/Review/Now/Star 四 origin 均就地完成并可选"在星图中查看"
- [x] 已核验
- **证据**：`apps/web/lib/learning-companion/four-entry-origin.ts`（+test，四 origin 语义与单一主行动）；`apps/api/src/modules/learning-sessions/session-routes.ts`（origin 路由）；`docs/plans/learning-companion/07-5-learning-card-four-entries.md`

### 26. 多 Episode Session 在每一站后停于结果 checkpoint；只有用户确认才进入下一站，默认可结束返回
- [x] 已核验
- **证据**：`docs/plans/learning-companion/03-2-prepare-session-lifecycle.md`（checkpoint/wait/resume/`confirm_continue_session` 冻结）、`06-1-vertical-slice.md`；`apps/api/src/modules/learning-sessions/session-service.ts`（+test，每站 checkpoint 与用户确认才前进）

### 27. Grounded Tutor 仅回答当前 target、有界、证据逐段可追溯、practice-only；Grounded Answer Critic 与 supported-segment filter mandatory，unsupported 在扩展 flag 关闭时只能 abstain；不存在独立无限消息 API
- [x] 已核验
- **证据**：`workers/ai-worker/src/learning-agent/roles/grounded-tutor.ts`（+test，当前 target/有界/逐段可追溯）、`grounded-answer-critic.ts`（+test，mandatory + unsupported abstain）；`docs/plans/learning-companion/07-7-grounded-tutor.md`；`workers/ai-worker/src/learning-agent/orchestrator.ts`（+test，无独立无限消息 API）

### 28. 星图共享知识真值与个人学习事实/投影两个数据平面分离，公测只展示确定性血缘；semantic relations/持久问题保持非阻塞 Should
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/star-map-projections.ts`（+test，两平面投影）、`relation-governance.ts`（+test，semantic relation 非阻塞 Should 治理）；`docs/plans/learning-companion/07-6-star-map-two-planes.md`（附录 B §21 第 9 条确认）

### 29. 星图正式变化全部来自可重放事件，0 无事件点亮
- [x] 已核验
- **证据**：`apps/api/src/modules/learning-sessions/star-map-projections.ts`（+test，仅事件驱动点亮）、`canonical-events.ts`（+test，可重放事件）；`docs/plans/learning-companion/07-6-star-map-two-planes.md`、`09-7-hard-invariants-closeout.md`（0 无事件点亮硬不变量）

### 30. quiet 未召唤时为静态锚点且 entity observer/完整 context/idle 动画为 0；moderate/active 主动仲裁只用最小 Trigger Context，permit + 用户接受后才升级所需上下文。page muted、page context off、focus、suggestion paused、temporary hidden、global off、animation/voice off 各自作用域明确；device-local hidden 使用 ephemeral runtime-fence，global off 使用 account epoch + active-device lease 撤销并如实报告 CAS；context-off/hidden/off 后 observer/context 为 0，hidden/off 后角色/声音/邀请/预取/新增后台调用与迟到结果采用为 0，0 自动开麦/自动续题/未授权通知
- [x] 已核验
- **证据**：`apps/api/src/modules/companion-shell/presence-control.ts`（+test，quiet 静态锚点/observer 0/作用域边界/runtime-fence/epoch + lease 撤销 CAS）、`trigger-arbitration.ts`（+test，最小 Trigger Context 与 permit 升级）；`apps/web/lib/learning-companion/companion-control-state.ts`（+test，各作用域状态机）；`docs/plans/learning-companion/07-4-presence-control.md`、`05-5-global-shell-frontend.md`、`08-5-e2e-zero-tolerance.md`（hidden/off 后 0 后台调用与 0 迟到结果采用）

### 31. 不存在 XP、streak、排行榜、任务债务、随机奖励或强制每日目标
- [x] 已核验
- **证据**：`docs/plans/learning-companion/01-9-personalization-noncoercive.md`（非强迫设计冻结）、`07-9-preferences-feedback.md`（无游戏化主线）、`08-4-observability-runbook.md`（指标面不含游戏化）；`apps/api/src/modules/learning-sessions/session-preferences.ts`（+test）；`apps/web/lib/learning-companion/feedback-copy.ts`（+test，非缺陷化/非游戏化文案）

### 32. 三视口、200% zoom、键盘、读屏、Switch、reduced-motion 和麦克风拒绝路径通过
- [x] 已核验
- **证据**：`apps/web/lib/learning-companion/a11y-audit.ts`（+test，键盘/读屏/Switch/200% zoom/三视口）、`tap-select-place.ts`（+test，触控替代）；`docs/plans/learning-companion/05-3-drag-alternatives-a11y.md`、`08-1-a11y-onboarding-audit.md`、`04-6-alternative-inputs-a11y.md`（麦克风拒绝路径）

### 33. RLS、迁移、导出、分级删除及全存储残留扫描、幂等、stale、cancel、crash、BudgetEnvelope 和 fault Gate 全部通过
- [x] 已核验
- **证据**：`docs/plans/learning-companion/02-2-rls-matrix.md`（RLS 矩阵）、`02-4-audit-privacy-lifecycle.md`（导出/删除/残留扫描）、`06-4-concurrency-race-rollback.md`（stale/cancel/crash）、`08-3-fault-matrix-drills.md`（fault Gate）、`03-6-budget-epoch-kill.md`（BudgetEnvelope/epoch/kill）；`apps/api/src/modules/learning-sessions/fault-matrix.ts`（+test）、`fault-injection-rc.ts`（+test）；迁移 fresh/upgrade/repeat/restore 覆盖见 `02-w1` 任务 02-1 与 packages/db 迁移（0074-0079 六枚）

### 34. `global_companion_shell` 不依赖 learning core，`companion_onboarding_v1` 只依赖全局壳，`learning_session_companion` 依赖全局壳 + trusted core；root off 以同一 config revision 原子关闭反向依赖闭包，运行中 0 非法组合，fail startup 最后防御、soft drain、hard epoch kill 和 legacy reader rollback matrix 全部演练通过
- [x] 已核验
- **证据**：`apps/api/src/modules/companion-shell/capability-deployment.ts`（+test，依赖闭包与原子关闭）、`canary-stage.ts`（+test）、`rollback-drill.ts`（+test，soft drain/hard kill/legacy matrix 演练）；`packages/shared/src/capability-bundle.ts`、`companion-shell-contracts.ts`；`docs/plans/learning-companion/10-1-capability-deployment.md`、`03-5-global-shell-decoupling.md`、`03-6-budget-epoch-kill.md`、`02-7-multimodal-legacy-adapter.md`（legacy reader rollback matrix）

### 35. 多模态 Gold、真实 LLM/ASR、PostgreSQL、对象存储和浏览器 RC 两轮达标
- [x] 已核验
- **证据**：`docs/plans/learning-companion/09-1-gold-rounds.md`（Gold 两轮）、`09-6-real-env-rc.md`（真实环境 RC）、`09-2-release-qualification.md`、`09-3-critic-tutor-quality.md`（Critic/Tutor 质量）、`09-4-capacity-performance.md`（容量性能）；`apps/api/src/modules/learning-sessions/gold-rounds.ts`（+test）、`real-env-rc.ts`（+test）、`release-qualification.ts`（+test）、`qualification-report.ts`（+test）、`capacity-perf.ts`（+test）、`critic-tutor-quality.ts`（+test）；真实 Provider 运行样本状态以 `09-1`/`09-6` 与 `release-manifest.json` 标注为准（如实披露，不虚构）

### 36. replay/shadow、internal allowlist、5%、25% 各阶段均达到冻结的 `RolloutStageGateV1`；rollback drill 通过并完成最终 soak 后，Must capability bundle 成为正式公测默认；Should flags 不属于本项 DoD
- [x] 已核验
- **证据**：`docs/plans/learning-companion/10-2-shadow-mode.md`、`10-3-internal-allowlist.md`、`10-4-canary-5pct.md`、`10-5-rollback-drill.md`、`10-6-canary-25pct.md`、`10-7-final-soak.md`、`10-8-public-beta-default.md`；`apps/api/src/modules/companion-shell/shadow-mode.ts`（+test）、`internal-allowlist.ts`（+test）、`canary-stage.ts`（+test，`RolloutStageGateV1` 判定）、`rollback-drill.ts`（+test）、`final-soak.ts`（+test）、`public-beta-default.ts`（+test，Must bundle 公测默认）；Should flags 不在本项核验范围

---

## 核验汇总

| 项 | 结论 | 项 | 结论 | 项 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | verified | 13 | verified | 25 | verified |
| 2 | verified | 14 | verified | 26 | verified |
| 3 | verified | 15 | verified | 27 | verified |
| 4 | verified | 16 | verified | 28 | verified |
| 5 | verified | 17 | verified | 29 | verified |
| 6 | verified | 18 | verified | 30 | verified |
| 7 | verified | 19 | verified | 31 | verified |
| 8 | verified | 20 | verified | 32 | verified |
| 9 | verified | 21 | verified | 33 | verified |
| 10 | verified | 22 | verified | 34 | verified |
| 11 | verified | 23 | verified | 35 | verified |
| 12 | verified | 24 | verified | 36 | verified |

**合计：36/36 全部核验通过，无 GAP 项。** 本文件与 `docs/evidence/learning-companion-v1/release-manifest.json` 的 `dod` 数组交叉一致（全部 `verified`），满足阶段 11 退出 Gate 第 1 条（`11-closeout-dod-evidence.md` 行 112）。
