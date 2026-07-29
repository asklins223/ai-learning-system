# v0.6 证据索引

> 关联计划：[AI 学习系统 v0.6 版本实施计划：可信掌握闭环](../../plans/AI学习系统-v0.6-版本实施计划-2026-07-22.md)<br>
> 关联登记册：[v0.6 实施登记册](../../plans/v0.6-implementation-register.md)<br>
> 创建日期：2026-07-24<br>
> 最后更新：2026-07-26（v0.6 实施审查、附加修复与发布边界复核）<br>
> 本轮记录：[v0.6 实施审查与修复记录（2026-07-26）](implementation-review-and-fixes-2026-07-26.md)

> **当前结论：** M0-M6 为代码候选，M7 未开始；正式版本仍为 `0.5.0`，v0.6 尚未发布。各 Gate 文件记录阶段性实现和验证证据，不应在缺少 clean SHA、完整 RC、真实 Provider 与 Alpha 观察证据时解释为正式发布 Gate 已关闭。

## 里程碑 Gate 证据

每个里程碑的 Gate 证据必须包含：通过项列表、命令输出摘要、执行人、执行时间和 Git commit 绑定。不以"代码存在"替代 DoD。

### M0：基线与决策冻结

**Gate 要求：**
- [x] Base SHA、migration end、Owner、预算和证据路径明确
- [x] v0.6 Must/Should/Could 与删减线获批
- [x] 不存在另一份可编辑 v0.6 范围文档

**证据文件：** `m0-gate.md` ✅

### M1：Schema、RLS 与纯策略

**Gate 要求：**
- [x] reducer、assistance 和 schedule 表驱动测试全绿
- [x] fresh/upgrade/repeat/restore migration PostgreSQL 集成测试通过（13/13）
- [x] RLS 多 workspace/多 user 矩阵 PostgreSQL 集成测试通过（11/11）

**证据文件：** `m1-gate.md`（2026-07-25 阶段快照；本轮 PostgreSQL 增量见审查记录）

**实现摘要：**

| 交付物 | 文件 | 测试数 | 状态 |
|--------|------|--------|------|
| rubric-reducer-v1 | `packages/shared/src/rubric-reducer.ts` | 101 | ✅ 全绿 |
| discrete-v2 策略 | `packages/shared/src/scheduling-policy-v2.ts` | 53 | ✅ 全绿 |
| fingerprint | `packages/shared/src/fingerprint.ts` | 56 | ✅ 全绿 |
| scheduling-unified | `packages/shared/src/scheduling-unified.ts` | 19 | ✅ 全绿 |
| feature-flags | `packages/shared/src/feature-flags.ts` | 16 | ✅ 全绿 |
| question-safety | `packages/shared/src/question-safety.ts` | — | ✅ 全绿 |
| deterministic-question | `packages/shared/src/deterministic-question.ts` | — | ✅ 全绿 |
| Schema（8 新表） | `apps/api/src/db/schema/validation-v2.ts` | — | ✅ |
| Migration 0040-0043 | `apps/api/src/db/migrations/` | 13 个 PostgreSQL 集成用例 | ✅ 全绿 |
| RLS runtime context | `0043_v06_rls_context_alignment.sql` | 11 个 PostgreSQL 集成用例 | ✅ 全绿 |
| Lock ordering contract | `apps/api/src/__tests__/v06-lock-ordering-contract.test.ts` | 25 | ✅ 全绿 |
| E2E 种子数据脚本 | `apps/api/src/scripts/seed-e2e-v06.ts` | — | ✅ |

**总测试数：** 352（packages/shared），全部通过。

### M2：Question + Rubric

**Gate 要求：**
- [x] question/rubric 原子性和 stale 并发测试通过
- [x] Question/Rubric Gold v1 fixture 完成（60 个跨领域样本 + 评分器，`packages/ai-quality/src/v06/`）
- [x] 评分器改为使用独立 prediction，缺失/重复/覆盖不全时 fail closed
- [ ] 真实 Provider prediction 与独立人工标注完成两轮 RC
- [x] 客户端题面不能产生升级

**证据文件：** `m2-gate.md`（代码/fixture 阶段证据；真实 Provider RC 未完成）

### M3：逐点评估与 Review 集成

**Gate 要求：**
- [x] Evaluation Gold v1 fixture 完成（120 个回答 + 评分器，`packages/ai-quality/src/v06/`）
- [x] 真实 quadratic weighted kappa、false-mastery 和覆盖率门禁已实现
- [ ] 真实 Provider prediction 与独立人工标注完成两轮 RC
- [x] Provider/job/fingerprint 失败不会错误升级或丢答案
- [x] validation 与 review 共用相同 reducer/scheduling policy

**证据文件：** `m3-gate.md`（代码/fixture 阶段证据；真实 Provider RC 未完成）

### M4：Question-first UX

**Gate 要求：**
- [x] 未辅助提交前全部网络/RSC/hydration/预取/DOM 隐藏结构字段为 0（源码级验证）
- [x] Playwright E2E 框架就绪（3 个 spec 文件 + axe-core + 3 视口配置，需运行服务器）
- [x] 本地浏览器定向检查：Milkdown 加载、路由切换、卡死会话恢复和 retry 入队
- [ ] 完整 E2E 全绿运行并绑定 RC 证据

**证据文件：** `m4-gate.md`（源码/单测阶段证据；完整 E2E 未完成）

**实现摘要：**

| 交付物 | 文件 | 测试数 | 状态 |
|--------|------|--------|------|
| ValidationFocus 组件 | `apps/web/components/ValidationFocus.tsx` | — | ✅ |
| validation-focus.css | `apps/web/app/styles/validation-focus.css` | — | ✅ |
| 卡片验证 Focus 路由 | `apps/web/app/(workspace)/(focus)/cards/[id]/validate/` | — | ✅ |
| Review Focus 路由 | `apps/web/app/(workspace)/(focus)/review/[scheduleId]/` | — | ✅ |
| Review 安全队列 | `apps/web/app/(workspace)/(default)/review/page.tsx` | — | ✅ |
| Feature Flag 门禁 | `apps/web/lib/feature-flags.ts` + `packages/shared/src/feature-flags.ts` | 24 | ✅ 全绿 |
| v0.6 API 客户端 | `apps/web/lib/api.ts`（10 方法 + 12 类型） | 19 | ✅ 全绿 |
| Review 安全端点 | `apps/api/src/modules/review/routes.ts` + `service.ts` | — | ✅ |
| Exposure fingerprint 不变性 | `packages/shared/src/fingerprint-invariant.test.ts` | 26 | ✅ 全绿 |
| Cache-Control 契约 | `apps/api/src/__tests__/v06-cache-control-contract.test.ts` | 9 | ✅ 全绿 |
| Session 幂等 & CAS 契约 | `apps/web/lib/__tests__/v06-session-contract.test.ts` | 20 | ✅ 全绿 |
| Review 泄漏检测 | `apps/web/lib/__tests__/v06-review-leakage.test.ts` | 12 | ✅ 全绿 |
| 键盘 & 无障碍源码验证 | `apps/web/lib/__tests__/v06-keyboard-a11y.test.ts` | — | ✅ 全绿 |
| DOM 泄漏源码验证 | `apps/web/lib/__tests__/v06-dom-leakage.test.ts` | — | ✅ 全绿 |
| E2E scaffold | `apps/web/lib/__tests__/v06-e2e-scaffold.test.ts` | — | ✅ 已定义 |

**总测试数：** 263（apps/web）+ 352（packages/shared）+ 1361（apps/api），全部通过。

### M5：Card Repair 与成本观测

**Gate 要求：**
- [x] 非触发 0 二次调用；hard failure 0 激活
- [x] Repair Gold v1 fixture 完成（30 个样本 + 评分器，`packages/ai-quality/src/v06/`）
- [ ] 真实 Provider 输出与独立人工标注完成两轮 RC
- [x] 成本、延迟和 repair 触发率可按 provider/model/prompt 分桶

**证据文件：** `m5-gate.md`（代码/fixture 阶段证据；真实 Provider RC 未完成）

### M6：FSRS Shadow 与回放

**Gate 要求：**
- [x] 正式 schedule 影响为 0
- [x] 相同历史重放产生相同 shadow hash
- [x] 报告明确样本量、校准、模拟工作量和 `insufficient_data`

**证据文件：** `m6-gate.md`（代码与回放阶段证据；Alpha 观察未完成）

### M7：RC、灰度与 14 日观察

**Gate 要求：**
- [ ] 全量 release-check、两轮真实 Provider AIQ、迁移/恢复和 E2E 全绿
- [ ] 48 小时无安全不变量、虚假升级或未归属 dead job
- [ ] 7 日运行 SLO 达标或样本不足明确记录
- [ ] 14 日产品/质量/成本复盘完成
- [ ] v0.7 只选择一个主方向，或明确暂不立项

**证据文件：** `m7-gate.md`（未创建）

**当前状态：** 未开始（需真实 Provider 凭据 + Alpha 环境部署）

## 2026-07-26 定向验证汇总

| 验证域 | 结果 | 说明 |
| --- | --- | --- |
| PostgreSQL 集成 | 38/38 通过 | 有效串行/独立库结果：RLS 11 + migration 13 + validation session concurrency 14 |
| 修复后全量单元测试 | 2717/2717 通过 | Shared 360 + DB 3 + AIQ 84 + API 1422 + Web 302 + Worker 546 |
| API 定向 | 恢复/锁序 30/30 通过 | CAS 竞态、RLS transaction 和 lock ordering |
| Web 定向 | 50/50 通过 | 恢复、DOM 隐私、键盘与进度 UI；不等于完整 Playwright RC E2E |
| 类型/静态/构建 | 6 个 package typecheck、Web lint、API/Worker build 通过 | Web production build 也已在本轮早期通过 |
| Compose / 本地运行 | dev/prod 配置解析通过；API/Web 可用 | Worker 后续退出 137，未将最终 Provider 完成链路计为通过 |
| 浏览器 | 可恢复路径通过 | 会话恢复“可重试”，DOM 敏感字段 0，console warning/error 0 |

2026-07-26 的 2717 项是本轮修复后的全量单元测试，通过拆分 API 文件组在单步 30 秒限制内完成。PostgreSQL 三文件后续并行重跑曾因共用数据库 DDL 死锁而被判定为无效编排，已增加 `npm run test:v06:postgres` 串行脚本。发布前仍需执行完整 release-check，并把原始输出、commit、环境和执行时间绑定到 M7 证据。

## 2026-07-26（第二轮）：外部实施审计与修复

独立容器（Linux x64 / Node 22 / PostgreSQL 16）对 v0.6 与 Card Generation v2
的全量代码审计：发现并修复 1 个 P0（RLS 下 post-commit 写入失效）与 8 类 P1
（重复 rubricItemId 虚假升级、assisted 升级泄漏、题目过期死锁、deterministic
fallback 自我拒绝、planner 三处确定性失败、run retry 单单元卡死、repair CAS
未 lease-fenced、stale 转移被回滚）。修复后：全量单元 2825/2825、v0.6
PostgreSQL 集成 42/42（修复了一条写完从未跑过的 M6 断言）、API 侧 card-gen
PostgreSQL 集成 5/5、6 包 typecheck 0 错误。三份 card-gen v2 同日文档的状态
矛盾已更正（计划状态栏 → "已实施（代码候选）"）。完整报告与遗留清单：
`external-audit-and-fixes-2026-07-26.md`。发布边界不变：M7 未开始，
v0.6 未发布。

## 目录结构

```
docs/evidence/v0.6/
  README.md          — 本索引
  implementation-review-and-fixes-2026-07-26.md — 第一轮实施审查、修复与发布边界
  external-audit-and-fixes-2026-07-26.md — 第二轮外部审计、修复与遗留清单
  m0-gate.md         — M0 Gate 证据 ✅
  m1-gate.md         — M1 阶段性 Gate 证据
  m2-gate.md         — M2 阶段性 Gate 证据
  m3-gate.md         — M3 阶段性 Gate 证据
  m4-gate.md         — M4 阶段性 Gate 证据
  m5-gate.md         — M5 阶段性 Gate 证据
  m6-gate.md         — M6 阶段性 Gate 证据
  m7-gate.md         — M7 Gate 证据（未创建）
```
