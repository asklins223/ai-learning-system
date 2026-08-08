# 阶段 08（W7）：跨模块 A11y、安全、隐私与可观测性审计

> **第一层执行顺序第 8 步**
> 前置：阶段 07（W6 全局伴星）
> 后置：阶段 09（W8 质量与 RC）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W7」；规范依据：§13（安全/隐私/A11y/可靠性）、§17.2（故障矩阵）、§16.4（产品价值观指标）、§5.4.5（抑制规则）。

---

## 本阶段目标

对 W1~W6 已同步实现的三档存在感、全部控制/抑制状态、显式偏好、A11y、安全和隐私做跨模块审计，建立可观测性与 runbook，为 RC 做准备。

## 可并行执行的任务（第二层）

### 任务 08-1：A11y 与 onboarding 审计（§13.4）

**交付物**：onboarding 跳过/恢复/重播、页面焦点与读屏、credential-safe、stale page action、跨 workspace 清空和 all-pages manual fallback E2E；语音/无语音/键盘/读屏/reduced-motion E2E。

**任务内容（原文 §13.4，W7 bullet）**：

- 首次引导的"跳过"在每一步都是视觉、键盘和读屏同级动作；引导可返回、暂停、恢复和主动重播，不用会困住焦点的 tooltip 链；
- 伴星锚点、当前上下文、建议原因、忙碌/退场和页面 action 均有语义标签；关闭面板后焦点回到原触发位置，live region 只播报必要状态；
- onboarding tooltip/侧板焦点不陷阱、跳过一级动作、关闭后焦点返回、读屏 live region、200% zoom 与 390 px 不遮挡；
- 所有拖拽有 tap-select-place、键盘和 Switch 等价操作；screen reader 可理解节点、关系、路线、Scene 和结果；颜色、空间位置和动画不是唯一信息载体；触控目标至少 44×44 CSS px；200% zoom 不丢功能；390/768/1440 三视口无主路径阻断；reduced-motion 完整支持；语音输出默认不自动播放；无倒计时评分、无操作速度评分；
- 角色状态与真实 Session/assessment/commit 状态的一致性审计（动画不得伪装评估进度或 canonical 结果）。

**验收**：WCAG 2.2 AA serious/critical 为 0；硬偏好违反为 0。

---

### 任务 08-2：安全与隐私审计（§13.1/§13.3）

**交付物**：prompt injection、跨租户、DOM/prefetch、并发 assistance 审计；credential 零采集复核。

**任务内容（原文 §13.1/§13.3，W7 bullet）**：

- trusted 提交前前台 Companion DTO、RSC/hydration、prefetch、cache 和 DOM 零 private contract 字段/完整 claim 结论/secret solution/正确映射/distractor 身份/hidden rubric/expected target/private evidence/历史正确答案/内部 gap verdict/Tutor 提示（§13.1，DOM Gold 同时校验 public allowlist 与 private denylist）；
- credential 页零采集复核：输入值及字段焦点/长度/粘贴/自动填充/时序元数据进入 Companion DTO、RSC/hydration/cache、analytics、日志、模型请求、截图或持久上下文必须为 0；公开帮助只读页面类型与防枚举归一化错误码；
- `PageCompanionContextV1`、页面 manifest 和 action token 的 schema、版本、签名/来源、workspace、permission snapshot、contextVersion 与 allowlist 校验；页面切换后 stale action fail closed；
- workspace/角色切换原子清空全局任务上下文；跨 workspace entity refs、onboarding resumeRef 和邀请 key 不得复用；
- prompt injection、伪 evidence/node/token/option ID、跨版本引用、音频替换和 replay 攻击 fail closed；drag/order/scenario payload 校验 allowlisted IDs、数量、版本和 hash；semantic relation candidate 不能通过回答接口变成 published；
- `temporary_hidden/global_off` 后零监听/零调用复核（observer/context DTO/角色/邀请/声音/预取/新增 Companion job；`global_off` 还要求全部设备 lease 失效、系统通知和跨设备调用为 0；可取消调用取消、迟到结果丢弃）。

**验收**：所有攻击面对抗集通过；硬偏好违反为 0。

---

### 任务 08-3：故障矩阵演练（§17.2）

**交付物**：按故障矩阵逐项演练并记录结果。

**任务内容（原文 §17.2 表格，W7 bullet）**：

| 故障 | 预期行为 |
| --- | --- |
| Global Shell/角色资源失败 | 页面、认证和全部手动功能先加载；降级为静态帮助或完全不显示，不阻塞主任务 |
| auth-surface manifest 无效 | fail closed 为无伴星的标准认证页；不得改用模型生成帮助或读取表单 |
| page context/action token stale | 拒绝动作，刷新净化上下文；未保存内容、workspace 和权限状态不被绕过 |
| onboarding 中断/登录过期 | 保存已确认步骤；重新认证后只用 scoped token + revision CAS 从合法 step/origin 恢复，offer consumed 不回退或被系统主动重放 |
| 多设备同时恢复同一 Session | 后进入设备明确选择接管或只读；未接管设备不能提交 |
| hidden/off 后 Companion late response | 丢弃且不渲染、不写状态、不触发后续 job；必要的 locked formal core 只按原 contract 完成 |
| ASR timeout/low confidence | transcript 未确认，`not_assessable`；允许重录/换模态，无理解副作用 |
| Session Supervisor crash | 从 contract/probe/artifact/event 恢复，不重做已锁输入 |
| Critic unavailable | `evaluation_retryable`，不由 Supervisor 替代 |
| formal budget unavailable before start | 不展示 Scene、不收回答，给出非惩罚稍后/换 practice 路径 |
| budget/Provider incident after answer lock | 使用预留 envelope 或进入有 SLA 的 recovery queue；超时 operational-only，0 学习副作用 |
| Grounded Tutor unavailable | trusted 主链仍可完成，额外问题可稍后恢复 |
| duplicate tool/response | artifact 与副作用 exactly-once |
| Card/Key Point/Evidence 更新 | 对应未提交 Episode stale，保留历史，无 mastery/schedule 写入 |
| cancel/断线 | 持久化事件恢复，不重复 Provider 和 commit |
| raw audio storage failure | transcript 确认前停止 voice lock，可重录或走 silent bundle；确认后 raw audio 丢失不影响 canonical transcript/outcome |
| vector/retrieval failure | 当前-target Tutor 直接用 published exact evidence；Should 搜索层关闭，不扩大或伪造来源 |
| star overlay failure | 静态路线卡/列表回退，理解内核不受影响 |
| cross-tenant/forged ID | 拒绝并记录安全事件 |
| publish/commit 响应丢失 | 同一 canonical result 和 schedule，0 重复副作用 |
| privacy/trust/scheduler hard incident | bump runtime epoch、fence 全部未 commit Episode、取消未完成外部 job，禁止 trusted 恢复 |
| late result after hard kill | 仅低敏审计摘要，不写可恢复 probe/artifact/assessment staging |

关键 crash、retry、cancel、stale 和并发场景重复执行，hard invariant 必须 100% 通过。

**验收**：故障矩阵全部演练通过并留档；任何 hard invariant 违反进入立即回滚评估。

---

### 任务 08-4：可观测性、指标与 runbook（§16.4/§16.6）

**交付物**：cost/latency/ASR/trust/route/companion 指标、dashboard、alerts、runbook 和 privacy review。

**任务内容（原文 §16.4/§16.6，W7 bullet）**：

- 指标覆盖：首次引导的开始/跳过/暂停/恢复/重播分布与引导后首个有意义动作比例；各 route/page kind 的主动召唤、建议采纳/忽略、立即隐藏、手动 fallback 分布；无键盘完成 Session 占比；模态分布；存在感设置分布与关闭率；路线主动停止/缩短/换一组/完成比例；问题标记保存/解决/丢弃（Should）；后续独立 recall、修补后同类 rubric 缺失率、迁移任务成功率；Tutor 显式反馈；ASR not-assessable 和模态切换率；
- onboarding 完成率、伴星打开时长、对话轮数、留存、DAU、学习时长和完成数量只能作为观察指标，不能授权隐藏跳过、增加弹窗、streak、任务债务、自动续题或伴侣催促；
- 成本与调用放大监控：每 Episode/Session 的 LLM 调用、token、ASR 秒数、TTS 字符、对象存储和 Tutor 独立预算；用户级 p50/p95 成本；重试放大系数；hidden/off 后新增成本为 0；
- dashboard、alerts、runbook 和 privacy review（audit/ledger TTL、entity-bearing 数据清理、导出/删除与残留扫描）。

**验收**：dashboard/alerts/runbook 可用；观察指标与硬 Gate 分离清晰。

---

### 任务 08-5：全链路 E2E（§16.4/§17.1 子集）

**交付物**：语音/无语音/键盘/读屏/reduced-motion E2E，以及角色状态与真实 Session/assessment/commit 状态的一致性。

**任务内容（原文 §16.4 硬 Gate + §17.1，W7 bullet）**：

- `temporary_hidden` 本地生效/runtime-fence 确认后当前 device session 的页面 context listener/DTO、角色/声音/应用内邀请/预取与新增 Companion 调用为 0；`global_off` CAS 后所有设备上述活动及 Companion 系统通知为 0；可取消调用未取消或迟到结果被采用为 0；
- `global_off` account epoch 向 active devices 传播不超过 W0 SLA、旧 lease 到期后不挂载/调用、CAS 失败不显示全局成功；
- account global off 用户在新设备认证后、开关状态解析前不挂载 observer/context/角色或发 Companion 调用；
- 任意 `sensitivity=credential` 页输入值及字段交互元数据零进入；该页 LLM/ASR/TTS、个性化预取与 DOM/selection observer 为 0；
- `quiet` 未召唤时 entity/selection observer、完整 `PageCompanionContextV1` 构造/传输和 idle 动画为 0；moderate/active 在 permit + 用户接受前不传输 visible/selected entity refs 或页面内容；
- 未经影响预览、当前 context/permission 重验、有效用户 nonce 与显式确认而成功执行的写入/发布/偏好修改/导出/删除为 0；Global Shell 直接写领域数据为 0；
- 自动开启麦克风为 0；未 opt-in 通知为 0；`later/dismiss/stop` 修改 schedule/偏好/理解状态或制造负向记录为 0；用户主动停止成功率 100%；完成后自动进入下一题/路线为 0；
- onboarding `offerStatus=offered` 后第二次自动展示为 0；consumed 后同版本系统自动邀请或自动重放为 0；用户主动跳过所需动作数为 1；终态被刷新/重登/旧 CAS/跨设备回退为 0。

**验收**：以上全部为 0 容忍验证通过；E2E 记录留档。

---

## 阶段退出 Gate（08 / W7）

- [x] WCAG 2.2 AA serious/critical 为 0；
- [x] 硬偏好违反为 0（§16.4 自主性硬 Gate 全部 0）；
- [x] 故障矩阵演练全部通过并留档；
- [x] dashboard、alerts、runbook 和 privacy review 完成。

通过后进入阶段 09（W8 质量、容量、故障与真实 Provider RC）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：08-1~08-5 全部实施并签署（审计逻辑/演练/指标/决策记录均落盘）
- 验证：apps/api 2432/2432、packages/shared 374/374、packages/db 5/5、apps/web 750/750、workers typecheck、git diff --check 全部通过
- security_review：1 轮 warn（1 MEDIUM 缺测静默通过 / 4 LOW 空采样 fail closed / replay 时钟偏斜 / 导出自报夸大 / 死代码）→ 修复后复查 **pass**（缺测显式 fail、空采样 fail closed、时钟偏斜判定）
- 承接：阶段 09（W8 质量、容量、故障与真实 Provider RC）
