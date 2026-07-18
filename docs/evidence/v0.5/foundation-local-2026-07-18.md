# v0.5 foundation 本地验证证据（2026-07-18）

> Status: Partial / Development evidence only。本记录验证当前未提交工作树中的 foundation/expand 实现，不是 clean commit、CI artifact、M0/M1 Gate 或 RC 证据。

## 绑定范围

- 开发起点：`33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`
- 分支：`codex/v0.5-implementation`
- 运行环境：Darwin/arm64，Node `v22.16.0`
- 工作树：包含当前 v0.5 实现和用户已有的 README/图片改动；未暂存、未提交

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

## 预期阻断

`verify-release-inputs` 当前返回非零，因为 v0.5 必需输入尚未进入 clean Git 提交，工作树同时包含用户未跟踪文件。这是预期的 fail-closed 结果，不应改写为发布失败已修复，也不得通过忽略 dirty/untracked 输入绕过。

## 尚未覆盖

1. Node 22 clean CI artifact、全仓/关键模块/changed-lines coverage、浏览器 E2E、扫描和 AIQ 真实 Provider 报告；
2. SEC-01 RLS enforce、1,000 次连接池复用和完整双 Worker 故障矩阵；
3. 邀请 token 的数据库/API 生产接入、成员/onboarding 旅程；
4. review attempt 持久化事务、幂等约束、API/UI、导出删除和 E2E；
5. 机器 gate report digest 聚合、镜像/部署 provenance、独立 human security/data review。
