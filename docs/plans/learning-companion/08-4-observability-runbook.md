# 决策记录 08-4：可观测性、指标与 runbook（§16.4/§16.6）

> 状态：**Frozen（已冻结）**
> 执行：阶段 08（W7）任务 08-4
> 日期：2026-08-08
> 来源：`08-w7-audit-observability.md` 任务 08-4（§16.4/§16.6）+ 冻结记录 01-5
> （§16.4 产品与价值观指标、§16.6 成本与调用放大 Gate）+ 02-4（audit/ledger 隐私
> 生命周期）+ 04-5（全复制面 redaction）+ 07-9（偏好与反馈）
> 约束级别：dashboard/alerts/runbook 可用；观察指标与硬 Gate 分离清晰。

---

## 1. 交付物

- `apps/api/src/modules/observability/metrics-schema.ts`：指标 schema 纯逻辑
  （无 DB/无网络/无时钟/无副作用/无随机）——冻结指标定义表（observation /
  observe-only / cost / hard-gate 四类）、观察 vs 硬 Gate 分离校验、分布/比例
  计算、成本与调用放大计算（p50/p95、重试放大、hidden/off 后新增成本 0）。
- `apps/api/src/modules/observability/metrics-schema.test.ts`：单测。
- `apps/api/src/modules/observability/privacy-review.ts`：privacy review 纯逻辑
  ——audit/ledger TTL、entity-bearing 数据清理、导出/删除与残留扫描检查清单。
- `apps/api/src/modules/observability/privacy-review.test.ts`：单测。
- 本文档：dashboard/alerts/runbook 与决策记录（Frozen）。

---

## 2. 决策：指标 schema 是确定性字典，观察与硬 Gate 分离是结构约束

dashboard、alerts、runbook 一律消费 `metrics-schema.ts` 的冻结枚举与纯函数，任何
地方不得自造指标语义：

- **四类指标**（`MetricCategory`）与冻结记录逐条对应：
  - `observation`：§16.4 §5.1「观察但不作为强迫优化目标」——首次引导开始/跳过/
    暂停/恢复/重播分布与引导后首个有意义动作比例；召唤/建议采纳/忽略/立即隐藏/
    manual fallback（按 route/page kind）；无键盘完成 Session 占比；模态分布；
    存在感设置分布与关闭率；路线主动停止/缩短/换一组/完成比例；问题标记保存/
    解决/丢弃（Should）；后续独立 recall、修补后同类 rubric 缺失率、迁移任务
    成功率；Tutor 显式反馈；ASR not-assessable 与模态切换率；
  - `observe-only`：§16.4 §5.2「只观察、不得用于授权强迫优化」——onboarding
    完成率、伴星打开时长、对话轮数、留存、DAU、学习时长、完成数量（7 项）；
  - `cost`：§16.6——每 Episode/Session 的 LLM 调用、输入/输出 token、ASR 秒数、
    TTS 字符、对象存储字节、current-target Tutor 独立预算；用户级 p50/p95 成本；
    重试放大系数；
  - `hard-gate`：§16.4 §5.3 + §16.6 硬 Gate 观测对照项——hidden/off 后新增成本 0、
    用户取消确认后新增调用 0、Tutor 不得借用 formal 预算、重试放大系数上限、
    p95 成本上限。
- **观察 vs 硬 Gate 分离是结构约束**（`checkCoerciveAuthorization`）：任何非
  hard-gate 指标被授权 `hide_skip / extra_modal / streak / task_debt /
  auto_advance / companion_nudge` 任一强迫优化手段即判违规；`observe-only`
  7 项经 `assertObservationOnlyMetric` fail closed。**不得**以 onboarding 完成率、
  伴星打开时长、对话轮数、留存、DAU、学习时长或完成数量授权隐藏跳过、增加弹窗、
  streak、任务债务、自动续题或伴侣催促（§16.4 §5.2）。
- **确定性**：同一输入恒得同一输出。分布归一化、比例、p50/p95（R7 线性插值）、
  重试放大、成本聚合均无随机/时钟依赖，测试对每个函数提供干净样本 + 违规样本
  双断言。

## 3. 决策：成本与调用放大监控（§16.6）

- **每 Episode/Session 独立预算**：`llm_calls / input_tokens / output_tokens /
  asr_seconds / tts_characters / object_storage_bytes / tutor_budget` 按
  per-episode/per-session 统计；`sumCostSamples` 确定性聚合。
- **用户级 p50/p95**：`computeUserCostPercentile(userCosts, dimension, p)` 按维度
  计算，作为 dashboard 成本面板与扩容决策输入。
- **重试放大系数**：`computeRetryAmplification(uniqueRequests, billedCalls)` =
  计费调用 / 唯一请求；默认上限 `DEFAULT_RETRY_AMPLIFICATION_CAP = 1.5`（W0 冻结
  口径，RC 故障注入验证；只能改常量不能改判定逻辑）。同一 provider/job attempt
  重复计费调用：0。
- **hidden/off 后新增成本为 0**：`checkHiddenOffZeroNewCost` 对 hidden/off 确认
  后全部成本样本判定任一维度 > 0 即违规；`cancel_confirmed` 语义覆盖「用户取消被
  服务端确认后新增调用：0」。
- **Tutor 预算隔离**：`checkTutorFormalBudgetIsolation` 保证 Tutor detour 用独立
  envelope、不消耗/不借用 formal assessment 预算。
- **p95 成本上限**：`checkP95CostCap` 任一维度 p95 越过冻结上限即停止扩量；以缩减
  Critic/证据/A11y 绕过成本上限的上报一律判违规（§16.6）。
- **零成本面**：公开认证层、安静锚点、未触发页面 context 注册不产生 Provider 成本
  （对应 08-5 D1/D5 的 zero-activity 校验，本 schema 提供成本侧对照）。

## 4. 决策：dashboard

只读面板，按 §16.4/§16.6 分组展示，指标 id 全部来自冻结定义表：

| 面板 | 指标（id） | 说明 |
| --- | --- | --- |
| 首次引导 | onboarding_started / onboarding_first_meaningful_action_ratio | 分布 + 首个有意义动作比例 |
| 召唤与采纳 | companion_summoned | summoned/adopted/ignored/immediately_hidden/manual_fallback 分布 |
| 完成与模态 | no_keyboard_session_ratio / modality_distribution | 无键盘占比 + 模态分布 |
| 存在感 | presence_distribution / presence_turn_off_rate | 设置分布 + 关闭率 |
| 路线 | route_disposition_distribution | active_stop/shortened/switched_group/completed |
| 问题标记 | question_flag_disposition_distribution | saved/resolved/discarded（Should） |
| 学习成效 | subsequent_independent_recall / post_repair_same_rubric_miss_rate / transfer_task_success_rate | recall/缺失率/迁移成功率 |
| Tutor/ASR | tutor_feedback_distribution / asr_not_assessable_rate / modality_switch_rate | 显式反馈 + ASR |
| 产品观察 | onboarding_completion_rate / companion_open_duration / conversation_turns / retention / dau / learning_duration / completions_count | 只观察，**不带优化动作** |
| 成本 | llm_calls_per_episode / llm_input_tokens_per_episode / llm_output_tokens_per_episode / asr_seconds_per_session / tts_characters_per_session / object_storage_bytes_per_episode / tutor_budget_per_episode / user_cost_p50 / user_cost_p95 / retry_amplification_factor | 每 Episode/Session + 用户级分位 |

dashboard 不得为观察指标提供「据此修改行为」的控件；observe-only 指标面板附加
「只观察，禁止授权强迫优化」横幅（文案校验复刻 07-9 反馈约束风格）。

## 5. 决策：alerts

告警规则全部以 `hard-gate` 与 `cost` 类指标为触发源（`observation / observe-only`
只进面板、不设 alert）：

| 告警 | 触发 | 动作 |
| --- | --- | --- |
| hidden-off-new-cost | `checkHiddenOffZeroNewCost` 任一违规 | 立即冻结扩容、走 §7 runbook P1 |
| cancel-confirmed-calls | `cancel_confirmed` 任一违规 | P1（自主性硬 Gate） |
| tutor-formal-borrow | `checkTutorFormalBudgetIsolation` 违规 | P1 |
| retry-amplification | `checkRetryAmplificationUnderCap` 超过 1.5 | P2，故障注入复查 |
| p95-cost-cap | `checkP95CostCap` 越限 | P1：停止扩量（不得缩减质量项绕过） |
| privacy-review | `assertPrivacyReviewPassed` 任一违规 | P1（§5.3-12 硬 Gate） |

观察类指标（onboarding 完成率/留存/DAU 等）**不产生 alert**——避免任何把观察
指标当 SLA 触发强迫优化的路径。

## 6. 决策：privacy review（§13.2 / 02-4 / 01-5 §5.3-12）

`privacy-review.ts` 提供 12 项确定性检查清单（`runPrivacyReview` +
`assertPrivacyReviewPassed` fail closed）：

1. audit TTL：`companion_audit` 超过 30 天未 delete/tombstone 为违规；
2. ledger TTL：`companion_invitation_ledger` 原始 entity refs 超过 30 天为违规；
3. audit tombstone content-free：清空 entityOpaqueIds/contextPermissionHashes；
4. ledger tombstone content-free：key 替换为不可逆 SHA-256 截断键、清空
   boundedReason/suggestionLease/oneTimePermit；
5. entity 清理覆盖全存储（DB/对象存储/队列/cache 残留 0，对齐 04-5 全复制面）；
6. 导出覆盖率 100%（活动行 + tombstone 行）；
7. 删除跨全部 workspace 级联；
8. 删除后不触发重新邀请；
9. 删除后不重建画像；
10. 全存储残留扫描唯一删除入口（count=1）；
11. 用途隔离：不入增长画像/兴趣推断/跨 workspace analytics；
12. RLS 双条件：audit user-private、ledger user-private-in-workspace（0075 风格）。

## 7. 决策：runbook（故障手册）

| 严重度 | 场景 | 步骤 |
| --- | --- | --- |
| P1 | hidden/off 后仍产生 Companion 成本 | 1) `checkHiddenOffZeroNewCost` 定位维度；2) 复核 runtime-fence / epoch fanout（08-5 D1/D2）；3) 取消未取消调用、丢弃迟到结果；4) 修复前冻结相关扩量；5) 记录违规，禁止 trusted 恢复（01-5 §5.3-12 语义） |
| P1 | 用户取消后新增 Provider 调用 | 服务端取消确认后零新增调用复核；调用面按 08-5 D1 零活动矩阵排查 |
| P1 | Tutor 借用 formal 预算 | 隔离 envelope 复核；Tutor detour 按 contract 上限扣账（01-5 §16.6） |
| P1 | p95 成本越限 | 停止扩量；不缩减 Critic/证据/A11y；进入 W8 容量/真实 Provider RC 评审 |
| P2 | 重试放大 >1.5 | 故障注入复查（01-5 §16.6）；恢复只走有 SLA 的 recovery queue，不得因预算耗尽卡死 retryable |
| P1 | privacy review 违规 | 定位 12 项中违规项；TTL/残留扫描/导出删除入口修复；数据残留清理为 0 后重新 review |
| P2 | 观察指标面板异常 | 校验埋点是否符合冻结 schema（`validateMetricSchema`）；不因观察值改变产品行为 |

## 8. 不做的边界

- 不实现埋点/采集器/harness（真实事件上报与时间窗统计在接线任务）；本 schema 提供
  确定性聚合与判定函数供其消费。
- 不新增数据库表（指标/成本走既有 audit、outbox 与学习 Session 事件域投影；
  audit/ledger 隐私语义由 02-4 维护）。
- 不修改既有 companion/learning-sessions 模块行为；全部为读侧纯逻辑。

## 9. 验收与证据

- [x] 指标 schema 覆盖任务 08-4 全部指标清单（§16.4 §5.1/§5.2 + §16.6）。
- [x] 观察 vs 硬 Gate 分离清晰：非 hard-gate 指标授权任何强迫优化判违规；
      observe-only 7 项 fail closed。
- [x] 成本计算：p50/p95、重试放大、hidden/off 后新增成本 0、Tutor 预算隔离、
      p95 上限（含质量缩减绕过）。
- [x] privacy review 12 项检查清单 + fail closed。
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。
- [x] `npm test --prefix apps/api` 通过（含新增 metrics-schema/privacy-review 单测）。
