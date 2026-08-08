# W1 证据：数据、RLS、迁移、隐私与事件底座

> 对应任务 11-2 证据文件 3。佐证 DoD 3、9、10、13、21、33。
> 决策记录：`docs/plans/learning-companion/02-1-rls-matrix.md` ~ `02-10-animation-engine-spike.md`。

## 1. 迁移清单（已落盘，路径核验）

`apps/api/src/db/migrations/` 下 0074-0079 六份迁移全部存在：

| 迁移 | 内容 | 对应记录 |
| --- | --- | --- |
| `0074_learning_sessions_schema.sql` | Learning Session/Episode 核心 schema | 02-1 |
| `0075_learning_sessions_rls_matrix.sql` | Session/Episode RLS 矩阵 | 02-2 |
| `0076_companion_audit_ledger.sql` | companion audit 与 invitation ledger | 02-4 |
| `0077_learning_unit_exposure.sql` | learning_unit_exposure aggregate | 02-8 |
| `0078_learning_outbox_events.sql` | canonical events outbox | 02-9 |
| `0079_learning_sessions_keypoint_fk.sql` | Episode→Key Point 外键约束 | 02-1 |

## 2. RLS 矩阵（02-2）

- account/workspace/device 三类状态权限边界明确；跨 workspace/user 泄漏为 0（判定层，`0075` 迁移 + 对应测试全绿）。
- account-scoped Companion 状态表只按认证 `user_id` 授权，不使用 workspace RLS，跨设备同步。
- worker 最小权限：评估/commit 流程仅 SELECT/INSERT/UPDATE（状态流转、locked/completed 标记）；**删除语义由 `redaction`/`status` 表达，不授予 DELETE**。

## 3. onboarding CAS（02-2/02-8 边界 + 07-1 落定）

- 首次引导恢复使用 **scoped-token + revision CAS**（`not_offered→offered` 唯一 display permit；`consumed` 单调、不被系统重放；offered 不重弹）；判定层测试全绿（见 `w6` 证据 07-1）。

## 4. audit / ledger（02-4）

- `companion_audit` 与 `companion_invitation_ledger` 落盘（`0076`）；`COMPANION_AUDIT_TTL_MS = 30 天`（冻结 TTL，代码：`apps/api/src/modules/companion-shell/audit-service.ts`）。
- 用途仅限安全、幂等、预算与用户支持；不进入增长画像或跨 workspace analytics（佐证 DoD 13）。
- 用户导出/删除覆盖与路径核验见 `cost-budget-report.md`。

## 5. auth-surface（02-5）

- public-auth 与 authenticated `sensitivity=credential` 页面只使用**签名静态 allowlist**；输入值/字段交互元数据进入 Companion/日志/analytics/模型为 0（佐证 DoD 9）。
- 未登录伴星不依赖 authenticated API。

## 6. Generation → Learning handoff / legacy adapter（02-6 / 02-7）

- handoff adapter 拒绝 draft/privateDraft/publishStatus 非正式产物（zod schema 校验）。
- `existing-domain-multimodal-adapter-v1`：非文本 artifact ref/摘要、历史 reader、input uniqueness、redaction cascade；旧 reader 兼容语义见 `legacy-reader-compatibility-matrix.md`。

## 7. learning_unit_exposure（02-8）

- `learning_unit_exposure` aggregate/guard 落盘；source learning unit reveal/assisted/lock 状态变化经 `new_episode` 传递，不参与键计算与状态分支。

## 8. canonical events 与投影（02-9）

- 同一事务保证：投影看到的事件集合与权威事实永远一致（无权威事实已提交但 outbox 未写 / 反之的半程状态）（佐证 DoD 21、29）。

## 9. 动画引擎 spike（02-10）

- 二维角色动画引擎选型桌面评估完成：Rive 主引擎 + CSS/SVG 降级层（性能、许可证、离线降级、无障碍四项评估）；落地见 W4（`w4` 证据 05-4）。

## 10. 判定层证据

- 本阶段实现/测试随各模块落地（`apps/api/src/db/migrations/`、`apps/api/src/modules/companion-shell/` 等），四包测试全绿（apps/api 2942、packages/shared 374、packages/db 5、apps/web 750）。
- 各决策记录（02-1~02-10）状态均为 Frozen（已冻结）。
