# v0.6 实施审查与修复记录（2026-07-26）

> 审查日期：2026-07-26  
> 审查对象：v0.6 M0-M6 代码、数据库迁移、Question-first 会话、AI Quality、Worker 可靠性，以及同期附加修复  
> 版本结论：**代码候选，尚未发布**  
> 当前正式版本：`release/version.json` 仍为 `0.5.0`

## 1. 结论

v0.6 的 M0-M6 代码主体和同期附加功能已经落地，本轮审查发现的数据库隔离、错误信息持久化、AI Quality 评分可信度、Provider 超时预算、编辑器生命周期和终态 Job 会话恢复等问题已修复，并完成了对应的定向验证。

这不等于 v0.6 已发布，也不等于全部 Gate 已关闭。M7 的真实 Provider 双轮 AIQ、完整 E2E/release-check、Alpha 灰度、48 小时安全观察、7 日 SLO 和 14 日复盘仍未完成；因此不得修改正式版本号、创建发布标签或把状态写成 Released。

## 2. 审查范围与功能状态

| 范围 | 当前状态 | 本轮结论 |
| --- | --- | --- |
| M0-M6 可信掌握闭环 | 代码完成，候选验证通过 | 保留“代码完成”，不能写成发布完成 |
| M7 RC、灰度与观察 | 未开始 | 仍是发布阻断项 |
| 来源收录简化与 URL 解析 | 已实施 | 与 v0.6 候选一并保留；已有实施后审查记录 |
| Milkdown 编辑器接入 | 已实施 | 生命周期竞态已修复；生产构建和本地浏览器检查通过 |
| 长笔记学习卡生成优化 | 仅方案设计 | 未发现对应完整实现，不能计入本版本已交付能力 |

## 3. 本轮发现与修复

### 3.1 PostgreSQL 迁移、RLS 与就绪检查

- 新增 `0042_v06_artifact_types_and_integrity.sql`：补齐 PostgreSQL `artifact_type` 的 v0.6 枚举值，清理可识别的历史 SQL 参数泄漏，并补上 `review_attempts.next_schedule_id` 外键。
- 新增 `0043_v06_rls_context_alignment.sql`：把 8 条 v0.6 RLS policy 从错误的 `app.current_user_id` / `app.current_workspace_id` 对齐到运行时实际设置的 `app.user_id` / `app.workspace_id`；缺失上下文时继续 fail closed。
- `/ready` 的 v0.6 数据库检查扩展为 8 张新表，并要求 migration journal 至少包含 `0043`。
- v0.6 迁移末端更新为 `0043_v06_rls_context_alignment.sql`，下一可用编号为 `0044`。

### 3.2 硬证据与 Question/Rubric 一致性

- 统一“当前有效硬证据”的判定，排除失效、错位或被 override 的证据，避免无有效硬证据时发生理解升级。
- Question 与 Rubric Worker 在事务内重新读取当前 evidence 和 source fingerprint，避免使用调用前的过期快照。
- Rubric schema 强制 key 唯一，并要求至少一个 `required` 条目，防止无法可靠归约的题目进入 active 状态。
- Feature flag 改为 fail closed；开发环境显式开启 v0.6，生产默认关闭并维持旧调度版本，避免环境变量缺失时意外启用。

### 3.3 隐私与错误信息净化

- 新增共享的安全错误归类与净化函数，日志、`jobs.last_error` 和审计 `error_message` 只保留错误类别、名称和安全 code。
- SQL 参数、用户回答、堆栈、Provider 原始响应等敏感内容在日志序列化和 Worker 持久化边界被移除。
- API 与 Worker 的 Pino serializer 使用同一净化语义，避免不同写入路径重新暴露原始异常。

### 3.4 AI Quality 评分器可信度

- 移除旧评分器直接读取 gold label 自我认证的实现；评分改为接收独立 prediction 后计算。
- 缺少预测、重复预测或覆盖不完整时 fail closed。
- Evaluation 使用真实的 quadratic weighted kappa，并保留 false-mastery、关键类别召回和 repair 指标。
- scorer 版本更新为 `2.0.0`。Fixture 与评分器可以用于 PR/本地验证，但不能替代 M7 的真实 Provider 输出和人工标注。

### 3.5 Worker 超时预算与降级

- 新增嵌套 Provider abort budget：Provider 默认 60 秒，Handler 默认 90 秒，为 deterministic fallback、状态持久化和错误净化预留 30 秒。
- Provider 子超时不再误 abort 外层 Job signal，避免降级逻辑尚未执行就被共同取消。
- `.env.example`、开发/生产 Compose 和超时测试同步更新。

### 3.6 Web 编辑器与验证会话恢复

- Milkdown 增加生命周期 guard，修复路由切换或卸载时异步 editor create/destroy 的竞态。
- 验证 UI 不再展示 Worker/API 原始错误，并会把失败 Job 与会话状态重新对齐。
- 新增终态 Job 恢复：`question_preparing` 对应 Job 已终态或缺失时转为 `question_retryable`；`evaluation_pending` 同理转为 `evaluation_retryable`。更新以 `status + workspace + user + 当前 Job 指针` 做 CAS，竞态失配时重读最新 submission，避免旧 dead Job 覆盖新 retry Job。
- GET 会话的 submission/question/key point 读取留在同一 RLS transaction；重试开始时清理旧错误，RetryView 只展示安全映射后的错误文案。
- 本地浏览器验证确认：历史卡在“准备中”的会话可恢复为“可重试”，重试会创建新的 Question Job。Provider 最终完成链路仍应在 M7 E2E/真实 Provider 证据中闭环。

### 3.7 共享 DTO 与 FSRS 依赖

- `ReviewSchedule` 共享 DTO 补齐 v0.6 调度字段，减少 API/Web/Worker 类型漂移。
- FSRS 依赖固定到 `4.6.0`，golden vector 以固定版本验证，避免浮动依赖改变 shadow 结果。

### 3.8 回归套件可重复性

- 调度分发测试与 fail-closed 实现对齐：未设置 `SCHEDULER_POLICY_VERSION` 时默认 v1，v2 用例必须显式设为 `discrete-v2`。
- 补齐 Review 测试的 assistance exposure/effective evidence mock，并让 RLS migration 契约只检查可执行 SQL，不再被说明注释误报。
- 新增 `npm run test:v06:postgres` 串行执行 3 个共用测试库的 PostgreSQL 集成文件，避免并行 DDL 与会话并发用例互相死锁。

## 4. 本轮验证证据

以下是 2026-07-26 审查过程中实际执行并观察到的结果；它们是定向审查证据，不替代 M7 的完整 release evidence。

| 验证 | 结果 | 说明 |
| --- | --- | --- |
| PostgreSQL RLS matrix | 11/11 通过 | 覆盖 user/workspace 隔离与缺失上下文 fail closed |
| PostgreSQL migration | 13/13 通过 | 覆盖 fresh/upgrade/repeat/restore 与 0042/0043 |
| PostgreSQL validation session concurrency | 14/14 通过 | 覆盖会话并发、幂等和调度约束 |
| PostgreSQL 集成合计 | 38/38 通过 | 有效结果来自独立审查库的正确环境/串行执行 |
| 修复后全量单元测试 | 2717/2717 通过 | Shared 360 + DB 3 + AIQ 84 + API 1422 + Web 302 + Worker 546 |
| API 终态恢复/锁序定向测试 | 30/30 通过 | 覆盖 CAS 竞态、RLS transaction 与 lock ordering |
| Web 恢复/隐私/键盘定向测试 | 50/50 通过 | 包含 Milkdown 生命周期、会话进度与安全错误文案 |
| TypeScript | 6/6 package 通过 | Shared、DB、AIQ、API、Web、Worker 均 `tsc --noEmit` 0 错误 |
| Lint / build | 通过 | Web 全量 lint；Web production build 在本轮通过；最终 API/Worker bundle 通过 |
| Compose 配置解析 | dev/prod 均通过 | 仅证明配置可解析，不等于 Alpha 部署完成 |
| 本地服务状态 | API/Web 可用；Worker 后续退出 137 | Worker 异常限于本地运行环境，因此未把最终 Provider 完成链路计为通过 |
| 浏览器人工检查 | 已通过可恢复路径 | 会话显示“可重试”；DOM 不含原始错误/Job ID/rubric/fingerprint；console warning/error 为 0 |

> 本轮后段曾用一条并行命令将 3 份 PostgreSQL 集成文件同时指向同一审计库，导致 DDL 死锁，且该命令缺少 RLS admin URL；该运行已判定为无效测试编排，不替代上表 38/38 的有效结果。仓库已增加串行脚本，但正式 M7 仍需在受控环境中重跑并绑定原始输出。

## 5. 尚未完成与发布阻断项

### 5.1 M7 必须补齐

- 固定真实 Provider、模型 revision、prompt/dataset/scorer 版本，执行两轮独立 AIQ；输入必须是 Provider prediction，标签必须来自独立人工标注。
- 运行完整 release-check，并完成首次验证、Review、unable、source/result reveal、retry、恢复、3 视口、键盘、200% zoom 和 WCAG E2E。
- 在目标 Alpha 环境完成 migration/restore、Worker 双实例、lease lost、重复 Job、Provider timeout/schema failure 故障矩阵。
- 绑定 clean commit、tag、migration、镜像 digest 和 release manifest；关闭 P0/P1 与 v0.5 延续门禁。
- 依次完成 48 小时安全观察、7 日 SLO 观察和 14 日产品/质量/成本复盘。
- 根据观察结果只选择一个 v0.7 主方向，或明确暂不立项。

### 5.2 附加功能剩余项

- Milkdown 文档中的自动保存、冲突处理、图片上传、编辑锁定、回滚和移动端等人工测试项仍需在完整 E2E/验收阶段逐项闭环。
- 来源收录虽然已实施并有单元测试记录，但真实中文 GBK/GB2312 网站样本和生产网络环境仍需单独验收。
- 长笔记学习卡生成优化仍是设计稿；在实现、基准和回归证据完成前，不得写入 v0.6 已交付清单。

## 6. 版本与文档约束

- `release/version.json` 保持 `0.5.0`。
- 当前计划状态保持 `Approved`，里程碑状态保持“M0-M6 代码完成、M7 未开始”。
- M0-M6 的现有 Gate 文件是代码/定向验证证据；未绑定 clean SHA、执行人/时间、完整命令输出或仍依赖真实环境的条目，不应解释为正式发布 Gate 已关闭。
- 只有 M7 全部完成并由 Release Owner 批准后，才能更新正式版本、创建 tag、发布镜像并把计划转入归档。
