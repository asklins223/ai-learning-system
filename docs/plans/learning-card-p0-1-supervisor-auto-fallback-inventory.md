# P0-1 盘点:Supervisor Auto-Fallback 场景矩阵与定位结论

> 属于 `learning-card-generation-perf-quality-optimization.md`(v1.3)Phase 0 任务 P0-1。
> 日期:2026-08-06
> 代码基线:v0.7 分支(基于 main)

## 1. 定位结论:临时兜底 vs 正式状态机入口

**正式状态机入口**是 `workers/ai-worker/src/agent/roles/supervisor-loop.ts` 的
`executeSupervisorTurn`(16 状态状态机),由 `run-phase-executor.ts:341` 调用。

**临时兜底**是 `workers/ai-worker/src/agent/supervisor-auto-fallback.ts` 的
`maybeInjectSupervisorAutoFallback`(run-phase-executor.ts:355 调用),仅在
`executeSupervisorTurn` 返回后对 outcome 做**纯调度修正**:

- 不生成语义内容(claim/标题/摘要),只注入调度类工具调用;
- 目的:模型未按管道推进时的确定性兜底,防止死循环与空转;
- 后续版本中,`request_grounding_review` / `request_verification` 等将转为
  系统内部状态机命令(`deprecated_system_managed_transition`,见实施计划 §3.3),
  auto-fallback 的对应注入分支随之收敛进状态机本身。

结论:**auto-fallback 是"临时兜底",不是"正式状态机入口";两处并存,职责分离
(状态机做权威推进,auto-fallback 只在模型失速时做确定性调度修正)。**

## 2. 场景矩阵

| 场景 | 触发条件 | 触发原因(审计) | 注入工具 | nextAction | 说明 |
|---|---|---|---|---|---|
| A1 | 模型未调用工具 + 有 Draft 无 Quality Report | `supervisor_no_tool_calls_auto_progress` | `request_grounding_review`(draftHash 取 DB 权威值) | `wait_for_children` | 纯调度 |
| A2 | 模型未调用工具 + Report passed + deterministic pending | 同上 | `validate_draft` | `continue` | 纯调度 |
| A3 | 模型未调用工具 + Report passed + deterministic passed | 同上 | `request_verification` | `complete` | 纯调度 |
| A4 | 模型未调用工具 + 管道无法纯调度推进 | 同上 | 无 | `needs_attention` | protocol_error,不注入 |
| A5 | 模型未调用工具 + deterministic failed | 同上 | 无 | `needs_attention` | 不注入 validate(防 BUG-94 循环) |
| B1 | 模型调用 `request_verification`(错误 draftHash,BUG-94)+ 有 Draft 无 Report | `supervisor_model_verification_redirect` | `request_grounding_review`(draftHash 替换为 DB 权威值) | `wait_for_children` | 替换而非放行 |
| B2 | 模型调用 `request_verification` + 管道就绪 | 同上 | `request_verification`(draftHash 替换为 DB 权威值) | `complete` | 替换为正确 hash |
| C1 | 只读自旋 ≥3 + 有 Draft 无 Report | `supervisor_read_only_spin_detected` | `request_grounding_review` | `wait_for_children` | 纯调度 |
| C2 | 只读自旋 ≥3 + 无 Draft 有候选 | 同上 | `submit_deck_draft`(候选 claim 机械组装) | `continue` | 不生成新语义,后续仍走 Critic 门禁 |
| C3 | 只读自旋 ≥3 + 无 Draft 无候选 | 同上 | 无 | `needs_attention` | protocol_error |

未触发:模型正常调用非 verification 工具且自旋计数 < 3 → outcome 原样返回。

## 3. 代码事实

- `computeSupervisorAutoFallback`(纯决策,无 DB 依赖):`supervisor-auto-fallback.ts`
- `maybeInjectSupervisorAutoFallback`(副作用:Agent Event 写入):同上
- 自旋计数函数 `countConsecutiveReadOnlySupervisorTurns`:`run-phase-executor.ts`
  (由 `card-supervisor-agent.ts` re-export)
- 调用点:`run-phase-executor.ts:341(executeSupervisorTurn)`→ `:355(maybeInject...)`

## 4. 测试覆盖

`workers/ai-worker/src/__tests__/supervisor-auto-fallback.test.ts`(11 例,纯逻辑):

- A1~A5、B1~B2、C1~C3、未触发,共 11 个用例;
- 关键断言:B1/B2 中注入工具的 `draftHash` 必须是 DB 权威值(非模型传入的错误 hash)。

既有测试:`supervisor-spin-detection.test.ts`(自旋计数 5 例)、
`supervisor-agent-behavior.test.ts`(44 例,含 §17.4 必测行为)。
