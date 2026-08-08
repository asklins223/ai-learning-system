# 旧 reader 兼容矩阵（legacy-reader-compatibility-matrix）

> 对应任务 11-2 证据文件 12。佐证 DoD 33、36。
> 决策记录：`02-7-multimodal-legacy-adapter.md`、`06-2-episode-commit-outbox.md`、`06-4-concurrency-race-rollback.md`、`10-5-rollback-drill.md`（legacy reader matrix 演练）、`10-8-public-beta-default.md`（旧入口退休）。

## 1. 兼容矩阵冻结（02-7 §5，canonical compatibility matrix）

同一 pending schedule 的两条写路径——**旧 question-first**（legacy reveal → submit，validation session 消费 schedule 生成 successor）与**新 Episode**（enter-practice/reveal → confirm-and-lock，`consume_pending` 生成 successor）——的读写/消费规则冻结如下：

| pending 状态 | 旧 question-first 预检 | 新 Episode 预检 |
| --- | --- | --- |
| `pending`，无人消费 | **allowed**（`consume_pending` 授权内） | **allowed** |
| 已被旧 question-first 消费 | allowed（同路径幂等重放） | **blocked**（`already_consumed`） |
| 已被新 Episode 消费 | **blocked**（`already_consumed`） | allowed（同路径幂等重放） |
| 非 `pending`（completed/cancelled/deleted） | **blocked**（`schedule_not_pending`） | **blocked** |
| generation 不匹配（supersede 换代） | **blocked**（`generation_mismatch`） | **blocked** |
| 消费状态未知 | **blocked**（`unknown_state`，fail closed） | **blocked** |

- **唯一消费的保证分层**：① 应用层预检 `canonicalCompatibilityCheck(inputScheduleId, generation, requester, pendingState)` 在任何写入前按上表判定；② 数据库约束兜底 `review_schedules_pending_unique_idx`（每 `(workspace,user,key_point)` 至多一条 pending）——二者不能同时消费同一 pending schedule，即使预检竞态，数据库约束拒绝第二写（佐证 DoD 33 的幂等与唯一消费）。
- 读规则：两条路径都只读权威 `review_schedules`（pending 判定 + pending 唯一索引）。
- 实现：`apps/api/src/modules/learning-sessions/legacy-adapter.ts`（纯转换器 + 执行包装器，fail closed、sha256、最小只读视图输入类型）。

## 2. 旧域 reader 对多模态 Artifact 的兼容（02-7 §2/§3/§4）

- 非文本 Artifact 在旧域只存 **opaque artifact ref/hash、render summary 与 point assessments**，绝不把 graph/order/repair JSON 伪装进 `userAnswer`（render summary 规则按模态冻结：voice 只给「确认转写 N 字」、text 预览 ≤80 字、drag/ordering/repair/scenario 只给计数，永不 `JSON.stringify(payload)`）。
- 历史 API/UI 经 adapter 渲染 `renderSummary` 并**跳转私有 artifact**（`parseOpaqueArtifactRef` 按私有 artifact 读取权限访问）。
- **input uniqueness**：`uniquenessKey = sha256("content:{contentHash}|probe:{probeRef}|version:{version}")`，与模态 JSON/Scene/rubric/policy 版本无关；redaction 后 tombstone 行无法可靠重建唯一键 → fail closed 抛错（拒绝用不可靠信息去重）。
- **redaction 级联（content-free tombstone）**：`validation_events.user_answer → [redacted]`、`feedback → NULL`、`review_attempts.answer_text/answer_type → NULL`；关联键为 opaque artifact ref（LIKE 匹配、drizzle 参数化无注入面）；`buildRedactionCascadeSql` 纯函数输出可审计级联计划，`applyRedactionCascade(tx, artifactId)` 在调用方 workspace 事务内执行（RLS 由 `withWorkspaceTransaction` 保证）——佐证 DoD 33 的「分级删除及全存储残留扫描」在旧域 answer copy 侧的落地。

## 3. 保留旧 question-first / Review Queue 的证据（06-2 / 06-4 / 10-8）

- **06-2 episode-commit**：disposition 映射到现有 validation/review 枚举（`mapReducerToValidationOutcome/ReviewOutcome/...`），正式结果落入现有 canonical facts（`review_attempts` / `validation_events` / `understanding_events`），不建第二套真相；`commitKey = epc:<disposition>:<hash>` 幂等；cancel 后已 commit Episode 保留、当前与未开始 Episode 零副作用（`evaluateCancelSemantics`：committed → preserved）。旧 question-first 提交的验证/复习结果与 review 域长期共存，是 Review Queue 继续可读的事实基础。
- **06-4 race-rollback**：三组 contentExposureKey 竞态中 **legacy reveal → new Episode lock 必须看到 practice-only（assistance 先赢）**；new reveal → legacy submit 必须被阻止；lock 先赢时已锁 artifact 冻结 pre-exposure snapshot，之后 reveal 只写 exposure/cooldown 不追溯污染——旧 question-first 与新 Episode 在同一 exposure 语义下互斥共存。
- **10-5 rollback drill（legacy reader matrix）**：projection（understanding_universe_v2 / star map）关闭时旧 reader 仍读 pending schedule / attempt / 结果（数据 forward-only 保留即读得到）；回滚不修改现有 schedule / attempt / understanding history / active Card Set（快照深比较）；再开启投影时执行 drift replay 与观察窗口——详见 `rollback-drill.md` §2.3。
- **10-8 公测默认与旧入口退休**：旧文本主入口**退休的是「默认地位」**（默认从 `legacy_text_first` 切换为 `companion_guided`），入口本身保留可访问（`legacyEntryAvailable = true`），不隐式删除或替换旧能力——既有 question-first 验证与 Review Queue 不被破坏（佐证 DoD 36 的退休语义）。

## 4. 判定层证据

- 兼容矩阵各组合、redaction 级联、uniqueness 键重建、竞态判定均为纯函数 + 单测双断言（干净样本放行 / 违规样本必拒），随各阶段四包测试全绿（apps/api 2942、packages/shared 374、packages/db 5、apps/web 755）。
- legacy reader matrix 演练于 2026-08-08 执行，PASS（`rollback-drill.test.ts` 49 例全绿），详细记录见 `rollback-drill.md`。
- 决策记录 02-7、06-2、06-4、10-5、10-8 状态均为 Frozen（已冻结）。
