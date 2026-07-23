# ADR-0003：数据分类、事务租户上下文与 RLS

- Status: Accepted（2026-07-19 补充设计理念修正，见 §Design Concept Amendment）
- Owner: Security / Database Owner
- Approver: repository owner `@asklins223`（development self-review；RLS enforce 前必须独立 security/data review）
- Date: 2026-07-18
- Amended: 2026-07-19

## Context

v0.4 已分 migrator、API、Worker 角色并补齐多数复合外键，但应用连接仍直接执行全局查询，迁移明确暂缓 RLS。若在没有事务级上下文和 Worker claim 函数时直接启用 policy，会造成全站拒绝或连接池串租户。

## Decision

### 数据分类

- Workspace-owned：notes、sources、cards、evidence、validation、review、understanding、search、AI artifact/audit、benchmark report/label 等带 `workspace_id` 的业务表。策略要求 `workspace_id = current_setting('app.workspace_id', true)::uuid`。
- User-private-in-workspace：evidence overrides、validation events、review schedules/attempts、understanding events、onboarding state。除 workspace 条件外，还要求 `user_id = app.user_id`；Owner 的管理读取通过单独受控函数，不在通用 policy 中扩大权限。
- Global identity/control：users、user AI model config、sessions、auth rate limits。API 不做任意表扫描，改用最小权限 `SECURITY DEFINER` 函数；函数固定 `search_path`、验证输入并只返回必要列。
- Cross-workspace operations：jobs 与维护/恢复元数据。Worker 只可调用原子 claim/renew/finish/reap 函数；拿到 job 后在对应 workspace 事务中处理业务表。

### 上下文与策略

1. API/Worker 的业务事务首先执行 `set_config('app.workspace_id', $1, true)` 和 `set_config('app.user_id', $2, true)`；只允许 transaction-local `true`，禁止 session-local `SET`。
2. 上下文 helper 对缺失、空值、非 UUID 和嵌套 workspace 变化 fail closed。事务提交、回滚或异常后设置自动消失。
3. 逐表采用 expand → verify → enforce：先补齐 workspace/user 列和复合 FK，再创建 policy 和权限测试，最后 `ENABLE ROW LEVEL SECURITY` 与 `FORCE ROW LEVEL SECURITY`。migrator 保留 `BYPASSRLS`，API/Worker 必须 `NOBYPASSRLS` 且不拥有表。
4. API 认证先通过受控 session 函数得到 user/workspace，再把整个受保护 handler 放入租户事务。服务层显式接收 transaction executor，禁止在 handler 中逃逸到全局连接。
5. readiness 校验当前角色、迁移末端、关键 policy 版本以及 API/Worker 的 `rolbypassrls = false`。
6. RLS 只是第二道防线；应用查询仍必须带 workspace/user 条件，复合 FK 继续阻止跨 workspace 关联写入。

## Alternatives

- 只依赖应用 `WHERE workspace_id = ...`：拒绝，单次漏条件即可泄漏。
- 在连接借出时使用 session-local `SET` 并归还前清理：拒绝，异常和池复用会留下高危串线窗口。
- 给 Worker `BYPASSRLS`：拒绝，Worker 解析外部输入且拥有广泛业务副作用。

## Consequences

服务需要逐步改为 transaction executor，迁移量较大；但任何缺失上下文都会变成显式拒绝。Worker claim 和 handler 数据访问被分成两个权限面。

## Migration

0018 起只新增迁移：上下文 helper/受控函数与 policy 先落地但不默认 enforce；完成真实受限角色和双 workspace 集成测试后逐表启用。每批记录表清单和验证查询。

## Rollback / Forward-fix

应用必须兼容 policy 已存在但暂未 enforce。若某批启用造成拒绝，先关闭该批 feature flag/流量，再由 migrator 暂停具体 policy 并以前向迁移修复；不得回滚已写业务数据。

## Design Concept Amendment（2026-07-19）

### 当前模型与理念修正的关系

ADR-0002 的理念修正将"个人工作区优先"确立为产品首要概念。本 ADR 的 RLS 设计与此完全兼容，且不冲突：

1. **RLS 是 workspace 级隔离机制**：无论一个 workspace 属于单人还是多人，RLS 保证跨 workspace 数据不会泄漏。当前已落地的 24 表 RLS policy 和 `withWorkspaceTransaction` 上下文设置不需要修改。
2. **当前共享 workspace 是协作模式**：同一个 workspace 内多成员共享 workspace-owned 数据是明确的产品行为（协作），不是安全缺陷。RLS 的 user-private 策略继续保护成员间的个人数据（验证记录、复习计划等）。
3. **v0.6 多工作区模型不改变 RLS 架构**：未来用户可属于多个 workspace，但每次查询仍在单一 workspace 事务上下文中执行。`withWorkspaceTransaction` 的 `workspaceId` 参数会随当前选定 workspace 变化，RLS policy 本身不需要修改。

### 开发环境安全缺陷（需修复）

当前开发环境存在一个与理念修正无关但需要记录的安全缺陷：

- `docker-compose.dev.yml` 中所有服务均使用 `postgres://ailearn:ailearn_dev@...` 连接，而 `ailearn` 角色是 `rolsuper=t, rolbypassrls=t` 的数据库超级用户。
- 这意味着即使代码遗漏了 `WHERE workspace_id = ...` 条件，RLS 也不会拦截——超级用户绕过所有 policy。
- **生产环境必须使用 `ailearn_api` / `ailearn_worker` 角色**（`NOBYPASSRLS`），否则 RLS 形同虚设。
- 部分业务模块（`validation/service.ts`、`evidence/service.ts`、`review/service.ts` 等）存在直接使用全局 `db.query` 而非 `withWorkspaceTransaction` 的查询路径；这些在开发环境正常工作（超级用户绕过 RLS），但在生产环境用受限角色时会返回 0 行（RLS fail-closed）。

### 后续路线影响

原 ADR-0009 的多工作区 v0.6 主线提案已撤回并转入本地归档。现有 RLS policy 与已经实现的工作区能力继续按 v0.5 baseline candidate 验收；后续新增租户模型要求必须由新的 Accepted ADR 明确授权。

## Evidence

- `infra/postgres/roles.sql` 明确 API/Worker 为 `NOBYPASSRLS`，migrator 为 `BYPASSRLS`。
- migration 0014 明确列出启用 RLS 前的四个前置条件。
