# 阶段 04（W3）：语音、Response Artifact 与独立评估

> **第一层执行顺序第 4 步**
> 前置：阶段 02（W1 Handoff/adapter Gate）与阶段 03（W2 Runtime）
> 后置：阶段 05（W4 Scene Runtime）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W3」；规范依据：§6.5（语音一等输入）、§7.2（Artifact 状态机）、§7.3（Trust）、§7.5（Assessment）、§7.6/§7.7（assistance/stale/cancel）、§13.2（音频与 transcript 治理）。

---

## 本阶段目标

打通语音 trusted 路径与 Response Artifact 管线，让 Independent Assessment Critic 能对冻结 artifact 做逐项 evidence 判定，并保证 ASR 不可靠时 100% fail closed。

## 可并行执行的任务（第二层）

### 任务 04-1：TTS / ASR / transcript 确认 / 重录 / 换模态（§6.5）

**交付物**：TTS 朗读净化题面、ASR 逐字转录、用户播放/确认/重录/切换模态全流程。

**任务内容（原文 §6.5）**：

- TTS 只原样朗读净化题面，不额外给关键词或语气暗示；TTS 只使用审核过的固定 voice/profile 和净化纯文本，不接受模型生成的 SSML、远程音频 URL 或隐藏提示；
- ASR 生成逐字 transcript，用户可播放、确认、重录或切换模态；
- Agent 不能自动润色、概括或补全后再把结果当用户答案；
- 口音、流利度、语速、停顿和音量不进入理解判定；
- 关键术语低置信时返回 `not_assessable`，不能猜测；
- 用户确认的逐字 transcript 是 voice artifact 的 canonical answer；重录确认仍为 voice revision，手工修正则创建 `text_or_mixed` revision；两者都服从同一 lock、stale、assistance 与删除规则；
- 无麦克风、安静环境或言语障碍用户始终可切换 `text_or_mixed` canonical 输入；通过 `structuredProofEligibility` 的目标还可用 `structured-proof-v1` 获得同级 canonical outcome 资格；不合格目标不得展示 silent mastery 路线，更不能以选择题换皮冒充等价。

**验收**：语音 trusted 路径完整；重录/换模态不产生理解副作用。

---

### 任务 04-2：Voice Artifact 与 Provider 数据治理（§7.2 + §13.2）

**交付物**：`voice/text_or_mixed` artifact、FrozenProbe hash binding、raw audio transient policy 与 Provider data governance。

**任务内容（原文 §7.2 模态 payload + §13.2）**：

- `voice` payload：逐字 confirmed transcript、segment timestamps、ASR provider/model/version/language/confidence、可选的短期 audio ref/hash；只有重录后的确认仍属于纯 voice；
- `text_or_mixed` payload：原始文本与 hash；用户手工编辑 ASR transcript 会创建此模态的新 Artifact，并通过 `supersedesArtifactId` 保留来源，不伪装为纯 voice；
- 每个 Artifact 必须逐 hash 匹配 Episode 的 `FrozenProbeRef`；只有 version 没有 private solution/safety hash 不足以进入评估；
- raw audio 只是 ASR 与短期争议窗口所需的 transient 输入，加密、短 TTL、默认不进长期备份；用户确认 transcript 后 raw audio 丢失或到期不降低既有 trust；
- voice artifact 长期保留 transcript、transcript hash、短期 audio hash、ASR provider/model/version/language/confidence 与用户确认时间；audio hash 不能被用来恢复声音；
- ASR/TTS Provider 必须绑定 tenant policy、区域、保留期、训练使用禁令/数据处理合同与 consent version；不满足 workspace policy 时语音能力不可用，并提供 text 或 eligibility 合格的 structured 路径；
- 音频、transcript、题面、答案不进入普通日志、Prometheus label 或 analytics payload；
- 请求必须携带 base revision、public scene hash、user action nonce 和 idempotency key；locked 后迟到 autosave/chunk 一律拒绝。

**验收**：FrozenProbe hash 绑定通过；raw audio 短 TTL 与加密生效；Provider policy 不满足时语音 fail closed。

---

### 任务 04-3：Artifact Trust、EpisodeTrustDecision 与 reducer（§7.2/§7.3/§7.4）

**交付物**：服务端 `effectiveTrustClass` 计算、`EpisodeTrustDecision` 签发、`rubric-session-reducer-v2` 与 `facet-to-mastery-policy-v1` 执行、assistance/stale 检查。

**任务内容（原文 §7.2/§7.3/§7.4，W3 bullet）**：

- Agent 只能请求 `requestedTrustClass`；Scene policy 冻结 `templateTrustCeiling`；服务端在 lock 时根据 disclosure、attempts、assistance、stale 和 integrity 计算单 Artifact 的最保守 `effectiveTrustClass`；客户端和 Agent 均不能提交或覆盖 effective 值；
- 结构化 bundle 的 mastery 资格由服务端签发 `EpisodeTrustDecision`（episodeId、effectiveClass、sourceArtifactIds、frozenProbeSetHash、requiredRubricCoverageHash、bundlePolicyVersion、assistanceSnapshotHash、reasonCodes、decisionHash）；COMMIT 只消费冻结 Artifact 集与 `EpisodeTrustDecision`；单 Scene 的 `facet_eligible` 不会被回写成 `mastery_eligible`；
- `rubric-session-reducer-v2` 先输出 `pass | partial | fail | not_assessable`，再由 validation/review domain adapter 映射到现有 canonical outcome 枚举；`facet-to-mastery-policy-v1` 的 7 条固定规则（见阶段 01 任务 01-2）在此实现；
- `EpisodeTrustDecision` + disposition 矩阵（阶段 01 任务 01-2）是 W5 的输入；
- assistance/stale：`enter-practice/reveal` 与 `confirm-and-lock/submit` 锁同一 learning-unit guard 和当前 probe row（见阶段 02 任务 02-8）；episode target fingerprint 失配 → stale，无正式副作用；
- 多 artifact 只消费 content assistance 前、effective trusted 且 locked 的 bindings；practice artifact 不参与正式归约。

**验收**：trust 只由服务端签发；assisted/stale 结果 0 升级、0 延长 interval；同 artifact 重放 hash 一致。

---

### 任务 04-4：Independent Assessment Critic 逐项 evidence binding（§7.5）

**交付物**：独立 Agent Session 的 Assessment Critic，输出逐项 `RubricAssessment`。

**任务内容（原文 §7.5 + §4.3 INDEPENDENT_ASSESS）**：

- 使用独立 Agent Session、system policy 和模型快照；不继承 Supervisor 的自由文本判断；
- 读取完整锁定 artifact、冻结 rubric target 和 canonical evidence；
- 每个 verdict 绑定 Response Artifact、真实 answer excerpt 或 interaction refs、evidence refs；
- 每个冻结 rubric item 恰好一条最终 assessment；evidence refs 必须是该 RubricTarget 预绑定 evidenceRefIds 的子集；excerpt 必须能从锁定 transcript/text 重建；interaction refs 必须来自 artifact；
- ordering、固定 graph 和 typed repair 优先由 deterministic modality scorer 产生逐项 evidence；仅开放语义、语音和复杂理由交给 Critic；
- unknown、duplicate、missing、伪造引用全部 fail closed；Critic 不返回总体 outcome；runtime Critic 不给自己的 RC Gold 打分；
- 不返回 overall mastery、复习间隔或共享图关系真值。

**验收**：critic 与人工逐项一致性基线建立；越权输出（mastery/interval）为 0。

---

### 任务 04-5：重录/修订、redaction 与两级 replay（§13.2）

**交付物**：重录/手工编辑 revision、全复制面 redaction、ASR 失败/低置信/音频替换和两级 replay 测试。

**任务内容（原文 §13.2 + §7.2 状态机）**：

- 状态机：`Voice Artifact: capturing → transcribed → awaiting_confirmation → locked | superseded | stale`；`locked → redacted`（append-only tombstone，不可恢复为 locked）；
- 重录、手工修正 transcript 或改变结构答案创建新 revision/artifact 并记录 `supersedesArtifactId`，不原地修改已哈希行；`correctionMethod` 明确区分重录与手工编辑；
- 删除 transcript 将 artifact 标为 `redacted`，不能同时宣称该 assessment 仍可做完整语义重审；级联 redaction 覆盖 artifact transcript/segments/hash、assessment `answerExcerpt`、复述用户答案的 Critic rationale、Tutor/Critic job payload、retry payload、对象引用与 cache；
- assessment rationale 默认内容最小化，只存 reason code 和必要的 rubric/evidence ref；删除后对数据库、对象存储、队列与 cache 做内容扫描，用户答案残留为 0；仅保留不含内容的 tombstone ID、删除原因、policy/version 和历史 outcome ref；
- 回放分两级：canonical event/assessment 可确定性重放既有 outcome 与投影；只有未 redacted 的 artifact 才能被新版 Critic 做 semantic re-audit；
- 用户删除对应学习结果：写 compensating invalidation event，不改写历史事件；official scheduler 在同一事务 supersede/cancel 由该结果派生的 current pending schedule，再依据剩余有效事实产生恰好一个 active schedule；UI 在删除前明确展示 raw audio、answer content、learning result 三种删除影响；
- ASR 失败、低置信、音频替换、replay 攻击全部 fail closed（`not_assessable`，可无损重试）。

**验收**：全复制面 redaction 残留扫描为 0；两级 replay 测试通过；ASR 不可靠时 100% not-assessable/fail closed。

---

### 任务 04-6：语音替代输入与 reduced-motion 状态（§13.4）

**交付物**：键盘/读屏替代入口、麦克风拒绝与 reduced-motion 状态。

**任务内容（原文 §13.4，W3 bullet）**：

- 所有支持 voice 的 Key Point 有零打字 canonical 路径；所有 Key Point 有 `text_or_mixed` canonical fallback；profile-eligible 目标另有 `structured-proof-v1`；
- 可暂停、重听、确认 transcript 和切换模态；
- 无倒计时评分、无操作速度评分；
- 麦克风权限拒绝后可进入 text 或 eligibility 合格的 structured proof，不出现操作死路；UI 不把尚未支持的组合伪装成可验证。

**验收**：麦克风拒绝后无操作死路；键盘/读屏可完成同等主路径。

---

## 阶段退出 Gate（04 / W3）

- [x] 语音 trusted 路径完整（TTS → ASR → 确认 → lock → assess）；
- [x] ASR 不可靠时 100% not-assessable/fail closed；
- [x] artifact 全复制面 redaction 与两级 replay 通过；
- [x] 键盘/读屏替代入口、麦克风拒绝与 reduced-motion 状态交付。

通过后进入阶段 05（W4）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：04-1~04-6 全部实施并签署（契约/服务/测试/决策记录均落盘）
- 验证：apps/api 1661/1661、packages/shared 374/374、packages/db 5/5、worker critic 25/25、web typecheck/eslint 通过
- security_review：1 轮 warn（2 HIGH/1 MEDIUM/2 LOW）→ 修复后复查 **pass**（HIGH #1 无来源 FrozenProbe 绑定、HIGH #2 content-hash 单一来源、MEDIUM #3 matcher 参数化、LOW #4 输入校验、LOW #5 客户端 hash 采信）
- 承接：阶段 05（W4 Scene Runtime）
