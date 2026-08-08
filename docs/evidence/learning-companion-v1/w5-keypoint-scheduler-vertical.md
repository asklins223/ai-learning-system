# W5 证据：单 Key Point 纵切、official scheduler 与四入口

> 对应任务 11-2 证据文件 7。佐证 DoD 4、21、22、23、24、25、26。
> 决策记录：`docs/plans/learning-companion/06-w5-vertical-slice-scheduler.md`（任务 06-1~06-6）与 `06-1-vertical-slice.md` ~ `06-6-transfer-minimal-slice.md`、`07-5-learning-card-four-entries.md`。
> 状态：**Frozen** ｜ 执行：阶段 11 / W11 任务 11-2 ｜ 日期：2026-08-08

## 1. 实现文件核验（路径存在）

`apps/api/src/modules/learning-sessions/` 下：

| 单元 | 路径 | 对应任务 |
| --- | --- | --- |
| vertical-slice | `vertical-slice.ts`（+ `vertical-slice.test.ts`） | 06-1 |
| episode-commit | `episode-commit.ts`（+ `episode-commit.test.ts`） | 06-2 |
| disposition | `disposition.ts`（+ `disposition.test.ts`） | 06-3 |
| race-rollback | `race-rollback.ts`（+ `race-rollback.test.ts`） | 06-4 |
| official-scheduler | `official-scheduler.ts`（+ `official-scheduler.test.ts`） | 06-5 |
| route-launcher | `route-launcher.ts`（+ `route-launcher.test.ts`） | 06-5 |
| transfer-gate | `transfer-gate.ts`（+ `transfer-gate.test.ts`） | 06-6 |
| four-entry-origin | `apps/web/lib/learning-companion/four-entry-origin.ts`（+ `four-entry-origin.test.ts`） | 07-5 |

## 2. 单 Key Point 可信纵切（06-1，佐证 DoD 4、24）

- `vertical-slice.ts` 在一个 Key Point 上打通 voice 与 profile-eligible silent bundle 的完整闭环：`stabilize`（重新看看：语音回忆或 structured-proof-v1，只有 official `create_initial/consume_pending` 完整 mastery Episode 才创建/消费 schedule，恰好一个 active schedule）与 `clarify`（再弄清一点：独立诊断 → 结果 → 引导练习，提示前完整正式 Episode 可提交，提示后全为 practice）。
- 语音路径覆盖全部 required rubric/facets 时签发 `mastery_eligible`；silent bundle 满足 §7.4 条件时归一 canonical outcome（佐证 DoD 24 的 stabilize/clarify 同一 Episode 模型，非缺陷化用户文案）。

## 3. COMMIT 单事务 CAS 与 outbox 投影（06-2，佐证 DoD 21、23）

- `episode-commit.ts` 实现最终 COMMIT：一个数据库事务内按固定顺序锁 `runtime-control → learning_episode → authoritative target/version guard → keyPoint schedule guard → input schedule（consume 时）`，单次 CAS 同时验证 runtimeEpoch=snapshot、episodeEpoch 未变、Episode=active && !cancelled && !stale、content revision/fingerprint 匹配、scheduling decision hash 匹配、kill=false；`create_initial` 验证无 active pending，`consume_pending` 验证精确 generation 仍 active；任一失败整体回滚为 stale/cancelled/blocked（佐证 DoD 23）。
- 服务端签发 `EpisodeTrustDecision` → `rubric-session-reducer-v2` → `facet-to-mastery-policy-v1` → 互斥纯函数推导唯一 `EpisodeCommitDisposition`；正式结果优先落入现有 validation/review/understanding canonical facts，同事务 outbox 派生 facet/map projection（support objects 不是第二套真相，佐证 DoD 21）。
- 一个 Episode commit 失败/ stale 不回滚之前已成功的独立 Episode；cancel 后已 commit 保留、当前与未开始零副作用；重试/断线/Worker crash 不重复 result 或 schedule 副作用。

## 4. disposition 全覆盖与调度唯一性（06-3/06-5，佐证 DoD 22）

- `disposition.ts` 五类 disposition 全覆盖（canonical_mastery / canonical_unable / canonical_facet_observation / practice_or_diagnostic / operational_only，详见 `w2` 证据 §4）：create/consume 后恰好一个 active schedule，consume-pending 最多消费一次；record-only/facet/practice/operational 0 schedule 副作用。
- `official-scheduler.ts`：同一时间唯一 official scheduler（versioned discrete policy），`route-launcher.ts` 为轻量路线启动器（默认只展示一条有理由的推荐路线，点"换一个"才生成并替换；支持换组/减少/稍后/自由漫游/查看到期事实，不要求清空、不显示红色欠账、不自动进入下一轮）；FSRS 独立 shadow，`schedulingDecision.decisionRef/hash/authorizedAction/prioritySource/policyEpoch` 持久化，FSRS shadow 不进入候选/排序/推荐理由/用户文案（0 路线影响，佐证 DoD 22）。
- 非强迫恢复：长时间未使用先询问可投入时间；`later` 是合法用户选择不是失败状态；`later/dismiss/stop` 不修改 schedule、偏好或理解状态（佐证 DoD 26 侧）。

## 5. 并发、竞态与回滚（06-4，佐证 DoD 23）

- `race-rollback.ts`：同一 pending schedule 不能被旧 question-first submission 与新 Episode 同时消费（数据库唯一约束 + target-level idempotency 兜底）；legacy reveal → new Episode lock、new reveal → legacy submit、Scene/Rubric/policy rollover 三组 `contentExposureKey` 竞态正确；first artifact lock 后 rubric/target/evidence 不可改变，内容失配 → stale 无正式副作用；kill/cancel/stale/publish × COMMIT 并发双顺序测试全部通过，rollback 后无重复副作用。

## 6. transfer 最小切片与静态卡 fallback（06-6，佐证 DoD 24）

- `transfer-gate.ts`：单 Key Point `transfer`（试着应用）只在完整 rubric/evidence 下开放；默认 `record_only` 写 facet，只有 official policy 签发 `create_initial/consume_pending` 且完整 mastery plan 通过时才影响 schedule；无完整 rubric/evidence 时 transfer 不可达。
- 不依赖 Canvas 的列表/静态卡 fallback 可用（搜索、卡片、"此刻"与复习均可直接开始，星图不是唯一入口）。

## 7. 四入口共享内核（07-5，佐证 DoD 25、26）

- `apps/web/lib/learning-companion/four-entry-origin.ts`：Card/Review/Now/Star 四 origin 共享 Session/Episode 内核，`originRef`、viewport/selection snapshot 与 completion summary contract 在 PREPARE 时冻结；每处可"在星图查看"但不强制跳转；origin-aware completion 在用户停止/选择返回/全部 Episode 明确结束时执行，不在 Episode 之间强制跳页。
- 多 Episode Session 每站后停于结果 checkpoint，只有用户命令 `confirm_continue_session` 才 PREPARE 下一 Episode（`session.ts`，03-2），默认可结束返回（佐证 DoD 26）。学习卡"一个主行动"与四入口 UI 接线完整验收见 `w6` 证据（07-5）。

## 8. 判定层证据

- 决策记录 `06-1`~`06-6`、`07-5` 头部状态均为 **Frozen（已冻结）**；阶段 06 退出 Gate 5 项全部勾选（consume-pending 最多消费一次、record-only/facet/practice/operational 0 调度副作用、FSRS shadow 0 路线影响、并发双顺序全通过、列表/静态卡 fallback 可用）。
- 阶段 06 执行记录：apps/api 2006/2006、packages/shared 374/374、packages/db 5/5、apps/web 549/549、typecheck 与 git diff --check 通过；security_review 1 轮 warn（幂等 TOCTOU / generation 默认 0）→ 修复后复查 **pass**（幂等检查移入锁内 + setCommitKey 同事务唯一约束、缺 generation 降级 record_only）。
