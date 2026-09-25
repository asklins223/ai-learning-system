# D5 · 公共运行基础合同

> 日期：2026-09-24
>
> 状态：**W0-5 交付的设计件（39d §5）。本文件不写产品代码、不改数据库、不删任何链路。**
>
> 依据：39 §15.3-10/-14/-15、§15.5；39c §4–§5、§9；39d §6（W3-1/W3-2/W3-3/W3-5 的判据）；坐标与读数实测于提交 `e7cea900` + 干净树。
>
> 谁在用它：W3-1（任务运行内核）、W3-2（事务纪律）、W3-3（竖向样例）、W3-5（作答 AI 迁入）、W7-7（制卡链切换）。**W3 不得自行发明第二套任务形状**；不够用时回来改本文件。

---

## 0. 一句话

**三块底座已经在了**：`jobs` 表 + SQL 租约/重试函数、`job-lease.ts` 的租约断言、`AIProvider` 的模型传输、以及 `WorkspaceTransactionScope` 的**活动事务检测**（已存在且已测）。**缺的是中间那一层**——任务定义（输入／工具／输出／预算／完成条件）、尝试与检查点的统一语义、两种执行模式的统一外壳、以及事务边界的**强制执行**。

D5 只补这一层。它不重写已经对的东西，也不把四阶段制卡"包一层适配器"当成交付。

---

## 1. 现状盘点

### 1.1 已经对的（复用，不重建）

| 底座 | 坐标 | 它已经提供了什么 |
| --- | --- | --- |
| 队列表 | `jobs`（列：`id, type, workspace_id, payload, status, attempts, lease_token, requested_by, priority, resource_class, idempotency_key, max_attempts, retry_policy_json, retry_after_at`） | **租约、尝试计数、幂等键、重试策略、优先级、资源类**都已经在表上 |
| 租约与重试的 SQL 收口 | `ailearn_claim_jobs(interactiveLimit, backgroundLimit, maxAttempts)`、`ailearn_reap_stale_jobs(leaseTimeoutMs, maxAttempts)`、`ailearn_renew_job_lease(...)`（SECURITY DEFINER）、`ailearn_finish_job(...)`（返回算好的 `status/attempts/backoff_ms/is_dead`） | 退避与死信**已经是服务端算的**，应用层不再自行计算（`queue.ts:287-290` 的注释记录了这次收敛） |
| 租约断言 | `workers/ai-worker/src/lib/job-lease.ts` | `assertJobLease`（副作用前 fail closed，双次 abort 检查）、`lockJobLease`（业务事务内 `FOR UPDATE` 锁 jobs 行 + 续租）、`withJobTransaction`（把 handler 事务绑到 job 的 workspace/actor）、`JobLeaseLostError`（区分 aborted/inactive） |
| 模型传输 | `workers/ai-worker/src/lib/ai-provider.ts` | `AIProvider` 抽象：`chatCompletion` / `chatJson` / `executeAgentTurn`（**工具循环在 provider 层已经存在**）、`getCapabilities()`；五个 provider 实现 |
| **活动事务检测** | `packages/shared/src/workspace-transaction.ts`（`WorkspaceTransactionScope`） | `current(): ActiveWorkspaceTransaction \| undefined` 与 `requireActive()`；基于 `AsyncLocalStorage`，**能识别隐式外层事务**（不只是"文本里有没有 transaction"）；已有用例「requireActive reuses a live transaction and fails closed once it closes」 |
| 业务 outbox | `canonical_learning_event_outbox` 等 | 可靠投递边界，保留 |

**结论**：39 §15.5 说的"任务身份、尝试与事件、取消、恢复、超时、用量"里，**尝试与超时已经在 `jobs` 一侧**；缺的是**任务定义、预算、输出合同、检查点与两种模式的外壳**。

### 1.2 重复的（要收，不是要重写）

| 重复项 | 坐标（实测） | 重复的是什么 |
| --- | --- | --- |
| worker 侧 8 个 handler 各一套循环/重试/解析/进度 | `card-generation-v2-handler.ts`、`companion-agent-runtime.ts`、`companion-dialogue.ts`、`companion-dialogue-stream.ts`、`companion-thought.ts`、`companion-summarizer.ts`、`companion-memory-extractor.ts`、`companion-daily-summary.ts` | 模型调用后的**输出解析、有界重试、失败分支、进度写入** |
| 意图分类器 | `companion-tool-intent.ts` | 每轮一次额定 LLM 调用决定"要不要用工具"（39b §9.5 的 P3 处置） |
| **API 侧一条完全独立的 transport** | `apps/api/src/modules/learning-runs/run-critic.ts` | 自己的 HTTP（`postJsonToPublicEndpoint`）、自己的配置（`ASSESSMENT_CRITIC_URL` / `_KEY` / `_MODEL`）、自己的重试与 strict 解析——**不走 `AIProvider`** |
| 四个 outbox 四套重试规则 | `canonical_learning_event_outbox`、`card_generation_run_outbox_v2`、`learning_run_processing_outbox`、`practice_trail_event_outbox` | 各自的领取/重试/终态写入 |

**注意 39c §2 的自我纠正，本文件继承**：`runV2AuthoringPhase` 那一段**已经有有效拆分**（短事务读输入 → 事务外逐候选生成 → 单独提交），"不能说今天整条仍是一个未提交大事务"。作答评估主路径也已经把 Critic HTTP 放在事务外。**这两处是本文件要"复用其正确边界"的样板，不是要拆的对象。**

### 1.3 缺的（D5 的交付物）

1. **任务定义形状**（上下文／工具／输出／预算／完成条件）
2. **两种执行模式的统一外壳**（单次结构化 vs 工具循环）
3. **检查点语义**（"从哪一步恢复、不重付哪一步"的判据）
4. **事务边界的强制执行**——目前没有；而且**模型调用真的在事务内**（§5.1 有实测证据）

---

## 2. 任务定义形状

任务定义是**代码里的有类型函数**，不建工作流 DSL、不建插件市场（39 §15.5 末段）。最小形状：

```ts
export interface AiTaskDefinition<TInput, TOutput> {
  readonly id: string;              // 稳定标识，落进尝试记录
  readonly version: number;         // **提示词 + 输出合同**的版本；参与检查点匹配
  readonly mode: "structured" | "tool_loop";

  readonly budget: AiTaskBudget;    // §2.2
  readonly completion: AiTaskCompletion; // §2.3

  /** 短事务准备：校验权限与业务版本、冻结输入引用/哈希、领尝试、写租约令牌。提交后释放连接。 */
  prepare(ctx: AiTaskContext, attempt: AiAttemptToken): Promise<TInput>;

  /** 事务外执行。**不接受任何事务对象**（§5）。 */
  execute(input: TInput, env: AiTaskEnvironment): Promise<TOutput>;

  /** 短事务保存：核对尝试身份/租约/取消/权限/输入版本，写不可变输出与下一步投递。 */
  commit(ctx: AiTaskContext, attempt: AiAttemptToken, output: TOutput): Promise<AiTaskReceipt>;
}

export interface AiAttemptToken {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly attemptId: string;       // 每次尝试一个新 id
  readonly leaseToken: string;      // 复用 `jobs.lease_token` 的形状
  readonly idempotencyKey: string;  // 复用 `jobs.idempotency_key`
  readonly workspaceId: string;
  readonly userId: string | null;
}
```

### 2.1 上下文（`AiTaskContext`）

只带**引用**，不带正文：

```ts
{
  workspaceId, userId,
  // 输入快照：按 D3（W0-3）的合同，冻结实际正文 + 引用摘录 + 哈希；**不是只存版本 ID**
  // `audio`（2026-09-25，随 W3-5 语音转写接入时补）：输入就是上传的那段字节，
  // 转写成功之后才写 artifact 行——拿 `artifact` 会指向一个当时不存在的行 id。
  inputSnapshotRef: { kind: "note_version" | "artifact" | "task" | "audio", id: string, hash: string },
  // 权限档位与授权来源（服务端给，页面文本不成为授权）
  permissionLevel, 
  // 取消信号
  signal?: AbortSignal,
}
```

**不放进上下文的东西**（每一条都是防"上下文膨胀成第二个事实源"）：聊天长历史、完整材料正文、其他模块的目标列表。

### 2.2 预算（`AiTaskBudget`）

**模型预算与业务提交重试分开限额**（39 §15.3-16），这是两条轴，不许合成一条：

| 轴 | 谁管 | 触顶行为 |
| --- | --- | --- |
| 模型调用预算（次数／单步时长／整任务时长／成本） | 任务定义 | 保留已完成内容，说明可稍后再试或结束；**不把资源限制说成用户能力不足**（39 §6.2） |
| 业务提交重试 | 领域服务（不花模型） | 继续恢复，**不因模型预算耗尽而丢弃已取得的有效结果**（39c §8 末段） |

首期建议值（39c §8 末段，本文件继承）：**每个模型步骤最多一次自动重试**，受单步/整任务时间与成本上限约束；权限、内容版本、无效输入、实质质量问题**不自动重试**；**结构修复占这次机会，不另开修复循环**。

### 2.3 完成条件（`AiTaskCompletion`）

三种，显式声明，不许"跑完就是完成"：

- `structured_parsed`：输出通过严格解析（schema 校验全过）才算完成；
- `tool_loop_settled`：工具循环以"不再请求工具且产出终答"收尾（39b §9.5 的 `toolChoice` 收口之后，动作步不产 prose）；
- `custom`：任务定义自带的有界判据（例如"至少一张候选通过程序校验"）。

**完成 ≠ 业务采纳**（39c §4 末段）：任务完成只代表拿到了产物；卡片保存、学习结算、日程写入各自由业务服务给回执。

---

## 3. 两种执行模式

同一套运行基础支持两种，**不要求每个功能都先跑一次意图分类或多 Agent 分工**（39 §2.1）：

| 模式 | 谁在用 | 形状 |
| --- | --- | --- |
| `structured` **单次结构化** | 候选生成、内容检查、开放回答评估、转写后的结构化处理 | 一次 provider 调用 + 严格解析；解析失败按 §2.2 的"一次机会"处理，不另开修复循环 |
| `tool_loop` **工具循环** | 伴星对话（已是 `executeAgentTurn`） | 复用 provider 已有的工具循环；步数／调用次数／超时由 `budget` 给；循环内**不得**写业务状态 |

**共同约束（两种模式都要满足）**：

1. 外部调用一律在**事务外**（§5）。
2. 逻辑共用**不要求串同一队列**：作答反馈不能被批量制卡耗尽资源 → **不同 `resource_class` / 并发配额**（`jobs` 表已有这一列，直接用）。39c §4 原话："作答与批量制卡分队列、分配额，作答反馈优先。"
3. 取消：对话取消**不默认撤销已经提交成功的业务动作**（39b §5 末段）。取消信号只停尚未提交的工作。

---

## 4. 尝试、租约、检查点、幂等键

### 4.1 四者的分工（一张表定死，防"四个概念互相顶替"）

| 概念 | 承载 | 唯一性来源 | 半途崩溃后的行为 |
| --- | --- | --- | --- |
| **尝试** `attemptId` | `jobs.attempts` + 尝试记录 | 每次执行新 id | 旧尝试的输出**不许提交**（租约已换） |
| **租约** `leaseToken` | `jobs.lease_token` | `ailearn_claim_jobs` / `ailearn_renew_job_lease` | 租约失效 → 提交被拒；reaper 把 job 放回 |
| **检查点** | 业务侧的不可变产物（已持久化的生成结果、已保存的评估报告） | 输入快照哈希 + 任务定义版本 | **从检查点续跑，不重付已完成的模型步骤** |
| **幂等键** `idempotencyKey` | `jobs.idempotency_key` + 业务侧唯一约束 | 调用方给的稳定键 | 重投读取既有回执，不重复业务写入 |

### 4.2 检查点匹配的判据（这是 D5 里最容易做错的一处）

检查点只有**同时**满足下列全部，才允许复用：

1. `taskId` 相同；
2. `taskVersion` 相同（**换了提示词或输出合同 = 不复用**；39c §8："恢复使用原任务固定的合同与输入，不因部署了新提示词就默默重跑已完成步骤"——反过来，也不能因为部署了新提示词就**默默复用**旧产物）；
3. 输入快照哈希相同（正文 + 引用摘录的哈希，不是版本 ID）；
4. 权限与取消状态在保存时重新核对过。

**不做跨用户复用**：不按"提示词相似"复用私有结果（39c §8）。

### 4.3 恢复表（39c §8 的表，本文件接收为合同）

| 中断点 | 恢复行为 |
| --- | --- |
| 请求已提交但响应丢失 | 按请求身份找回同一任务/提交，不开第二次 |
| 生成已保存、检查未开始 | 从检查继续，不重付生成成本 |
| 部分批次/候选已完成 | 保留有效结果，只恢复未完成的有界任务 |
| 模型完成但持久化前崩溃 | provider 支持可靠查询则恢复；否则**可能再次调用**——**不承诺外部调用恰好一次**，成本如实记录 |
| 结果已提交、worker 未确认 | 重投读既有检查点/回执，不重复采纳 |
| worker 租约过期、旧结果晚到 | 以尝试令牌 + 有效期 + 输入版本拒绝旧提交 |
| 用户改候选/换题/取消 | 新版本与结果提交在短事务里串行核对；过期报告不用于新内容 |
| 保存成功但投影失败 | 回执说已保存，投影异步重试；不重跑生成/保存 |
| 回答已保存、评分失败 | 预算内显示重试中；耗尽则明确无法判定，可按原答案手动重试或结束，**不永久显示待判定** |
| 评分成功、调度提交失败 | 恢复领域提交，不重跑评分 |

**"只产生一次业务效果"靠结果提交与领域写入的唯一约束/CAS，不靠"模型只被调用一次"**（39c §8 原话）。

---

## 5. 事务边界强制执行（本文件分量最重的一节）

### 5.1 实测证据：模型调用今天真的在事务里（两处，逐行核过）

文件：`workers/ai-worker/src/handlers/card-generation-v2-handler.ts`

| # | 处理器 | 事务入口 | 模型调用 | 事实 |
| --- | --- | --- | --- | --- |
| 1 | `runV2PlanPhase`（规划段） | `:1252` `withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {` | **`:1417`** `const plannerResult = await executePlanner({` | 事务内第一步对 run 行做 **`FOR UPDATE` 行锁**（`:1254` 的注释自己写着"在 `withWorkerWorkspaceTransaction` 事务内持锁到提交"），模型调用在**同一个回调内** |
| 2 | 重规划段（`replan`），`:2831` 起的处理器 | `:2843` 同形状打开事务 | **`:2965`** `const plannerResult = await executePlanner({` | 同样是"事务内规划"；`:2962` 的注释写明这是"重跑 planner" |

⇒ **持有业务行锁等外部模型**，且不止首次生成一条路。这就是 39c §2 那句"名为'短事务'的阶段仍可能等待外部模型；拆函数不等于拆事务"的现场，也印证了 39c 对 `regenerate/replan/recheck` 的判断（"各自有处理器和事务包裹"）。

**核对方式（W3-2 实施时照做）**：`grep -n "await executePlanner(" <该文件>` → 两个调用点；`grep -n "withWorkerWorkspaceTransaction(" <该文件>` → 三个入口（`:1252` / `:1800` / `:2843`），逐个确认模型调用是否落在其中。**不能只看首次生成那一条。**

### 5.2 强制执行的三件套（原语已有，接线是新的）

**第一件：接口形状上不接受事务对象。**
`AiTaskDefinition.execute` 的签名里**没有** `tx`（§2）。这不是纪律，是类型：写不出来。同理，领域读写函数不得把 provider 闭包传进事务回调。

**第二件：公共外部调用边界检测活动事务，有则拒绝并记开发错误。**

**原语已经在了**：`WorkspaceTransactionScope.current()` / `requireActive()`（`packages/shared/src/workspace-transaction.ts`），基于 `AsyncLocalStorage`，**能识别隐式外层事务**。所以这一件要做的是**接线**，不是新造：

```
在公共外部调用边界（发模型/转写/图片解析/对象存储之前）：
  if (workspaceTransactionScope.current() !== undefined) {
    记录开发错误（含调用点）
    throw           // 拒绝执行
  }
```

- **API 与 worker 两侧都要接**（39c §5.2 原话："API 与 worker 两侧都要覆盖，防止隐式加入外层事务"）。
- 判据必须是"当前异步作用域有没有活动事务"，**不是"文本里有没有出现 transaction"**——后者是 39c §10 点名要避免的假绿。
- **验收方式（39c §10）**：在已有事务作用域里误调模型，断言**立即被执行边界拒绝**；且测试要覆盖**隐式嵌套**，不只覆盖显式传参。

**第三件：数据库后备超时。**

`workers/ai-worker/src/db.ts` 已经设了 `statement_timeout`（默认 60s，须小于 120s 租约），并**刻意不设** `idle_in_transaction_session_timeout`——注释写明理由是"V2 管道（H4）在事务内做 LLM HTTP 调用，事务此时 idle-in-transaction"。

**这一条随 §5.1 的修复一起翻**：当模型调用不再在事务内，就不该再为它留着"事务内做外部调用"的宽容设置。动作顺序：

1. 先修 `runV2PlanPhase` 的边界（生成 W3-3/W7-7 的活儿）；
2. 再把 `idle_in_transaction_session_timeout` 设成有界值（具体阈值按当时实测的有界数据库操作定，**不是拿超时替代正确拆分**——39c §5.2 原话）；
3. 顺带核对其余三处：不在锁内重试／退避／轮询／大 CPU；材料大小与批量写入有上限；每个检查点、结果与下一步投递在同一事务形成（不允许"结果已提交、下一步永久丢失"）。

### 5.3 验收口径（抄 39c §10，不许降级为"函数名检查"）

- 分别让**生成、检查、改写、评估、转写**慢 30 秒 → 断言外部等待期间**不持有对应业务事务与行锁**，并发读写不被钉住。
- 验收**不是**只检查函数名或新增 `isolated:true`，而是注入慢模型时**真实观察数据库会话、锁、连接占用**（39c §5.2 末句）。
- 恢复也要测：重生成与失败分支同样满足同一纪律，不是只测首次生成。

---

## 6. 迁移与删除清单

**本文件不授权删除任何链路。** 下表是"实施时要处置什么、怎么核对当前调用方"：
（删之前逐条按 39d §3 第 1 条核对引用，并在交付说明里列出删除范围。）

| 现有部分 | 处置 | 当前调用方核对方式 |
| --- | --- | --- |
| 四阶段制卡固定编排（Planner → 逐目标 Author → Grounding → Pedagogy） | **改造**：被"小批生成 + 独立综合检查"替换（W7-1/W7-7） | 全仓搜 `executePlanner` / `executeAuthoring` / `executeGrounding` / `executePedagogy` 的调用点；核对 `generation-run-service.ts` 的请求方与 outbox 的 `type` 取值 |
| 自动 bounded repair / recheck / replan / 投机 pedagogy | **删除**（失去调用方后） | 搜 `boundedRepair` / `recheck` / `replan` / `speculative`；核对各自 handler 注册点与 `jobs.type` 取值 |
| 制卡专属 AI 租约/重试/进度运行器 | **改造**：调用方切到公共机制，保留必要业务投递与持久化语义 | 搜 `card_generation_run_outbox_v2` 的领取/续租/终态写入函数；确认 `jobs` 侧的租约已覆盖 |
| API 内专属 Critic transport（`postJsonToPublicEndpoint` + `ASSESSMENT_CRITIC_*`） | **改造**：迁入公共模型任务，**独立评估上下文、strict 解析与有用规则保留**（W3-5） | 搜 `ASSESSMENT_CRITIC_URL` / `ASSESSMENT_CRITIC_KEY` / `ASSESSMENT_CRITIC_MODEL` 的读点与部署配置；核对该配置在 compose / CI / 文档里的出现处 |
| `companion-tool-intent.ts` 分类器 | **删除**（W2-4 的 P3 达标后） | 搜 `companionNeedsTool` 的调用点；69b §9.5 已给出判决线（S1 探针 ① < 2%） |
| `LearningRun` 的原始回答、变体约束、暴露、提交与调度 | **保留并适配**新观察语义 | 不删；只按 D1（W0-1）扩展 origin 与 goal 映射 |
| 结构题判定、确定性提示、快照与激活回执 | **复用**（核对新合同后） | 不为"统一 Agent"把本来不需要模型的步骤改成模型调用（39c §2 末行） |
| 旧 UI 阶段、固定比例进度、专属失败文案与测试 | **随新状态语义替换** | 搜进度百分比组件与专属文案键；原有有效业务约束迁成新合同测试 |
| 四个 outbox | **保留**（都是业务投递边界），但**重试规则要向 `jobs` 侧看齐** | 逐个核对其重试参数来源；本轮只登记差异，不合并 |

**删除的前置**：39d §3 的两条红线——不用 git 写操作删代码、删除前核对调用方并在交付说明里列范围。

---

## 7. 作答「提交→首个有效反馈」的性能下限

39c §4 与 §15.5：**迁移不得使"提交→首个有效反馈"变慢**，以迁移前的现状分位数为下限。

**W0-8 复量值（2026-09-24，n=91，`learning_artifact.locked` → 首个 `learning_assessment.completed|not_assessable`）**：

| 分位 | 读数 |
| --- | --- |
| p50 | **107 ms** |
| p95 | **8746 ms** |
| 分布 | **双峰**：<200 ms 共 50 条（夹具/模拟）、1–3 s 7 条、3–10 s 23 条、>10 s 1 条 |

**怎么用这个数（重要，别用错）**：

- **p50 107 ms 不是这条链的性能下限**——它落在夹具桶里。真要拿它当门槛，等于拿 mock 的耗时去要求真模型。
- **W3-5 的门槛取"真模型那一段"**：当前 3–10 s 桶（23 条）与 p95（8746 ms）。迁移后**不得劣于**这两个读数。
- **测量口径必须一致**：同一条 `learning_artifact.locked → learning_assessment.completed|not_assessable` 的定义；且必须在**分队列、分配额**（§3 第 2 条）落地之后再量，否则量到的是队列争抢而不是迁移代价。
- 迁移后的读数**进 §19 实施日志**，与本节并列。

---

## 8. 未决项与落点

| 未决项 | 为什么本文件不定 | 落点 |
| --- | --- | --- |
| `resource_class` 的具体取值与并发配额 | 需要真实负载分布 | W3-1 核定 |
| `idle_in_transaction_session_timeout` 的阈值 | 需要按有界数据库操作实测（§5.2 第三件） | W3-2 |
| 检查点表的物理形状（新表 vs 复用 `jobs.payload`） | 取决于 W3-3 竖向样例的真实读写形状 | W3-3 |
| 四个 outbox 是否最终合并 | 本轮只登记差异；合并是一次独立的重构决定 | W7 之后评估 |
| 转录/图片解析是否走同一任务形状 | 它们也是外部调用，但输出合同不同 | W3-5（转写）、W6-2（长材料分页） |

---

## 附：本文件用到的实测读数（可复算）

```
# 1) 模型调用在事务内（§5.1，两处）
card-generation-v2-handler.ts:1252  withWorkerWorkspaceTransaction(..., async (tx) => {   ← 规划段
                          :1417  const plannerResult = await executePlanner({
                          :2843  withWorkerWorkspaceTransaction(..., async (tx) => {   ← 重规划段
                          :2965  const plannerResult = await executePlanner({
  → 两处都是"持业务行锁等外部模型"
  → 核对：grep -n "await executePlanner(" 得 2 个调用点；
          grep -n "withWorkerWorkspaceTransaction(" 得 3 个入口（1252 / 1800 / 2843）

# 2) API 侧独立 transport
grep -rn "chatCompletion\|chatJson\|executeAgentTurn" apps/api/src/modules → 0 命中
run-critic.ts:8-18  经 @ailearn/shared/public-json-http 的 postJsonToPublicEndpoint；
                    配置 ASSESSMENT_CRITIC_URL / _KEY / _MODEL

# 3) 活动事务检测已存在
packages/shared/src/workspace-transaction.ts  WorkspaceTransactionScope.current() / requireActive()
packages/shared npm test → "ok 282 - requireActive reuses a live transaction and fails closed once it closes"

# 4) 租约与重试已在 SQL 侧收口
queue.ts: MAX_ATTEMPTS = 3；ailearn_claim_jobs / ailearn_reap_stale_jobs /
          ailearn_finish_job（返回 status/attempts/backoff_ms/is_dead）/ ailearn_renew_job_lease

# 5) 性能读数（W0-8）
learning_run_events: n=91，p50 107 ms / p95 8746 ms；<200ms 50、1–3s 7、3–10s 23、>10s 1
```
