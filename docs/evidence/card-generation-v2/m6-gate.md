# Card Generation v2 — M6 Gate

> 里程碑：M6（默认切换、回滚能力与旧链路兼容）  
> 当前结论：**代码 / 文档候选；发布 Gate 未关闭**  
> 日期：2026-07-26  
> Commit：待主任务在最终 clean SHA 上填写  
> 关联计划：[学习卡生成引擎 v2](../../plans/learning-card-generation-engine-v2.md)  
> 运维手册：[rollout / rollback Runbook](../../runbooks/card-generation-v2-rollout-rollback.md)

本页只记录可复核的证据。没有实际执行输出的项目保持“待执行”，代码存在不等于
生产发布 Gate 通过。

## 1. 实现证据

| 检查项 | 状态 | 可复核位置 |
| --- | --- | --- |
| Server v2 对新请求默认开启，精确 `false` 可回滚 | 已实现，待最终回归 | `packages/shared/src/feature-flags.ts` |
| Web v2 UX 默认开启，精确 `false` 可回滚 | 已实现，待最终回归 | `apps/web/lib/feature-flags.ts` |
| `.env.example` 明确双开关原子回滚 | 已复核 | `.env.example` |
| Web public flag 变更要求重新构建 | 已复核 | `.env.example`、Runbook §2 / §8 |
| Legacy rollback handler 不再有整篇 12k 静默截断 | 已实现，待最终回归 | `workers/ai-worker/src/handlers/index.ts`、`card-generation-m6-retirement-contract.test.ts` |
| v2 使用 typed exact evidence，不创建 fuzzy post-align job | 已实现，待最终回归 | `workers/ai-worker/src/handlers/card-generation-text.ts` |
| Legacy handlers 保持可调度，支持历史任务和显式回滚 | 已实现，待最终回归 | `workers/ai-worker/src/index.ts` |
| Full publish 使用 epoch / state CAS 和全局 coverage gate | 已实现，待 PostgreSQL 故障注入复核 | `workers/ai-worker/src/handlers/card-generation-text.ts` |
| Partial 结果不 supersede 旧 active，卡片保持 archived | 已实现，待 PostgreSQL 集成复核 | `runPublishCardGeneration` 的 `partialResult` 分支 |
| Owner cancel 撤销 job lease 并取消未完成 unit | 已实现，待并发集成复核 | `apps/api/src/modules/card-generation/service.ts` |
| Card Set 支持 overview + section、分页与组级生命周期 | 已实现，待完整 E2E | API `card-set` module、Web `/card-sets/[id]` |
| migration `0049` 为 forward-only 且保留 rollback 兼容 | **待主任务确认迁移文件、journal 与 fresh/upgrade/repeat 输出** | 最终 migration artifact |
| rollout / rollback Runbook | 已复核 | `docs/runbooks/card-generation-v2-rollout-rollback.md` |

## 2. 本次实际执行

下表只允许填写本次实际运行过的命令。最终合并后若文件或 commit 变化，主任务需要在
clean SHA 上重跑并替换本节。

| 命令 / 检查 | 结果 | 原始输出位置 |
| --- | --- | --- |
| M6 flag / retirement 定向单测 | ✅ 已执行（2026-07-26 外部审计容器，Linux x64 / Node 22 / PostgreSQL 16）：worker `card-generation-m6-retirement-contract` + `card-generation-m6-default` 4/4；api `card-generation-v2-contract` 12/12；web `card-generation-v2-deployment-defaults` 1/1 | 外部审计报告 `docs/evidence/v0.6/external-audit-and-fixes-2026-07-26.md` |
| 文档相对链接存在性检查 | ✅ 已执行（同上）：m6-gate / runbook / v2 计划三份文档内相对 .md 链接 0 失效 | 同上 |
| `rg` 检查 project overview 不再宣称 12k / 单卡主架构 | ✅ 已执行（同上）：`rg "12,000|12000 字符|12k" docs/project-overview.md` 0 命中 | 同上 |

> 环境说明：以上为外部审计容器中的定向验证（工作树快照，非 clean SHA；
> mock provider；未启动完整 compose）。附加通过项：API 侧 PostgreSQL 集成
> `card-generation-v2-postgres` 1/1、`card-generation-text-v2-postgres` 1/1、
> `card-generation-partial-v2-postgres` 3/3（专用可销毁库 + 迁移 0001–0049 全量
> fresh 通过；注意这些用例还要求 `DATABASE_URL` 与 ADMIN_URL 指向同一测试库，
> runbook 命令示例未写明）。worker 侧 `card-generation-run/text-pipeline/
> image-pipeline` 集成与真实 Provider/对象存储路径在本容器无法运行，仍为待执行。
> 本节不改变 §3/§4 的结论：发布 Gate 未关闭。

## 3. 发布前必须补齐

| Gate | 状态 | 完成要求 |
| --- | --- | --- |
| `make verify` | 待执行 | clean SHA 原始 CI artifact |
| `make release-check` | 待执行 | exact release tag、完整 manifest、coverage 硬门槛 |
| API / Worker / Web build 与 typecheck | 待最终合并重跑 | 绑定镜像 digest |
| Card Generation PostgreSQL 集成 | 待执行 | 专用测试库串行通过；记录 migration end |
| 图片 / partial PostgreSQL + 对象存储集成 | 待执行 | 专用测试库、测试对象存储、原始输出 |
| migration `0049` fresh / upgrade / repeat / RLS | 待执行 | 0 数据损坏、legacy 兼容成立 |
| 真实 Provider 短文 / 长文 / 多图 RC | 待执行 | provider revision、成本、质量和 p95 |
| 浏览器完整旅程与无障碍 | 待执行 | 三视口、刷新恢复、取消、partial、Card Set 分页 |
| publish retry 故障注入 | 待执行 | 新增 Provider 调用 0；重复 Card Set 0 |
| stale epoch 故障注入 | 待执行 | 旧 epoch 激活 0 |
| rollback 演练 | 待执行 | 双开关、Web rebuild、API/Worker restart、在途 drain/cancel |
| Alpha 观察窗 | 待执行 | 指标、SQL 硬检查、异常与 `insufficient_data` 记录 |

## 4. 硬门槛

以下任一项没有证据或结果非零，M6 不得标记通过：

- 完整 run 的 source/image coverage 不等于 `10000` bps；
- active key point 缺少 exact text span / image region evidence；
- stale generation epoch 激活；
- `partial_ready` 激活 cards、替代旧 active 或进入验证/复习；
- publish retry 增加 Provider 调用或重复 Card Set；
- 关闭任一单独开关后仍允许 split-brain 发布；
- 在途 v2 run 被改写为 legacy、丢失 checkpoint 或被旧 Worker 当作未知 job；
- 数据库通过 down migration 回滚 `0049`；
- 真实 Provider、PostgreSQL、浏览器或观察样本缺失却被记录为通过。

## 5. 最终签署占位

主任务在发布候选冻结后填写：

| 字段 | 值 |
| --- | --- |
| Clean commit SHA | 待填写 |
| API image digest | 待填写 |
| Worker image digest | 待填写 |
| Web image digest | 待填写 |
| Migration end | 待填写（必须包含 `0049`） |
| Provider / immutable revision | 待填写 |
| 测试 artifact | 待填写 |
| 回滚演练记录 | 待填写 |
| 观察窗 | 待填写 |
| Owner approval | 待填写 |
| Security / data approval | 待填写 |
