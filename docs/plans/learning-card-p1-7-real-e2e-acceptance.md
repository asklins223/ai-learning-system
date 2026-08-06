# P1-7 验收记录：Phase 1 状态机正式化——真实端到端验证

> 日期：2026-08-06
> 分支：v0.7
> 真实环境：本地 postgres(pgvector:pg16)+ 真实 provider(tokenrhythm / deepseek-v4-flash-0731)
> 复现脚本：`workers/ai-worker/scripts-p1-real-e2e.ts`(真实 API 调用,有成本)

## 1. 运行结果

| 指标 | 值 |
|---|---|
| Run 状态 | **succeeded**(42.1 秒) |
| Job 数 | 11 个全部 succeeded |
| Units | prepare ✓ / supervisor agent_run ✓ / extractor ✓ / **critic(自动创建)** ✓ / deterministic_verify ✓ / publish ✓ |
| Draft | 1 个 |
| Supervisor turns | 约 7 turns(21 个事件 / turn 约 3) |
| E2E 耗时 | **42.1s**(基线问题集 81~114s 范围内,单内容较短) |

## 2. Phase 1 验收对照

| 任务 | 验收 | 证据 |
|---|---|---|
| P1-1 Draft→自动 Critic | 日志 `P1-1: submit_deck_draft 成功后系统自动创建 Critic` + `scheduleCriticForDraft: Critic 任务已创建`;critic unit(level=1, ordinal=90, parent=supervisor)自动出现并 succeeded | 真实日志 + units 表 |
| P1-2 Critic→自动 VERIFY | 逻辑已实现(集成测试 P1-2 验证 passed+deterministic passed → verify);真实流程中 deterministicStatus 由 validate_draft(确定性代码)更新后再走 verify | 集成测试 6/6 + run 成功 |
| P1-3 Repair→自动 Critic | 集成测试 P1-3 验证(新 draft 无评审 → 自动 critic,parent 保持等待) | 集成测试 |
| P1-4 Child→自动推进 | 事件驱动 resume(CAS waiting_child→running),集成测试 P1-4 验证 | 集成测试 |
| P1-5 工具 Deprecated | 真实日志 `request_verification: Supervisor 请求 Verify(deprecated_system_managed_transition)` | 真实日志 |
| P1-6 竞态/幂等 | 集成测试 P1-6a/b/c 验证重复/并发调用无重复 unit/job | 集成测试 |

## 3. 质量与稳定性

- 无重复 Critic/VERIFY unit(units 表:critic ×1、verify ×1)
- 全部 11 job succeeded,无 dead/失败
- 质量门禁:run 走完整 VERIFY + PUBLISH,结果卡 published

## 4. 观测与后续

- supervisor unit 终态残留 running(run 已 succeeded)——complete 分支未置 supervisor 终态,既有行为,后续 Phase 可收口
- `validate_draft`(deterministic preflight)仍由 Supervisor 模型调用;完全系统化(P1-2 全自动)可在后续版本将 validate_draft 并入 autoProgressAfterChildUnit
- `openai-compatible.ts` 存在遗留 `console.error("[REPRO-LOG] REQUEST"...)` 调试输出(含请求前缀信息),建议后续清理
- 真实 E2E 单内容 42s;基线报告(P0-8)需分层样本
