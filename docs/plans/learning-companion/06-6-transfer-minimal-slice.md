# 冻结记录 06-6：transfer 最小切片与静态卡 fallback（§8/§14.1/§10.6）

> 状态：**Frozen（已冻结）**
> 执行：阶段 06（W5）任务 06-6
> 日期：2026-08-08
> 来源：`06-w5-vertical-slice-scheduler.md` 任务 06-6（原方案 §14.1 transfer / §10.6 星图入口与 Canvas 改造原则）；冻结记录 `01-2-session-scene-artifact-trust-contracts.md` §5.2/§7.3/§8.3/§8.5
> 约束级别：**transfer 无完整 rubric/evidence 时不可达**；**无 Canvas 环境主路径完整**（星图不是唯一入口）。

**交付物**：`apps/api/src/modules/learning-sessions/transfer-gate.ts`（单 Key Point transfer 最小切片守卫，纯函数）、`transfer-gate.test.ts`（单测）、`apps/web/components/learning-companion/StaticCardFallback.tsx`（列表/静态卡 fallback，无 Canvas 依赖）、本文档（决策记录）。

---

## 1. 冻结范围（§14.1 transfer + §8 学习卡主行动）

- `transfer`（试着应用）是四个 intent 之一（`stabilize` / `clarify` / `transfer` / `explore`，01-2 §5），
  **不是平级玩法按钮**；本任务交付的是其**单 Key Point 最小切片**；
- transfer **只在完整 rubric/evidence 下开放**：`rubricComplete` 与 `evidenceComplete`
  任一为 false → `unavailable`（fail closed，无任何学习/schedule 副作用）；
- transfer 三种形态：`situated_application`（单 Key Point 情境）、`repair`（故障修复）、
  `boundary_variant`（边界变式），各自映射到 Scene 种类（01-2 §6.1/§6.2）；
- **默认 `record_only` 写 facet**：只有 official policy 签发 `create_initial`/`consume_pending`
  **且完整 mastery plan 通过**时才影响 schedule；否则 `effectiveAuthorizedAction` 降级为
  `record_only`（0 schedule 副作用，facet-to-mastery-policy-v1 §8.3）；
- `explore`（随便看看）：听解释、证据浏览、开放问题、沙盘，全部 `practice_only` + `no_effect`，
  不消费 schedule。

## 2. transfer-gate 守卫规则（纯函数，可测）

`evaluateTransferAccess({ keyPointId, rubricComplete, evidenceComplete, transferForm, authorizedAction, masteryPlanPassed })`：

| 输入条件 | disposition | effectiveAuthorizedAction | scheduleAffected | 副作用 |
| --- | --- | --- | --- | --- |
| transferForm 非法 | `unavailable` | `record_only` | false | 0 学习/0 schedule |
| rubric 不完整 或 evidence 不完整 | `unavailable` | `record_only` | false | 0 学习/0 schedule |
| official `create_initial`/`consume_pending` **且** masteryPlanPassed | `mastery_transfer` | 保持 create/consume | **true** | create/consume 后恰好一个 active/successor schedule，同 generation exactly-once（§8.3/§8.5） |
| official `no_effect`（practice 路径） | `practice_only` | `no_effect` | false | 0 canonical projection、0 review attempt、0 schedule |
| 其余（默认，含官方 `record_only`，以及 create/consume 但 mastery 未通过） | `facet_observation` | `record_only` | false | 只写 facet evidence，0 overall outcome、0 review attempt、0 schedule |

- 三形态 → Scene 种类：`situated_application`→`multi_step_scenario`、`repair`→`repair`、`boundary_variant`→`conditional_variant`；
- schedule 影响**仅限 official 签发**：非官方/非法 `authorizedAction` 一律回落到默认 `record_only`；
- `evaluateExploreAccess(mode)`：四种 explore 形态均 `allowed`、`practice_only`、`no_effect`、`scheduleAffected=false`；非法 mode fail closed。

## 3. 静态卡 fallback 设计（§10.6，无 Canvas 环境主路径完整）

- `StaticCardFallback` 是**纯静态 UI + props 回调**组件，不引用 canvas/webgl、不调用服务端；
- 四入口共享同一 Session/Episode 内核：`search`（搜索）、`card`（卡片）、`now`（此刻）、`review`（复习），
  每组独立徽标与分组——**星图不是唯一入口**（§10.6）；
- 每张卡只有一个主行动「开始/继续一小段航程」（§8 学习卡一个主行动）；朗读/查看证据等作为次级内容工具；
- 卡片展示**可开始的事实**而非掌握度：`capabilityFacets` 只展示已验证能力切面，`dueLabel` 是到期事实描述，
  不展示红色欠账清单（§10.4 / 06-5 §9 非强迫恢复）；
- `meta.requiresCanvas` 仅提示「可在星图中查看」，**不阻塞直接开始**；
- explore 入口一律带「练习模式 · 不影响进度」徽标（practice-only）；
- `compact` 用于移动端紧凑布局（星域列表 + 路线卡，§10.6）。

## 4. 与既有冻结语义的对齐

- disposition 命名与 01-2 §8.5 矩阵一致：`mastery_transfer` ↔ `canonical_mastery`、
  `facet_observation` ↔ `canonical_facet_observation`、`practice_only` ↔ `practice_or_diagnostic`；
- `authorizedAction` 字段与 `PrivateLearningEpisodeContract.schedulingDecision.authorizedAction`
  同型（scene-contracts.ts）；收口后迁移到 @ailearn/shared；
- 本任务不写掌握/schedule 真值：守卫与 fallback 均为纯函数/纯 UI，schedule 写路径仍只属于
  official scheduler（06-5）。

## 5. 验收映射

- ✅ transfer 无完整 rubric/evidence 时不可达（单测「无完整 rubric/evidence 不可达」）；
- ✅ 三种形态各自正确（单测「三种形态」）；
- ✅ 默认 record_only 写 facet（单测「默认 record_only 语义」）；
- ✅ schedule 影响仅限 official 签发 + 完整 mastery plan（单测「schedule 影响仅限 official 签发」）；
- ✅ explore 全部 practice-only、不消费 schedule（单测「explore 全部 practice-only」）；
- ✅ 无 Canvas 环境主路径完整（StaticCardFallback 四入口直接开始，无 canvas/webgl 依赖）；
- ✅ `npm run typecheck --prefix apps/api`、`npm test --prefix apps/api`、`npm run typecheck --prefix apps/web` 通过。
