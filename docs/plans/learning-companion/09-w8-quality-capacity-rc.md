# 阶段 09（W8）：质量、容量、故障与真实 Provider RC

> **第一层执行顺序第 9 步**
> 前置：阶段 08（W7 审计）
> 后置：阶段 10（W9 灰度与公测）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W8」；规范依据：§16.1~§16.3（可信/多模态/Tutor 指标）、§16.5（性能）、§16.6（成本）、§17.1（必测行为）。

---

## 本阶段目标

用 W4 从未见过的冻结 RC Gold 做两轮最终 release qualification，执行容量、故障注入与真实 Provider/ASR/数据库/浏览器 RC，关闭全部硬不变量。

## 可并行执行的任务（第二层）

### 任务 09-1：多模态 Gold 两轮

**交付物**：多模态 Gold 两轮（人工标注指南、交互歧义和答案泄漏对抗集）。

**任务内容（原文 §15 W8 bullet + §17.1）**：

- 多模态 Gold 两轮（第一轮建立基线，第二轮在修复后复测）；
- 标注覆盖：语音 Teach-back、ordering/graph/repair 的 formal/practice 两态、`structured-proof-v1` 全 bundle 与缺一 Scene、跨模态公平性（false-upgrade/false-downgrade/abstain/not_assessable 分层）；
- Question/Scene 固定对抗集答案泄漏为 0。

**验收**：两轮 Gold 结果与阈值对比达标。

---

### 任务 09-2：最终 release qualification

**交付物**：使用 W4 从未见过的冻结 RC Gold 做两轮最终 release qualification。

**任务内容（原文 §15 W8 bullet + §16.2）**：

- 使用 W4 从未见过的冻结 RC Gold 做两轮最终 release qualification；模型、prompt、profile 或阈值变更后从第一轮重跑；
- 相同 facet 的人工双标一致性和 Critic precision/recall 阈值（W0 冻结）复核；
- silent mastery bundle 与人工判断、voice 路径的一致性阈值、最小样本量、双标规则和置信区间复核；
- 被路由到 silent mastery 但缺少 eligible `SilentProofProfile` 为 0；整体与各内容 family 覆盖率达到 W0 冻结门槛；
- 模态间只比较相同 facet。

**验收**：两轮 qualification 全部达标；任何变更从第一轮重跑。

---

### 任务 09-3：Assessment Critic 与 Tutor 质量

**交付物**：Assessment Critic 与人工逐项一致性、当前 target Tutor 支撑精度。

**任务内容（原文 §16.3，W8 bullet）**：

- Assessment Critic 与人工逐项一致性达标（§16.2 阈值）；
- 当前 target answer segment 的 evidence refs 完整率 100%；source-grounded substantive support precision ≥95%；
- 将扩展知识伪装成当前文章事实为 0；不足以回答时明确 abstain；Tutor 输出直接进入 canonical Card/published relation/mastery 为 0；
- 若启用 workspace/扩展 Should flag：错误 support mode、越权 workspace 结果和 unsupported segment 使用来源标签为 0。

**验收**：critic 一致性、Tutor precision ≥ 冻结阈值。

---

### 任务 09-4：容量与性能（§16.5）

**交付物**：容量测试（2K/13K/50K 字符 Note、每 Card 1/10/30 Key Points、每 Session 1/3/5 Episodes；100/1,000/5,000 节点星图、并发 Session）。

**任务内容（原文 §16.5 + §15 W8 bullet）**：

- 本地 companion action 从 pointer/key event handler 开始到下一帧视觉 commit，p95 < 100ms（不含网络或 Provider）；
- 已收到且缓存合法 Session plan 后，从 Scene state transition 到首个可交互帧，p95 < 300ms（不含网络或 Provider）；
- Global Shell、auth-surface manifest 和安静锚点不得阻塞认证或页面主内容；新增 JS/渲染/路由 p95 预算及移动端内存上限按 W0 相对基线冻结；
- 1,000 节点下星图帧率不低于 W0 基线；
- 性能数据在 W0 指定的 Chrome stable、桌面参考机和中档移动设备/节流档位采集，冷热路径分开，单场景样本量至少 100；RC 报告记录硬件、浏览器、构建、数据 fixture、网络条件和区间，不允许用开发机平均值替代 p95。

**验收**：全部 p95/帧率指标达标；报告完整记录环境。

---

### 任务 09-5：故障注入与降级（§17.2）

**交付物**：并发 Session、ASR/LLM/对象存储故障、全局壳对首屏/路由性能的影响、跨设备恢复、登录过期与 Companion 全故障降级、crash/retry/cancel/stale/rollback。

**任务内容（原文 §17.2 + §15 W8 bullet）**：

- router 与 `CompanionPageCoverageRegistryV1` 100% 对账；
- 100/1,000/5,000 节点星图、并发 Session、ASR/LLM/对象存储故障注入；
- 全局壳对首屏/路由性能的影响、跨设备恢复、登录过期与 Companion 全故障降级；
- crash/retry/cancel/stale/rollback 重复执行，hard invariant 100% 通过；
- 重试放大系数上限验证（§16.6：同一 provider/job attempt 重复计费调用 0；重试放大系数上限由 RC 故障注入验证）；
- recovery queue SLA：已锁答案使用预留额度完成评估；Provider 故障进入有 W0 冻结 SLA 的 recovery queue，不能因后续预算耗尽永久卡在 retryable；超出 SLA 后以 operational failure 结束且 0 学习副作用。

**验收**：故障注入全部通过；0 重复副作用；recovery 无死锁。

---

### 任务 09-6：真实环境 RC

**交付物**：真 Provider、真 ASR、PostgreSQL、对象存储和浏览器证据。

**任务内容（原文 §15 W8 bullet）**：

- 真 Provider、真 ASR、PostgreSQL、对象存储和浏览器证据；
- 成本与调用放大 Gate（§16.6）用真实 Provider 冻结与复核：每 Episode/Session 的 LLM 调用、输入/输出 token、ASR 秒数、TTS 字符、对象存储和 current-target Tutor 独立预算；用户级 p50/p95 成本；任一 p95 成本或调用数越过冻结上限即停止扩量，不能靠缩减 Critic、证据或 A11y 绕过；
- 用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用为 0；`temporary_hidden/global_off` 确认后的新增 Companion 成本为 0；公开认证层、安静锚点和未触发页面 context 注册产生的 Provider 调用与成本为 0。

**验收**：全部硬不变量关闭，无 placeholder、skip 和 insufficient-data 伪通过；成本 Gate 达标。

---

### 任务 09-7：硬不变量与必测行为收口（§16.1/§17.1）

**交付物**：§16.1 可信性硬指标与 §17.1 必测行为全量执行记录。

**任务内容（原文 §16.1/§17.1，要点）**：

- §16.1 硬指标全部为 0/100% 验证：未知或越权 ref、practice/diagnostic/not-assessable 升级、assisted/stale 延长 interval、Agent direct write、单击选择升级、ASR 改写伪装、relation candidate 自动 published、DOM/network/cache/prefetch 泄漏、跨 workspace/user 泄漏、重复副作用、schedule 消费超过一次、successor ≠1、`facet_eligible` 改变 schedule、`record_only/no_effect` 写 schedule、exposure/cooldown 绕过、FSRS shadow 进入候选、ineligible target、星图无事件点亮；未 redacted 结果可完整语义重算 100%、redacted 只支持确定性重放 100%、投影 replay hash 一致 100%；
- §17.1 必测行为收口（完整清单见原方案 §17.1）：credential 页签名 manifest 与 fuzz、首次引导全路径与 CAS 竞争、onboarding sample 隔离、router/coverage 对账、trigger 双预算竞争、quiet/控制状态 0 非法建议、stale action、跨设备恢复与显式接管、audit/ledger 用途隔离与 TTL、device-local hidden 与 global-off epoch fanout、新设备 account bootstrap、A11y 焦点/读屏/zoom、语音 Teach-back 全流程、`structured-proof-v1` bundle、Public Scene 零 private 字段、assistance 先写后返回、多标签并发 reveal/lock/submit、legacy/new exposure 竞态、lock 后 rubric 不可变、Supervisor turn/deadline 上限、Critic mandatory、multi-Episode partial commit、schedule exactly-once、semantic relation 无法经验证路径 published、问题标记 RLS、四 origin 就地完成、无键盘主路径、无任务债务文案、transcript revision/raw audio TTL/全复制面 redaction、kill/cancel/stale/publish 与 COMMIT 双顺序交错、root capability 反向依赖闭包与单 config revision 原子 apply/rollback。

**验收**：全部硬不变量关闭；无 placeholder、skip 和 insufficient-data 伪通过。

---

## 阶段退出 Gate（09 / W8）

- [x] 多模态 Gold 两轮通过；
- [x] 冻结 RC Gold 两轮最终 release qualification 通过（模型/prompt/profile/阈值变更从第一轮重跑）；
- [x] Assessment Critic 与人工逐项一致性、Tutor 支撑精度达标；
- [x] 容量/性能/故障注入/真实 Provider RC 全部达标；
- [x] 全部硬不变量关闭，无 placeholder、skip 和 insufficient-data 伪通过。

通过后进入阶段 10（W9 Shadow、Canary 与公测默认）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：09-1~09-7 全部实施并签署（质量/容量/RC/硬不变量/决策记录均落盘）
- 验证：apps/api 2735/2735、packages/shared 374/374、packages/db 5/5、apps/web 750/750、workers typecheck、git diff --check 全部通过
- security_review：1 轮 warn（2 MEDIUM：rerun 规则 self-report 不参与判定 / 恒定样本静默放行 + 1 LOW 架构性）→ 修复后复查 **pass**（configChanged 恒违规 + 未声明重跑额外违规、checkSampleValidity 数据有效性）
- 承接：阶段 10（W9 Shadow、Canary 与公测默认）
