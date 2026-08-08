# 阶段 06（W5）：单 Key Point 可信纵切与 official scheduler

> **第一层执行顺序第 6 步**
> 前置：阶段 05（W4 Scene Runtime）与阶段 02（W1 Handoff/adapter Gate）
> 后置：阶段 07（W6 全局伴星）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W5」；规范依据：§4.3（COMMIT）、§7.4（disposition 矩阵）、§7.7（stale/cancel）、§9（路线式复习与双层调度）、§8（学习卡）。

---

## 本阶段目标

在一个 Key Point 上打通 voice 与 profile-eligible silent bundle 的完整可信链路（prepare → lock → assess → reducer → commit → domain facts → outbox projection），并让 official scheduler 成为唯一 schedule 写路径。

## 可并行执行的任务（第二层）

### 任务 06-1：单 Key Point 可信纵切

**交付物**：一个 Key Point 上打通 voice 与 profile-eligible silent bundle 的 `stabilize/clarify` 完整闭环。

**任务内容（原文 §15 W5 bullet + §9.1）**：

- `stabilize`（重新看看）：语音回忆或 `structured-proof-v1`；只有 official `create_initial/consume_pending` 的完整 mastery Episode 才创建/消费 schedule，并恰好留下一个 active schedule；
- `clarify`（再弄清一点）：独立诊断 → 结果 → 引导练习；提示前的完整正式 Episode 可提交；提示后的操作全为 practice；
- 语音路径覆盖全部 required rubric/facets 时签发 `mastery_eligible`；silent bundle 满足 §7.4 全部条件时归一 canonical outcome。

**验收**：voice 与 silent 两条主路径在同一 Key Point 上均可完成并产生正确 disposition。

---

### 任务 06-2：Episode 全链路与 outbox projection（§4.3/§12.2）

**交付物**：Episode prepare → lock → assess → reducer → `EpisodeCommitDispositionV1` → existing-domain facts → outbox projection 打通。

**任务内容（原文 §4.3 COMMIT + §12.2，W5 bullet）**：

- 最终 COMMIT 在一个数据库事务内按固定顺序锁 `runtime-control → learning_episode → authoritative target/version guard → keyPoint schedule guard → input schedule（consume 时）`，并以单次 CAS 同时验证：`runtimeEpoch=snapshot`、`episodeEpoch` 未变、Episode=`active && !cancelled && !stale`、current content revision/fingerprint 匹配、scheduling decision hash 匹配、kill=false；`create_initial` 还验证不存在 active pending，`consume_pending` 验证精确 generation 仍 active；任一失败整体回滚为 stale/cancelled/blocked；
- 服务端签发 `EpisodeTrustDecision`，运行 `rubric-session-reducer-v2` 与 `facet-to-mastery-policy-v1`，再由 contract 冻结版本的互斥纯函数推导唯一 `EpisodeCommitDisposition`（优先级链见阶段 01 任务 01-2）；
- 正式结果优先落入现有 validation/review/understanding canonical facts，并通过同事务 outbox 派生 facet/map projection，避免第二套真相；
- 一个 Episode commit 失败或 stale 不回滚之前已成功的独立 Episode；cancel 后已 commit Episode 保留，当前和未开始 Episode 零副作用；重试、断线和 Worker crash 不得重复 result 或 schedule 副作用。

**验收**：同事件重放得到相同 disposition 与投影 hash；outbox 派生 projection 正确。

---

### 任务 06-3：disposition 全覆盖（§7.4）

**交付物**：create-initial、consume-pending、record-only/facet、practice/diagnostic、not-assessable/unable 全部覆盖。

**任务内容（原文 §7.4 disposition 表，W5 bullet）**：

- `canonical_mastery`：写现有 validation event（review origin 同时写 review attempt/outcome），create/consume 后恰好一个 active schedule，同 generation exactly-once；
- `canonical_unable`：用户明确 `unable` 时按冻结 unable policy 恰好一个 active schedule，不写"已掌握"；
- `canonical_facet_observation`：写扩展后的 `validation_point_assessments` 作为唯一 canonical facet fact + outbox；0 overall outcome、0 review attempt、0 schedule；
- `practice_or_diagnostic`：写 learning session practice/diagnostic event；0 canonical projection、0 schedule；
- `operational_only`：not-assessable/provider failure/stale/cancel → retryable/terminal operational state 与低敏审计；0 学习副作用；
- incomplete silent bundle 只保留 support artifact，绝不因 `record_only` 落入 facet canonical fact。

**验收**：consume-pending 最多消费一次；create/consume 后恰好一个 active schedule；record-only/facet/practice/operational 0 调度副作用。

---

### 任务 06-4：并发、竞态与回滚（§7.6/§7.7）

**交付物**：同 schedule 并发、旧/新入口竞态、partial/stale/cancel 和 rollback 全部通过。

**任务内容（原文 §7.6/§7.7，W5 bullet）**：

- 同一 pending schedule 不能同时被旧 question-first submission 与新 Episode 消费；数据库唯一约束和 target-level idempotency 为最终兜底；
- legacy reveal → new Episode lock、new reveal → legacy submit、Scene/Rubric/policy rollover 三组共享 `contentExposureKey` 竞态正确；
- first artifact lock 后 rubric/target/evidence 不能改变；Key Point/Evidence/Rubric/Scene policy 任一内容失配 → stale，无正式副作用；
- cancel 终止当前和未开始 Episode；已 commit 保留；partial commit 状态明确；
- 所有 turn/tool/Critic 结果落库前重新比较 contract 的 `runtimeEpochSnapshot + episodeEpoch`；hard kill 后迟到响应只记低敏审计摘要；
- 断线恢复只读取 event/contract/artifact，不重复 Provider 调用和业务副作用。

**验收**：并发双顺序测试（kill/cancel/stale/publish × COMMIT）全部通过；rollback 后无重复副作用。

---

### 任务 06-5：official scheduler 与 FSRS shadow（§9）

**交付物**：versioned discrete policy 作为当前 official scheduler、FSRS 独立 shadow、路线建议与非强迫恢复。

**任务内容（原文 §9，W5 bullet）**：

- 同一时间只能有一个 official scheduler：当前可继续使用 versioned discrete policy；FSRS 保持独立 shadow，只有完成连续 stability/difficulty 状态、校准、工作量和回放 Gate 后才能转正；Agent 上线不自动授权 FSRS 转正；
- Official scheduler 负责：formal eligibility、early-review authorization、typed scheduling authorization、due window、successor schedule、memory state 和 policy reason；
- Learning Session Supervisor 只在合法候选集合中决定：本轮处理哪些目标、顺序/主题聚合/预计时长、采用什么 Encounter、是否建议稳固/修补/迁移；Agent 不得静默延期、完成或修改 schedule，也不得让 practice 结果进入 FSRS；
- "此刻"（原 Today）从任务入口改为轻量路线启动器：询问或沿用可用时间/意图/输入条件；默认只展示一条有理由的推荐路线，点"换一个"才生成并替换；支持换一组、减少数量、稍后、自由漫游和查看详细到期事实；不要求清空，不显示红色欠账，不自动进入下一轮；原始 FIFO Review Queue 保留为诊断、历史和回滚入口；
- 非强迫恢复：长时间未使用后先询问当前可投入时间；只使用 official scheduler 优先级、canonical gap 和用户当前兴趣选择少量内容；未处理 schedule 保留事实，不因不展示而被静默完成或延期；用户可随时停止，部分完成不受惩罚；`later` 是合法用户选择，不是失败状态；
- 每个 Episode plan 持久化 `schedulingDecision.decisionRef/hash/authorizedAction/prioritySource/policyEpoch`；FSRS shadow 不得进入候选、排序、推荐理由或用户文案。

**验收**：FSRS shadow 0 路线影响；`later/dismiss/stop` 不修改 schedule、偏好或理解状态。

---

### 任务 06-6：transfer 最小切片与静态 fallback（§8/§10.6）

**交付物**：单 Key Point transfer 最小切片（只在完整 rubric/evidence 下开放）与不依赖 Canvas 的列表/静态卡 fallback。

**任务内容（原文 §14.1/§10.6，W5 bullet）**：

- 单 Key Point `transfer` 最小切片只在完整 rubric/evidence 下开放；`transfer`（试着应用）：单 Key Point 情境、故障修复、边界变式；默认 `record_only` 写 facet，只有 official policy 签发 `create_initial/consume_pending` 且完整 mastery plan 通过时才影响 schedule；
- 先提供不依赖 Canvas 的列表/静态卡 fallback（星图不是唯一入口：搜索、卡片、"此刻"和复习均可直接开始）；
- `explore`（随便看看）：听解释、证据浏览、开放问题和沙盘，全部 practice-only，不消费 schedule。

**验收**：transfer 无完整 rubric/evidence 时不可达；无 Canvas 环境下主路径完整。

---

## 阶段退出 Gate（06 / W5）

- [x] consume-pending 最多消费一次；create/consume 后恰好一个 active schedule；
- [x] record-only/facet/practice/operational 0 调度副作用；
- [x] FSRS shadow 0 路线影响；
- [x] 同 schedule 并发、旧/新入口竞态、partial/stale/cancel 和 rollback 全部通过；
- [x] 列表/静态卡 fallback 可用。

通过后进入阶段 07（W6 全局伴星）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：06-1~06-6 全部实施并签署（契约/服务/测试/决策记录均落盘）
- 验证：apps/api 2006/2006、packages/shared 374/374、packages/db 5/5、apps/web 549/549、typecheck 与 git diff --check 全部通过
- security_review：1 轮 warn（1 MEDIUM 幂等 TOCTOU / 1 MEDIUM generation 默认 0）→ 修复后复查 **pass**（幂等检查移入锁内 + setCommitKey 契约同事务唯一约束、缺 generation 降级 record_only）
- 承接：阶段 07（W6 全局伴星、四入口、星图与当前目标 Tutor）
