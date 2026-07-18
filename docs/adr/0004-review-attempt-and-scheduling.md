# ADR-0004：Review Attempt 与可解释离散调度

- Status: Accepted
- Owner: Learning Loop Owner
- Approver: repository owner `@asklins223` acting as Product Owner for development
- Date: 2026-07-18

## Context

v0.4 的 validation event 可追溯，但 review schedule 的“完成”主要更新状态与固定倍增间隔，没有独立 attempt、回答/回忆结果或调度前后原因。按钮操作因此可能被误解为真实理解提升。

## Decision

1. 新增 `review_attempts`，至少保存 workspace/user/schedule/subject、validation question/key point/evidence/note version、answer type、outcome、confidence、skip reason、调度前后快照、reason code、idempotency key、started/completed 时间。
2. 正常完成必须包含一次 recall/answer 和 `correct | partial | incorrect | unable` 结果；`later` 与 `unable` 是可审计动作，不生成成功完成事件。
3. 回答正文只存在业务表中，不复制到日志、指标或产品事件；导出、删除、备份与 RLS 均覆盖它。
4. 离散调度档位固定为 1、3、7、14、30、60 天。`incorrect/unable` 回到 1 天，`partial` 最多前进一档，`correct` 前进一档；`later` 保持档位并只移动到明确的短暂延期时间。每次变更保存 reason code。
5. 只有绑定有效服务端问题且目标 key point 存在 hard evidence 时，`correct/partial` 才能产生理解升级；否则 attempt 标记 `question_invalid` 或 `evidence_insufficient` 并保持或降低状态。
6. attempt、understanding event 和 schedule 更新在一个事务中，以 `(workspace_id, user_id, idempotency_key)` 唯一。响应可安全重放。
7. 卡片/来源版本变化时，旧问题和 evidence 版本标记 stale/superseded；历史 attempt 不改写。

## Alternatives

- 引入 FSRS：延后，当前样本不足且难以解释。
- 继续把 schedule update 当作 attempt：拒绝，无法证明用户是否回忆或回答。
- 把回答正文写入 telemetry 方便分析：拒绝，违反 Alpha 隐私边界。

## Consequences

Review UI 必须从单按钮改为开始、作答/回忆、提交结果和可解释下一次时间。旧 schedule 仍保留，但不能再直接生成 `reviewed` 理解事件。

## Migration

先新增 attempt 表和 nullable 版本引用；新 API 默认走 attempt 事务。读取 v0.4 schedule 时，把 `0/2/4/6/8/12/16/24` 等旧间隔映射到不缩短原间隔的第一个 v0.5 档位，并同时保存原始值与规范档位供审计。旧 complete API 在兼容窗口内返回 deprecation header，并禁止产生理解升级，遥测确认无调用后删除。

## Rollback / Forward-fix

UI 可通过 feature flag 回到只读 review 列表，但服务端不恢复无 attempt 的“完成”。调度错误以前向补偿 attempt 修正，不修改历史记录。

## Evidence

- v0.4 `review_schedules` 只有 interval/last review，没有 attempt 模型。
- v0.4 validation question/event 已提供可复用的服务端题目和版本绑定基础。
