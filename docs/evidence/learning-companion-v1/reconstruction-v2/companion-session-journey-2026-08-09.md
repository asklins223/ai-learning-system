# Reconstruction v2：真实 Companion Session 旅程证据

> 采集日期：2026-08-09（Asia/Shanghai）  
> 状态：部分 Gate 已通过；不是公测发布签收。  
> 关联计划：`docs/plans/learning-companion/12-companion-experience-reconstruction.md` R4、R7、R8

## 浏览器旅程

使用真实 Playwright Chromium 1440 项目、真实登录会话、真实 Web/API/Worker 容器和真实 PostgreSQL，运行：

```text
E2E_BASE_URL=http://localhost:3000
E2E_SEED_OUTPUT=/tmp/companion-seed-v4.json
npx playwright test tests/companion-session-journey.spec.ts \
  --project=chromium-1440-pr --config=playwright.config.ts
```

结果：`3 passed`。

覆盖内容：

1. Card → Companion stage → text answer → diagnostic result → Card；
2. Answer lock → transactional assessment outbox → Worker `assessment_complete`，测试不调用同步 `/assess`；
3. Review → Companion stage → Review；
4. Now → Companion stage → Today；
5. Star Map 键盘搜索真实 key point → Companion stage → Graph。

入口测试还断言了 `origin=review`、`origin=now`、`origin=star_map` 以及创建后的 `session` 参数，避免在 Session 尚未创建时误判页面已经可用。

## Seed 修复

旧 E2E seed 只创建了可以显示的 standalone card，Review schedule 也没有 `key_point_id`，因此无法满足 Companion PREPARE 的 canonical 候选条件。本轮 seed 已补齐：

- `card_generation_runs`（generation epoch 1、成功结果引用）；
- active `learning_card_sets`；
- 带 card set / generation run provenance 的 active `learning_cards`；
- `card_key_points` 与 evidence；
- 绑定 key point 的到期 `review_schedules`。

这项修复同时保证 Review/Now 入口和 Card/Star Map 使用同一条 canonical candidate 链路。

## PostgreSQL 结果

浏览器运行期间的数据库检查结果：

```text
active_sessions = 0
unprocessed_outbox = 0
Card answer outbox attempts = 1, processed = true
assessment_source = deterministic
critic_version = diagnostic-fail-closed-v1
Review / Now / Star Map sessions = ended
Review / Now / Star Map episodes = cancelled
```

这里的 `deterministic` 是 fail-closed diagnostic reducer，不是 Provider-backed Critic；本证据不把它升级为正式 mastery 或 schedule commit。

本轮专用 seed run 在采集完成后按精确 run id 清理，未保留在开发库中。

## 容器与 HTTP 检查

采集时实际容器状态：

```text
ailearn-dev-api-1       healthy
ailearn-dev-postgres-1  healthy
ailearn-dev-web-1      up
ailearn-dev-worker-1   up
```

实际检查：

```text
GET http://localhost:4000/ready  → 200
GET http://localhost:3000/cards/<seed-card-id> → 200
```

首次按用户要求直接检查 `ailearn-dev-web-1`、API、Worker 实例日志时，发现 Worker 的旧
`generate_validation_question` 任务确实有 `permission denied for table validation_questions`。
根因是 Worker 最小权限矩阵漏掉了验证题异步链路使用的表。已补齐
`infra/postgres/roles.sql`，并新增前向迁移 `0087_learning_worker_validation_grants.sql`；
迁移和角色 bootstrap 均实际执行成功，使用 `ailearn_worker` 真实事务插入回滚 smoke test
也通过。修复后的最近 2 分钟日志没有 Web 编译/模块解析错误、API 5xx、Worker poll/权限/
约束错误；readiness 为 200，active session、未处理 outbox、pending/running jobs 均为 0。

## 尚未通过的 Gate

- Owner 对源图商业使用许可的确认；
- 10 个可见生产状态帧；当前提供的源图有 8 个作者姿态，`explain` 与 `assessment_handoff` 暂时复用。`exit_or_hidden` 按合同 suppressed、不渲染。审核矩阵见 [`companion-reference-asset-matrix.png`](./companion-reference-asset-matrix.png)，机器可读状态见 [`companion-reference-asset-matrix.json`](./companion-reference-asset-matrix.json)；
- 真实 Provider Critic artifact；
- `commit_recorded` 驱动的正式 PgCommitPort canonical side effect；
- Owner 最终视觉与发布签收。

## 页面级 Companion 几何回归

本轮发现并修复了一个真实离屏问题：`features/companion` 新 Runtime 使用的 Tailwind
定位类没有被 `tailwind.config.ts` 扫描，导致 `sm:bottom-5` 未生成，桌面视口
`1280×720` 下锚点实际 `y=1167`。

修复后，真实认证 E2E `Companion anchor stays inside the viewport and uses the owner asset`
通过；浏览器复测结果为：

```text
viewport = 1280×720
anchor rect = x=1202, y=648.86, width=58, height=51.14
computed bottom = 20px
asset = /images/companion/reference/dormant.png
V2 panel = visible after summon
legacy lc-quiet-anchor = 0
```

同一页面级回归现已覆盖真实浏览器的三档视口，锚点和召唤后的面板均保持在视口内：

```text
390×844   anchor x=310, y=716.86, right=368, bottom=768
          panel  x=0,   y=574.03, right=380, bottom=780
768×900   anchor x=690, y=828.86, right=748, bottom=880
          panel  x=358, y=0,      right=758, bottom=900
1440×900  anchor x=1362,y=828.86, right=1420,bottom=880
          panel  x=1030,y=0,      right=1430,bottom=900
```

对应回归测试位于 `tests/e2e/tests/companion-session-journey.spec.ts`，本轮
`2 passed`（桌面锚点/Owner 资产 + 三档视口锚点/面板）；测试 seed 已按精确
run id 清理，清理后 active session 与未处理 outbox 均为 0。

## 角色资产审核矩阵

本矩阵仅用于 Owner 审核，不是 Codex v2 8×11 宠物包，也不会把 `reused` 状态安装成生产专用帧。`authored` 表示直接来自用户参考图的裁切，`reused` 表示运行时暂时复用已有姿态，`suppressed` 表示按合同隐藏且不加载角色资源。
