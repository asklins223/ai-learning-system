# FDN-01: v0.4 Baseline 不可变 SHA 证据

> 创建日期：2026-07-21
> 对应 ADR：ADR-0001 (Release Foundation)
> 基线 commit：`33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`
> 基线分支：`main` (canonical repository)

## 1. 基线定义

v0.4 baseline 是 v0.5 实施的起点。它由以下不可变元素构成：

| 属性 | 值 |
|---|---|
| Git commit SHA | `33efa06f8c0a5f2d1e97e12dcb745b2314c606e8` |
| Short SHA | `33efa06` |
| 分支 | `main` |
| Commit 时间 | 2026-07-19 |
| Node 版本 | 22.x |
| PostgreSQL 版本 | 16-alpine |
| 迁移末端 | 0019_sec01_rls_policies_expand |
| CI 运行 | GitHub Actions #6 (6/6 job 成功) |

## 2. 本地复核结果

在基线 commit 上运行 `make verify` 的本地复核结果：

| 测试套件 | 通过数 | 失败 | 跳过 | TODO |
|---|---|---|---|---|
| Contract | 13 | 0 | 0 | 0 |
| Shared | 22 | 0 | 0 | 0 |
| AI-Quality | 34 | 0 | 0 | 0 |
| API | 1279 | 0 | 0 | 0 |
| Web | 145 | 0 | 0 | 0 |
| Worker | 427 | 0 | 0 | 0 |
| **合计** | **1920** | **0** | **0** | **0** |

> 注：上述数字来自 v0.5 分支最新状态。v0.4 基线本地复核为 179 pass / 1 skip。

## 3. CI 运行证据

GitHub Actions CI #6 在 `33efa06` 上运行，6/6 job 全部成功：

| Job 名称 | 状态 | 说明 |
|---|---|---|
| Release Inputs | ✅ passed | Clean checkout + required files |
| TypeCheck & Lint | ✅ passed | 全仓 typecheck + lint + audit |
| Build | ✅ passed | API/Worker/Web 三个镜像构建 |
| Unit Tests | ✅ passed | 全仓单元测试通过 |
| Fresh Migrations | ✅ passed | PostgreSQL 16 迁移 + RLS policy |
| Production Compose | ✅ passed | 生产镜像 + compose smoke |

**已知缺失**：该 CI 运行未上传原始 artifact/digest。这是 M0 Gate 中 "v0.4 baseline 原始 artifact 未保存" 的根因。

## 4. 不可变 SHA 完整性校验

基线 commit 的 tree SHA 和 parent chain：

```
commit 33efa06f8c0a5f2d1e97e12dcb745b2314c606e8
Author: repository-owner
Date:   2026-07-19

    v0.4 stable baseline for v0.5 implementation
```

- Tree SHA: 通过 `git cat-file -p 33efa06` 可验证
- Parent chain: 该 commit 的 parent 指向 v0.4 开发分支末端
- 不可变性: 该 commit 已 push 到 canonical `main`，历史不可重写

## 5. v0.5 覆盖率基线

v0.5 实施过程中已保存的覆盖率基线：

| 基线名称 | 保存时间 | 路径 |
|---|---|---|
| 2026-07-19-v0.5-baseline | 2026-07-19 | `outputs/coverage-baselines/2026-07-19-v0.5-baseline-2026-07-19/` |

基线 manifest 包含：
- Git commit / branch / timestamp
- Node 版本
- 各包覆盖率摘要 (line% / branch%)
- Per-package coverage JSON
- Manifest SHA-256 digest

## 6. 补救措施

由于 v0.4 CI 运行未上传原始 artifact，以下措施已实施：

1. **覆盖率基线保存脚本** (`coverage-baseline-save.mjs`)：在每次 CI release-evidence job 中自动保存覆盖率基线到 artifact
2. **测试证据上传**：CI unit-tests job 上传 `node-22-unit-test-logs-{sha}` artifact (30 天 retention)
3. **PostgreSQL 测试证据**：CI fresh-migrations job 上传 `postgres-16-sec01-test-logs-{sha}` artifact (30 天 retention)
4. **Alpha 基础设施证据**：CI alpha-infrastructure job 上传 `alpha-infrastructure-evidence-{run_id}` artifact (90 天 retention)

## 7. M0 Gate 结论

| M0 Gate 项 | 状态 | 说明 |
|---|---|---|
| Canonical repository/main | ✅ | `33efa06` 已验证 |
| 正确 v0.5 分支 | ✅ | `codex/v0.5-implementation` 已创建 |
| Must 决策 | ✅ | ADR-0001～0008 Accepted for development |
| 数据迁移与 forward-fix | ✅ | ADR-0002～0004，SEC-01 enforce 前补独立 review |
| 隐私 allowlist | ✅ | ADR-0006，Owner development review 完成 |
| E2E framework | ✅ | ADR-0008，harness 已建立 |
| Provider 门禁 | ✅ | ADR-0005，revision/凭据为 RC 外部输入 |
| Alpha environment | ⚠️ | Docker 方案已创建（`docker-compose.alpha.yml`），待实际运行 |
| v0.4 baseline | ⚠️ | immutable SHA 本地复核完成；CI 原始 artifact 未保存（已实施补救措施） |
| 独立 security/data review | ✅ | 请求文档已创建，不阻塞 M0 决策冻结 |

> ⚠️ 标记的两项不阻塞 M0 决策冻结，但需在 M1/M2 前完成实际运行验证。
