# v0.5 foundation 本地验证证据（2026-07-18）

> Status: Partial / Development evidence only。本记录验证已提交的 foundation/expand 实现，不是 CI artifact、M0/M1 Gate 或 RC 证据。

## 绑定范围

- 开发起点：`33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`
- 分支：`codex/v0.5-implementation`
- Foundation commit：`5b5591f20afd6ccac33a2158b2dba6c9e1503b16`
- 运行环境：Darwin/arm64，Node `v22.16.0`
- Git 状态复核：分支已推送并与 `origin/codex/v0.5-implementation` 同步；工作树 clean

## 自动化结果

| 验证 | 结果 |
| --- | --- |
| `make verify` | pass；233 pass、0 fail/skip/todo |
| Release/version contract | 13/13 pass |
| Shared | typecheck pass；22/22 test pass |
| Database package | typecheck pass；11-file schema mirror pass |
| API | typecheck pass；106/106 unit pass |
| Web | typecheck、ESLint pass；69/69 test pass |
| Worker | typecheck pass；23/23 test pass |
| PostgreSQL rate-limit integration | 隔离 PostgreSQL 16 上另行 1/1 pass；见 SEC-01 expand 证据 |
| Production builds | API、Web、Worker pass |
| Production dependency audit | 五个 package root 均为 0 vulnerabilities；审计后 dependency/lockfile 未变 |
| Release manifest JSON Schema | Draft 2020-12 validation pass |
| CI YAML parse | pass |
| `git diff --check` | pass |

本轮合计 233 项 `make verify` 检查，加 1 项真实 PostgreSQL integration，共 234 项通过。

## Clean release input 复核

Node `v22.16.0` 在 clean commit 上执行 `verify-release-inputs` 通过，19 个 journal migration 输入均已跟踪。当前工作树已把 workflow 的 push 范围扩展到 `codex/**`，并增加 Node/PostgreSQL 原始日志 artifact；该配置只有在本次提交推送并成功运行后才能形成远端证据，因此这里仍是本地 clean-checkout 证据，不是 Actions artifact。

## 后续 expand 验证增量

同日以 Node `v22.21.1` 复跑当前 expand 工作树：`make verify` 246 pass、0 fail/skip/todo，API/Web/Worker production build 均通过；另在隔离 PostgreSQL `16.14` 上完成 rate-limit 1 项、RLS policy 1 项和双 Worker queue 5 项。完整范围与 enforce 阻断项见 SEC-01 expand 证据，本节不把增量结果改写为 foundation commit 本身的历史结果。

## 尚未覆盖

1. Node 22 clean CI artifact、全仓/关键模块/changed-lines coverage、浏览器 E2E、扫描和 AIQ 真实 Provider 报告；
2. SEC-01 RLS enforce、API 请求池 1,000 次交替复用和完整 Worker handler side effect/renew 故障矩阵；当前只覆盖 Worker `max: 1` 池与 jobs 双 session 子场景；
3. 邀请 token 的数据库/API 生产接入、成员/onboarding 旅程；
4. review attempt 持久化事务、幂等约束、API/UI、导出删除和 E2E；
5. 机器 gate report digest 聚合、镜像/部署 provenance、独立 human security/data review。
