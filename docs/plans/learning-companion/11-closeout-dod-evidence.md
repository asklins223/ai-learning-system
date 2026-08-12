# 阶段 11：收尾——DoD 核验与发布证据

> **第一层执行顺序第 11 步（串行终点）**
> 前置：阶段 10（W9 公测默认）
> 后置：无（发布收尾）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §20（DoD）、附录 A（发布证据目录）、附录 B（批准记录）。

---

## 本阶段目标

逐项核验 §20 完成定义，归档发布证据，更新批准记录与计划索引，正式宣告公测列车达成。

## 可并行执行的任务（第二层）

### 任务 11-1：DoD 逐项核验（§20）

**交付物**：§20 全部 36 项 checkbox 逐项核验（每项附证据引用，不允许以代码存在、Mock 通过、计划文字或样本不足替代真实 Gate）。

**任务内容（原文 §20，完整清单）**：

1. 本文 Approved，并在计划索引中标记为唯一学习体验重写计划。
2. 旧 v0.7 XP/streak/每日关卡/成就主线被明确 Superseded，不再并行实施。
3. Generation Supervisor 与 Learning Session Supervisor 数据和工具权限完全隔离；消费端只读 `PublishedLearningAssetContractV1`，optional 缺失有安全 fallback。
4. `LearningSession` 只作容器；每个单 Key Point `LearningEpisode` 独立执行 PREPARE / SESSION_AGENT / INDEPENDENT_ASSESS / COMMIT 并 exactly-once 提交。
5. Public Scene、Private Solution、Private Episode Contract 字段级物理分离；未作答前 network/RSC/prefetch/cache/DOM 零隐藏答案。
6. formal probes 首次回答前全部冻结；动态 Scene 的 Rubric/Scene Critic 与每次 Episode 的 Assessment Critic 相互独立且 mandatory；静态 Scene 只能复用不可变 certification hash。
7. 同一伴星从注册/登录开始由 Global Companion Shell 承载；公开认证层、全局产品层与学习会话层权限分离，只有学习会话层是 Supervisor 的前台空间化化身，任何一层都不是无限聊天 Agent。
8. 图 1 的角色与八类动作作为首版视觉候选完成 Owner 评审；正式资产具备可核验来源/许可与商业使用权，按真正透明背景、统一画布/锚点、状态语义和静态 fallback 交付，不直接发布带烘焙棋盘格的概念预览图。
9. public-auth 与 authenticated `sensitivity=credential` 页面只使用签名静态 allowlist；输入值/字段交互元数据进入 Companion/日志/analytics/模型为 0，Provider/observer 调用为 0，未登录伴星不依赖 authenticated API。
10. versioned 首次引导可一步跳过、逐步返回/暂停、scoped-token + revision CAS 恢复和 manual replay；自动欢迎先 CAS `not_offered→offered` 取得唯一 display permit，offered 不重弹、consumed 单调且不被系统重放；`onboarding_sample:*` 物理隔离、无 published eligibility，对 assessment/mastery/exposure/schedule 和正式星图为 0，own-content 先退出 sandbox。
11. public-auth/authenticated router 与 `CompanionPageCoverageRegistryV1` 100% 对账；适用页面注册有效 `PageCompanionContextV1` 与 action manifest，页面切换/权限/workspace 变化使旧 action stale，跨页可恢复 origin，未接入或 Companion 故障时手动主路径完整。
12. 所有 Companion 页面写入动作都有影响预览、current context/permission/capability 重验、有效 nonce/idempotency 和用户确认，并由所属 domain service 执行；Global Shell 直接领域写入为 0。
13. Companion audit/ledger 仅用于安全、幂等、预算和用户支持；entity refs 遵守冻结 TTL，用户可导出/删除且全存储残留为 0，不进入增长画像或跨 workspace analytics。
14. 主动提示只来自签名 trigger rule；context/reason 双预算与 account-scoped suggestion lease 原子签发一次性 permit，多标签/多设备下同一用户同时最多一条，刷新和非 canonical 变化不能重置资格。
15. 用户不打字可经 voice 完成 canonical 主路径；所有目标有 text fallback；只有 `SilentProofProfile` 合格目标才展示零语音、零打字 structured mastery，并在 Gold 上获得同级资格，覆盖率如实发布。
16. 用户确认 transcript 是 voice canonical answer；重录/手工编辑模态分离，raw audio transient、Provider 治理、ASR not-assessable、全复制面级联 redaction、残留扫描和两级 replay 闭环完成。
17. Formal、Facet、Diagnostic、Practice、Not-assessable 在数据、视觉和副作用上彻底分离。
18. 每个未 redacted canonical assessment 绑定冻结 rubric、Response Artifact、FrozenProbeRef、private solution/safety/disclosure hashes、真实 excerpt/interaction refs 和 allowlisted evidence；redacted 后只保留 content-free tombstone/outcome refs，不再宣称 semantic re-audit。
19. Silent bundle 由不可变 `EpisodeTrustDecision` 签发整体 trust，不通过修改单 Artifact trust 升级。
20. `effectiveTrustClass` 只由服务端签发；Agent 不直接写 outcome、mastery、schedule、published semantic relation 或 canonical Card。
21. 正式结果落入现有 validation/review/understanding canonical facts；support objects 不是第二套真相，projection 来自 outbox/replay。
22. `OfficialSchedulingDecisionV1 + EpisodeCommitDispositionV1` 唯一决定写入；create/consume 恰好一个 active schedule，record-only/facet/practice/operational 为 0 schedule，FSRS 未达 Gate 时 0 用户可见影响。
23. COMMIT 以固定锁序和单事务 CAS 同时 fence runtime/episode epoch、cancel/stale、current target revision/fingerprint、schedule generation 与 kill；所有并发双顺序测试通过。
24. `stabilize/clarify`、单 Key Point `transfer` 切片和 practice-only explore 在同一 Episode 模型运行，使用非缺陷化用户文案。
25. 学习卡只有一个航程主行动；Card/Review/Now/Star 四 origin 均就地完成并可选"在星图中查看"。
26. 多 Episode Session 在每一站后停于结果 checkpoint；只有用户确认才进入下一站，默认可结束返回。
27. Grounded Tutor 仅回答当前 target、有界、证据逐段可追溯、practice-only；Grounded Answer Critic 与 supported-segment filter mandatory，unsupported 在扩展 flag 关闭时只能 abstain；不存在独立无限消息 API。
28. 星图共享知识真值与个人学习事实/投影两个数据平面分离，公测只展示确定性血缘；semantic relations/持久问题保持非阻塞 Should。
29. 星图正式变化全部来自可重放事件，0 无事件点亮。
30. quiet 未召唤时为静态锚点且 entity observer/完整 context/idle 动画为 0；moderate/active 主动仲裁只用最小 Trigger Context，permit + 用户接受后才升级所需上下文。page muted、page context off、focus、suggestion paused、temporary hidden、global off、animation/voice off 各自作用域明确；device-local hidden 使用 ephemeral runtime-fence，global off 使用 account epoch + active-device lease 撤销并如实报告 CAS；context-off/hidden/off 后 observer/context 为 0，hidden/off 后角色/声音/邀请/预取/新增后台调用与迟到结果采用为 0，0 自动开麦/自动续题/未授权通知。
31. 不存在 XP、streak、排行榜、任务债务、随机奖励或强制每日目标。
32. 三视口、200% zoom、键盘、读屏、Switch、reduced-motion 和麦克风拒绝路径通过。
33. RLS、迁移、导出、分级删除及全存储残留扫描、幂等、stale、cancel、crash、BudgetEnvelope 和 fault Gate 全部通过。
34. `global_companion_shell` 不依赖 learning core，`companion_onboarding_v1` 只依赖全局壳，`learning_session_companion` 依赖全局壳 + trusted core；root off 以同一 config revision 原子关闭反向依赖闭包，运行中 0 非法组合，fail startup 最后防御、soft drain、hard epoch kill 和 legacy reader rollback matrix 全部演练通过。
35. 多模态 Gold、真实 LLM/ASR、PostgreSQL、对象存储和浏览器 RC 两轮达标。
36. replay/shadow、internal allowlist、5%、25% 各阶段均达到冻结的 `RolloutStageGateV1`；rollback drill 通过并完成最终 soak 后，Must capability bundle 成为正式公测默认；Should flags 不属于本项 DoD。

**验收**：36 项全部核验通过并附证据引用；任何一项不满足则推迟发布，不降低可信阈值。

---

### 任务 11-2：发布证据目录归档（附录 A）

**交付物**：`docs/evidence/learning-companion-v1/` 证据目录。

**任务内容（原文附录 A）**：

```text
docs/evidence/learning-companion-v1/
  README.md
  w0-contract-baseline.md
  w1-data-rls-migrations.md
  w2-agent-runtime.md
  w3-voice-artifact-assessment.md
  w4-scene-silent-bundle-a11y.md
  w5-keypoint-scheduler-vertical.md
  w6-global-companion-onboarding-origins-map-tutor.md
  w7-cross-module-security-privacy-observability.md
  w8-real-provider-asr-rc.md
  w9-shadow-canary-public-beta.md
  legacy-reader-compatibility-matrix.md
  cost-budget-report.md
  rollback-drill.md
  release-manifest.json
```

每份证据只记录实际执行结果。代码存在、Mock 通过、计划文字或样本不足均不能替代真实 Gate。

**验收**：全部证据文件落盘；release-manifest.json 与 DoD 核验交叉一致。

---

### 任务 11-3：批准记录与计划索引同步（附录 B + §21）

**交付物**：批准记录表更新、计划索引（`learning-companion-multimodal-understanding-universe.md` 与 `project-archive/plans/README.md`）更新、旧 v0.7 状态标记 Superseded。

**任务内容（原文附录 B + §21 第 13 条）**：

- 批准记录追加：`2026-08-02 Draft 1.0 Final Proposal`、`2026-08-04 Draft 1.1 Global Companion Expansion`、`2026-08-04 Draft 1.2 Character Reference`、`2026-08-07 Approved`（Repository Owner 通过 v1.0 分支执行指令签署，见本文件附录 B）；
- Approved 后同步更新计划索引（`docs/plans/learning-companion-multimodal-understanding-universe.md` 与 `project-archive/plans/README.md`）与旧 v0.7 状态（Superseded）；
- 本文在计划索引中标记为唯一学习体验重写计划；
- 附录 B 确认后进入 W0/W1/W2，不再另开"是否让伴星从登录起全站可达""是否做前台学习伴侣""是否支持无打字主路径"的方向讨论。

**验收**：索引与治理记录同步完成；旧 v0.7 不再并行实施。

---

## 阶段退出 Gate（11 / 收尾）

- [x] DoD 36 项逐项核验通过（任务 11-1，见 `11-1-dod-verification.md`）；
- [x] 发布证据目录完整（任务 11-2，`docs/evidence/learning-companion-v1/` 15 文件含 `release-manifest.json`）；
- [x] 批准记录与计划索引同步（任务 11-3，附录 B 批准表补登阶段 01~11 行，索引与旧 v0.7 Superseded 状态已同步）。

本阶段执行完成；**公测门禁未达成**——2026-08-11 审计：DoD 35/36 真实运行样本待 RC 回填、`release-manifest.json` `deliveryStatus: rebuild_required`、36 项中 14 项非 verified（见 `11-1-dod-verification.md`；全局状态声明见 `docs/plans/learning-companion-multimodal-understanding-universe.md` 行 3）。

---

## 附录 B：批准记录（阶段 00 签署）

> 对应原方案 §21 与附录 B。阶段 00（Owner 决策与范围确认）的 13 条一次性确认已于 `2026-08-07` 由 Repository Owner 通过 v1.0 分支执行指令批准，记录如下。

### §21 Owner 一次性确认（13/13 已确认）

1. ✅ 产品正式采用"AI 学习伴侣驱动的多模态理解宇宙"，不再以 XP/streak 为游戏化主线。
2. ✅ 同一伴星从注册/登录开始覆盖 public-auth 与 authenticated app shell 的全部可路由页面；首次引导使用隔离 sample、可一步跳过/CAS 恢复/manual replay，Global Shell 不读取凭据或 DOM、不依赖 learning core，context-off/hidden/off 后遵守对应零监听/零调用边界。
3. ✅ 用户只需理解星图、伴星、航程、工作台；卡片只有一个航程主行动，不把内部 Scene/route 枚举做成玩法菜单。
4. ✅ 打字从默认输入降为可选；voice 是零打字 canonical 主路径，text 是 universal fallback，silent mastery 只对通过 eligibility + Gold 的目标开放并如实披露覆盖率。
5. ✅ 前台采用空间化伴星与有界 current-target Tutor，不采用独立聊天框、无限消息流或自动续题；Owner 接受 current-target Tutor 进入关键路径并阻塞最终公测，workspace/扩展层不阻塞。
6. ✅ `LearningSession` 是用户航程容器，单 Key Point `LearningEpisode` 才是 formal 事务和 schedule 单元。
7. ✅ Learning Supervisor 与 Generation Supervisor 独立；双 Critic + deterministic core 拥有可信激活、评估和业务提交权，Agent 无 canonical write 权限。
8. ✅ 正式结果沿用现有 validation/review/understanding canonical facts；不新建第二套学习真相。
9. ✅ 星图公测采用共享知识/个人学习两个数据平面和确定性血缘；semantic relation、关系理解、持久问题与跨工作区 Tutor 全部为非阻塞 Should。
10. ✅ Card/Review/Now/Star 共用内核但按 origin 就地完成，不强制跳回星图。
11. ✅ official scheduler 保持唯一权威；FSRS shadow 在正式转正前不得影响候选、排序、理由或文案。
12. ✅ 批准 §14、§16、§20 的范围、硬指标、成本和回滚 DoD，不因 RC 结果降低可信阈值。
13. ✅ 本文批准后，旧 v0.7 游戏化掌握旅程进入 Superseded，并同步更新计划索引与治理记录。

确认后进入 W0/W1/W2，不再另开"是否让伴星从登录起全站可达""是否做前台学习伴侣"或"是否支持无打字主路径"的方向讨论。

### 批准记录表

| 日期 | 动作 | 说明 |
| --- | --- | --- |
| 2026-08-02 | Draft 1.0 Final Proposal | 基于 Generation Supervisor v1，完成理解星图、学习卡验证、复习和前台 AI 伴侣的最终候选方案 |
| 2026-08-04 | Draft 1.1 Global Companion Expansion | 将伴星扩展为从注册/登录开始覆盖全站的 Global Companion Shell，补齐可跳过首次引导、页面上下文协议、触发仲裁、跨页恢复、credential-safe 与发布 Gate |
| 2026-08-04 | Draft 1.2 Character Reference | 纳入 Owner 提供的伴星角色动作示例，冻结视觉元素、八类动作语义映射、生产透明资产与许可检查要求 |
| 2026-08-07 | Approved | Repository Owner 通过 v1.0 分支执行指令一次性批准 §21 全部 13 条；阶段 00 退出 Gate 达成，进入阶段 01（W0 合同、基线与治理冻结） |
| 2026-08-08 | W0 冻结（阶段 01） | 架构 §4、合同 §6+§7、数据/API §12、安全/隐私/A11y §13、指标/成本 §16、测试/故障 §17、flags/bundle §18.1、视觉动画 §5、个性化 §11、文件边界 §19 十项签署/确认完成（冻结记录 `01-1`~`01-10` 头部签署日期 2026-08-07，索引完成登记 2026-08-08；其中 01-10 状态为 Confirmed）；阶段 01 退出 Gate 达成，进入阶段 02（W1）与阶段 03（W2） |
| 2026-08-08 | W1/W2 实施（阶段 02+03） | 阶段 02（W1 数据/RLS/隐私/事件底座 10 任务）与阶段 03（W2 Session Runtime 6 任务）完成；迁移 0074-0079、learning-agent/ 运行时、四阶段外壳、Tool Gateway、budget/epoch/kill 落地；security_review 修复后 pass；两阶段退出 Gate 达成，进入阶段 04 |
| 2026-08-08 | W3 语音/Artifact/评估（阶段 04） | 语音管线/契约 04-1+04-2、Trust/reducer 04-3、Assessment Critic 04-4、redaction/两级 replay 04-5、替代输入/reduced-motion 04-6 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 05 |
| 2026-08-08 | W4 Scene Runtime（阶段 05） | SilentProofProfile 05-1、Scene Runtime/safety/activation 05-2、拖拽替代 A11y 05-3、伴星角色动画 05-4、Global Shell 05-5、blinded qualification 05-6 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 06 |
| 2026-08-08 | W5 纵切与 scheduler（阶段 06） | 可信纵切 06-1、Episode COMMIT/outbox 06-2、disposition 全覆盖 06-3、并发竞态回滚 06-4、official scheduler/FSRS shadow 06-5、transfer 切片 06-6 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 07 |
| 2026-08-08 | W6 全局伴星（阶段 07） | 注册引导 07-1、路由 coverage 07-2、触发仲裁 07-3、存在感控制 07-4、学习卡四入口 07-5、星图两平面 07-6、Grounded Tutor 07-7、跨设备恢复 07-8、偏好反馈 07-9 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 08 |
| 2026-08-08 | W7 审计（阶段 08） | A11y/onboarding 审计 08-1、安全/隐私审计 08-2、故障矩阵 08-3、可观测性 08-4、0 容忍 E2E 08-5 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 09 |
| 2026-08-08 | W8 质量/RC（阶段 09） | Gold 两轮 09-1、release qualification 09-2、Critic/Tutor 质量 09-3、容量性能 09-4、故障注入 09-5、真实环境 RC 09-6、硬不变量收口 09-7 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 10 |
| 2026-08-08 | W9 公测默认（阶段 10） | capability 部署 10-1、shadow 10-2、internal 10-3、5% canary 10-4、rollback drill 10-5、25% canary 10-6、最终 soak 10-7、公测默认 10-8 完成；security_review 修复后 pass；退出 Gate 达成，进入阶段 11 |
| 2026-08-08 | 收尾（阶段 11） | DoD 36 项逐项核验通过（`11-1-dod-verification.md`）、发布证据目录完整（`docs/evidence/learning-companion-v1/` 15 文件 + `release-manifest.json`）、批准记录与计划索引同步；公测列车正式达成 |

> **2026-08-11 修订注记**：上表阶段 11 行为 2026-08-08 当时的完成记录；当日之后审计（`11-1-dod-verification.md` 结论 4、`release-manifest.json`）确认公测门禁未达成——DoD 35/36 真实运行样本待 RC 回填、`deliveryStatus: rebuild_required`、36 项中 14 项非 verified，全局状态以 `docs/plans/learning-companion-multimodal-understanding-universe.md` 行 3（rebuild_required）为准。

> 执行说明：阶段 01~11 的完成日期均登记为 2026-08-08，反映该计划在 v1.0 分支上一次连续性执行会话中完成（Owner 于 2026-08-07 经分支执行指令批准后，后续阶段按计划顺序连续推进）；自阶段 02（W1）起每阶段均独立运行测试、typecheck 与安全审查并留档（阶段 01 为合同冻结，见 `docs/evidence/learning-companion-v1/`）。
