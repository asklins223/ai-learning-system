# 冻结记录 01-5：成功指标、性能与成本 Gate（§16）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-5（原方案 §16）
> 约束级别：全部阈值与样本量、SLA、区间在 W0 冻结并在看到 RC 结果前不变；W8/W9 的验收基准。

## 1. 任务定位

**交付物**：可信性硬指标、多模态评估质量、Tutor 质量、产品价值观指标、体验/性能 Gate、成本/调用放大 Gate（W8/W9 的验收基准）。

**忠实性说明**：本记录按原方案 §16 全文冻结。源文档任务 01-5 为要点摘录；凡摘录未列出、但原方案 §16 含有的必冻结阈值，均已按原方案补全并以「*（原文 §16 补充）*」标注；未标注条目即摘录与原文一致。

## 2. 可信性硬指标（§16.1）

以下全部为 0 容忍（未标注者均为「= 0」），或标注的 100% 要求：

- 未知或越权 evidence/artifact/node/edge/option ref：0；
- practice/diagnostic/not-assessable 导致 mastery 或 schedule 升级：0；
- assisted/stale 结果训练 FSRS 或延长 interval：0；
- Agent 直接修改 outcome、due、mastery、published semantic relation：0；
- 单击选择/判断单独产生 mastery upgrade：0；
- ASR/Agent 改写后的答案伪装为用户原始答案：0；
- semantic relation candidate 自动转 published：0；
- 未作答前 DOM/network/cache/prefetch 答案泄漏：0；
- 跨 workspace/user 学习数据泄漏：0；
- 重复 job/tool/commit 产生重复副作用：0；
- 一个 input schedule 被成功消费超过一次：0；
- 每个成功提交的 schedule-bearing Episode 的 successor schedule 数不等于 1：0；
- `facet_eligible` 或 incomplete silent bundle 改变 Key Point schedule：0；
- `record_only/no_effect` 写 schedule 或结束 review attempt：0；
- `create_initial/consume_pending` 提交后 active schedule 数不等于 1：0；
- 同一内容通过 legacy/new、换 Scene/policy 绕过 exposure/cooldown：0；
- FSRS shadow 进入候选、排序、推荐理由或用户文案：0；
- Episode plan 包含 ineligible target 或缺少 official decision ref：0；
- 星图无事件依据的正式状态变化：0；
- 未 redacted 结果从 contract + frozen probes + artifacts + EpisodeTrustDecision + assessments + scheduling decision + reducer 可做完整语义重算：100%；
- redacted 结果只要求由 canonical event + content-free tombstone 确定性重放既有 outcome/投影，且明确不支持 semantic re-audit：100%；
- 投影 replay hash 一致：100%。

## 3. 多模态与评估质量（§16.2）

- Formal artifact 结构完整率：100%；运行中可用率目标 ≥99.5%；
- Question/Scene 固定对抗集答案泄漏：0；
- critical contradiction 被判可掌握：0；
- ASR 关键内容不可辨时进入 `not_assessable`：100%；
- 未 redacted 评估的 artifact/evidence/excerpt 可追溯率：100%；redacted 评估的 tombstone/outcome/policy refs 可追溯率：100%，excerpt 必须已删除；
- 相同 facet 的人工双标一致性和 Critic precision/recall 阈值在 W0 冻结，RC 后不得降低；
- 纯识别猜中导致整体掌握：0；
- voice 与 silent bundle 按相同 rubric/facet 分层报告 false-upgrade、false-downgrade、abstain 和 `not_assessable`；
- silent mastery bundle 与人工判断、voice 路径的一致性阈值、最小样本量、双标规则和置信区间在 W0 冻结；
- 被路由到 silent mastery 但缺少 eligible `SilentProofProfile`：0；整体与各内容 family 覆盖率达到 W0 冻结门槛；
- 模态间只比较相同 facet，不要求单个排序 Scene 与开放讲解提供相同信息量。*（原文 §16 补充）*

## 4. Grounded Tutor 质量（§16.3）

- 当前 target answer segment 的 evidence refs 完整率：100%；
- source-grounded substantive support precision 目标 ≥95%；
- 将扩展知识伪装成当前文章事实：0；
- 不足以回答时能够明确 abstain；
- Tutor 输出直接进入 canonical Card/published relation/mastery：0；
- 若启用 workspace/扩展 Should flag，错误 support mode、越权 workspace 结果和 unsupported segment 使用来源标签：0。*（原文 §16 补充）*

## 5. 产品与价值观指标（§16.4）

### 5.1 观察但不作为强迫优化目标

- 首次引导的开始、跳过、暂停、恢复和主动重播分布，以及引导后用户独立完成第一个有意义动作的比例；
- 各 route/page kind 的主动召唤、建议采纳/忽略、立即隐藏和使用手动 fallback 的分布；
- 无键盘完成的 Session 占比；
- 用户选择语音、触控、文字和混合模态的分布；
- 伴星安静/适度/主动设置分布和关闭率；
- 路线主动停止、缩短、换一组和完成比例；
- 问题标记保存、解决和丢弃比例（Should flag 启用时）；
- 后续独立 recall、修补后同类 rubric 缺失率、迁移任务成功率；
- Grounded Tutor 回答有帮助/没帮助的显式反馈；
- ASR not-assessable 和模态切换率。

### 5.2 只观察、不得用于授权强迫优化

onboarding 完成率、伴星打开时长、对话轮数、留存、DAU、学习时长和完成数量只能作为观察指标，不能授权隐藏跳过、增加弹窗、streak、任务债务、自动续题或伴侣催促。

### 5.3 自主性硬 Gate（全部 0 容忍；原文 §16.4 硬 Gate 清单逐一冻结）

1. `temporary_hidden` 本地生效/runtime-fence 确认后，当前 device session 的页面 context listener/DTO、角色/声音/应用内邀请/预取与新增 Companion 调用：0；`global_off` CAS 后所有设备上述活动及 Companion 系统通知：0；可取消调用未取消或迟到结果被采用：0；
2. `global_off` account epoch 向 active devices 传播超过 W0 SLA、旧 lease 到期后仍挂载/调用、或 CAS 失败却显示全局成功：0；
3. account global off 用户在新设备认证后、开关状态解析前挂载 observer/context/角色或发 Companion 调用：0；
4. 任意 `sensitivity=credential` 页的输入值及字段焦点/长度/粘贴/自动填充/时序元数据进入 Companion DTO、日志、analytics、截图、模型或持久上下文：0；该页 LLM/ASR/TTS、个性化预取与 DOM/selection observer：0；
5. `global_companion_shell` 启用且 surface 未命中 auth-local hide/temporary hidden/global off 时，registry 中可交互 route 的有效 manifest 与规定召唤入口覆盖率：100%；隐藏/关闭时只要求恢复入口可达；伴星故障时同页面手动主路径可完成率：100%；
6. onboarding `offerStatus=offered` 后第二次自动展示：0；consumed 后同版本由系统自动邀请或自动重放：0；用户主动跳过所需动作数：1；终态被刷新、重登、旧 CAS 或跨设备回退次数：0；用户主动 manual replay 不计为违规；
7. `quiet` 下除新注册 consent surface 外的主动提示：0；`page_muted/page_context_off/focus_until_task_end/suggestion_paused/suppressedSuggestionClassIds` 命中的越界提示：0；
8. `quiet` 未召唤时 entity/selection observer、完整 `PageCompanionContextV1` 构造/传输和 idle 动画：0；moderate/active 在 permit + 用户接受前传输 visible/selected entity refs 或页面内容：0；
9. stale `pageInstanceId/contextVersion/permissionSnapshotHash` 成功执行 action：0；跨 workspace context/entity 泄漏：0；
10. 当前页面上下文关闭后传入 Companion/Provider 的 entity refs、contextual suggestion/action：0；恢复/接管前暴露未重验 target 名称：0；未接管设备成功提交：0；
11. 未经影响预览、当前 context/permission 重验、有效用户 nonce 与显式确认而成功执行的写入、发布、偏好修改、导出或删除动作：0；Global Shell 直接写领域数据：0；
12. Companion audit/ledger 超过冻结 TTL 仍含 entity ref、用户删除后存储残留、进入增长画像/兴趣推断或跨 workspace analytics：0；导出覆盖率：100%；
13. formal 作答、录音、输入、拖拽、模态框和危险操作期间的内容性主动建议：0；
14. 同一 `contextBudgetKey` 被消费后页面提示重复次数：0；同一 `reasonBudgetKey` 被消费后同类提示重复次数：0；刷新、重登、选择变化和页面往返重置次数：0；未注册 reason/capability/page/action 产生主动提示：0；
15. 无有效 `CompanionSuggestionPermitV1` 渲染主动提示：0；同一用户并发 active suggestion 数 >1：0；非 canonical 实质变化推进 `targetChangeEpoch`：0；
16. 自动开启麦克风：0；未 opt-in 通知：0；
17. `later / dismiss / stop` 修改 schedule、偏好、理解状态或制造负向记录：0；
18. 用户主动停止成功率：100%；完成后自动进入下一题/路线：0；
19. 主动邀请导致的关闭/打断率达到 W0 冻结停止阈值时，停止扩量并回退该邀请策略。

## 6. 体验与性能 Gate（§16.5）

- 本地 companion action 从 pointer/key event handler 开始到下一帧视觉 commit，p95 < 100ms；不含网络或 Provider；
- 已收到且缓存合法 Session plan 后，从 Scene state transition 到首个可交互帧，p95 < 300ms；不含网络或 Provider；
- Global Shell、auth-surface manifest 和安静锚点不得阻塞认证或页面主内容；新增 JS/渲染/路由 p95 预算及移动端内存上限在 W0 相对基线冻结，超限时优先降级角色而不是延迟主页面；
- Provider/ASR 阶段有真实进度、取消与恢复；
- 1,000 节点下星图帧率不低于 W0 基线；
- 390/768/1440、200% zoom、键盘、读屏、reduced-motion 主路径通过；
- 麦克风拒绝、ASR 失败、无动画和无 Canvas 精细操作均有可完成路径。*（原文 §16 补充）*

**性能数据采集要求**：性能数据必须在 W0 指定的 Chrome stable、桌面参考机和中档移动设备/节流档位上采集，冷热路径分开，单场景样本量至少 100；RC 报告记录硬件、浏览器、构建、数据 fixture、网络条件和区间，不允许用开发机平均值替代 p95。*（RC 报告与禁止替代 p95 为原文 §16 补充）*

## 7. 成本与调用放大 Gate（§16.6）

- W0 用真实 Provider 冻结每 Episode/Session 的 LLM 调用、输入/输出 token、ASR 秒数、TTS 字符、对象存储和 current-target Tutor 独立预算，以及用户级 p50/p95 成本；
- PREPARE 创建不可借用的 `BudgetEnvelope`；展示首个 formal Scene 前预留全部 required probes、一次允许的重录/结构修正上限、Assessment Critic 重试与 commit 所需额度；workspace/user 余额不足在作答前以非惩罚方式拒绝；*（余额非惩罚拒绝为原文 §16 补充）*
- 已锁答案使用预留额度完成评估；Provider 故障进入有 W0 冻结 SLA 的 recovery queue，不能因后续预算耗尽永久卡在 retryable；超出 SLA 后以 operational failure 结束且 0 学习副作用；*（不得因预算耗尽卡死在 retryable 为原文 §16 补充）*
- Tutor detour 使用独立 envelope，不能借用 formal reserve；重录、多 Scene 和澄清分别按 contract 上限扣账，Agent 无权提高；*（独立 envelope 细则为原文 §16 补充）*
- 同一 provider/job attempt 的重复计费调用：0；重试放大系数上限在 W0 冻结并由 RC 故障注入验证；*（重试放大系数为原文 §16 补充）*
- 用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用：0；
- `temporary_hidden/global_off` 确认后的新增 Companion 成本：0；Tutor 不得消耗或借用 formal assessment 预算；*（Tutor 预算隔离为原文 §16 补充）*
- 公开认证层、安静锚点和未触发的页面 context 注册产生的 LLM/ASR/TTS 调用与 Provider 成本：0；
- 任一 p95 成本或调用数越过冻结上限即停止扩量，不能靠缩减 Critic、证据或 A11y 绕过。*（不得以缩减质量项绕过为原文 §16 补充）*

## 8. 验收标准

- 全部阈值与样本量、SLA、置信区间在 W0 冻结，并在看到 RC 结果前不变；
- 本记录即为 W8/W9 的验收基准；W8/W9 按本记录中的 §16.1–§16.6 逐项验收。

## 9. 补全说明（相对源文档任务 01-5 摘录）

以下内容为源文档摘录未列出、按原方案 §16 补全的必冻结阈值（均已写入上文对应小节并标注）：

- §16.2：模态间只比较相同 facet，不要求单个排序 Scene 与开放讲解提供相同信息量；redacted 评估 tombstone/outcome/policy refs 可追溯率 100% 且 excerpt 必须已删除。
- §16.3：启用 workspace/扩展 Should flag 时，错误 support mode、越权 workspace 结果和 unsupported segment 使用来源标签：0。
- §16.4：自主性硬 Gate 完整清单（摘录仅概括为「全部 0 容忍」），共 19 项逐条冻结，详见 §5.3。
- §16.5：麦克风拒绝、ASR 失败、无动画和无 Canvas 精细操作均有可完成路径；预算超限优先降级角色而不是延迟主页面；RC 报告记录硬件/浏览器/构建/data fixture/网络条件/区间，禁止用开发机平均值替代 p95。
- §16.6：workspace/user 余额不足在作答前以非惩罚方式拒绝；recovery queue 不得因预算耗尽永久卡在 retryable；Tutor detour 独立 envelope 不得借用 formal reserve 且重录/多 Scene/澄清按 contract 上限扣账、Agent 无权提高；重试放大系数上限 W0 冻结并由 RC 故障注入验证；Tutor 不得消耗或借用 formal assessment 预算；停止扩量不能靠缩减 Critic、证据或 A11y 绕过。

> 全部阈值以本冻结记录与「项目知识/原方案 §16」为准；如后续任何工作文档与本文不一致，以本文（冻结）为准。
