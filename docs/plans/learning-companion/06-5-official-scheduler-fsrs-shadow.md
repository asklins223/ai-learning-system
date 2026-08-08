# 冻结记录 06-5：official scheduler 与 FSRS shadow（§9）

> 状态：**Frozen（已冻结）**
> 执行：阶段 06（W5）任务 06-5
> 日期：2026-08-08
> 来源：`06-w5-vertical-slice-scheduler.md` 任务 06-5（原方案 §9 路线式复习与双层调度、
> §10.4 非强迫恢复）；冻结记录 `01-2-session-scene-artifact-trust-contracts.md`
> §5.2（typed scheduling authorization）、§8.3/§8.5（schedule 副作用矩阵）、
> `01-5-metrics-cost-gates.md` §16.1（FSRS shadow 0 影响）、§16.4（later/dismiss/stop
> 0 副作用、不自动进入下一轮）
> 约束级别：**FSRS shadow 0 路线影响**；**later/dismiss/stop 不修改 schedule、偏好或
> 理解状态**。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/official-scheduler.ts`：Official Scheduler
  （versioned discrete policy 作为**唯一 official**；formal eligibility / early-review
  authorization / typed scheduling authorization / due window / successor schedule /
  memory state / policy reason；FSRS shadow 结构隔离断言；Agent 上线不授权 FSRS 转正）。
  全部纯函数。
- `apps/api/src/modules/learning-sessions/official-scheduler.test.ts`：单测（44 例）。
- `apps/api/src/modules/learning-sessions/route-launcher.ts`：轻量路线启动器（「此刻」入口；
  非强迫恢复；一条推荐；换一个/换一组/减少/稍后/自由漫游/到期事实；无红账；不自动进入
  下一轮；later 是合法选择）。全部纯函数。
- `apps/api/src/modules/learning-sessions/route-launcher.test.ts`：单测（30 例）。
- 本文件：决策记录。

## 2. 核心决策

### 2.1 同一时间只有一个 official scheduler

- 当前 official = **versioned discrete policy（discrete-v2）**：`OFFICIAL_SCHEDULER_ID =
  "official-scheduler-v1"`、`OFFICIAL_POLICY_VERSION = "discrete-v2"`、
  `OFFICIAL_POLICY_EPOCH = 1`。
- **FSRS 保持独立 shadow**：只有完成连续 stability/difficulty 状态、校准、工作量和
  回放 Gate 后才能转正（`resolveFSRSPromotionStatus` 恒返回 `shadow_only`）。
- **Agent 上线不自动授权 FSRS 转正**：`agentOnline` 参数被显式忽略。

### 2.2 Official Scheduler 职责（全部收口在本模块）

| 职责 | 实现 | 语义 |
| --- | --- | --- |
| formal eligibility | `resolveFormalEligibility` | initial_validation / scheduled_review / repair_revalidation / ad_hoc_transfer / practice；无 canonical → fail closed；create_initial 要求不存在 active pending（01-2 §5.2） |
| early-review authorization | `authorizeEarlyReview` | 必须用户显式请求 + 无 unassisted 冷却 + 近期无失败 + 存在 pending；**从 Card/Star 选择目标只改 prioritySource，本身不授予 early review**（01-2 §5.2） |
| typed scheduling authorization | `issueTypedAuthorization` | create_initial / consume_pending / record_only / no_effect；consume_pending 必须绑定精确 inputScheduleId + generation，否则 fail closed 为 record_only |
| due window | `computeDueWindow` | effective start = max(next_review_at, unassisted_eligible_after)（discrete-v2 §9.4）；not_due / due / overdue（默认宽限 24h） |
| successor schedule | `computeSuccessorSchedule` | 只有 create_initial / consume_pending 才可能产生 successor；record_only / no_effect 一律 0 schedule 副作用（01-2 §8.5）；stale/provider_failure 不写 |
| memory state | successor 内 | before/after interval、understandingEffect（upgrade/downgrade/unchanged） |
| policy reason | reasonCodes | 进入 `OfficialSchedulingDecisionV1.reasonCodes`，随 decisionRef/hash 持久化到 Episode plan |

`deriveOfficialDecision`（PREPARE 阶段）产出冻结的
`OfficialSchedulingDecisionV1 { decisionRef, decisionHash, authorizedAction,
inputScheduleId, inputScheduleGeneration, prioritySource, policyVersion, policyEpoch,
reasonCodes }` —— 每个 Episode plan 都持久化这组字段（01-2 §5.2 / 06-5）。

### 2.3 FSRS shadow 隔离（0 路线影响断言）

- official-scheduler / route-launcher 的**输入与输出类型不含任何 FSRS 字段**（类型层面
  隔离）；
- `assertFSRSShadowNoInfluence(officialDecision, shadowDecision)`：official decision 只含
  冻结字段，shadow 字段名不得与其重合；违规即抛错；
- 单测证明：候选附加任意 FSRS shadow 字段不改变排序、推荐理由或到期事实；推荐文案
  不含 FSRS 标识（§16.1「FSRS shadow 进入候选、排序、推荐理由或用户文案 = 0」）。

### 2.4 路线启动器（「此刻」入口）

- 询问或沿用可用时间/意图/输入条件；**默认只展示一条有理由的推荐路线**，点「换一个」
  才生成并替换；
- 支持：换一个（排除当前推荐目标重新生成）、换一组（排除当前 + 历史排除 + later）、
  减少数量、稍后、自由漫游（practice-only · 不影响进度）、查看详细到期事实；
- 不要求清空；到期事实用**事实语言**（「已到期 X 天」），**不显示红色欠账**；
- **不自动进入下一轮**：stop → done；dismiss → 关闭推荐不自动补一条；deferLater 清空
  路线后不自动生成替代；`requestNextRound` 是显式请求才进入下一轮；
- 原始 FIFO Review Queue 保留为诊断、历史和回滚入口，本模块不替代它。

### 2.5 非强迫恢复

- 长时间未使用（默认 ≥ 3 天）或首次进入且未知时间 → `ask_time`：**先询问当前可投入
  时间**（3/10/20 分钟或自定义）；
- 回答时间后只按 official scheduler 优先级 + canonical gap + 用户当前兴趣选择**少量
  内容**（恢复上限 `RECOVERY_MAX_ITEMS = 2`）；
- **未处理 schedule 保留事实**：候选集在任何动作下保持原样，不因不展示而被静默完成或
  延期；
- 用户可随时停止，部分完成不受惩罚；`later` 是合法用户选择，不是失败状态。

### 2.6 零副作用保证（§16.4）

- `later/dismiss/stop`（以及换一个/换一组/减少/查看/自由漫游）**不修改 schedule、
  偏好或理解状态**：sideEffects 只含 `{kind:"none"}`；
- 唯一允许的副作用是用户明确开始某目标的 `begin_episode`，且它只引用 official
  `schedulingDecisionRef`，不写 schedule —— schedule 修改只由 official 决策 + commit
  阶段决定；
- Agent 不得静默延期、完成或修改 schedule，也不得让 practice 结果进入 FSRS（practice
  的 shadow 写入路径维持既有 `computeFSRSShadowDecision` 的 assisted/stale 拒绝语义，
  本任务不改写该路径）。

## 3. 与既有冻结语义的对齐

- `authorizedAction` / `prioritySource` / `policyEpoch` 字段与
  `PrivateLearningEpisodeContract.schedulingDecision`（scene-contracts.ts）同型；
- `deriveOfficialDecision` 复用 session-service 的 `buildSchedulingDecision`，保证
  decisionRef/decisionHash 确定性生成，与既有 PREPARE 冻结格式一致；
- successor 计算委托 `scheduling-policy-v2`（`calculateDiscreteV2Schedule`），official
  scheduler 只做授权封装与 0 副作用防护；
- 03-2 `deriveEpisodeCandidates` 的优先级顺序（user_selected > official_due/overdue/
  repair > canonical_gap）在 route-launcher 中保持，恢复路径强调 official 优先级。

## 4. 验收标准

1. `npm run typecheck --prefix apps/api` 通过；
2. `npm test --prefix apps/api` 通过（2006 通过 / 0 失败，含新增 74 例）；
3. FSRS shadow 0 路线影响（结构隔离断言 + 附加 shadow 字段排序不变 + 文案无 FSRS）；
4. `later/dismiss/stop` 不修改 schedule、偏好或理解状态（sideEffects 全 none 单测）；
5. Agent 上线不自动授权 FSRS 转正（恒 shadow_only 单测）。

> 本记录与 `06-w5-vertical-slice-scheduler.md` 任务 06-5、冻结记录 01-2/01-5 冲突时，
> 以本记录与对应冻结记录为准。
