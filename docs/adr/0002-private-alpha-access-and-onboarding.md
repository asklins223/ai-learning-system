# ADR-0002：Private Alpha 邀请、成员与 onboarding

- Status: Accepted
- Owner: Product / Identity Owner
- Approver: repository owner `@asklins223`（development self-review；独立 security/data review 待 SEC-01 enforce/RC）
- Date: 2026-07-18

## Context

v0.4 已有邀请码注册、workspace membership、session 和 owner 检查，但缺少 Owner 自助创建/撤销邀请、成员生命周期、服务端 onboarding 状态和角色分支。现有邀请码以明文主键保存，也没有显式撤销状态。

## Decision

1. Private Alpha 上限为 15 人、最多 3 个活跃 workspace；只有 `owner` 和 `member` 两个有效角色。
2. 邀请通过复制链接或邀请码交付，本版不接邮件。明文 token 只在创建响应中展示一次；数据库保存 SHA-256 token hash、不可逆短提示、创建者、过期时间、撤销时间、消费人和消费时间。
3. 消费邀请使用行锁和唯一约束，在创建用户、membership、onboarding state 与标记消费的同一事务中完成；过期、撤销、已消费和并发失败使用稳定错误码。
4. Owner 可以分页查看邀请状态、撤销未消费邀请、查看成员、移除 member 并撤销该成员在 workspace 中的全部 session。最后一个 Owner 不可被移除。
5. onboarding 按 `(workspace_id, user_id, version)` 持久化。Owner 路径必须设置 workspace AI consent/data policy；member 只能查看并确认当前政策。之后两类用户都可选择 Mock 或配置个人 Provider，并完成首份内容、首张卡、证据说明和首次验证。
6. 步骤完成必须由服务端业务事实驱动；客户端不能任意把“首张卡/首次验证”标成完成。

## Alternatives

- 继续保存可用明文邀请码：拒绝，数据库泄漏会直接产生可消费凭据。
- 引入 admin/editor 等角色：拒绝，v0.5 不具备完整语义和测试矩阵。
- 客户端 localStorage 记录 onboarding：拒绝，无法跨设备继续且容易伪造完成。

## Consequences

邀请 token 丢失后无法再次显示，只能撤销并新建。移除 member 会立即使其 workspace session 失效。Owner 与 member 的 UI 和 E2E fixture 必须分支覆盖。

## Migration

新建 v0.5 invitation 表或 expand 现有 `invite_codes`；旧未消费 code 可一次性 hash 回填后清空明文，无法安全回填的 code 失效并由 Owner 重新签发。新增 onboarding state 后按现有业务对象回填已完成步骤。

## Rollback / Forward-fix

旧注册 API 在一个明确兼容窗口内只读取迁移后的 token；出现问题时关闭邀请创建/消费 feature flag，不恢复明文 token。数据问题以前向修复处理。

## Evidence

- v0.4 `invite_codes`、`workspace_members` 和 `sessions` schema。
- v0.4 `registerWithInvite` 已使用事务与 `FOR UPDATE`，可作为并发消费基础。
