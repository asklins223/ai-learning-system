# 决策记录 02-4：Companion audit/ledger 与隐私生命周期（§5.8+§12.2）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-4
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-4（原方案 §5.8+§12.2）
> 约束级别：TTL expiry 与 tombstone 生效；全存储残留扫描通过；导出覆盖率 100%。

## 1. 目标

把 Companion page/action audit（`companion_audit`）与页面/target 邀请 ledger
（`companion_invitation_ledger`）落到独立的隐私生命周期上：

- **用途隔离**：audit/ledger 只用于安全、幂等、预算与用户支持；不进入增长画像、
  兴趣推断或跨 workspace analytics；不写学习事实。
- **TTL / tombstone**：原始 entity refs 只保留到冷却/idempotency/retry 所需最短
  期限，默认 30 天（W0 privacy owner 冻结）；到期删除或替换为不可逆、content-free
  的预算 tombstone。
- **导出/删除**：用户可导出/删除自身 audit + ledger（级联），删除后不触发重新邀请，
  不把拒绝行为重建为画像；全存储残留扫描有唯一删除入口。

实现：`packages/db/src/schema/companion.ts`（两张表定义）、
`apps/api/src/db/migrations/0076_companion_audit_ledger.sql`（建表+RLS+GRANT）、
`apps/api/src/modules/companion-shell/audit-service.ts`（audit/ledger 逻辑与生命周期）、
`apps/api/src/modules/companion-shell/routes.ts`（导出/删除端点）。

---

## 2. 用途隔离（§12.2 §2.2 + 02-4 任务内容）

- audit 行只保存：page/action/entity **opaque IDs**、context/permission **hashes**、
  `policyVersion`、`result`、`createdAt`。**不保存**整页内容、DOM、截图、凭据或
  未提交输入（`PageCompanionContextV1` 是短生命周期页面能力快照，不作为行为录像持久化）。
- audit/ledger 全部**不入** mastery、official scheduler、路线难度、人格/兴趣画像、
  增长分群或跨 workspace analytics（代码注释同步标注）。
- `suppressedSuggestionClassIds` 作为用户显式选择可长期保存但**不携带 target**：
  继续复用 `user_companion_account_state.suppression`（02-1 已落库），audit-service
  只提供读取钩子，不新增存储；安全保留例外须单独 policy、可见期限和访问审计（暂无）。
- 事件域：ledger/audit 相关事件属独立产品事件域，学习事实重放忽略（01-3 §12.5）。

## 3. TTL / tombstone（§12.2 §2.2）

- `companion_audit` 短 TTL 默认 **30 天**；`companion_invitation_ledger` 原始
  entity refs 默认 **30 天**。清理由维护任务按 `(workspace, user)` 作用域调用
  `sweepCompanionAuditTtl` / `sweepCompanionInvitationLedgerTtl`（低频，不阻塞请求）。
- **delete 模式**：整行删除。
- **tombstone 模式**（content-free）：
  - audit：清空 `pageOpaqueId/actionOpaqueId/entityOpaqueIds/contextPermissionHashes`，
    置 `tombstonedAt`；保留 `pageActionType/policyVersion/result/createdAt` 的
    不可逆计数。
  - ledger：把 `stablePageContextKey/contextBudgetKey/reasonBudgetKey` 替换为
    **不可逆 SHA-256 截断键**并置 `tombstonedAt`，清空 `boundedReason/
    suggestionLease/oneTimePermit`；保留 `cooldownEpoch/reasonBudgetRemaining/
    shownAt` 预算计数（不可逆、content-free，且保持唯一索引合法）。
  - tombstone 后 fail closed：不得再发起邀请展示、不得回退终态。
- 清理索引：audit `(user_id, created_at)` / `(workspace_id, user_id, created_at)`、
  ledger `(workspace_id, user_id, updated_at)` + 部分 tombstone 索引，保证 TTL 扫描
  与导出/删除路径可走索引。

## 4. 导出 / 删除 / 残留扫描

- 01-3 §3.1 冻结 API 清单**无** audit 导出/删除端点，本任务按 02-4「导出/删除与
  全存储残留扫描」能力补充实现：
  - `GET /me/companion/audit/export`：导出当前 workspace 内该用户 audit + ledger
    （导出覆盖率 100%：含活动行与 tombstone 行；仅 opaque IDs/hashes/版本/结果）。
  - `DELETE /me/companion/audit`：删除当前 workspace 内该用户 audit + ledger（级联）。
  - `deleteAllUserCompanionAuditAndLedger(userId)`：跨**全部** workspace 级联删除
    （账号删除/全存储残留扫描钩子；枚举用户 workspace 后逐 workspace 走 RLS 上下文）。
- 残留语义：audit/ledger 只存在本库（无 cache/队列/分析副本）；删除后**不能**因
  ledger 删除自动重新邀请，也不把拒绝行为重建为画像。若未来引入分析副本，删除流程
  必须同步清理并扫描（唯一删除入口已集中）。
- RLS：ledger 属 user-private-in-workspace，audit 属 user-private，均使用
  `workspace_id + user_id` 双条件（0075 风格）；任一 context 缺失即 fail closed，
  跨 workspace/user 泄漏为 0。GRANT：`ailearn_api` 读写；`ailearn_worker` 不授权。

## 5. 幂等与原子性（01-3 §12.5）

- context/reason 双预算、`activeSuggestionLease` 与一次性 permit 在**单事务**内
  原子签发（行级 `FOR UPDATE`）：同一 `contextBudgetKey` 由唯一索引兜底至多一行；
  同 `clientLeaseId` 重试幂等返回同一 permit；他处 lease 活跃 → `won=false`；
  permit 已消费 → 拒绝重复展示；dismiss 后不再自动展示（终态不回退）；迟到 cooldown
  旧写拒绝（`STALE_COOLDOWN`）。
- 验收映射：TTL expiry 与 tombstone 生效（§3）；全存储残留扫描通过（§4 唯一删除
  入口）；导出覆盖率 100%（§4 export 含全部行）。
