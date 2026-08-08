# 阶段 03（W2）：Learning Session Supervisor Runtime

> **第一层执行顺序第 3 步**
> 前置：阶段 01（W0 冻结）
> 后置：阶段 04（W3）的 Runtime 前置
> 可与阶段 02（W1 数据底座）并行
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W2」；规范依据：§4.3（四阶段外壳）、§4.4（Loop 边界）、§5.3（typed actions）、§12.4（tool gateway）。

---

## 本阶段目标

实现 Learning Session Supervisor 的有界运行时：PREPARE → 有界 SESSION_AGENT 编排 → 可审计 staging，全程 0 canonical write，让 W3（语音/评估）能在此之上工作。

## 可并行执行的任务（第二层）

### 任务 03-1：Agent Runtime 复用与隔离

**交付物**：复用通用 Agent Runtime 的 session、turn、tool event、budget、checkpoint、lease 和 native-tool/structured-action 能力；role/tool/provider/budget 与 Generation Supervisor 完全独立。

**任务内容（原文 §0.2/§0.3/§4.2，W2 bullet）**：

- generic Agent runtime 复用，但 role/tool/provider/budget 独立；
- Learning Session Supervisor 只能读取已确定性 Publish 的 canonical Card、Key Point 和 Evidence，不得读取 generation draft、Candidate Ledger 私有 staging 或未通过 Critic 的产物；
- Generation Supervisor 不得读取个人回答、音频、理解状态、用户问题标记或复习表现，也不得为单个用户改写共享卡片；
- 落地形态：Typed Agent Graph（阶段、状态、权限与恢复）= bounded LoopAgent node（路线与 Scene 编排）+ specialist Agents（Tutor、Rubric/Scene Critic、Assessment Critic）+ deterministic core（资格、事务、事实、调度、投影）；
- 上下文记忆来自数据库里的 contract、probe、artifact、assessment、偏好和事件摘要，不来自无限增长的聊天 messages。

**验收**：两套 Supervisor 的数据与工具权限隔离测试通过。

---

### 任务 03-2：PREPARE 与 Session 生命周期

**交付物**：Session 创建（PREPARE）、Session loop、typed actions、checkpoint、wait/resume、cancel；`confirm_continue_session` 用户 checkpoint。

**任务内容（原文 §4.3 PREPARE + §4.2 事务层级）**：

- PREPARE：解析用户选择的 Key Point、临时问题上下文或复习入口；从 official scheduler、needs-repair 状态和 active canonical 内容中生成合法 Episode 候选；冻结 formal eligibility、typed scheduling decision、Episode/content exposure 身份、用户偏好、assistance snapshot、BudgetEnvelope、capability/runtime epoch 和 policy versions；只读 `PublishedLearningAssetContractV1` required canonical 字段；PREPARE 本身不把含答案的评分合同返回客户端；
- `LearningSession` 是用户可见航程容器（串联 1~5 个 Episode，无 route-level mastery 或总体 schedule 副作用）；多 Episode 之间必须经过用户 checkpoint：本 Episode 真实结果 → 结束并返回来源（默认）/ 用户确认"继续下一站" / 换一个或缩短剩余路线；只有用户命令 `confirm_continue_session` 才能 PREPARE 下一 Episode；没有倒计时默认选择；
- origin-aware completion 在用户停止、选择返回或全部 Episode 明确结束时执行，而不是在 Episode 之间强制跳页；
- PREPARE 创建不可借用的 `BudgetEnvelope`（§16.6）：展示首个 formal Scene 前预留全部 required probes、一次允许的重录/结构修正上限、Assessment Critic 重试与 commit 所需额度；预算不足必须在用户作答前阻断。

**验收**：Session 生命周期完整；取消后当前与未开始 Episode 零副作用、已 commit Episode 保留。

---

### 任务 03-3：四阶段外壳与有界 SESSION_AGENT

**交付物**：PREPARE → SESSION_AGENT → INDEPENDENT_ASSESS → COMMIT 外壳骨架；`RUBRIC_AND_SCENE_PREPARE` 子流程；0 trusted 内容性 follow-up。

**任务内容（原文 §4.3 SESSION_AGENT + §4.4）**：

- 根据目的地和显式偏好默认提议一条路线；"换一个"才生成备选；
- 在首个 formal probe 展示前执行不向用户展示的 `RUBRIC_AND_SCENE_PREPARE` 子流程：解析 RubricTarget → Scene Author 提出草案 → deterministic schema/safety → 独立 Rubric/Scene Critic → 确定性激活 immutable private/public contracts；
- 每个 RubricTarget 冻结 criterion、server-only expected target/hash、weight、required、facet、target、逐项 evidence refs 和 semantic-support report；
- 公测 v1 的同一 formal Episode 在首次回答前冻结全部 trusted probes 和分支；Supervisor 只能请求 `requestedTrustClass`，不能签发 effective trust；
- trusted 阶段不读取内容性 gap 来动态出题，只能接收 `continue / stop / not_assessable / switch_modality` 等无答案控制信号；
- 内容性 assessment gap 只有在正式答案锁定并完成 Independent Assess 后才可供结果解释或 practice 使用；
- practice 阶段可以按已知缺口自适应追问，但其后续 artifact 全部保持 practice-only；
- 不进入无限聊天，不新增评分目标，不替用户完成答案；
- Agent Loop 硬边界（W0 冻结值）：Session Supervisor turns ≤8；trusted 内容性动态 follow-up =0；每条路线 Encounter 2~5；同时 active 学习会话每用户 1；单次 Agent turn deadline ≤120s（由 Provider/ASR policy 冻结）；Session inactivity expiry 建议 30 分钟（只结束 active UI，不回滚已 commit Episode）；Pause TTL 恢复时必须重查 source/policy/assistance stale；
- Supervisor staging plan，0 canonical write。

**验收**：无限 loop 不可达；trusted 阶段无内容性动态出题；越权写为 0。

---

### 任务 03-4：Tool Gateway 与权限隔离（§12.4）

**交付物**：Scene Author/Supervisor/Companion/Tutor/Critics 分离的 tool gateway、public DTO serializer、prompt-injection boundary。

**任务内容（原文 §12.4 actor 矩阵，W2 bullet）**：

- 各 actor 使用不同工具 allowlist：Session Supervisor（读净化 contract summary、`propose_bounded_route`、从已审核模板提议 probe、`focus_nodes/draw_route/stage_scene`、`propose_episode_ready`、提议结束；禁止 lock/submit、enter-practice、保存问题、直接派发/代签评估、commit、读内容性 gap 后继续 formal）；Scene Author（只读当前 target published claim/evidence 与 private Rubric staging，写未激活 Scene staging；禁止读用户回答、激活或展示 Scene、跨 target 检索、签发 trust/outcome）；Session Companion Renderer（呈现 public typed actions、收集用户动作 nonce、恢复 origin；禁止读 private contract/solution、自由发工具、替用户确认）；Grounded Tutor（practice 状态读当前 target 已发布证据，生成证据卡/当前目标 Scene/短解释；禁止 formal assessment、跨 target 无限搜索、写 mastery/schedule/Card/relation）；Grounded Answer Critic（只读 Tutor segment、allowlisted evidence/premises 和 support mode，输出逐段 support verdict；禁止扩大检索、改写回答、参与 formal assessment、写学习事实）；Rubric/Scene Critic（只读 private staging，输出激活 verdict；禁止展示给用户、辅导、签发业务 outcome）；Assessment Critic（只读 locked artifact、RubricTarget 和 evidence，输出逐项 assessment；禁止生成 probe、修改 artifact、输出 mastery/interval）；Scene Activation Service（确定性校验后 exactly-once 激活；禁止内容生成、修复、跳过 Critic、改变 trust ceiling）；Deterministic Core（校验 required artifacts 后派发独立评估、锁、reducer、existing-domain commit、outbox、scheduler；禁止开放式生成或替用户表达意图）；
- 禁止：任意 SQL/shell/文件系统/HTTP/插件；全局伴星后台截屏、环境监听、持续麦克风、DOM/credential/clipboard 读取；动态生成并执行前端代码；读取跨 workspace/user artifact；trusted 回答前读取或返回 hidden rubric/expected concept/evidence；直接写 mastery/schedule/published semantic relation/canonical Card；child Agent 再 spawn Agent；提高预算、延长无限会话或跳过 Critic；
- public DTO 使用显式 allowlist、`private/no-store` 与 DOM/RSC/prefetch/cache 泄漏测试；Private Episode、RubricTarget、solution 和 Provider policy 只供服务端内部 actor 读取；
- 伴星优先使用 typed spatial actions（§5.3）：`focus_nodes`、`draw_route`、`stage_scene`、`read_prompt`、`offer_branch`、`show_change`、`propose_curiosity_save`（Should）、`return_to_origin`、`end_session`；模型不能返回任意 DOM、CSS、HTML 或脚本。

**验收**：actor 越权尝试全部被网关拒绝；prompt-injection 对抗集通过；public DTO 零 private 字段。

---

### 任务 03-5：Global Shell 与 Session Supervisor 解耦

**交付物**：页面导航、首次引导和静态帮助不创建 Session，也不借用 learning Agent budget。

**任务内容（原文 §0.5/§5.4，W2 bullet）**：

- Global Companion Shell 是一层确定性分发与呈现壳，不是第二条 Learning pipeline：所有页面复用一个 versioned context/action contract、一个触发仲裁器和一套用户开关；不得为每个页面再建独立助手 Agent、消息历史或记忆库；
- `global_companion_shell` 不依赖 learning core；页面导航、首次引导和静态帮助不创建 Session，也不借用 learning Agent budget；
- 在 Learning Session 外，Global Shell 只使用确定性产品动作（§5.3）：`spotlight_ui_anchor`、`open_page_help`、`preview_navigation`、`resume_onboarding`、`resume_checkpoint`、`show_permission_scope`、`dismiss_suggestion`、`preview_registered_page_action`、`request_page_action_confirmation`；这些动作不能创建 Episode、直接修改领域数据或被模型自由拼装。

**验收**：普通浏览/引导路径零 Session 创建、零 learning budget 消耗。

---

### 任务 03-6：Budget、epoch 与 kill 政策落地

**交付物**：budget/context/turn deadline/inactivity/pause TTL 执行与 `runtimeEpochSnapshot + episodeEpoch` 检查；`learningRuntimeEpoch`/`commitKillSwitch` 挂钩。

**任务内容（原文 §4.3/§4.4/§7.7/§13.5）**：

- 所有 turn/tool/Critic 结果落库前重新比较 contract 的 `runtimeEpochSnapshot + episodeEpoch`；COMMIT 使用固定锁序与完整 CAS（详见阶段 01 任务 01-1 与阶段 06）；
- hard kill 后的迟到 Provider/ASR/Critic 响应只记录不含用户内容的审计摘要，不写 probe/artifact/assessment staging，也不能恢复为 trusted；
- privacy/trust/scheduler hard incident：bump runtime epoch、fence 全部未 commit Episode、取消未完成外部 job，禁止 trusted 恢复（§17.2）；
- 断线恢复只读取 event/contract/artifact，不重复 Provider 调用和业务副作用；
- budget/context/turn deadline/inactivity/pause TTL 与 0 trusted content follow-up 全部生效。

**验收**：epoch 失配、kill、超时路径不产生任何学习副作用。

---

## 阶段退出 Gate（03 / W2）

- [x] Agent 越权写 outcome/schedule/graph truth 为 0（任务 03-3/03-4：staging 0 canonical write 类型保证 + Tool Gateway 越权全拒）。
- [x] 无限 loop 不可达（任务 03-3：loopGuard turns≤8/trusted follow-up=0/Encounter 2~5 等硬边界）。
- [x] PREPARE/Session loop/typed actions/checkpoint/wait/resume/cancel 完整（任务 03-2：PREPARE 冻结 + loop 状态机 + confirm_continue_session checkpoint + cancel 零副作用）。
- [x] Global Shell 与 Session Supervisor 解耦（任务 03-5：普通页面零 Session、零 budget）。
- [x] staging plan 0 canonical write（任务 03-3/03-6：字面量 canonicalWrite:false + epoch/CAS 政策）。

通过后进入阶段 04（W3）。
