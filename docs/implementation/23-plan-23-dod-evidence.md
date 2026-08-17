# Plan 23 DoD 证据记录（RL-18 汇总；持续更新）

> 依据：23 方案 §27 Definition of Done。每项链接到测试、集成测试、commit 或运行指标。
> 更新至：2026-08-17（第 5 实施轮）

## 一、产品 DoD（§27.1）

| # | 项目 | 证据 |
|---|---|---|
| 1 | 用户能区分"查看学习目标"和"开始学习" | typed action（create_run/resume_run/review/practice_only）→ 唯一主行动按钮；action-navigation.vitest.ts（6 用例）断言 card_v2/review_v2 参数与 resume 精确 runId |
| 2 | Card 详情不再像不能提交的答题页 | learning-cards/[cardId]/page.tsx 档案页（FE-19..26）：无输入/无 renderer；集成测试断言 surface 装配无 answer/rubric 泄漏 |
| 3 | 所有正式作答只发生在三分钟旅程 | LearningRun 为唯一提交边界（方案 16 冻结）；详情/卡库/首页 CTA 全部走 /learning-runs/new（origin=card_v2/review_v2/today_v2） |
| 4 | 只有 V2 Objective 的工作区首页完整可用 | learning-dashboard.integration.ts：纯 V2 fixture（4f825f38）首页非空、非 first_use、focus 可行动 |
| 5 | Card 列表展示真实 Note/Source | ObjectiveLibrary.tsx 行内 ObjectiveSourceLine（noteTitle+freshness）；list item 携带 primaryNoteTitle |
| 6 | 星图 Objective 与 Note 有明确血缘 | understanding-topology-v3.integration.ts：backfill 后 sourced_from 边 >= 3、missing_origin=0 |
| 7 | 一卡一目标不再生成重复知识节点 | Topology V3 无 card/key_point 节点（assertNoCardOrKeyPointNode 断言）；graph 页 V3 切流（-1554 行旧双实体代码） |
| 8 | source_outdated/archived/superseded 一致体验 | Surface freshness/lifecycle + chip 映射（objective-state.vitest.ts 6 用例）；§36.5 状态矩阵落地 |
| 9 | 0-card Note 完整存在 | Topology 测试断言 Note 节点在 0-objective 情况仍存在（TP-10） |

## 二、技术 DoD（§27.2）

| # | 项目 | 证据 |
|---|---|---|
| 1 | Objective Surface 是唯一正式读取合同 | learning-objective-surface-contracts.ts（V3 zod strict）+ learning-objectives 模块；首页/卡库/详情/星图全部消费 V3 |
| 2 | Dashboard 同一 snapshot/eligibility cutoff | learning-dashboard/service.ts（单事务构建）+ parity 测试：list 默认 active cutoff（RL-01 暴露并修复） |
| 3 | Objective Origin 支持多来源并完成 backfill | origin-migration.ts（card_note_version > evidence_binding 确定性版本匹配）+ 幂等 executor；RL-03 reconciliation：backfill 后 missing=0、silentLoss=0 |
| 4 | Topology V3 使用 objective-native node | understanding-v3/topology-repository.ts + contract 测试（拒收 card/key_point） |
| 5 | Home/Cards/Today/Review/Search/Graph/Pet 原子切流 | Home/Cards/Detail/Graph/Today 已切（commit 序列）；Search 索引（CS-03）；Pet 区被并行重构占用（CS-05/06 pending）；capability bundle 空壳就绪（W0-09，OFF） |
| 6 | legacy alias 正式可见性为 0 | 0176 迁移退役整个 alias 机制（并行实施 commit 46c0c38）；RL-02 断言纯 V2 fixture 无 active legacy 卡 |
| 7 | 所有旧 route 有明确迁移行为 | /v2/route-resolution（mapped/gone/ambiguous/forbidden）+ history-route 测试（V2 card mapped、未知 gone） |
| 8 | 历史 Run/Schedule/event/hash 未重写 | RL-04：backfill+reconcile+清理全流程 learning_runs 快照 sha256 字节级不变 |
| 9 | consumer audit 正式消费者全部 done | audit 模块随兼容层整体退役（并行 commit 3c9723f）；一致性由 parity 测试接替 |
| 10 | capability rollback 不破坏 in-flight Run | capability bundle 默认 OFF；Rollback-drill 图已含 learning_objective_system_v3（RL-14 演练 pending） |

## 三、质量 DoD（§27.3）

| # | 项目 | 证据 |
|---|---|---|
| 1 | Cross-surface parity 全通过 | learning-objective-parity.integration.ts（3 用例）：Dashboard=List=Graph active=表计数 |
| 2 | Home/Card detail/Run/Graph E2E | 页面级 E2E 待 API 恢复构建（并行波次中）；当前以集成测试 + 实机路由探测（307/401）代替 |
| 3 | public leakage gate | W1-17 contract 测试（注入私有键拒绝）+ surface/topology/dashboard 集成测试 findPrivatePayloadLeaks=0 + CS-03 搜索文档零私有载荷 |
| 4 | migration reconciliation 无未解释差异 | RL-03：每目标逐条可解释；silentLoss=0 |
| 5 | 320px/键盘/读屏 | chip/source-line/action 组件语义化（aria-label/aria-expanded/role=listbox/方向键）；视觉 QA 待 E2E 环境 |
| 6 | P0 一致性指标 | 指标链路（RL-09/10）pending；parity 测试作为 CI 级一致性门禁 |
| 7 | 视觉 QA | 待 UI 环境恢复（并行波次中） |

## 四、测试资产清单（当前全绿）

- 集成测试 24/24（apps/api/src/integration-tests/learning-objective-*.integration.ts + understanding-topology-v3 + learning-dashboard）
- 单测 9/9（action-resolver）
- Web vitest 12/12（action-navigation 6 + objective-state 6）
- shared contract 测试 508+（含泄漏/版本冻结）
- 脚本：objective-inventory（只读）、legacy-field-scan、verify-objective-fixtures、origin-backfill-cli
