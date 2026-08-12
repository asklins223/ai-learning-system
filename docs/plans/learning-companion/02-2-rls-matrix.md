# 决策记录 02-2：RLS 矩阵与权限边界（§13.3+§12.1）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-2
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-2（原方案 §13.3+§12.1）
> 约束级别：account/workspace/device 三类状态权限正确；跨 workspace/user 泄漏为 0。

## 1. 目标

把任务 02-1 落盘的 8 张表（迁移 0074）与尚未落库的账本/投影/审计对象，按「数据归属矩阵（§12.1）+ §13.3 RLS 与攻击面」逐表落到明确的权限边界：

- workspace-scoped 学习过程表使用 `workspace_id + user_id` 双条件 RLS；
- account-scoped Companion 状态表只按认证 `user_id` 授权，不使用 workspace RLS，跨设备同步；
- device-local hide 不写持久表，runtime-fence 仅短 TTL server-side ephemeral table；
- GRANT 按角色存在性 least-privilege，worker 无 account 表权限。

实现：`apps/api/src/db/migrations/0075_learning_sessions_rls_matrix.sql`（全部语句幂等，fresh/upgrade/repeat/restore 可重跑）。

---

## 2. 数据归属矩阵（§12.1）逐表

### 2.1 本批已落库表（0074 建表，0075 定权限）

| 表 | 归属域 | RLS 策略（policy 名） | 说明 |
| --- | --- | --- | --- |
| `learning_sessions` | user-private-in-workspace | `learning_sessions_workspace_user_isolation` | 双条件：workspace + user |
| `learning_episodes` | user-private-in-workspace | `learning_episodes_workspace_user_isolation` | 双条件：workspace + user |
| `learning_session_probes` | user-private-in-workspace | `learning_session_probes_workspace_user_isolation` | 双条件：workspace + user |
| `learning_response_artifacts` | user-private-in-workspace | `learning_response_artifacts_workspace_user_isolation` | 双条件：workspace + user；不可变 payload |
| `learning_assessment_reports` | user-private-in-workspace | `learning_assessment_reports_workspace_user_isolation` | 双条件：workspace + user；支撑证据非 canonical outcome |
| `user_companion_onboarding` | account-scoped | `user_companion_onboarding_user_isolation` | 仅 user_id；跨设备同步 |
| `user_companion_account_state` | account-scoped | `user_companion_account_state_user_isolation` | 仅 user_id；跨设备同步 |
| `user_learning_preferences` | account-scoped（account 级行）/ user-private-in-workspace（workspace 级行） | `user_learning_preferences_user_isolation` | `user_id` 且（`workspace_id IS NULL` 或 `workspace_id = app.workspace_id`） |

### 2.2 尚未落库对象（归属域约定，后续任务建表时须遵守）

| 对象 | 归属域 | 预期 RLS |
| --- | --- | --- |
| `companion_invitation_ledger` | user-private-in-workspace | 双条件 `workspace_id + user_id`（任务 02-4 落库） |
| `user_capability_projection` | user-private-in-workspace（可重算） | 双条件 `workspace_id + user_id`（或 user_id + 可选 workspace，参照 prefs） |
| `companion_runtime_fences` / `active_surface_leases` | device-local / ephemeral | 短 TTL server-side table；仅 user + device session + surface epoch + TTL，不存 page/entity/content |
| Companion page/action audit | user-private + 短 TTL | 导出/删除、去关联；不进入画像（任务 02-4） |

### 2.3 不落库/不入持久域的边界

- `temporary_hidden`、auth-surface hide：device-local non-identifying，只留设备本地布尔值，不关联 user/workspace/登录标识/错误历史/学习数据；清除站点数据即可移除。
- `PageCompanionContextV1`：短生命周期页面能力快照，不作为用户行为录像持久化。
- 共享知识真值（published Card / Key Point / Evidence / 血缘）：**workspace-owned**，继续沿用既有 workspace-owned 策略（不属于本迁移 8 表范围）。

---

## 3. RLS 策略细节（§13.3）

### 3.1 workspace-scoped 学习表：双条件，写入须为 workspace 内用户

```sql
CREATE POLICY learning_sessions_workspace_user_isolation
  ON public.learning_sessions FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
```

- `USING` 与 `WITH CHECK` 同时要求 `workspace_id` 与 `user_id` 匹配，故：
  - 用户只能读/写**自己的**学习行（行属主）；
  - 同一 workspace 的**其他用户**不可见（user 维收紧）；
  - 仅设置 `app.workspace_id` 而无 `app.user_id` 的 workspace actor fail closed（NULL 比较恒为假）；
  - context 全缺失时 fail closed。
- 0074 已 `ENABLE + FORCE ROW LEVEL SECURITY`，0075 重申并替换单条件 policy 为双条件（`DROP POLICY IF EXISTS` 旧 `*_workspace_isolation`）。
- 约束：API/worker 事务必须同时设置 `app.workspace_id` 与 `app.user_id`（与 0043 v0.6 context 对齐一致）。

### 3.2 account-scoped Companion 表：只按 user_id 授权

```sql
CREATE POLICY user_companion_onboarding_user_isolation
  ON public.user_companion_onboarding FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
```

- 仅认证 `user_id` 可读/写自身行；`app.workspace_id` 不参与判定 → workspace actor 不可读，其他用户不可读；
- 不使用 workspace RLS，跨设备同步（同账号多设备共享一行，靠 revision/epoch CAS 竞争，任务 02-3）；
- 0074 已建，0075 幂等重申（保证矩阵可独立审阅）。

### 3.3 user_learning_preferences：account 级 + workspace 级混合矩阵

```sql
CREATE POLICY user_learning_preferences_user_isolation
  ON public.user_learning_preferences FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND (
      workspace_id IS NULL
      OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
  )
  WITH CHECK ( /* 同上 */ );
```

- account 级行（`workspace_id IS NULL`，唯一索引 `user_learning_preferences_user_account_unique_idx`）：仅 user_id 授权，跨设备同步；
- workspace 级行（`workspace_id IS NOT NULL`，唯一索引 `user_learning_preferences_user_workspace_unique_idx`）：`user_id + workspace_id` 双条件，即 user-private-in-workspace；
- 单一 policy 覆盖两种行形态；workspace actor 与其他用户一律不可读。

### 3.4 device-local hide：不写持久表

- 0074 未创建任何 device-local 持久表，0075 不新增；
- runtime-fence 仅保留 `user + device session + surface epoch + TTL`（短 TTL server-side ephemeral table），落点在任务 02-3 的 lease/fence 实现；
- 任何 `temporary_hidden`/auth-surface hide 值都不进入 account-scoped 或 workspace 持久域。

---

## 4. least-privilege GRANT（0071 模式，幂等）

| 角色 | 学习过程表（5） | account-scoped 表（3） |
| --- | --- | --- |
| `ailearn_api` | SELECT, INSERT, UPDATE, DELETE | SELECT, INSERT, UPDATE, DELETE |
| `ailearn_worker` | SELECT, INSERT, UPDATE（**无 DELETE**） | **不授权** |

- 按角色存在性授权（`IF EXISTS (SELECT 1 FROM pg_roles ...)`），roles.sql 未重放前角色也可用；
- worker 最小权限：评估/commit 流程只需 SELECT/INSERT/UPDATE（状态流转、locked/completed 标记），删除语义由 `redaction`/`status` 表达，不授予 DELETE；
- worker 无 account 表权限：worker 事务不得读取用户 Companion 状态/偏好。

---

## 5. 跨 workspace/user 泄漏为 0 的验收依据

对每张表逐一核对，任何一条不满足即视为泄漏：

1. **行级隔离成立**：所有表均 `ENABLE + FORCE ROW LEVEL SECURITY`（非 owner 角色 NOBYPASSRLS，0074 起生效；0075 重申）。
2. **workspace-scoped 学习表**：任意 `(workspaceId_A, userId_A)` 上下文下，SQL 可访问的行集合 ⊆ `{workspace_id = A AND user_id = A}`；`workspaceId_A` 下的其他 user 行不可见；`workspaceId_B` 全部不可见。
3. **account-scoped 表**：`app.user_id` 缺失（workspace-only actor / 未登录）时读返回 0 行；其他 user_id 读返回 0 行；同 user 跨设备可见（跨设备同步语义）。
4. **prefs 混合矩阵**：account 级行仅本人可见；workspace 级行仅本人且 workspace 匹配可见。
5. **device-local**：temporary hidden 本身不存在可被 RLS 覆盖的持久表；runtime-fence 是短 TTL、FORCE RLS 的 content-free server-side 表，泄漏面仍限制为当前 user/device/epoch/TTL。
6. **worker 边界**：worker 对 account 表无 GRANT（授权失败而非空读），学习表只读/写自己 actor 上下文的行（需事务携带原 actor 的 `app.user_id`）。
7. **fail-closed**：`current_setting(..., true)` 缺失返回空串 → NULL 比较恒假 → 无上下文时任何角色都读不到行。

> 迁移验证约束：本阶段无法连接真实 Postgres，0075 不执行 `db:migrate`；SQL 按现有迁移风格幂等编写（`DROP POLICY IF EXISTS` + `CREATE POLICY`、`ENABLE/FORCE`、按角色存在性 GRANT 全部可重跑）。真实库验证在阶段退出 Gate 与集成测试阶段补充。
