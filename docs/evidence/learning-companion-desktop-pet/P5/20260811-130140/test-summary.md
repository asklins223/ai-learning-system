# P5 — Trusted Learning Action Bridge：测试摘要（evidence）

验证日期：2026-08-11（P5-1 ~ P5-6 全程，DB 为本地 ailearn-dev postgres）

## 全量矩阵（全绿）

| 项目 | 结果 |
|---|---|
| api 全量 `npm test` | 3010 tests / 0 fail |
| api `tsc --noEmit` | 0 error |
| shared `npm test` | 397 / 0 |
| worker `tsc --noEmit` | 0 error |
| worker handler 单测（dialogue + tts-segments） | 14 / 0 |

## P5 固定测试（必测矩阵）

### apps/api/src/integration-tests/companion-action-migration-postgres.integration.ts（2/2）
- 0092 表/索引/6 个 router 字段存在
- 同 conversation 第二条 pending 冲突（single pending 唯一索引）

### apps/api/src/integration-tests/companion-action-rls-postgres.integration.ts（2/2）
- FORCE RLS：ailearn_worker 无 context 对 proposals/runs 零行
- worker 有 context 时只读自己 workspace/user 的行；错误 context 零行；superuser 不拦截

### apps/api/src/integration-tests/companion-action-bridge-postgres.integration.ts（6/6）
- menu context：无数据 → resume/start null（disabled）+ contextRevision 稳定；有 active session → resume 候选 + payloadSha256 合法
- menu proposal create 原子：双消息 + action_ref + proposal pending + action.proposed + ACTION_STALE 409
- decision reject：原子零副作用 + action.decision event
- decision confirm 纯导航（open_review）：同步 succeeded + action.completed + typed route
- decision confirm session（resume）：202 accepted + action run + companion_action job
- context-grants 签发：HMAC-SHA256 签名 + 5min TTL + episode 解引用到 session

### workers/ai-worker/src/integration-tests/companion-action-postgres.integration.ts（2/2）
- start_session → learning_session 创建 + 恰好一条 durable result 消息 + run succeeded + action.completed event
- 非 accepted run 跳过（不执行不重复）

## 回归

- apps/api companion-conversation-postgres.integration.ts 23/23 cancelled 0（GRANT 恢复后）
- 重跑后 0 残留（companion_action_proposals / companion_action_runs / companion_conversations / learning_sessions intent='start' 均 0）

## 未通过 / 未跑

- 无 P5 测试失败
- 未跑：真机桌面/Electron 纵切（P5 为 service/worker 层；桌面接线留 P6/真机）
