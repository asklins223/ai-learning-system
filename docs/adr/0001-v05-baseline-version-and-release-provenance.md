# ADR-0001：v0.5 基线、统一版本源与发布追溯

- Status: Accepted
- Owner: Release Owner（repository owner `@asklins223`）
- Approver: repository owner
- Date: 2026-07-18

## Context

本地旧 `main@ced1422c` 与公开维护线没有 merge base。公开 `main`、规划快照和 `v0.4.0` peeled commit 必须先被核验，v0.5 才能避免从错误历史构建。当前五个 package 和 README 分别保存版本号，发布时还缺少一份把 commit、迁移、镜像和测试证据绑定起来的机器可读清单。

## Decision

1. canonical repository 固定为 `https://github.com/asklins223/ai-learning-system.git`，v0.5 开发起点固定为公开 `main@33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`。
2. 开发分支从该 SHA 创建，默认名为 `codex/v0.5-implementation`；不得重写本地旧 `main`。
3. `release/version.json` 是版本值的唯一人工编辑源。package、lockfile、README 和 release manifest 是派生或受校验副本。
4. 开发期版本为 `0.5.0`；候选标签使用 `v0.5.0-rc.N`，正式标签使用 annotated `v0.5.0`。标签必须指向 clean checkout。
5. `release-check` 校验 Git clean、版本一致、迁移 journal、测试摘要、镜像 digest 和 manifest schema。发布 manifest 至少记录 tag、commit、source date、Node 版本、迁移末端、各镜像不可变 digest、测试/覆盖率/AIQ 摘要和审批证据。
6. release manifest 中的 digest 必须来自已部署镜像；不得把可变 tag 当作 digest。
7. tag CI 必须实际调用 manifest verifier。当前 foundation 在机器报告聚合、artifact 下载与 promotion evidence 完成前主动阻断所有 release tag；不得用手填 `passed` 或任意 evidence 字符串绕过。首个合约只覆盖 `rc.1` 绝对阈值，后续 RC 和正式版保持阻断，直到上一 RC 比较与 14 日 promotion evidence 有机器可验证输入。

## Alternatives

- 继续以五个 `package.json` 为并列版本源：拒绝，无法判断哪个值权威。
- 把旧本地 `main` merge 到公开历史：拒绝，两条独立历史会重新引入已清理的私有资料和旧实现。
- 只在 GitHub Release 文本中记录版本：拒绝，不可由 CI 完整验证。

## Consequences

所有版本变更必须通过同步脚本或校验器；RC 构建会因任何未跟踪发布输入、机器报告、镜像/部署证据或 digest 缺失而失败。旧本地历史仍可查询，但不参与 v0.5 构建。

## Migration

先引入版本源、同步/校验脚本和 manifest schema，再把五个 package、lockfile与 README 提升到 0.5.0。已有 v0.4 tag 保持不变。

## Rollback / Forward-fix

版本元数据错误时停止发布并以前向提交修复；不得移动已发布 tag。若候选 tag 错误，作废该候选并创建下一个 `rc.N`。

## Evidence

- `git ls-remote origin` 于 2026-07-18 返回 `main@33efa06f...`。
- `v0.4.0` annotated tag object 为 `e4f3ce95...`，peeled commit 为 `0b9708d0...`。
- M0 初步本地实跑证据见 `docs/evidence/v0.5/m0-baseline-2026-07-18.md`；Node 22 CI artifact 与 clean tracked evidence 尚待补齐。
