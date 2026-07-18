# AI 学习系统 v0.5 版本实施计划

> 状态：Approved for development（M0 收口中；foundation/expand 已在本地开始，M1 Gate 未通过）<br>
> 文档版本：0.4<br>
> 计划日期：2026-07-18<br>
> 最后更新：2026-07-18<br>
> 目标版本：`v0.5.0`<br>
> 产品阶段：Private Alpha<br>
> Canonical repository：`https://github.com/asklins223/ai-learning-system.git`<br>
> Canonical branch：`main`<br>
> 发布标签：annotated tag `v0.4.0`，tag object `e4f3ce95ec8c5ddd5b5d71c473d34bdc2e134fcd`，peeled commit `0b9708d02a1d376c9db96eaf2accd33301cf2c9d`<br>
> 规划审计快照：`33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`（审计于 2026-07-18）<br>
> 文档 Owner：repository owner `@asklins223`<br>
> Approver：repository owner `@asklins223`（development self-review；SEC-01 enforce 与 RC 前必须补独立 security/data review）<br>
> 批准日期/证据：2026-07-18，Codex 任务指令“开始实施这一版本计划”；ADR-0001～0008<br>
> 容量假设：2 条并行实施流（安全/后端与产品/质量）<br>
> 建议周期：8 周开发与验收，随后 2 周小范围观察；若只有 1 名实施者，按 10～12 周并移除全部 Should<br>
> 一句话目标：让 5～15 名受邀用户能够安全、独立、可度量地完成“输入 → 学习卡 → 证据 → 验证 → 复习”闭环。

> **重要声明**：本文只定义下一版本的目标、边界、顺序和验收门槛，不代表任何功能已经实现，也不授权跳过评审直接修改代码、数据库或部署环境。本文所有验收项初始均为未完成。

## 0. 文档定位与基线说明

本文是在 canonical 分支上落地后唯一有效的 v0.5 活动计划，固定路径为：

`docs/plans/AI学习系统-v0.5-版本实施计划-2026-07-18.md`

发现入口为 `docs/plans/README.md`。活动计划不得在仓库根目录或 `project-archive/` 保留第二份可编辑副本；版本冻结后由后继计划替代，并在索引中标记 `Superseded` 或 `Archived`，不复制内容制造双源。

早期产品愿景、V0 Personal Beta、v0.4 实施计划和审核报告已经在 public main 的 `5a1c9cf` 中移除。它们只作为本地历史输入；本文已重新陈述 v0.5 仍然采用的目标和原则，因此 canonical 计划不依赖这些已删除文件或未跟踪的 `project-archive/`。

文档生命周期为：

```text
Draft → Approved → Superseded → Archived
```

- `Draft → Approved`：Owner 批准开发范围和 M0 决策并记录证据；当前可由 Owner self-review 启动 foundation/expand。M0 负责锁定独立评审要求和证据入口；实际独立 security/data approval 是 SEC-01 enforce 与 RC 的阻断输入；
- `Approved → Superseded`：有新的受控计划明确替代本文；
- `Superseded → Archived`：版本退出观察期，索引保留只读位置和最终结论。

### 0.1 当前分支风险

当前本地 `main@ced1422c15217910889c9240b5503eaf2b01cc60` 仍属于 `v0.3.1-rc.1` 的旧历史；canonical 审计快照为 `33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`，两条历史没有共同 merge base。因此：

1. 本计划按不可变 planning SHA `33efa06f8c0a5f2d1e97e12dcb745b2314c606e8` 审视和定义；
2. 实施前必须先确认 canonical repository、分支和最新 commit SHA；
3. 不得直接把旧 `main` 当作 v0.5 开发基线；
4. 不得在未确认历史关系前执行强推、重置或批量覆盖；
5. v0.5 RC 必须从确认后的 clean public main 后继提交构建。

### 0.2 版本判断

annotated tag `v0.4.0` 已发布，其 peeled commit 为 `0b9708d02a1d376c9db96eaf2accd33301cf2c9d`；规划快照中的五个 package 与公开 README 均声明 `0.4.0`。因此下一常规增量版本命名为 `v0.5.0`。

v0.5 是第一次受控 Private Alpha，不等于产品路线中的完整 V1。它先用 5～15 人验证安全、可信和可运营的最小闭环，再决定是否扩大功能面。

### 0.3 基线证据快照

| 结论 | 不可变证据 | 状态 |
| --- | --- | --- |
| 当前公开版本为 0.4.0 | `33efa06:README.md:5`；五个 `package.json:3` | 静态已复核 |
| v0.4 核心能力清单 | `33efa06:README.md:7-17` | 静态已复核，运行态待 M0 复测 |
| 迁移/构建/单测/Compose/备份 CI 已配置 | `33efa06:.github/workflows/ci.yml` | 配置已复核，最新 Actions 结果待 M0 保存 |
| 维护提交声称约 180 项测试通过 | commit `33efa06` message | 仅维护记录，M0 必须从 clean checkout 重跑 |
| RLS 仍暂缓 | `33efa06:apps/api/src/db/migrations/0014_n007_workspace_fk_completion.sql:151-160`；`33efa06:infra/postgres/roles.sql:10-12` | 静态已复核 |
| 30 篇样本与 90%/85%/85% 阈值存在 | `33efa06:apps/api/src/modules/benchmark/service.ts:12-20`；`33efa06:packages/shared/src/constants.ts:4-10` | 静态已复核，发布门禁尚未闭环 |
| CI 无浏览器 E2E，生产 smoke 为单 Worker | `33efa06:.github/workflows/ci.yml` | 静态已复核 |
| 可观测性以 Pino、health/readiness 为主 | `33efa06:apps/api/src/lib/logger.ts`；`33efa06:apps/api/src/server.ts:41-135` | 静态已复核 |

## 1. 当前能力与主要缺口

### 1.1 v0.4 已形成的基线

- 文本、Markdown、代码和 URL 来源采集；
- 笔记编辑、自动保存和不可变版本；
- AI 学习卡、证据对齐和人工 evidence override；
- 持久化验证题、验证结果、理解事件和复习计划；
- 搜索、今日变化、理解图谱、导出和 Markdown 批量导入；
- Mock、DashScope、OpenAI-compatible 三类模型配置；
- 用户 API Key 加密保存，HttpOnly Cookie、CSRF 和共享登录限流；
- API、Worker、migrator 最小权限数据库角色；
- 迁移矩阵、生产 Compose smoke、Worker 单任务 smoke 和备份恢复门禁；
- 30 篇 AI 基准样本与 90% / 85% / 85% 的质量阈值定义；
- 发布后维护线记录约 180 项自动化测试通过，但公开 CI 最新实跑结果仍需在迭代启动时重新确认。

### 1.2 v0.5 必须处理的缺口

| 领域 | 当前事实 | v0.5 需要达到的状态 |
| --- | --- | --- |
| 版本基线 | 本地与公开维护线是独立历史 | 明确 canonical main、统一版本源并从 clean SHA 开发 |
| 租户隔离 | 已分数据库角色，但 RLS 明确暂缓 | API/Worker 在真实受限角色和连接池复用下通过 RLS 隔离 |
| Alpha 访问 | 已有邀请码注册和 workspace membership 基础对象 | Owner 可创建、查看、撤销邀请并管理成员，受邀者有完整 onboarding |
| 学习闭环 | 验证可追溯，但“完成复习”主要是状态按钮与固定倍增间隔 | 每次复习产生可审计 attempt，记录回忆/回答、结果、原因和调度变化 |
| AI 修正 | 证据支持 override，其他 AI 结果缺少统一反馈入口 | Must 提供人工反馈渠道；结构化反馈队列列为 Should |
| AI 质量 | 30 篇样本存在，但黄金标签不是仓库内不可变发布输入，CI 不跑质量比较 | 数据集、标签、评分器版本化，PR/RC/nightly 采用分层门禁 |
| 浏览器验收 | CI 只做 Web HTTP smoke，无真实浏览器 E2E | 核心流程、三档视口、键盘和控制台错误进入自动化门禁 |
| Worker 可靠性 | 单元测试与单 Worker smoke 为主 | 双 Worker、租约丢失、旧 Handler 返回、重试/死信有真实 PostgreSQL 故障测试 |
| 可观测性 | 以结构化日志、`/health`、`/ready` 为主 | Must 有 SLO 必需指标、告警和演练；完整 tracing/Dashboard 列为 Should |
| 导入能力 | 批量 Markdown 为主 | 保持现有能力；可恢复导入与 Readwise/Anki 适配列为 Should |
| 发布追溯 | 有构建和 CI 恢复门禁，缺统一版本源、digest 和发布清单 | tag、版本、迁移、镜像 digest、测试摘要一一对应；SBOM/签名列为 Should |

## 2. 目标用户与关键场景

### 2.1 目标用户

1. **Workspace Owner**：部署或管理一个小型学习空间，邀请成员并处理失败、反馈和隐私设置；
2. **受邀学习者**：没有仓库和运维知识，只通过 Web 完成模型配置、输入、验证与复习；
3. **版本维护者**：需要通过自动门禁判断版本能否安全发布和回滚。

### 2.2 v0.5 关注的四条用户旅程

旅程 A、B、D 属于 Must；旅程 C 的完整产品化属于 Should。Private Alpha 即使裁掉旅程 C 的产品界面，也必须公布一个人工支持渠道并记录反馈分流责任。

#### 旅程 A：首次价值

```text
收到邀请
→ 注册并进入正确 workspace
→ Owner 完成 workspace 隐私政策，member 查看并确认现有政策
→ 配置个人模型或选择 Mock
→ 新建或导入一篇内容
→ 生成第一张学习卡
→ 核对证据
→ 完成一次验证
→ 获得可解释的复习安排
```

#### 旅程 B：可信复习

```text
到期提醒
→ 先回忆或作答
→ 查看证据约束的反馈
→ 记录 review attempt
→ 根据结果更新理解状态与下次时间
```

#### 旅程 C：问题反馈（Should）

```text
发现关键点/证据/验证反馈有问题
→ 提交结构化反馈
→ 系统绑定原始对象、版本和 Provider 信息
→ Owner/维护者处理
→ 用户可看到处理状态
```

#### 旅程 D：故障恢复

```text
Provider 超时、Worker 重启或导入部分失败
→ 用户看到可理解状态
→ 系统安全重试且不重复产生业务副作用
→ 维护者从指标和关联 ID 定位原因
```

## 3. 版本目标

### 目标一：可验证的多租户安全

- API、Worker、migrator 使用不同受限角色；
- workspace 上下文只在事务内生效，连接归还连接池后不得残留；
- API 跨 workspace 读、写、关联和删除全部由应用校验与 RLS 双重拒绝；
- Worker 使用受控的跨 workspace claim 路径，处理具体任务时进入对应 workspace 上下文；
- 邀请、成员管理和 workspace 切换不能突破角色边界。

### 目标二：真实用户可以独立完成可信闭环

- Owner 能管理 Alpha 邀请和成员生命周期；
- 新用户无需阅读部署文档即可完成 onboarding；
- 验证题、用户回答、理解事件和复习计划保持可追溯；
- 完成复习必须产生 review attempt，不能只靠“已完成”按钮提升理解状态；
- 没有硬证据时明确降级或阻止理解升级。

### 目标三：AI 质量和运行状态可度量

- 黄金数据集、人工标签和评分逻辑都有版本；
- 区分确定性 PR 门禁和带成本的 RC 真实 Provider 门禁；真实 Provider nightly 属于 Should；
- 请求、任务、租约和 Provider 调用能够关联；
- 队列、延迟、失败、重试、dead job、token 和估算成本可见；
- 告警必须有负责人、阈值和演练记录。

### 目标四：从一次性发布转向受控 Alpha 运营

- 核心浏览器流程进入 CI；
- Alpha 行为指标只采集允许字段，不存原文、回答正文、API Key 或 Provider 原始响应；
- Owner 能导出完整 workspace；member 能使用现有授权范围内的单笔记导出，并明确知悉 v0.5 不提供个人批量导出的边界；
- 发布有清单、灰度、回滚和观察期。

## 4. 成功指标

### 4.1 RC 硬门禁

以下任一项失败均不得发布 RC：

- [ ] canonical main 与目标 SHA 已确认，工作区 clean；
- [ ] 所有 package、README、tag 和 release manifest 的版本一致；
- [ ] 空库、v0.4 代表性旧库、重复迁移和备份恢复通过；
- [ ] API/Worker/migrator 受限角色和 RLS 权限矩阵全绿；
- [ ] 跨 workspace 读写、关联、导出、删除测试为 0 泄漏；
- [ ] 双 Worker 竞争及故障注入无重复副作用；
- [ ] 关键浏览器 E2E 在 390 / 768 / 1440 三档视口通过；
- [ ] E2E 无未允许的 `console.error`、page error、未处理 Promise 或阻断性无障碍错误；
- [ ] 固定黄金集不少于 30 篇，硬引用 Precision ≥ 90%，关键点硬证据覆盖 ≥ 85%，期望位置硬证据覆盖 ≥ 85%；
- [ ] 覆盖率达到：全仓 lines ≥ 70%、branches ≥ 60%；身份、租户隔离、job/lease、证据、验证/复习、导入导出模块 lines ≥ 85%、branches ≥ 75%；changed lines ≥ 80%；
- [ ] 测试报告不存在未列入受控 allowlist 的 `skip` / `todo`，所有 flake 均有 Owner、Issue 和不超过 14 天的到期日；
- [ ] 生产依赖和镜像无 high/critical 漏洞，secret scan 通过；
- [ ] 发布清单包含 commit、tag、迁移版本、镜像 digest 和测试摘要；
- [ ] Alpha 环境定时加密备份、独立存储、保留轮换、失败告警和恢复演练通过；
- [ ] 无未关闭 P0/P1，已知 P2 均有 Owner、影响和规避方案。

### 4.2 Alpha 运行 SLO

下列定义在 M0 固化为 ADR；若调整数值，必须记录理由，不能在 RC 失败后临时降低门槛。

| SLI | 计算与排除 | 窗口/最小样本 | 目标 | 数据源 / Owner |
| --- | --- | --- | --- | --- |
| API 请求成功率 | `status < 500` / 全部 API 请求；排除 `/health`、合成探针和客户端主动断开 | 7 日；≥ 100 请求 | ≥ 99.5% | HTTP metrics / platform Owner |
| 核心旅程合成可用性 | 登录 → 首页 → 打开一张固定卡的探针成功次数 / 总次数 | 每 5 分钟；7 日且 ≥ 1,000 次 | ≥ 99.5% | synthetic monitor / quality Owner |
| Job 业务成功率 | `succeeded / (succeeded + dead)`；排除明确分类的用户 Key、权限、额度配置错误，不排除 timeout/schema failure | 7 日；≥ 30 个终态 job | ≥ 98% | job metrics / worker Owner |
| 队列积压 | 每分钟采样 `oldest_pending_age_seconds` | 24 小时；≥ 1,000 次采样 | 99% 样本 < 120 秒 | job metrics / worker Owner |
| 学习卡端到端时长 | 从 job 创建到 active card 可读，按 Provider 分桶 | 7 日；每个 Provider ≥ 30 次，否则只报告不判定 | Mock p95 < 15 秒；参考真实 Provider p95 < 90 秒 | job/provider metrics / worker Owner |
| 备份新鲜度（RPO） | 当前时间减最近一次已完成且校验通过的加密备份时间 | 连续监控 | ≤ 24 小时 | backup monitor / platform Owner |
| 恢复时间（RTO） | 从宣布开始恢复到 API ready、权限重放和核心表校验全部通过 | 每个 RC；使用不小于 Alpha 预估数据量的 fixture | ≤ 2 小时 | restore report / platform Owner |

跨 workspace 泄漏、不可恢复数据丢失和 secret 泄漏属于安全不变量，容忍度为 0，不使用百分比 SLO 稀释。

### 4.3 灰度扩量门槛

- **48 小时快速门槛**：0 安全不变量事件、0 未归属 dead job、API 5xx < 1%、无持续 30 分钟以上的积压告警；只用于决定是否从内部 workspace 扩到 1～2 个外部 workspace；
- **7 日稳态门槛**：4.2 中样本量充足的 SLO 全部达标，样本不足项明确标记 `insufficient_data`，不得伪装成通过；
- **14 日发布门槛**：安全不变量、稳态 SLO、已知问题和反馈复盘完成后，才决定 `v0.5.0` 转正；4.4 的产品退出指标只用于 V1 决策，不阻断 v0.5 转正；
- 任一 P0、跨 workspace、数据丢失或连续两次相同 P1 触发暂停扩量并执行回滚/修复流程。

### 4.4 Alpha 退出指标

这些指标用于判断是否进入更完整的 V1 Private Alpha，不作为首个 RC 的阻断条件：

- 邀请到注册成功率 ≥ 95%；
- 首次登录到第一张证据可查看学习卡的 p50 ≤ 15 分钟；
- 已激活用户中，首周完成一次完整闭环的比例 ≥ 60%；
- 连续两周至少 50% 的已激活用户完成“输入/更新内容 + 验证 + 复习”；
- 所有 Alpha 反馈（人工渠道或 Should 产品入口）3 个工作日内完成首次分流；
- 观察期内无 P0、无数据丢失、无跨 workspace 事件。

小样本阶段不把留存率包装成统计显著结论，所有产品指标必须同时显示分子、分母和样本周期。

## 5. 版本范围

### 5.1 Must：v0.5.0 必须完成

| Epic | 工作包 | 核心结果 |
| --- | --- | --- |
| FDN-01 | 基线与文档治理 | canonical main、版本源、ADR、release manifest 规则明确 |
| SEC-01 | RLS 与事务 workspace 上下文 | API/Worker/连接池复用下的数据库级隔离可验证 |
| SEC-02 / ALPHA-01 | 邀请、成员与首次使用 | Owner 可管理邀请/成员；新用户完成首张卡和首轮验证 |
| LOOP-01 / LOOP-02 | 可追溯验证与 Review Attempt | 服务端题目为默认路径；复习记录回答、结果、原因和调度变化 |
| QLT-01 / QLT-02 | 关键 E2E 与故障测试 | 核心闭环三视口；双 Worker 与真实 PostgreSQL 覆盖竞争、租约和恢复 |
| AIQ-01 | 版本化黄金集 | 固定样本、标签、评分器和可复现 RC Provider 门禁 |
| OPS-01 | 最小运维与备份 | SLO 必需指标/告警、定时加密备份和恢复演练可运行 |
| REL-01 | 可追溯发布 | 统一验证入口、digest、灰度和回滚清单 |

### 5.2 Should：在 Must 全绿后进入

- 建立 `import_run` / `import_item` 级导入报告、失败重试和来源映射；
- 支持 Readwise CSV/JSON 导出导入；
- 支持 Anki CSV/TSV 导入，`.apkg` 不在本版；
- 建立 LOOP-03 结构化反馈入口、Owner 分流队列和用户状态页；
- 运行真实 Provider nightly 趋势测试；
- 完整 token/成本、SSRF、产品漏斗 Dashboard 和 tracing；
- 生成 SBOM、软件来源证明与镜像签名；
- Owner 可查看不含学习正文的 Alpha 健康摘要；
- 对热点文件、CSS 体积、Bundle 和循环依赖建立维护预算；
- 将数据库 schema 收敛为单一权威源，替代长期字节镜像维护。

### 5.3 Could：仅在不影响发布门禁时尝试

- 新用户可选择一套只含公开样例的演示学习路径；
- 面向个人的轻量周报，基于真实事件而非 AI 编造总结；
- 对学习卡关键点提供受控编辑并触发派生物失效/重算；
- 一个额外 OpenAI-compatible Provider 的兼容性样例。

### 5.4 明确不做

- 公开注册、计费、订阅和商业配额；
- 浏览器插件、桌面端、iOS/iPadOS 和离线同步；
- PDF、图片、OCR、音视频处理和通用对象存储管线；
- 实时协同编辑、评论流和复杂组织权限；
- `.apkg` 原生解析；
- 大规模视觉重构或导航重做；
- 复杂 Concept 自动合并、全量知识图谱推理；
- 用真实用户内容训练第三方模型；
- 在缺少足够行为数据前引入 FSRS 等复杂调度算法。

## 6. 核心工作包定义

### 6.1 SEC-01：RLS 与受限角色闭环

#### 设计要求

- API 业务查询必须在事务内设置 transaction-local `app.workspace_id` 与必要的 `app.user_id`；
- 事务结束后上下文自动失效，不允许 session-local 泄漏；
- Worker 通过安全 claim 函数跨 workspace 领取任务，再在任务事务中进入对应 workspace；
- migrator 负责 DDL 和 policy，API/Worker 不拥有绕过 RLS 或修改 policy 的权限；
- 先建立数据分类清单：workspace-owned 表使用 workspace RLS；用户私有表使用 user/workspace 联合约束；`users`、`sessions`、`auth_rate_limits` 等全局身份/限流表使用最小授权和受控函数；`jobs` 等跨 workspace 运维表使用专用 claim/lease 函数；
- 所有应隔离表必须覆盖直接读取、写入、关联、级联/删除、导出和搜索投影，不得用“一刀切全表 policy”掩盖例外；
- readiness 能识别 role/policy 未应用或版本不匹配；
- migration 采用 expand → 验证 → enforce，避免一次切换导致全站不可读写。

#### DoD

- [ ] API 与 Worker 在真实受限账号下完成核心闭环；
- [ ] 连接池复用 1,000 次 workspace 交替请求无上下文串线；
- [ ] 两个 workspace 的跨域 ID 猜测、关联写入和批量接口全部被拒绝；
- [ ] Worker claim、续租、提交和回收通过 RLS/lease 双重约束；
- [ ] 迁移、回滚/前向修复和故障恢复 runbook 完成。

### 6.2 SEC-02 / ALPHA-01：邀请、成员与 onboarding

#### 功能边界

- Owner 创建一次性邀请，可设置过期时间并主动撤销；
- 邀请只展示必要元数据，不泄漏已消费 token；
- Owner 查看成员、角色和最近会话状态，可撤销成员现有会话；
- v0.5 只保留 `owner` / `member` 两级有效权限，`admin` 若无完整语义不得在 UI 中承诺；
- 邀请默认通过“复制链接/邀请码”交付，不在本版接邮件服务；
- onboarding 状态由服务端记录，允许跨设备继续；
- Owner 引导包括 workspace AI consent/data policy、Provider 选择/连接测试、首份内容、首张卡、证据说明和首次验证；
- member 只能查看并确认 Owner 已设置的 workspace 政策，再配置个人 Provider 或选择 Mock，不得被引导调用 Owner-only policy API；
- 使用 Mock 也能完成全流程，真实 Provider 配置失败时提供恢复路径。

#### DoD

- [ ] Owner 能创建、复制、查看状态、撤销邀请；
- [ ] 过期、撤销、已消费和并发消费均有明确结果；
- [ ] 成员不能执行 Owner 操作；
- [ ] Owner 与 member 两条 onboarding 分支均通过，member 不会遇到预期内的 403；
- [ ] 被移除成员的 session 失效且无法继续读取 workspace；
- [ ] 首次价值旅程在桌面和移动视口 E2E 通过。

### 6.3 LOOP-01 / LOOP-02：验证与复习

#### 数据要求

新增或等价实现 `review_attempts`，至少包含：

- `workspaceId`、`userId`、`reviewScheduleId`、`subjectType`、`subjectId`；
- 使用的 validation question / key point / evidence 版本；
- 回答类型、结果、置信度、跳过原因；
- 调度前后状态、间隔与原因；
- 幂等键、创建时间和完成时间。

默认不在产品事件或日志中复制用户回答正文。回答正文若属于学习记录，只存业务表并遵守导出、删除和隔离规则。

#### 行为要求

- 服务端持久化题目是新流程唯一默认入口；
- 没有硬证据的 key point 不得产生“已理解”升级；
- 正常完成复习需要一次回忆/回答及结果；
- “稍后再看”和“无法回答”必须记录原因，不伪装成完成；
- 调度仍使用可解释的离散档位，但由最新 validation/review outcome 驱动；
- attempt、understanding event 和下一次 schedule 在同一幂等事务中提交；
- 卡片或来源版本变化后，旧题目和旧证据按规则 stale/superseded。

#### DoD

- [ ] 重复提交、超时重试和双击不产生重复 attempt/schedule/event；
- [ ] 用户可从历史中解释“为什么现在复习、为什么安排到这个时间”；
- [ ] 错误理解只有新的有效验证才能关闭；
- [ ] 导出和删除覆盖 review attempt；
- [ ] 真实浏览器完成验证 → 到期复习 → 再验证闭环。

### 6.4 LOOP-03：结构化反馈（Should）

反馈最小模型应绑定：

- 反馈者、workspace、对象类型和对象 ID；
- 对象版本、artifact、Provider、model 和 prompt version；
- 分类：`incorrect`、`missing`、`bad_evidence`、`unsafe`、`other`；
- 可选说明、状态、处理人、处理结论和时间；
- 原对象删除后的保留/匿名化策略。

#### DoD

- [ ] 关键点、证据和验证反馈均可提交；
- [ ] 用户可查看自己的反馈状态；
- [ ] Owner 只能查看当前 workspace 反馈；
- [ ] 反馈不会自动改变理解状态；
- [ ] 反馈样本进入离线质量流程前必须去标识并获得允许。

### 6.5 AIQ-01：版本化 AI 质量门禁

#### 分层策略

| 层级 | 触发 | 内容 | 是否阻断 |
| --- | --- | --- | --- |
| PR | 每次变更 | schema、解析器、对齐器、固定 Mock、黄金标签完整性 | 是 |
| Nightly（Should） | 每晚或按需 | 固定参考 Provider 的 10 篇轮换样本与趋势比较 | 不阻断 PR；连续 3 次失败必须分流 |
| RC | 候选版 | 固定参考 Provider 对 30 篇完整黄金集运行 2 次 | 是 |
| Alpha | 持续 | 经允许的聚合反馈、无原文的质量信号 | 用于决策，不自动阻断 |

#### 版本化要求

- 样本文本、标签、评分器、prompt、模型配置分别有版本；
- 黄金标签不能只存在 workspace 可变表中；
- CI 必须校验每个 key point 标签覆盖完整，无标签时不得把指标显示为通过；
- 真实 Provider 的网络、配额、认证失败与模型质量失败分开统计；
- 不允许通过更换样本或减少 key point 数量静默提高分数；
- 每次阈值或数据集变化必须有决策记录。

#### RC 可复现配置

- 候选参考配置为 DashScope compatible endpoint + `qwen-plus`；M0 冻结 Provider 选择、预算与 revision 取证规则，每个 RC 再获取并记录当时可验证的精确 model/revision ID。若服务商只提供会漂移的别名，该别名不能单独充当可复现 RC 身份，manifest 还必须记录运行时间和服务商返回的模型修订信息；
- release manifest 固定 Provider endpoint origin、model ID、prompt version、temperature `0.2`、数据集版本、标签版本和评分器 commit；
- 30 篇样本完整运行 2 次，两次都必须满足 90% / 85% / 85% 绝对阈值；`rc.1` 只使用绝对阈值并冻结为首个可比基线，后续 RC 的三项两轮平均值相对上一个同配置已接受 RC 不得下降超过 2 个百分点；
- 认证、额度、DNS、网络和服务商 5xx 归为基础设施失败，可在 30 分钟内最多重试 2 次，但在成功完成整轮前 RC 保持阻断；schema failure、空结果和内容质量问题不得按基础设施失败重试洗掉；
- 单次 RC 预算上限为 10 美元等值或 AIQ ADR 中更低的人民币上限；超过预算必须停止并由 Owner 批准新预算，不能减少样本规避；
- PR 不访问付费网络，使用固定 Mock 验证结构、解析、对齐、评分公式和黄金标签完整性。

### 6.6 OPS-01：最小运维、可观测性与备份

#### Must 指标集

- HTTP：请求量、成功率、p95、5xx、readiness；
- Job：queue depth、oldest pending、wait/runtime、retry/dead、lease lost/reap；
- Provider：调用量、延迟、超时、schema failure、用户配置错误；
- Database：迁移版本、连接池、事务失败、RLS 拒绝和最近成功备份时间；
- 最小 Alpha funnel：邀请发出/消费、onboarding 完成、生成卡、提交验证、完成复习；
- Release：版本、commit、migration 和镜像 digest。

token/估算成本、SSRF 细分、完整产品漏斗、p50/p99、分布式 tracing 和综合运营 Dashboard 属于 Should，不得阻塞安全告警、SLO 和备份先落地。

#### 生产备份要求

- Alpha 数据库至少每 12 小时自动生成一次一致性备份，为 RPO ≤ 24 小时保留执行和调度余量；
- 备份在传输和静态存储时加密，密钥与备份分开管理；
- 备份保存在与主数据库故障域独立的位置，保留最近 14 个周期备份（覆盖 7 日）和 4 个周备份；
- 备份失败、超过 24 小时无已验证备份或校验失败必须告警；
- 每个 RC 在隔离环境恢复最新备份，重放角色/权限并核对迁移数、核心表行数、对象关联和 API readiness；
- 恢复报告记录计时起止、数据规模、校验范围和异常，作为 RPO/RTO 证据。

#### 隐私约束

- 事件名和属性使用 allowlist；
- 不记录 Note/Source 正文、用户回答正文、API Key、Cookie、CSRF、完整 URL query 或 Provider 原始回复；
- `requestId → jobId → leaseToken` 可关联，但展示 lease token 时只用不可复用的短标识；
- workspace/user 标识用于内部聚合时采用不可逆或受控标识；
- 明确保留期、访问权限和删除策略。

#### DoD

- [ ] 4.2 所需查询、最小 Dashboard、告警阈值和 Owner 可用；
- [ ] 定时加密备份、独立存储、保留轮换和失败告警可用；
- [ ] RC 恢复演练在 2 小时内完成并通过权限/完整性校验；
- [ ] 演练 Provider 超时、Worker 停止、queue 堆积、数据库不可用和迁移不匹配；
- [ ] 每个演练都能在目标时间内告警并定位；
- [ ] 日志/指标自动扫描不发现 secret 或学习正文。

### 6.7 QLT-01 / QLT-02：自动化验收

#### 测试底座时序

- M0 选定浏览器框架、fixture/seed 协议、截图/trace 留存和 console allowlist 格式；
- M1 完成可在 CI 启动的 Chromium harness、双 workspace fixture、无障碍扫描和错误捕获；
- M2/M3 每交付一条旅程就同步交付对应 E2E；
- M5 只做全量矩阵、性能和回归收口，不再首次建设测试基础设施。

#### 浏览器 E2E 矩阵

| 旅程 | PR | Nightly | RC |
| --- | --- | --- | --- |
| 登录/登出、session、workspace 权限 | Chromium 1440 | Chromium 390/768/1440 + Firefox 1440 | 同 Nightly |
| 邀请、注册、onboarding、首张卡 | Chromium 1440 | Chromium 390/768/1440 | Nightly + Firefox 1440 |
| 证据 override、验证、review attempt | Chromium 1440 | Chromium 390/768/1440 | Nightly + Firefox 1440 |
| 来源、Markdown 导入、搜索、星图、导出恢复 | 不阻断 PR；相关变更跑定向 smoke | Chromium 390/1440 | Chromium 390/768/1440 + Firefox 1440 |
| 51/100/1000 条边界和失败恢复 | 不运行 | Chromium 1440 | Chromium 1440 |

所有 PR/RC 流程执行键盘主路径和自动化 WCAG 2.2 AA 扫描，`serious` / `critical` 问题为 0。WebKit 在 v0.5 为 Could，不作为 RC 门禁。

#### 浏览器错误规则

- 未处理 page error、unhandled rejection、资源安全错误永远阻断，不可 allowlist；
- 预期 `console.warn/error` 必须记录精确匹配、Issue、Owner、理由和到期日，最长 14 天；
- allowlist 变更需要 quality Owner 审批，RC 不接受已过期条目；
- PR 失败即阻断。自动重试只用于收集 trace，不得把首轮失败改写为通过；确认 flake 后必须隔离并按上述规则限期修复；
- 失败截图、video/trace、console 和测试摘要保留至少 90 天。

#### PR smoke 流程

PR smoke 至少覆盖：

1. 登录/登出与 session 恢复；
2. 新建笔记、自动保存、生成学习卡；
3. 查看证据并提交 override；
4. 提交验证并得到结果；
5. 完成一次复习 attempt；
6. workspace 切换与权限拒绝。

Nightly/RC 扩展覆盖：

- 邀请注册和 onboarding；
- 来源创建、URL 异常、Markdown 批量导入与部分失败；
- 搜索分页、星图截断/加载、导出恢复；
- Provider 配置与连接测试；
- 51 / 100 / 1000 条数据边界；
- 390 / 768 / 1440 视口、键盘、焦点、减少动画和控制台错误。

#### 覆盖率与测试发现

- 全仓最低 lines 70%、branches 60%；
- 身份、租户隔离、job/lease、证据、验证/复习、导入导出最低 lines 85%、branches 75%；
- changed lines 最低 80%；
- M0 保存 `33efa06` 基线报告；若现状低于上述目标，v0.5 必须补齐测试后才能发布，不能用旧低基线豁免；
- `skip` / `todo` 默认 0；例外使用受控 allowlist，包含测试名、Issue、Owner、批准人和最长 14 天到期日；
- 测试 runner 使用目录发现而不是手写文件枚举；覆盖率、JUnit、flake 和 allowlist 报告保留至少 90 天。

#### Worker/数据库故障矩阵

- 双 Worker 同时 claim；
- claim 与 reap 竞争；
- lease 过期后旧 Handler 返回；
- Provider 收到 abort 后仍延迟返回；
- 事务提交前/后进程退出；
- 重复消息、重复 HTTP 请求、死信重放；
- API/Worker 受限角色权限不足；
- 连接池跨 workspace 复用；
- 备份期间写入静默和恢复后权限重放。

CI 必须执行上述门禁，避免新增测试文件未被发现或 flake 被自动重试掩盖。

### 6.8 REL-01：发布与供应链

- 建立单一版本源并校验五个 package、lockfile、README、tag 一致；
- 提供本地与 CI 共用的一个 `verify` / `release-check` 入口；
- 全仓 typecheck、lint、格式、测试、覆盖率、build、audit 统一输出摘要；
- 扫描依赖、secret 和容器镜像；SBOM、来源证明和签名属于 Should；
- 记录并固定应用镜像 digest；
- 生成机器可读 release manifest；
- RC 从 tag clean checkout 重跑全部门禁；
- 先内部 workspace，再 1～2 个外部 workspace，最后扩大到 5～15 人；
- 回滚必须包含应用、迁移兼容、Worker drain 和数据恢复步骤。

## 7. 里程碑与依赖顺序

### M0：基线冻结与设计决策

建议周期：2～3 个工作日。

#### 工作项

1. 确认 canonical repository、public main 和开发分支；
2. 记录 v0.5 起点 SHA，处理无 merge-base 风险；
3. 验证 `docs/plans/` 索引、生命周期和归档规则；
4. 在 `docs/adr/` 建立版本、RLS、review attempt、telemetry/backup 和 AI quality ADR；
5. 把 Must / Should / Could 及删减线冻结；
6. 为所有 Must 工作包指定 Owner、依赖和验收证据；
7. 前置浏览器 harness/fixture、无障碍扫描和 console allowlist 的技术选型；
8. 保存覆盖率、skip/todo、CI 与 release-check 基线报告。

#### Gate M0

- [ ] 基线 clean 且可从 Git 复现；
- [x] 所有 Must 开放决策均有 development 结论；
- [x] 数据迁移和回滚/前向修复方案通过 Owner development review（SEC-01 enforce 前补独立复核）；
- [x] 隐私事件 allowlist 通过 Owner development review（RC 前补独立 security/data review）；
- [x] 本文已从 Draft 转为 Approved for development。

### M1：租户隔离与多用户安全底座

建议周期：第 1～2 周。

#### 工作项

- transaction-local workspace/user context；
- workspace-owned、用户私有、全局身份和跨租户运维四类数据策略与 Worker 安全 claim；
- 角色授权、readiness 和迁移顺序；
- 跨 workspace、连接池复用和受限角色集成测试；
- 邀请/成员权限模型冻结；
- Chromium CI harness、双 workspace fixture、错误捕获和无障碍扫描底座。

#### Gate M1

- [ ] 真实受限角色完成核心闭环；
- [ ] 跨 workspace 测试 0 泄漏；
- [ ] 双 Worker 在 RLS 下可领取和完成任务；
- [ ] 代表性 v0.4 数据可无损升级。

### M2：邀请制 Alpha 与首次使用

建议周期：第 3 周。

#### 工作项

- 邀请创建、过期、撤销、消费和并发控制；
- 成员列表、移除与 session 撤销；
- workspace 切换边界；
- onboarding 状态和 Web 引导；
- 首次价值旅程的浏览器 E2E。

#### Gate M2

- [ ] 新用户在 Mock Provider 下独立完成首次价值旅程；
- [ ] 邀请生命周期和角色矩阵全绿；
- [ ] 移动、平板和桌面均无阻断问题。

### M3：可信验证与复习

建议周期：第 4 周。

#### 工作项

- 服务端验证题默认路径和旧兼容路径退场计划；
- review attempt 数据模型、API 和页面；
- outcome 驱动的可解释离散调度；
- 导出、删除、搜索/统计的关联更新；
- 验证/复习旅程 E2E 与幂等集成测试。

#### Gate M3

- [ ] 完整闭环所有状态都来自真实业务对象；
- [ ] 无硬证据时不能提升理解状态；
- [ ] attempt/event/schedule 幂等且事务一致；
- [ ] 导出、删除和恢复包含 review attempt。

### M4：质量基准、最小运维与故障测试

建议周期：第 5～6 周。

#### 工作项

- 固定黄金标签和评分器；
- PR/RC 质量门禁；真实 Provider nightly 仅在 Should 容量内进入；
- SLO 必需的 API/Job/Provider/最小 funnel 指标；
- 最小 Dashboard、告警和隐私扫描；
- 定时加密备份、独立存储、保留轮换和失败告警；
- 双 Worker、租约和失败恢复矩阵；
- 统一测试发现、覆盖率基线和意外 skip 门禁。

#### Gate M4

- [ ] 黄金集阈值通过；
- [ ] 故障注入无重复副作用或不可恢复状态；
- [ ] SLO 与告警演练通过；
- [ ] 最新备份可恢复并完成权限/核心数据校验；
- [ ] 指标与日志不含 secret/学习正文。

### M5：浏览器全量回归与发布工程

建议周期：第 7 周。

#### 工作项

- 全量浏览器 E2E 和大数据边界；
- 统一 `verify` / `release-check`；
- 全仓 lint、覆盖率、secret/依赖/镜像扫描；
- release manifest、digest 和回滚 runbook；
- SBOM、签名、性能和维护预算只在 Should 容量内进入；
- Should 项是否进入 RC 的最终裁剪。

#### Gate M5

- [ ] clean checkout 全门禁通过；
- [ ] 三视口核心流程通过；
- [ ] 发布清单完整且可机器校验；
- [ ] 回滚、备份恢复和 Worker drain 演练通过。

### M6：v0.5 RC、灰度与观察

建议周期：第 8 周发布 RC，随后观察 2 周。

#### 发布顺序

1. 创建 `v0.5.0-rc.1`；
2. 从 tag clean checkout 运行完整 release-check；
3. 部署内部 workspace，观察至少 48 小时；
4. 通过 48 小时快速门槛后扩到 1～2 个外部 workspace；
5. 满 7 日且稳态 SLO 达标后扩到 5～15 人；
6. 满 14 日、安全不变量、稳态 SLO、已知问题和反馈复盘满足 4.3 后决定是否转正；
7. 任一暂停条件触发则停止扩量并回滚/修复；
8. v0.5 发布门槛满足后发布 `v0.5.0`，否则继续 RC，不以日期强行转正；4.4 产品指标单独记录 V1 决策。

#### Gate M6

- [ ] 灰度期间无跨 workspace、数据丢失或不可恢复任务；
- [ ] SLO 达标且告警没有系统性噪声；
- [ ] 已知限制和支持方式已对 Alpha 用户说明；
- [ ] release manifest 与线上实际 digest 一致；
- [ ] 观察结论记录是否进入 V1 Private Alpha。

## 8. API、数据、UI 与兼容性影响

### 8.1 预期 API 面

具体命名由 ADR 决定，能力至少包括：

- 邀请：创建、列表、撤销、消费状态；
- 成员：列表、移除、session 撤销；
- Onboarding：读取/更新步骤状态；
- Review Attempt：开始、提交、稍后、历史；
- Feedback（Should）：提交、我的反馈、Owner 分流；
- Internal ops：只暴露聚合健康信息，不暴露学习正文；
- Import Run（Should）：创建、进度、失败项、重试。

v0.5 不新增 member 个人批量导出：完整 workspace export 仍为 Owner-only；member 只使用其已有权限范围内的单笔记导出。Review Attempt 必须进入 Owner workspace export、备份、恢复和删除校验；个人批量导出若要加入，按 Should 单独评审共享内容与个人学习记录边界。

所有列表必须有稳定分页；所有写接口必须有权限和幂等语义及明确错误码。Cookie 认证的非安全 HTTP 方法必须校验 CSRF；Bearer/API 客户端使用独立认证与权限校验，不强制浏览器 CSRF token。

### 8.2 数据迁移原则

1. 只做前向兼容迁移，不修改已发布迁移文件；
2. 新表/列先 nullable 或提供安全默认值，再回填，再收紧；
3. 启用 RLS 前先创建 policy、授权和验证查询；
4. 旧验证提交兼容路径必须有明确的弃用窗口和遥测；
5. 新事件进入导出、恢复、删除和备份校验；
6. 搜索、统计和指标是可重建投影，不得成为业务事实唯一来源；
7. 回滚优先采用应用兼容与前向修复，不承诺破坏性 schema down migration。

### 8.3 UI 原则

- 本版只增加完成 Alpha 旅程所需页面和状态，不做整体视觉重构；
- 所有异步步骤展示当前状态、可恢复动作和关联错误；
- “理解”“完成”“掌握”等文案必须来自真实事件，不用装饰性进度伪造；
- Owner 操作与学习者操作明确分区；
- 移动端优先保障 onboarding、验证和复习；若进入 Should，再覆盖结构化反馈；
- 键盘、焦点、减少动画、空态、错误态和长文本是验收项。

## 9. 风险与控制

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| 本地与公开历史分叉 | 在错误基线继续开发或误覆盖历史 | M0 先确认 canonical main，禁止强推/重置式“对齐” |
| v0.5 范围过大 | 稳定性与产品增量互相挤压 | 按 2 条实施流排 8 周；单人改为 10～12 周；所有 Should 可整体裁掉 |
| RLS 使 Worker/API 全面失效 | 核心业务不可用 | expand→验证→enforce；受限角色 smoke 先于默认启用 |
| 连接池上下文泄漏 | 严重跨租户事故 | 仅 transaction-local context，交替 workspace 压测和故障测试 |
| 真实 Provider 波动 | PR 不稳定、成本不可控 | PR 使用确定性门禁，RC 固定配置并设预算；nightly 仅 Should |
| 遥测泄漏学习内容 | 信任与合规风险 | 属性 allowlist、内容禁采、自动扫描、最小保留期 |
| 小样本指标被过度解读 | 错误产品决策 | 同时展示分子/分母/周期，退出指标只作方向证据 |
| Review 模型一次升级过度 | 数据模型和体验不可控 | v0.5 保持可解释离散档位，先收集 attempt 数据 |
| E2E 数量膨胀 | CI 过慢且维护成本高 | PR smoke、nightly 全量、RC 完整三层运行 |
| Schema 双份维护 | API/Worker 漂移 | v0.5 至少保持 CI diff；单一权威源列为 Should |

## 10. 开放决策与默认建议

### 10.1 ADR 治理

- ADR canonical 目录为 `docs/adr/`，索引为 `docs/adr/README.md`；M0 才创建具体 ADR 文件，不在 Draft 计划阶段预写实现结论；
- 临时 ID 使用 `ADR-v05-NNN`，进入 canonical main 时按仓库序号重命名；
- 每份 ADR 必须包含 Status、Owner、Approver、Date、Context、Decision、Alternatives、Consequences、Migration、Rollback/Forward-fix、Evidence；
- Must 相关 ADR 必须为 `Accepted`，本文才能从 Draft 进入 Approved；
- 默认建议只是 Proposed，不会因到期自动生效，必须由表中 Approver 明确批准。

### 10.2 决策表

| ID | 决策 | 默认建议 | Owner / Approver | 截止 | 状态 / ADR |
| --- | --- | --- | --- | --- | --- |
| D-01 | Alpha 规模 | 5～15 人、最多 3 个活跃 workspace | Product Owner / repository owner | M0 | Accepted / `ADR-0002` |
| D-02 | 邀请交付 | 复制链接/邀请码；邮件服务延后 | Product Owner / security reviewer | M0 | Accepted / `ADR-0002` |
| D-03 | 数据分类与隔离 | workspace、用户私有、全局身份、跨租户运维四类策略 | Security Owner / security reviewer | M0 | Accepted / `ADR-0003` |
| D-04 | Review 调度 | outcome 驱动离散档位；FSRS 延后 | Learning Loop Owner / Product Owner | M0 | Accepted / `ADR-0004` |
| D-05 | 真实 Provider 门禁 | RC 两轮完整集；PR 不调用付费模型；nightly 为 Should | AI Quality Owner / repository owner | M0 | Accepted / `ADR-0005` |
| D-06 | 指标与隐私 | Prometheus-compatible 指标 + 结构化日志；服务端 allowlist，不含正文 | Platform Owner / security-data reviewer | M0 | Accepted / `ADR-0006` |
| D-07 | 备份与恢复 | 12h 加密备份、独立故障域、14 个周期备份 + 4 个周备份 | Platform Owner / repository owner | M0 | Accepted / `ADR-0007` |
| D-08 | E2E 框架与矩阵 | Chromium PR/三视口 RC，Firefox 关键旅程，无障碍 AA | Quality Owner / repository owner | M0 | Accepted / `ADR-0008` |
| D-09 | 导入适配（Should） | Readwise CSV/JSON 优先，Anki CSV/TSV 次之 | Product Owner / repository owner | M5 裁剪 | Deferred / 无 ADR |

D-02、D-03、D-06 当前由 `@asklins223` 以 repository owner 身份兼任产品、安全、数据与平台角色完成 development self-review；这不是独立发布审批。独立 security/data reviewer 是 SEC-01 enforce 与 RC 的阻断输入。

## 11. 实施启动清单

只有以下项目全部完成，才算“M0 完成并解锁 SEC-01 enforce/合并”；在此之前只允许可回退的 foundation/expand 工作，不得声明 M1 Gate 或发布门禁通过：

- [x] canonical repository 和 main SHA 已确认；
- [x] v0.5 分支从正确基线创建；
- [x] 本文状态由 Draft 改为 Approved；
- [x] Must 范围、Owner、周期和删减线确认；
- [x] 版本/基线、RLS、Review Attempt、AI Quality、Telemetry/Privacy、Backup、E2E ADR 通过；
- [x] 数据迁移和回滚/前向修复方案通过；
- [ ] 测试 fixture、Alpha 环境和 Provider 预算准备完成（框架、fixture/环境契约与 10 美元上限已批准；CLI/harness、外部环境资源和真实凭据仍未准备）；
- [x] 隐私 allowlist、保留期和访问权限通过 Owner development review；SEC-01 enforce/RC 的独立 security/data review 要求和证据入口已记录；
- [ ] 当前工作区无会污染 release-check 的未跟踪发布输入（M0 工件提交后关闭）；
- [ ] v0.4 本地 immutable-SHA 基线已复核；待保存 Node 22 CI 原始 artifact 并把证据纳入 clean Git 提交。

## 12. 文档变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-07-18 | 基于 v0.4 发布与维护快照创建 v0.5 规划草案；尚未开始实现 |
| 0.2 | 2026-07-18 | 固定 canonical 路径与不可变 SHA；收敛为 8 周 Private Alpha；补齐数据分类、可计算 SLO、备份、E2E/覆盖率和 Provider 门禁 |
| 0.3 | 2026-07-18 | repository owner 批准开发启动；从 canonical SHA 建立 v0.5 分支；接受 ADR-0001～0008 并保存初步本地基线 |
| 0.4 | 2026-07-18 | 明确 Owner development self-review 与独立发布复核边界；修正 immutable-SHA coverage；M0 保持收口中并记录已开始的 foundation/expand |
