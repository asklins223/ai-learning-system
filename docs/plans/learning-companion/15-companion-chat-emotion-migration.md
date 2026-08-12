# 桌宠对话/聊天体验迁移方案（15 号）

> 状态：**调研与方案整理中，实施暂停待确认**
> 关联：13-desktop-pet-ai-learning-companion-reconstruction.md（桌宠重构总方案）、desktop-pet-handoff/03（对话合同）
> 参考项目：reference-projects/learning-companion/repos/ 下 6 个项目

---

## 1. 背景与目标

用户反馈：live2d 桌宠的**对话和聊天仍不尽人意**，要求吸收 reference 项目中成熟的做法，完善桌宠对话/聊天实际体验。

本文件先给出：参考项目成熟技术清单 → 当前项目差距 → 迁移方案设计 → 已落地改动（待确认） → 待办。

---

## 2. 参考项目调研结论（核心可迁移技术）

### 2.1 EchoBot（MIT）— Decision → Roleplay → Agent 三层架构

- **决策层**：正则规则优先 + LLM 兜底（temperature=0、历史截断 6 条），输出 `{route: chat|agent}`；
- **Roleplay 层**：轻量、禁工具、只看干净对话上下文（历史 12 条），快速自然回复，**人设不崩**；
- **Agent 层**：后台执行慢任务，角色先发"我去看看"式短确认（不虚假承诺），完成后用真实结果"转译"回话术；
- **场景指令**：direct_chat / delegated_ack / agent_result_presentation 多套人设化转译指令；
- **角色卡**：纯 Markdown（`# 角色名` + `## 人设` + `## 回复风格` + `## 细节偏好`），整体作为 system message。

### 2.2 MoeChat（GPLv3，仅洁净室参考）— 上下文注入 + 情绪引擎 + 记忆

- **上下文组织**：system prompt 模板（演员指令+角色设定+性格+文风示例）→ **并行检索**（情绪引擎+世界书+长时记忆+核心记忆）→ 拼成一条 user 消息注入；
- **情绪引擎**：三态状态机（NORMAL/MELTDOWN/RECOVERING）+ valence/arousal 2D 模型 → **9 宫格情绪指令**注入 user 消息开头，影响回复语气；
- **情感影响 TTS**：回复带 `[情绪标签]` → 切换不同参考音频；
- **长时记忆**：按天 jsonl + **模糊时间表达式检索**（"昨天/上周"→时间区间→bisect）+ 向量相似度过滤；
- **消息级特效**：关键词匹配触发爱心/雨雪粒子/emoji 等。

### 2.3 soullink-emotion-sdk（MIT）— 情绪表现引擎（最可迁移）

- **VAD 情绪状态机**（`EmotionStateController`）：baseline/target/current 三向量 + nudge + **指数逼近 + 衰减 + ambientDrift + 情绪保持时间**——纯 TS 零依赖；
- **情绪→表情参数表**（`EmotionArchetypeRegistry` + `standardParamTable`）：emotion×variant→参数范围 [min,max]、FACSKey→Live2D ParamId/scale，纯数据驱动；
- **五层 FACS 混合**（`MotionMixer`/`LayeredParameterMixer`）：idle/emotion/reaction/speech/manual 分层叠加、状态相关权重、attack/release 平滑——解决"表情打架"；
- **本地兜底链**：LLM 挂了 → 正则分类 + per-emotion 动作节拍 + per-emotion 回复文案（角色永不"死机"）；
- **口型独占 mouthOpen + 语音重音微动**；
- **本地中文正则分类器**（`MessageReactionClassifier`）：消息→emotion/intensity，零 LLM。

### 2.4 airi（MIT）— 对话 pacing 与流式控制标记

- **流式控制标记** `<|ACT {...}|>` / `<|DELAY:n|>`：纯文本流里嵌动作/pacing 指令，parser 分离 literal（喂 TTS）与 special（喂表情/延迟）；
- **思维/发言分离**：`<think>` 过滤，speech 进 TTS；
- **上下文分桶 + 扁平渲染**（bullet 而非 XML）；
- **主动发言/打断协议**：`interrupt: soft|force` + `priority` 队列语义。

### 2.5 其余两个项目

- **Meochat-APP（GPLv3，仅架构参考）**：透明像素穿透、播放协调器排序文本/音频/动作；
- **see-through（Apache-2.0）**：离线原画分层工具候选，仅资产流水线，不做运行时依赖。

---

## 3. 当前项目差距分析

对照方案 13 的规划，当前（2026-08-12 工作区）实施状态：

| 维度 | 方案 13 规划 | 当前状态 | 差距 |
| --- | --- | --- | --- |
| 对话流式 | SSE 真流式 + durable cursor | ✅ 已实现（worker 256-unit/50ms 写库） | — |
| Dialogue Router 三态 | casual/learning_question/learning_action | ✅ 已实现（worker 侧 classifier，冻结 prompt） | — |
| grounded-tutor 分支 | 受限证据回答 | ✅ 已实现 | — |
| **character.cue 契约** | §9.6 高层 cue：intent/emotion/intensity | ⚠️ **契约已定义但服务端从不发送、前端从不消费** | **未接线（核心差距）** |
| **情绪驱动表现** | LLM 只给 emotion/intent，本地 VAD/FACS 落地 | ❌ 前端只有确定性 presentation 状态机（listen/think/speak…），无 emotion 维度 | **缺失** |
| 回复情感 | soullink 本地分类器思路 | ❌ 无 | **缺失** |
| 对话记忆 | MVP 最近 20 条（不做长期人格记忆） | ✅ 最近 20 条/12k chars | 按方案保持 |
| 主动发言 | 有 proactive 服务 | ✅ companion-proactive-service 已存在 | — |
| 句子级 TTS | MoeChat 思路 | ✅ tts-segments 已实现 | — |

**结论**：方案 13 早就把参考项目的迁移边界写清楚了，其中「情绪驱动的角色表现」（cue 下发 + 本地分类 + VAD + 参数映射）是方案明确规划、合同 wire schema 已冻结、但**整条链路未接线**的部分——这正是"对话聊天不尽人意"最直接的原因：角色回复时表情是死板的（只有 think/speak 等粗粒度投影），没有情绪起伏。

---

## 4. 迁移方案设计（遵循方案 13 / 03 合同边界）

### 4.1 服务端（worker 已改，待确认）

在 `companion-dialogue` 对话 run 生命周期内，同事务下发 `character.cue` 事件（wire schema 已冻结，§4.4）：

| 时机 | cue（intent/emotion/intensity） | 依据 |
| --- | --- | --- |
| 阶段 2a（thinking） | think / curious / 0.35 | 03 合同 §5.2 确定性来源 |
| 终态事务（final） | explain / **本地分类器 emotion**（happy/surprised/curious/concerned，回落 neutral/0.30） | P4 bounded cue classifier 思路，**零 LLM 调用**，soullink MessageReactionClassifier 迁移 |
| markCompanionRunFailed（error） | uncertain / concerned / 0.45 | 03 合同 §5.2 确定性来源 |

- 不采用：第二次 LLM 调用猜情绪、从用户可见正文解析隐藏标签（合同禁止）；
- 事件顺序调整：thinking 时 status+1 个 seq；final 时 final→segments→cue→(action.proposed)；error 时 error→cue。

### 4.2 前端（仅改了类型/映射，reducer 与表现层未完成）

1. SSE `character.cue` → reducer 新 `emotion` 域（保存最近 cue + generation 守卫，防 global off 后旧 run 迟到 cue 污染）；
2. **VAD 情绪状态机**（新文件 `emotion-vad.ts`，soullink EmotionStateController 迁移）：baseline/target/current、指数逼近、静默衰减、情绪保持；
3. **emotion→Live2D 参数映射表**（新文件 `emotion-expression-map.ts`，soullink EmotionArchetypeRegistry 迁移）：适配 Mao PRO 现有参数（ParamBrowLY/RY、ParamEyeLSmile/RSmile、ParamCheek、ParamMouthUp/Down…）；
4. 接入现有分层参数系统（`live2d-parameter-frames.ts` 的 facs 层按 emotion 驱动，保留 presentation 兜底）。

### 4.3 明确不迁移（方案 13 已裁定或成本/风险不成比例）

- 长期人格记忆自动抽取（方案 7.7 MVP 明确不做，隐私优先）；
- 消息级特效/表情包（MoeChat 关键词特效，锦上添花，本次不做）；
- 多渲染器、插件平台（airi，方案明确不做）；
- 任意系统文件/shell 权限（EchoBot agent 能力，方案明确不做）；
- persona prompt 升版（companion-persona-v1 逐字冻结，升版需全量 persona regression，风险高，先不动）。

---

## 5. 已落地改动清单（本次会话，未提交，均可回滚）

| 文件 | 改动 | 状态 |
| --- | --- | --- |
| `packages/shared/src/companion-emotion-classifier.ts` | 新增：本地情感分类器（soullink 迁移，含否定前缀抵消/强度 clamp） | ✅ 10/10 测试通过 |
| `packages/shared/src/companion-emotion-classifier.test.ts` | 新增：10 条单测 | ✅ 通过 |
| `packages/shared/src/index.ts` | +1 行导出 | ✅ |
| `workers/ai-worker/src/handlers/companion-dialogue.ts` | 三处同事务下发 character.cue（thinking/final/error）+ insertStreamEvent 辅助 | ✅ typecheck 通过 |
| `workers/ai-worker/src/handlers/companion-dialogue.test.ts` | +3 条单测（buildFinalCuePayload/常量） | ✅ 12/12 通过 |
| `apps/web/features/companion-pet/conversation/companion-chat-client.ts` | SSE 映射加 character.cue case（wire schema 校验） | ✅ 未跑前端测试 |
| `apps/web/features/companion-pet/runtime/pet-runtime-types.ts` | 新增 emotion 域 + character.cue 事件类型 | ✅ |
| `workers/ai-worker/node_modules/@ailearn/shared/src/*` | 同步 install-links 拷贝（新文件+导出） | ✅（不进 git） |

### 未完成（被打断，尚未动手）

1. `pet-reducer.ts`：处理 character.cue（generation 守卫 + 更新 emotion 域）；
2. `emotion-vad.ts`：VAD 情绪状态机（新文件）；
3. `emotion-expression-map.ts`：emotion→参数映射（新文件）；
4. `live2d-parameter-frames.ts`：facs 层按 emotion 驱动；
5. `PetRuntimeProvider`：确认 SSE 分发链路（client 已映射，provider 的 onDispatch 是通用转发，大概率无需改）；
6. 前端相关测试。

---

## 6. 待确认问题（等你拍板）

1. **范围**：是否按上述「情绪驱动表现层」方向继续完成？（我认为这是最能直接改善"对话聊天体验"且方案内、风险低的一块）
2. **是否补充对话内容质量**：可选项包括 persona 升版（成本高）、上下文注入情绪/时间信息（成本中），是否本轮一并做？
3. **已改的代码**：保留继续，还是先回滚？

---

## 7. 风险与回滚

- 已改代码均为增量/新文件，未触碰历史遗留改动；回滚只需 `git checkout` 本次涉及文件（不含 node_modules 拷贝）；
- 事件 seq 布局变更影响 integration test（需 postgres 环境验证，本地未跑）；
- cue 为表现层建议，reducer 有 generation/accountEpoch 守卫，极端失败也不影响对话正文（fail-closed 到确定性投影）。
