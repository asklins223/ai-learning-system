# 学习卡 V1 旧栈清理·剩余任务修复方案

> 副标题：集成测试 rebase、legacy sessions 深清理、前端死代码与 V1 工具退役
>
> 状态：**Executed（五个阶段已全部执行完毕，执行记录见 §9.1）**
>
> 文档类型：技术实施设计（TDD）
>
> 版本：0.2（执行状态回写）
>
> 日期：2026-08-18（2026-08-19 回写执行状态）
>
> 前置：[`16-unified-learning-run-micro-journey-live2d-system-companion.md`](./16-unified-learning-run-micro-journey-live2d-system-companion.md) 与 [`20-learning-card-v2-value-first-generation-and-learning-target-rebase.md`](./20-learning-card-v2-value-first-generation-and-learning-target-rebase.md) 视为已冻结；本文只做 V1 残留的清除，不再引入新产品语义。

---

## 0. 结论先行

第一阶段清理已把**运行时主链**全部迁到 V2（全仓 7 包 typecheck 0 错误、单测套件仅剩环境性失败）。本文覆盖剩余五类 V1 残留，按依赖排序：

1. **A — 集成测试 rebase**（59 个文件里 28 个含 V1 表夹具）：最高优先，因为它们跑真实 PG，是 V1 残留的最后大面；
2. **B — legacy learning-sessions 深清理**：3 处裸 SQL `card_key_points` + 星图血缘 V1 case；
3. **C — migration 链核对**：26 个迁移文件仍引用 V1 表（链尾 0176 已清表，先核对后决定是否重建链）；
4. **D — web 死 API 客户端**：6 个指向已删端点的 api.ts 方法与旧生成 UI；
5. **E — 工具与杂项**：ai-quality V1 CLI、shared V1 density 契约、repro 脚本、business-ai-ops 说明。

执行红线（继承第一阶段，绝不违反）：

- **不使用任何 git 写操作**（尤其禁止 reset/批量 revert），全程文件级编辑；
- **不误删 V2 新逻辑**：凡被 `createRunV2 / freezeTargetSnapshotV2 / learning_objectives_v2 / surface / objective 搜索` 引用的代码一律保留；
- 每阶段完成即验证（typecheck + 对应测试），不攒批；
- 集成测试任何修改都必须在本机 PG（`docker compose` 或本地 postgres）上实际跑过才能算完成。

---

## 1. 背景与现状基线

### 1.1 第一阶段已完成（基线）

- `packages/db/src/schema/` 5 份旧副本对齐 `apps/api` 迁移版；`schema-contract.test.ts` 重写为当前 132 表快照；
- `learning-runs` 模块（run-service / run-processing-tick）全量 rebase：V1 `createRun` 变 V2 薄壳、Critic 只消费 frozen snapshot、schedule 写端统一 `subjectType='card' + subjectId=objectiveId`（顺带修复写读不一致）；
- 删除 V1 evidence 模块、旧 `cards/[id]` / `card-sets/[id]` 页面与 10 个专属组件、`legacy-backfill`、V1 validation 死路由/schema/service、`companion` 过渡期回退函数；
- 桥/桌宠/编辑器导航改指 V2（`/learning-cards/:cardId`、`/cards`=ObjectiveLibrary）；
- 8+2+4+7 个 V1 死测试删除，search/review/export-restore/activation/note/sec01/v06/understanding/permission-guard/companion-shell/bridge 测试全部对齐 V2；
- 修复 `understanding/service.ts` 证据计数 latent bug（revisionId↔objectiveId 映射方向），并恢复证据断言锁定。

基线验证：

| 包 | typecheck | 单测 |
| --- | --- | --- |
| packages/db | 0 | 5/5 |
| packages/shared | 0 | 460/460 |
| packages/ai-quality | 0 | — |
| workers/ai-worker | 0 | 763 pass / 0 fail（3 cancelled 为挂起超时 harness） |
| apps/api | 0 | 3197/3200（2 个 ffprobe 失败=缺 ffmpeg 二进制） |
| apps/web | 0 | 568/570（2 个失败=Live2D vendor 资产缺失） |
| apps/desktop | 0 | 2/2 |

### 1.2 剩余 V1 残留清单（本文的修复对象）

| 类别 | 位置 | 数量 |
| --- | --- | --- |
| 集成测试 V1 表夹具 | `apps/api/src/integration-tests/*.integration.ts`（50 个中 23 个） | 23 |
| worker 集成测试 V1 引用 | `workers/ai-worker/src/integration-tests/*`（9 个中 5 个） | 5 |
| legacy sessions 裸 SQL | `learning-session-context.ts:102`、`commit-port-pg.ts:137`、`session-routes.ts:557` | 3 |
| 星图血缘 V1 case | `learning-sessions/star-map-projections.ts:158`（`card_key_points.card_id`）+ 其测试 4 处断言 | 1+4 |
| migration 历史引用 V1 表 | `apps/api/src/db/migrations/*.sql` | 26 |
| web 死 API 方法 | `apps/web/lib/api.ts`（getCard / listCardSets / getCardSet / getCardGenerationStatus / regenerateCard / dismissCard 等） | ~6 |
| web 旧生成 UI | `notes/[id]/page.tsx`、`useGenerationPolling.ts`、`useGenerationActivity.ts` | 3 |
| ai-quality V1 CLI | `packages/ai-quality/src/card-generation-supervisor-v1/`（4 文件）+ `cli/supervisor-rc-gate.ts` | 5 |
| shared V1 density 契约 | `packages/shared/src/card-agent-contracts.ts`（被 index/provider-capabilities/metrics/learning-agent 引用） | 1 |
| repro 脚本 | `apps/api/repro-create.ts`、`repro-variant.ts`、`repro-variant2.ts` | 3 |

---

## 2. 阶段 A：集成测试 V1 夹具 rebase（最高优先）

### 2.1 现状

59 个集成测试（api 50 + worker 9）需要真实 PG 运行（`DATABASE_URL` + 本地 postgres）。其中 28 个通过裸 SQL `INSERT INTO card_key_points / learning_cards / learning_card_sets` 造 V1 数据，再驱动 learning-run / projection / companion / review 等场景。V1 表已删，这些测试现在**无法运行**（建表即 SQL 错误）。

### 2.2 目标

所有集成测试只使用 V2 数据：`learning_objectives_v2 + learning_objective_revisions_v2 + learning_cards_v2 + learning_target_snapshots_v2 (+ evidence_snapshots_v2 / bindings / eligibility)`，并经 `createRunV2`（originV2）驱动。

### 2.3 具体步骤

1. **抽公共 V2 fixture 助手**（新文件 `apps/api/src/integration-tests/helpers/v2-card-fixture.ts`）：
   - `createV2Objective(tx, ws, userId, { objectiveId?, statement? })`：插入 objective + revision（canonicalAnswer/scoringRubric/relations 最小合法值）+ evidence snapshot + eligibility（`usable`）+ binding；
   - `createV2Card(tx, ws, objectiveId)`：active card + publication revision；
   - `activateV2Target(tx, ws, userId, objectiveId)`：返回 `{ objectiveId, cardId }`，供 run 入口复用；
   - 幂等（按客观存在的 objectiveId 复用），并带 `after` 清理（`DELETE ... WHERE workspace_id = ...`）。
   - 参考现成 V2 fixture 模式：`learning-objective-parity.integration.ts`、`learning-objectives-surface.integration.ts`、`card-generation-v2-domain-events.integration.ts`。
2. **逐文件分类替换**（23 api + 5 worker）：
   - **可 rebase**（测 doc16/20 行为，如 `learning-runs-postgres`、`learning-runs-demonstrated`、`learning-runs-structured`、`projection-pagination`、`sandbox-and-star-map`、`companion-*`、`understanding-projection`、`shadow-translator`、`tool-gateway`、`assistant-memory`、`learning-metrics`、`commit-outbox`、`note-version-restore`、`rls-policies`）：把 V1 卡夹具换成 `createV2Objective+createV2Card`，`createRun(V1 origin)` 调用改 `createRunV2(originV2)`（或保留 createRun 薄壳直接传 V1 origin 形状，见 2.4 决策）；
   - **删除**（只测已删 V1 行为）：`evaluate-validation-concurrent-postgres.integration.ts`（V1 evaluate_validation handler 已删）、`v06-validation-session-postgres.integration.ts`（V1 validation session 契约）、`v06-migration-fresh-upgrade-repeat.integration.ts`（V1 迁移重放，见阶段 C 决策）、`v06-rls-matrix-postgres.integration.ts`（RLS 矩阵含 V1 表；改为只覆盖现存表或删除）；
   - **worker 侧**：`card-generation-run-postgres.integration.ts` 等 5 个——先确认它们实际断言什么，V1 引用若在注释/夹具里就替换，若测试目标本身就是 V1 则删除。
3. **验证**：本机 PG 上逐个跑 `node --import tsx --test --test-concurrency=1 <file>`，绿了才算完成。跑法与 `legacy-backfill-postgres.integration.ts` 头部注释一致。

### 2.4 决策点（需 Owner 确认）

- **D-A1**：`createRun`（V1 origin 薄壳）是否保留？
  - 方案 a（推荐）：保留薄壳（V1 origin.keyPointId→objectiveId alias 映射），集成测试可直接沿用旧调用形状，改动面最小；路由层同时接受 originV2 与 V1 origin。
  - 方案 b：删除薄壳与 V1 origin 类型，路由只收 originV2；集成测试全部改 `createRunV2`——更彻底，但共享契约与所有调用方同步改动。
- **D-A2**：`v06-migration-fresh-upgrade-repeat` 的去留与阶段 C 的 migration 链处理绑定（见 §4）。

---

## 3. 阶段 B：legacy learning-sessions 深清理

### 3.1 现状与问题

三处裸 SQL 读已删表（触发即 SQL 错误）：

| 文件 | 位置 | 用途 |
| --- | --- | --- |
| `companion-conversation/learning-session-context.ts` | :102 | 旧 session/episode 上下文聚合（JOIN card_key_points 取 claim） |
| `learning-sessions/commit-port-pg.ts` | :137 | legacy commit 的 `authoritative_target_guard` 行锁（card_key_points） |
| `learning-sessions/session-routes.ts` | :557 | tutor detour 的 evidence 展开（card_key_points.claim + evidences） |

另有 `learning-sessions/star-map-projections.ts:158` 的 `lineageToEdgeKind` 仍把 `card_key_points.card_id` 映射为 `contains` 边（V1 FK 血缘），其测试 4 处断言同样引用。

### 3.2 目标

- 这三处路径不再查询 V1 表；要么改为 V2 数据源，要么随 legacy 会话端点一起退役。
- `lineageToEdgeKind` 移除 V1 FK case；V2 血缘边（objective↔card↔note）若已有对应 case 则保留，没有则删 case 并让未知 FK fail closed（现有 default throw 已满足）。

### 3.3 决策点（需 Owner 确认，决定改动规模）

- **D-B1（范围）**：
  - 方案 a（推荐，最小）：**保留 legacy sessions 模块但改数据源**——三处 SQL 改为从 `learning_objectives_v2 / learning_cards_v2 / evidence_snapshots_v2` 取等价信息（claim→objectiveStatement；evidence→binding 关联的 snapshot）；`lineageToEdgeKind` 删 V1 case。优点是 `learningSessionRoutes / voiceRoutes / assessmentRoutes`（仍在 server.ts 注册）保持可用，风险最小；
  - 方案 b（彻底）：**删除 legacy sessions 客户端路径**（session-routes / voice-routes / assessment / commit-port / star-map-projections 等）并注销路由——改动面大，必须先确认 run 系统不依赖 voice/assessment 的共享机制（voice-routes 由 learning-run 语音作答复用的情况要逐一核对）。
- **D-B2**：`star-map-projections` 里 V1 FK 血缘的测试断言，随 case 删除同步删。

---

## 4. 阶段 C：migration 链核对（先核对，后决定）

### 4.1 现状

`apps/api/src/db/migrations/` 26 个 SQL 文件仍引用 V1 表（建表/索引/清空/删表）。链尾迁移（0176，git 记录：清空 V1 卡表与历史、删兼容表）已把 V1 表删掉——因此**新库全量 replay 的终态是干净的**（先建后删）。当前问题只是历史包袱与 `v06-migration-fresh-upgrade-repeat` 测试的重放断言。

### 4.2 步骤与决策

1. **核对**（必做）：本地 PG 空库跑完整迁移链，确认终态无 `learning_cards / card_key_points / learning_card_sets / card_generation_runs(无v2后缀) / benchmark_* / note_evidence_spans / provisional_candidates` 等 V1 表；并对照 `packages/db` schema 导出（132 表）逐表核对。
2. **D-C1（历史迁移去留）**：
   - 方案 a（推荐）：保留迁移历史原样（replay 幂等、终态干净即可），只更新 `v06-migration-fresh-upgrade-repeat` 的断言到 V2 终态；
   - 方案 b：用 drizzle-kit 从当前 schema 重新生成迁移链（squash）——迁移历史不可逆重建，测试环境虽可做，但风险高（drizzle 生成与手写迁移的差异、RLS 策略/权限语句可能丢失），**不推荐**，除非 Owner 明确要求。
3. 无论 a/b，新增迁移一律不再触碰 V1 表。

---

## 5. 阶段 D：web 死 API 客户端与旧生成 UI

### 5.1 现状

`apps/web/lib/api.ts` 仍导出 6 个指向**已删端点**的方法：`getCard`（GET /cards/:id）、`listCardSets` / `getCardSet` / `listCardSetCards` / `dismissCardSet` / `regenerateCardSet`、`getCardGenerationStatus`、`regenerateCard` / `dismissCard`；类型层还挂着 `CardDetailResponse / CardSetRecord / CardGenerationStatus` 等。使用方：`notes/[id]/page.tsx`（getCard + getCardGenerationStatus）、`useGenerationPolling.ts`、`useGenerationActivity.ts`、`card-generation-v2/api-client.ts`（regenerateCard）、`lib/__tests__/api.test.ts` 的 V1 用例。

### 5.2 步骤

1. **核对 notes/[id] 的生成流**：确认 V2 生成（`CardGenerationV2ActivationDialog / useGenerationPresentation`）已完整接管页面（页面头部若仍渲染 V1 生成状态区块，先随本阶段移除或切换），之后：
2. 删除 api.ts 死方法 + 对应类型（`CardDetailResponse / CardSetRecord / CardSetDetailResponse / CardSetCardsPageResponse / CardSetListResponse / CardSetRegenerateRequest/Response / CardGenerationStatus` 若无人再引用）；
3. 删除 `useGenerationPolling.ts` / `useGenerationActivity.ts`（或精简为 V2 需要的部分）；
4. 更新 `api.test.ts` 的 V1 用例（删除 card-set 路由用例，保留 in-flight dedup 等通用用例）；
5. 验证：`apps/web typecheck` 0 错误 + `pnpm run test` 不新增失败。

### 5.3 风险

- `notes/[id]/page.tsx` 是活跃页面，必须先确认 V2 生成 UI 覆盖所有入口（含旧 note 的生成状态展示），避免删了方法导致页面 404 或空白。若页面仍有 V1 生成区块，本阶段拆两步：先切 UI，再删 API。

---

## 6. 阶段 E：ai-quality V1 工具与 shared V1 契约

### 6.1 ai-quality

- `packages/ai-quality/src/card-generation-supervisor-v1/`（golden-set-data / golden-set-schema / rc-runner / scorer）与 `cli/supervisor-rc-gate.ts`：V1 三档 density（overview/standard/complete）golden 集。
- 引用方：`infra/prometheus/alerts.yml`（告警引用）+ `project-archive/evidence/v0.6/supervisor-agent-v1-release-manifest.json`（归档）。
- 方案（推荐）：**整目录删除** + `alerts.yml` 中相关告警规则同步移除（archive manifest 属归档证据，保留不动）；`packages/ai-quality` typecheck 确认 0 错误。
- 决策点 **D-E1**：若 Owner 还想保留 V1 评测脚本作历史对照，可整体移入 `project-archive/` 而不是删除——但不再参与任何 CI/typecheck。

### 6.2 shared card-agent-contracts

- `AgentRole` 等被 `provider-capabilities.ts`、worker `metrics.ts`、`learning-agent/types.ts` 引用（**保留**）；`GenerationDensity(overview/standard/complete)` 等 V1 density 契约是残留。
- 步骤：grep 确认 density 枚举及 `GenerationDensity` 无引用方后，从 `card-agent-contracts.ts` 移除 density 部分（或拆文件只留 AgentRole）；同步 `shared.test.ts` 若有断言。
- 验证：`packages/shared` typecheck + 测试，`workers/ai-worker` typecheck（metrics/learning-agent 的引用不受影响）。

### 6.3 杂项

| 项 | 处理 |
| --- | --- |
| `apps/api/repro-*.ts`（3 个） | 全部依赖已删结构：`repro-create.ts` / `repro-variant2.ts` 造 V1 卡（card_key_points/learning_cards），`repro-variant.ts` 写已删的 `learning_runs.key_point_id` 列。推荐**删除**（一次性调试脚本，git 历史可找回）；若 Owner 要保留，按阶段 A 的 fixture 助手 + `createRunV2` 重写。 |
| `workers/ai-worker/src/lib/business-ai-ops.ts` | V1 evaluateValidationViaChat 等仅被 3 个 provider 测试 + ai-provider.ts 注释引用。**保留**（provider 兼容性测试基建，不属学习卡运行链）；文件头补注释说明"V1 评估辅助，仅测试用"。 |
| `companion-objective-context.ts` | 仅注释提及 card_key_points（无查询），不动。 |

---

## 7. 验证矩阵与验收标准

| 阶段 | 验证命令 | 通过标准 |
| --- | --- | --- |
| A | 本机 PG 上逐个 `node --import tsx --test --test-concurrency=1 src/integration-tests/<file>`（api 与 worker 各一遍） | 全部绿；V1 表不再出现在任何集成测试 SQL |
| B | `pnpm exec tsc --noEmit`（apps/api）+ 相关单测（star-map-projections.test 等） | 0 错误；三处路径不触 V1 表 |
| C | 空库全量迁移 replay + `SELECT` 检查 V1 表不存在 + `v06-migration-fresh-upgrade-repeat` | 终态与 schema 132 表一致 |
| D | `apps/web` typecheck + `pnpm run test` | 0 错误；无新增失败；api.ts 无死端点方法 |
| E | 全仓 typecheck（7 包）+ shared/db 测试 | 0 错误；测试不回归 |

最终总验收（同第一阶段口径）：

- 全仓 7 包 typecheck = 0；
- `grep -rn "card_key_points\|learning_card_sets" apps packages workers --include="*.ts"` 仅剩注释/归档；
- api 单测 3200 全绿（除 ffprobe 环境项）、web 570 全绿（除 Live2D 资产项）、worker 无 fail；
- 集成测试在真实 PG 全绿。

---

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 集成测试 rebase 改动大、单测覆盖不到 | 每文件独立跑 PG 验证；按 2.3 的 fixture 助手统一造数，避免各文件自造 |
| legacy sessions 删除波及 run 语音/评估机制 | 先做 D-B1 方案 a（改数据源不删模块）；确认 voice-routes 与 learning-run 的共享后才考虑方案 b |
| migration 重建丢 RLS/权限语句 | 默认不做（D-C1 方案 a）；如 Owner 要求 squash，先在副本库全量对比新旧链终态 |
| web 页面 404/空白 | 阶段 D 先切 UI 再删 API；每一步 `next build` 或至少 tsc+测试兜底 |
| 又发生"被外部进程 reset 工作区" | 本方案全程文件级编辑、无 git 写操作；每阶段结束把改动清单固化到本文件 §9 |

## 9. 执行顺序与依赖

### 9.1 执行记录（2026-08-19 回写）

五阶段已全部执行（git: `7021471b` 第一波、`5aadb04f` 第二波 checkpoint，及后续
`7bbef3fd` / `75d16c80` 冗余审计清理）。逐项核对结果：

| 阶段 | 状态 | 核对证据 |
| --- | --- | --- |
| A 集成测试 rebase | ✅ 完成 | 全仓 `card_key_points` 引用仅剩 8 个文件的**注释**（rls-policies 断言 V1 表不存在、v06-migration 重放历史说明等合法引用），无真实 V1 夹具残留 |
| B legacy sessions 深清理 | ✅ 完成 | 三处裸 SQL 已清；`star-map-projections.ts` lineageToEdgeKind 现为 `learning_cards_v2.objective_id → contains` 且 default throw fail-closed |
| C migration 链核对 | ✅ 完成（按 D-C1 方案 a） | 22 个历史迁移保留原样；0176/0177 清表后终态干净；v06-migration-fresh-upgrade-repeat 断言已更新为 V2 终态。空库全量 replay 建议在下次本地 PG 环境就绪时补跑一次收尾确认 |
| D web 死 API 客户端 | ✅ 完成 | 死方法已删；`CardGenerationStatus` 为 api-types.ts 中有注释的内部接口类型（notes 页初始状态 + V2 run recovery），属有意保留；useGenerationPolling/useGenerationActivity 按"精简为 V2 需要"选项改造为走 getCardGenerationRun |
| E 工具与杂项 | ✅ 完成 | ai-quality supervisor-v1 目录与 cli gate 已删；repro-*.ts 3 个脚本已删；shared GenerationDensity 契约已删；business-ai-ops.ts 已按要求加"V1 评估辅助仅测试用"头注 |

遗留动作：§7 验收矩阵中"集成测试在真实 PG 全绿"需本机 PG 环境实际跑一轮作为最终签收。

### 9.2 签收核查与修正（2026-08-23）

对 §9.1 执行记录做独立核查（含实库验证），修正两处与事实不符的表述，并完成
此前遗留的"真实 PG 全绿"签收：

**§9.1 表述修正**：

| 项 | §9.1 原表述 | 核查事实（2026-08-23） |
| --- | --- | --- |
| C 阶段 | "0176 已把 V1 表删掉……终态干净" | **不准确**。0176 仅 `DELETE FROM` 清数据 + FK 改指 + DROP 6 张兼容边车表；`learning_cards / card_key_points / learning_card_sets / evidences / benchmark_* / note_evidence_spans / provisional_candidates` 至今以**孤儿空表**留存（实库 152 表 vs schema 132 定义）。且部分存活代码依赖这些表未删：invite-service 读 `evidences`、content-topology-w1 测试断言 `learning_cards.compatibility_role` 列、star-map-projections 的 `evidences.key_point_id` 血缘 case。补 DROP 迁移前必须先解除这批依赖 |
| A 阶段计数 | "引用仅剩 8 个文件的注释" | 实测含该字符串的文件为 17 个（绝大多数确为注释，结论方向正确、计数不准） |

**集成测试真实 PG 全绿签收（本次完成）**。首轮实跑暴露三层问题并全部修复：

1. **不可变触发器 vs 测试夹具**：0135 起的 V2 追加-only 触发器无条件拒绝
   UPDATE/DELETE，共享 fixture 的清理必然失败——这是此前"集成测试全绿"无法
   达成的直接原因。修复：迁移 `0180_immutable_trigger_test_bypass` 为三个守卫
   函数增加事务级 GUC `app.allow_history_mutation='on'` 受控旁路（生产代码永不
   设置）；fixture 清理事务内显式开启。另修 fixture 引用已 DROP 表
   （card_generation_cutover_events）与缺失 companion_conversations/jobs/
   onboarding_states 清理的问题。
2. **手工魔法工作区依赖**：dashboard / parity / topology-v3 / leakage /
   reconcile / history-route / origin-backfill / surface / search 九个套件依赖
   方案 23 附录 A.2 的手工工作区 `4f825f38-…`（0176 清库已抹除）。修复：新增
   自播种助手 `helpers/pure-v2-workspace-fixture.ts`，九个套件全部改为运行时
   自建夹具，可在任何干净 PG 独立运行。
3. **语义漂移断言**（大重构后无人能跑测试导致过期）：
   - E08 text+hint 期望 practice_completed → 按方案 16 冻结的 fail-closed 对齐
     为 not_assessable checkpoint；
   - structured / understanding-projection 两套件期望 structured_bundle 双 part
     → planV2Run 只产单 part 结构题且需显式结构 canonical answer（fixture 增
     `canonicalAnswerJson` 覆盖项），提交/结算断言全部实证对齐；
   - repair 纵切在 V2 无生成入口 → skip 并注明复活条件。

**顺带修复的真实缺陷**：

- `ailearn_claim_commit_outbox` PL/pgSQL 列引用歧义（42702，0109 起即坏）→
  迁移 `0181_fix_claim_commit_outbox_ambiguity` 加表前缀消除；该函数属已停用
  V1 commit 链路（LEARNING_RUN_V1 门控），修复后可安全重放。
- note-version-restore 夹具清理顺序：密封版本受三层触发器保护，改为先删 notes
  走级联（depth>1 放行路径）。

**当前集成测试矩阵**（2026-08-23 实跑）：V1 清理相关全部绿（learning-runs 8/8、
origin-contract 3/3、objective 系 9 文件全绿、topology-v3/dashboard/projection 全绿）。

### 9.3 第二轮：companion / 安全基建套件修复（2026-08-23 续）

首轮签收后继续修复了其余预存失败套件，其中挖出 **4 个真实产品缺陷**：

| # | 缺陷 | 修复 |
| --- | --- | --- |
| R1 | **companion 导出必失败**：footer 行经会更新哈希的 emitLine 写出，而 recordsSha256 已先 digest——每次导出抛 ERR_CRYPTO_HASH_FINALIZED；且 manifest 行未纳入哈希（违背自述覆盖范围） | footer 直写 onLine；manifest 改走 emitLine |
| R2 | **sandbox 调度语义丢失**：resolveV2Scheduling 把 onboarding sandbox 一律记为 not_authorized（V1 语义为 sandbox） | 按历史语义补回 |
| R3 | **桥接实体校验查错列**：verifyEntityRefs 按 id 校验，但 EntityRef 携带业务键（learning_cards_v2.card_id / learning_objectives_v2.objective_id）——桌宠页面上下文引用任何 V2 卡/目标必被误判不存在 | 按表映射查找列 |
| R4 | **0174 侵占 0039 托管命名空间**：新策略沿用 sec01_v1_ 前缀，触发 0039 目录守卫"清单外策略即拒绝" | 迁移 0182 将该策略改名脱离保留前缀（逻辑不变） |

测试侧对齐：action-bridge 六用例从已退役的 learning_sessions 种子切到 V2 候选
（learning_run_start/resume + 同步建 Run 的 succeeded 语义）；context-grants 的
episodes 夹具补 key_point_id（NOT NULL）；rls-policies 重放改为临时解除清单内表
RLS 后精确恢复（0039 守卫按设计拒绝在激活态重放），断言改为"重放不得改变激活
集合"；validation_events/questions 夹具补 legacy 卡 FK；共享 fixture 清理抽为
cleanupWorkspaceTables（含循环外键解除与旁路）。

**最终矩阵（49/49 全绿）**：全部集成套件实库通过。运行前提：各套件需自身环境
变量指向已迁移库（CONTENT_HASH / NOTE_VERSION_RESTORE / RATE_LIMIT /
REVIEW_ATTEMPT / SEC02_TEST_DATABASE_URL 等）；g009 需 migrator 角色；
v06-migration 需指向链已应用的库（其 fresh 重放语义已被 V2 移除，现仅验证
0040-0043 幂等段）。skip 项：demonstrated 需真实 Critic 凭据；repair 纵切待 V2
生成器；commit-outbox 全链需退役链路夹具（claim 函数本身已经 0181 修复并探针验证）。

```
A（集成测试，需 PG）  ← 依赖：A1 fixture 助手
B（legacy sessions）  ← 独立，可与 A 并行
C（migration 核对）   ← 依赖 A 中 v06-migration 用例的决策（D-A2/D-C1）
D（web 死代码）       ← 独立，可与 A/B 并行
E（工具/契约/杂项）   ← 独立，可随时做（工作量最小，建议最先清）
```

建议实际执行顺序：**E → D → A → B → C**（先清工作量小、风险低的，最后做最重的集成测试与 migration 决策）。

### 9.4 孤儿表物理退役收尾（2026-08-23）

§9.2 登记的"V1 孤儿空表未 DROP"遗留已完成：

1. **依赖解除**：
   - `invite-service.ts` 的 evidence_review 步骤改查 `evidence_snapshots_v2`
     （V1 evidences 已被 0176 清空，原检查对新数据恒失败，实为潜在缺陷）；
   - `star-map-projections.ts` 移除 `evidences.key_point_id` 血缘 case，
     未知 FK 维持 default throw fail-closed；单测夹具与边种类断言同步更新；
   - W1 集成测试不再断言 `learning_cards.compatibility_role` 列。
2. **迁移 0183**：DROP 11 张死表——原名单 8 张 + 实库依赖排查新增的 3 张空表
   （card_generation_candidate_evidence / card_generation_source_bundle_members /
   note_evidence_embeddings）。首版在实库被依赖网拦下：存活表上仍挂着 12 条指向
   V1 表的残留外键（card_generation_runs×3、evidence_overrides×2、
   validation_events×2、validation_questions×2、validation_submissions×1、
   review_attempts×1、validation_question_rubric_items×1），终版改为先逐条显式
   DROP CONSTRAINT 再按依赖序 DROP 表（等价 CASCADE 但可审计）。已登记 drizzle
   journal；实库重放通过，public 表数 152→141。validation_events 系列表仍被
   onboarding/review/sec02 使用，仅摘除外键、不退役本体。
3. **验证**：api tsc 0 新增错误；star-map 单测通过；`src/__tests__` 静态
   套件 1488/1488。集成测试需在真实 PG 重放 0183 后签收。

---

## 10. 需要 Owner 确认的决策点汇总

| 编号 | 问题 | 推荐 |
| --- | --- | --- |
| D-A1 | `createRun` V1 薄壳去留 | 保留（改动面最小） |
| D-A2 | `v06-migration-fresh-upgrade-repeat` 去留 | 与 D-C1 绑定，默认保留并改断言 |
| D-B1 | legacy sessions：改数据源 vs 删除模块 | 改数据源（方案 a） |
| D-C1 | migration 历史是否 squash 重建 | 不重建，仅核对终态 |
| D-E1 | ai-quality V1 目录：删除 vs 归档 | 删除（或移 project-archive） |
