# 方案 16 实施遗留记录(2026-08-14)

> 本文件记录当前未收敛的问题,供后续会话优先处理。**已修复项**见各实现文件注释与
> 方案 16 文档实施登记。

## 1. SSE 间歇 500(`/learning-runs/:id/events`)—— 未收敛

**现象**:
- `GET /api/learning-runs/{runId}/events?lastEventId=N` 偶发返回 HTTP 500(浏览器
  console.error),全量并发 e2e 时较常见,单跑偶发。
- 失败场景:提交/评估期间的 run(事件数 >0),重连带 lastEventId 时。
- 伴随现象:同期间 `GET /learning-runs/{runId}` 偶发 20-207s 慢响应(见 #2)。

**已做的修复(有效但不收敛)**:
- 2026-08-14:Critic HTTP 调用移出 DB 事务(三阶段:事务内读+标记 → 事务外 HTTP →
  事务内写回)——消除"事务持有连接数十秒"的**确定性**连接池耗尽路径。
- SSE handler 增加 `reply.raw.on("error")` 与 `writableEnded` 防御。
- 环境修复:API 重启需 `set -a; . ./.env` 全量加载(缺失
  `AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS` 会让 Critic 被 SSRF 拒绝);重启前必须
  确认旧进程已释放 4000(EADDRINUSE 会让新进程静默死亡、旧代码继续服务)。

**剩余假设(未验证)**:
- SSE handler 的 `reply.raw.writeHead(200)` + `reply.hijack()` 在 fastify 5.1 的
  竞态(客户端在 hijack 前断开 → writeHead 抛 ERR_STREAM_WRITE_AFTER_END → 500)。
- withWorkspaceTransaction 的 postgres.js(max=10)在"SSE 3s 轮询 × 多 run + 页面
  2s 轮询 + tick 10s + draft 保存"并发下的连接排队,叠加 #2 慢请求放大。

**建议下一步**:
1. 在 SSE handler 的 writeHead/hijack 处加 try/catch 与 request.log.error(当前
   500 无任何服务端日志,先让 500 可观测);
2. 对比其它 hijack 端点(inbox-routes/companion-events)确认是否同模式偶发;
3. 测量连接池:并发下 `pg_stat_activity` 与 postgres.js 连接数。

**2026-08-16 追加**:
- 新增 `apps/api/src/lib/safe-sse-write.ts`,所有 SSE/NDJSON 写路径统一改为
  `safeSseWrite`(检查 `writableEnded/destroyed` + try/catch,失败静默)。
- 已应用到:
  - `/learning-runs/:id/events`
  - `/companion/deliveries/inbox/stream`
  - `/companion/conversations/:id/events`
  - `/me/companion/events`
  - companion NDJSON export
- 单测 `learning-run-sse-write.test.ts` 4 项通过;API 全量 1612/1612。
- 新增 `scripts/sse-smoke.mjs` 并发冒烟工具（需已登录 Cookie + runId），
  可用来在真实 API 上观察并发 SSE 是否出现 500/写失败。
- 真实并发压测复现仍未完成,但“断开后 write 冒泡 500”的路径已被统一兜底。

## 2. API 偶发慢响应(20-207s)—— 未收敛

**现象**:`GET /learning-runs/{id}` 偶发 20-207s;DB 侧无慢查询(pg_stat_activity
无 active 长查询、无锁等待),SQL 单测 71ms。疑为 API 进程内连接池调度/事件循环
阻塞,与并发测试负载相关。

**建议下一步**:在 withWorkspaceTransaction 入口加耗时日志;检查
`structuredSolutionSql`(worker 角色, max=2)等长驻连接的复用;测量事件循环延迟。

## 3. 方案 20 生成管线(搁置)

- `card-generation-v2-journey` 2 条 + pr-smoke 生成卡 1 条失败:supervisor 模型
  语义输出(未 compose candidate 即 request_verification → 设计上 fail-closed
  protocol_error)。属方案 20 范畴,用户已指示搁置。

## 4. 2026-08-16 更新：V2 生产闭环已补齐

- 新增桌面 Electron E2E 冒烟骨架 `tests/e2e/tests/desktop-pet-smoke.spec.ts`
  （默认 `DESKTOP_E2E` 未设时跳过；设置 `DESKTOP_E2E=1` +
  `ELECTRON_APP_PATH` 后可启动 Electron 并验证窗口加载）。
- 同时清理了 e2e `card-generation-v2-journey.spec.ts` 两个未使用变量，
  `tests/e2e` 现在 `tsc --noEmit` 通过。

- 新 V2 Objective 激活时自动创建 hidden legacy alias，`createRunV2` 不再要求
  手工 alias；
- `/learning-runs/new` 支持 `originV2`，候选激活后有“开始三分钟验证”；
- `/learning-cards/[cardId]`、`/cards` V2 列表、Review/Today V2 origin、星图 V2
  节点、Reminder UI 已接通；
- 上述内容记录在方案 20 implementation-review R37 与 evidence-package。
- SSE 500 / 慢响应仍保持“防御已加、真实并发压测复现未完成”状态。

## 5. 2026-08-16 再次回审

- 对方案 16/20 文档与代码再次交叉核对（见 `16-audit-20260814.md` §36 与
  `20-learning-card-v2-implementation-review.md` R38）。
- 方案 16 此前“剩余（下轮）”中的 review/cards/graph context、
  graph.delta_applied、PetMenu V2 bridge、pet 三层挂载均已关闭。
- 剩余仍为外部依赖/流程/环境类：真实 Electron E2E、SSE 并发压测复现、
  慢响应收敛、LLM trusted-Commit 完整旅程、生产性能观测、人类双盲、
  C8 生产停写。
- Coverage 门禁已修复：`make verify` 与 `make coverage-gate` 均通过。
