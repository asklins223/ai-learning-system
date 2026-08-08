# W3 证据：语音管线、Response Artifact 与独立评估

> 对应任务 11-2 证据文件 5。佐证 DoD 15、16、18、27。
> 决策记录：`docs/plans/learning-companion/04-w3-voice-artifact-assessment.md`（任务 04-1~04-6）与 `04-1-voice-pipeline.md` ~ `04-6-alternative-inputs-a11y.md`。
> 状态：**Frozen** ｜ 执行：阶段 11 / W11 任务 11-2 ｜ 日期：2026-08-08

## 1. 实现文件核验（路径存在）

| 单元 | 路径 | 对应任务 |
| --- | --- | --- |
| voice-service | `apps/api/src/modules/learning-sessions/voice-service.ts`（+ `voice-service.test.ts`） | 04-1 |
| voice artifact 契约 | `packages/shared/src/voice-artifact-contracts.ts` | 04-2 |
| redaction-service | `apps/api/src/modules/learning-sessions/redaction-service.ts`（+ `redaction-service.test.ts`） | 04-5 |
| trust-service | `apps/api/src/modules/learning-sessions/trust-service.ts`（+ `trust-service.test.ts`，详见 `w2` 证据 §3） | 04-3 |
| assessment-critic | `workers/ai-worker/src/learning-agent/roles/assessment-critic.ts`（+ `assessment-critic.test.ts`） | 04-4 |
| grounded-tutor | `workers/ai-worker/src/learning-agent/roles/grounded-tutor.ts`（+ `grounded-tutor.test.ts`） | 04-6/07-7 |
| grounded-answer-critic | `workers/ai-worker/src/learning-agent/roles/grounded-answer-critic.ts`（+ `grounded-answer-critic.test.ts`） | 07-7 |

## 2. 语音 trusted 主路径（04-1，佐证 DoD 15、16）

- TTS 只原样朗读净化题面（固定审核 voice/profile，不接受模型生成的 SSML/远程音频 URL/隐藏提示）；ASR 生成逐字 transcript，用户可播放、确认、重录或切换模态；Agent 不自动润色、概括或补全。
- 用户确认的逐字 transcript 是 voice artifact 的 canonical answer；重录确认仍为 voice revision，手工修正创建 `text_or_mixed` revision（`supersedesArtifactId` 保留来源）；两者服从同一 lock、stale、assistance 与删除规则（佐证 DoD 16 的 transcript 确认语义）。
- 口音/流利度/语速/停顿/音量不进入理解判定；关键术语低置信返回 `not_assessable`，不猜测（ASR 不可靠时 100% fail closed）。

## 3. Artifact 治理与 evidence 绑定（04-2/04-4，佐证 DoD 18）

- `voice-artifact-contracts.ts`：voice/text_or_mixed payload、FrozenProbe hash 绑定（逐 hash 匹配 Episode 的 `FrozenProbeRef`，仅 version 而无 private solution/safety hash 不足以进入评估）、raw audio 短 TTL 加密 transient（丢失/到期不降低既有 trust）、ASR provider/model/version/language/confidence 记录；Provider 不满足 workspace policy 时语音 fail closed。
- Assessment Critic（独立 Agent Session、独立 system policy/模型快照，不继承 Supervisor 自由文本判断）：每个 verdict 绑定 Response Artifact、真实 answer excerpt/interaction refs、evidence refs；evidence refs 必须是 RubricTarget 预绑定 evidenceRefIds 子集；unknown/duplicate/missing/伪造引用全部 fail closed；不返回总体 outcome、mastery、interval 或共享图关系真值（佐证 DoD 18）。

## 4. redaction 与两级 replay（04-5，佐证 DoD 16）

- `redaction-service.ts` 实现状态机 `capturing → transcribed → awaiting_confirmation → locked | superseded | stale`、`locked → redacted`（append-only tombstone，不可恢复为 locked）；删除将 artifact 标为 redacted，不再宣称可完整语义重审。
- 级联 redaction 覆盖 artifact transcript/segments/hash、assessment `answerExcerpt`、复述用户答案的 Critic rationale、Tutor/Critic job payload、retry payload、对象引用与 cache；删除后对数据库/对象存储/队列/cache 做残留扫描；仅保留 content-free tombstone/outcome refs（佐证 DoD 16、18）。
- 两级 replay：canonical event/assessment 可确定性重放既有 outcome 与投影；只有未 redacted artifact 才能被新版 Critic semantic re-audit；用户删除写 compensating invalidation event，不改写历史事件，official scheduler 同事务 supersede/cancel 派生 schedule。

## 5. 替代输入与降级（04-6，佐证 DoD 15）

- 所有支持 voice 的 Key Point 有零打字 canonical 路径；所有 Key Point 有 `text_or_mixed` fallback；profile-eligible 目标另有 `structured-proof-v1`（同级别 canonical outcome 资格，不合格目标不展示 silent mastery 路线、不以选择题换皮冒充等价）。
- 麦克风拒绝后可进入 text 或 eligibility 合格的 structured proof，无操作死路；无倒计时评分、无操作速度评分；键盘/读屏可完成同等主路径。

## 6. 判定层证据

- 决策记录 `04-1`~`04-6` 头部状态均为 **Frozen（已冻结）**；阶段 04 退出 Gate 4 项全部勾选（语音 trusted 路径完整、ASR 不可靠 100% fail closed、全复制面 redaction 与两级 replay 通过、替代入口交付）。
- 阶段 04 执行记录：apps/api 1661/1661、packages/shared 374/374、packages/db 5/5、worker critic 25/25、web typecheck/eslint 通过；security_review 1 轮 warn（2 HIGH/1 MEDIUM/2 LOW）→ 修复后复查 **pass**（FrozenProbe 无来源绑定、content-hash 单一来源、matcher 参数化等全部修复）。
- Grounded Tutor / Grounded Answer Critic 的 supported-segment filter 与 abstain 语义完整验收见 `w6` 证据（07-7，佐证 DoD 27）。
