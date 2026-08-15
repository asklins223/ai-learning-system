# 桌宠对话/聊天体验迁移方案（15 号）

> 状态：**服务端/SSE 链路已实现并提交（commit `7be4ffe`，2026-08-12）；前端情绪表现层（reducer case / VAD / 参数映射 / facs 驱动）待实施**
> 关联：13-desktop-pet-ai-learning-companion-reconstruction.md（桌宠重构总方案）、desktop-pet-handoff/03（对话合同）
> 参考项目：reference-projects/learning-companion/repos/ 下 6 个项目

---

## 1. 背景与目标

用户反馈：live2d 桌宠的**对话和聊天仍不尽人意**，要求吸收 reference 项目中成熟的做法，完善桌宠对话/聊天实际体验。

本文件先给出：参考项目成熟技术清单 → 当前项目差距 → 迁移方案设计 → 已落地改动（已提交 7be4ffe） → 待办。

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
| **character.cue 契约** | §9.6 高层 cue：intent/emotion/intensity | ⚠️ **服务端已同事务下发（thinking/final/error）、SSE 已映射并 wire 校验（提交 7be4ffe），但 reducer 未消费、表现层未落地** | **半接线（表现层缺失）** |
| **情绪驱动表现** | LLM 只给 emotion/intent，本地 VAD/FACS 落地 | ⚠️ 类型/emotion 域已接（提交 7be4ffe），但 VAD 状态机、emotion→参数映射、facs 层驱动未实现 | **表现层缺失** |
| 回复情感 | soullink 本地分类器思路 | ✅ 已实现（`companion-emotion-classifier`，零 LLM，10/10 测试，提交 7be4ffe） | 已消项（待前端消费） |
| 对话记忆 | MVP 最近 20 条（不做长期人格记忆） | ✅ 最近 20 条/12k chars | 按方案保持 |
| 主动发言 | 有 proactive 服务 | ✅ companion-proactive-service 已存在 | — |
| 句子级 TTS | MoeChat 思路 | ✅ tts-segments 已实现 | — |

**结论**：方案 13 早就把参考项目的迁移边界写清楚了，其中「情绪驱动的角色表现」（cue 下发 + 本地分类 + VAD + 参数映射）是方案明确规划、合同 wire schema 已冻结的部分。当前**服务端/SSE 半程已接线并提交（7be4ffe）**，剩余前端表现层（reducer 消费 → VAD → 参数映射 → facs 驱动）未实施——这正是"对话聊天不尽人意"的直接原因：角色回复时表情是死板的（只有 think/speak 等粗粒度投影），没有情绪起伏。

---

## 4. 迁移方案设计（遵循方案 13 / 03 合同边界）

### 4.1 服务端（worker 已改并提交 7be4ffe）

在 `companion-dialogue` 对话 run 生命周期内，同事务下发 `character.cue` 事件（wire schema 已冻结，§4.4）：

| 时机 | cue（intent/emotion/intensity） | 依据 |
| --- | --- | --- |
| 阶段 2a（thinking） | think / curious / 0.35 | 03 合同 §5.2 确定性来源 |
| 终态事务（final） | explain / **本地分类器 emotion**（happy/surprised/curious/concerned，回落 neutral/0.30） | P4 bounded cue classifier 思路，**零 LLM 调用**，soullink MessageReactionClassifier 迁移 |
| markCompanionRunFailed（error） | uncertain / concerned / 0.45 | 03 合同 §5.2 确定性来源 |

- 不采用：第二次 LLM 调用猜情绪、从用户可见正文解析隐藏标签（合同禁止）；
- 事件顺序调整：thinking 时 status+1 个 seq；final 时 final→segments→cue→(action.proposed)；error 时 error→cue。

### 4.2 前端（SSE 映射/类型/reducer 初始域已提交；reducer case 与表现层未实施）

1. SSE `character.cue` → reducer 新 `emotion` 域（保存最近 cue + generation 守卫，防 global off 后旧 run 迟到 cue 污染）——**client 映射与 `PetEmotionStateV1` 已提交（7be4ffe），reducer 的 `case "character.cue"` 待补**；
2. **VAD 情绪状态机**（新文件 `emotion-vad.ts`，soullink EmotionStateController 迁移）：baseline/target/current、指数逼近、静默衰减、情绪保持；
3. **emotion→Live2D 参数映射表**（新文件 `emotion-expression-map.ts`，soullink EmotionArchetypeRegistry 迁移）：适配 Mao PRO 现有参数（ParamBrowLY/RY、ParamEyeLSmile/RSmile、ParamCheek、ParamMouthUp/Down…）；
4. 接入现有分层参数系统（`apps/web/features/companion-pet/character/live2d-parameter-frames.ts` 的 facs 层按 emotion 驱动，保留 presentation 兜底——该文件现有 facs 帧参数与映射表直接对齐）。

### 4.3 明确不迁移（方案 13 已裁定或成本/风险不成比例）

- 长期人格记忆自动抽取（方案 7.7 MVP 明确不做，隐私优先）；
- 消息级特效/表情包（MoeChat 关键词特效，锦上添花，本次不做）；
- 多渲染器、插件平台（airi，方案明确不做）；
- 任意系统文件/shell 权限（EchoBot agent 能力，方案明确不做）；
- persona prompt 升版（companion-persona-v1 逐字冻结，升版需全量 persona regression，风险高，先不动）。

---

## 5. 已落地改动清单（全部已提交 commit `7be4ffe`，2026-08-12）

| 文件 | 改动 | 状态 |
| --- | --- | --- |
| `packages/shared/src/companion-emotion-classifier.ts` | 新增：本地情感分类器（soullink 迁移，含否定前缀抵消/强度 clamp） | ✅ 已提交，10/10 测试通过 |
| `packages/shared/src/companion-emotion-classifier.test.ts` | 新增：10 条单测 | ✅ 已提交 |
| `packages/shared/src/index.ts` | +1 行导出 | ✅ 已提交 |
| `workers/ai-worker/src/handlers/companion-dialogue.ts` | 三处同事务下发 character.cue（thinking/final/error）+ insertStreamEvent 辅助 | ✅ 已提交，typecheck 通过 |
| `workers/ai-worker/src/handlers/companion-dialogue.test.ts` | +3 条单测（buildFinalCuePayload/常量） | ✅ 已提交，12/12 通过 |
| `apps/web/features/companion-pet/conversation/companion-chat-client.ts` | SSE 映射加 character.cue case（wire schema 校验，fail closed） | ✅ 已提交（前端测试当时未跑，实施阶段补） |
| `apps/web/features/companion-pet/runtime/pet-runtime-types.ts` | 新增 emotion 域（`PetEmotionStateV1`：cue + receivedAt）+ character.cue 事件类型 | ✅ 已提交 |
| `apps/web/features/companion-pet/runtime/pet-reducer.ts` | emotion 初始 state（`{ cue: null, receivedAt: 0 }`） | ⚠️ 部分完成：仅初始域，缺 `case "character.cue"` |
| `workers/ai-worker/node_modules/@ailearn/shared/src/*` | 同步 install-links 拷贝（新文件+导出） | ✅ 本地开发环境同步（不进 git） |

### 待办（未实施，按依赖顺序；**2026-08-12 已全部实施并测试，保留为登记**）

1. ✅ `pet-reducer.ts`：`case "character.cue"` 已实施（15a 根因修复时落地：消费 seq + 更新 emotion 域 cue/receivedAt + generation 补全）；
2. ✅ `emotion-vad.ts`：VAD 情绪状态机（新文件 `character/emotion-vad.ts`：target/current、指数逼近、holdMs 静默衰减、情绪保持、minIntensity 归零；7 条单测）；
3. ✅ `emotion-expression-map.ts`：emotion→facs 参数映射（新文件 `character/emotion-expression-map.ts`，覆盖 cue 五类 + 标签控制类精选映射，intensity 缩放，未知→neutral；6 条单测）；
4. ✅ `live2d-parameter-frames.ts`：facs 层按 emotion 驱动（VAD 输出→参数帧，emotion 接管 facs、presentation 兜底；接线：PetSurface 传 state.emotion → PetCharacterCanvas useEffect → Live2DCharacterDriver.pushEmotion → ticker 内 VAD.update；3 条新单测）；
5. ~~`PetRuntimeProvider` 确认分发链路~~ **已确认无需改**：onDispatch 为通用转发（`dispatchRef.current(event)`），character.cue 直接送达 reducer（销项）；
6. ✅ 前端测试：VAD 状态机单测、映射表单测、帧合成 emotion 接管单测（web 全量 1024/1024）；reducer case 已有测试覆盖（15a）。

**2026-08-12 扩展（段级情感接入 VAD）**：voice.segments 的标签 emotion 作为 VAD 第二条输入源——PetRuntimeProvider.dispatch 拦截 voice.segments（segment.emotion）→ 固定强度 0.65 → `onVoiceSegmentEmotion` 订阅（PetRuntimeApiV1 新增）→ PetCharacterCanvas 挂载时订阅 → driver.pushEmotion。至此 cue（轮级）与标签（段级）双路情绪均驱动 Live2D facs。

**2026-08-12 精确化（段级情感改为播放时推送）**：voice.segments 到达时仅记录 segmentId→emotion 映射（不再即时推送），由两条播放路径在段真正开始播放时消费：流式 StreamPlaybackController.onSegmentStart（play 首个 chunk 前）与非流式 pumpRealPlayback（fetch 前）→ pushSegmentEmotionOnPlay → VAD。表情切换与正在朗读的这句话精确同步。

**2026-08-13（引擎兼容）**：情感/富语言标签是 qwen-audio 专属能力——edge-tts 会把标签当文字朗读。标签工具迁移至 packages/shared/voice-expression-tags.ts（worker tts-segments re-export，api 共用）；api 是引擎边界：edge 分支合成前 stripVoiceExpressionTags 净化文本，qwen 分支保留标签；emotion 字段（Live2D 表情）与引擎无关，worker 始终解析下发。

**2026-08-13（全链路诊断：桌宠"蠢"根因）**：tokenrhythm 平台级 + companion 级 disableThinking 导致 deepseek-v4-flash 推理崩塌（实测 9.11 vs 9.9 答错并编造）。已移除两处 disableThinking，config 改 enableThinking: true（全平台恢复思考：对话 + 卡片生成/文本提取/复习编排等学习任务）。真机验证：9.11 vs 9.9 答对（9.9 更大，0.79 差）、鸡兔同笼答对（鸡23兔12）。

**2026-08-13（桌宠四问题修复）**：
1. ✅ 打断/切换对话后无声：streamPlayback fence 的 generation 是 per-conversation 递增——跨对话比较无意义导致新 run 段被丢弃。修复：runId 不同即接管（reducer 的 turn 校验是权威闸门），同 runId 才比较 generation；接管时重置 phase（旧 pump token 失效）。
2. ✅ 文字与朗读不同步：增量切段首段提前触发（TTS_FIRST_SEGMENT_MIN_CHARS=14，不要求完整句），真机验证首段在文字流 8% 时即到达；后续段仍按完整句。
3. ✅ 对话结束气泡不自动关：final 气泡在语音播放结束后"读完即关"（voice 回 idle 后 2 秒 dismiss），无语音路径保持原 autoDismiss。
4. ✅ Live2D 孤立（动作/口型/表情不联动）：**口型根因已修复**——流式播放器创建时未传 `onAudioLevel` → voiceLevel 恒 0 → lipsync 参数不驱动（2026-08-13 修复：`onAudioLevel: onVoiceLevel`）。动作链路核对：think/analyze 映射 mtn_04/special_02（模型 motions 齐全、index 匹配），speak 走 Idle 循环，celebrate/encourage 映射就绪（当前 bubble 无触发源，为未来预留）；表情链路（cue/标签→VAD→facs）已接线。注意：config/ai-platforms.json 为纯 JSON——不得加 // 注释（曾致解析失败 fallback mock）。

### 待办（TTS 表现力二期——2026-08-12 新增；**同日已全部实施并真机验证**，保留为实施登记）

> 来源：用户提供阿里百炼《实时语音合成》文档（指令控制 / 情感与富语言标签 / 连接复用三节），
> 要求完善进现有 qwen TTS 链路（15b 已接线：worker delta 级切段 + api qwen WS 桥接 + 前端流水线播放）。
> 相关文档：`15b-tts-engine-migration.md`（qwen 接入登记）。

1. ✅ **指令控制（高质量声音描述）**：`config/ai-platforms.json` 的 `tts.qwen` 增加 `instruction`（按所选音色 longanlingxi 特质写死：可爱甜美、25 岁女声、语速自然适中、适合轻松陪伴式对话）；`tts-config.ts` 的 `QwenTtsConfig` 加字段；`voice-routes.ts` 传参；`qwen-tts.ts` 的 run-task `parameters` 带上 `instruction`（≤100 字符；qwen-audio-3.0-tts-flash 系统音色支持任意指令）。
2. ✅ **情感与富语言标签（双文本管线）**：
   - worker 维护两条文本流：展示/入库用"剥离标签版"（assistant.delta / assistant.final / companion_messages **零标签**），TTS 切段用"保留标签版"（增量切段输入改为 raw 缓冲，不再直接吃入库文本）；
   - 白名单标签（**全表，2026-08-12 用户拍板**）：控制类 23 个 `[sad] [amazed] [deep and loud shouting] [trembling] [angry] [excited] [sarcastic] [curious] [like dracula] [bored] [tired] [scornful] [shouting] [asmr] [panicked] [mischievously] [empathetic] [whispers] [reluctantly] [crying] [serious] [very slowly] [very fast]` + 富语言类 7 个 `[gasp] [sighing] [clears throat] [giggles] [laughing] [cough] [snorts]`（合计 30 个，文档全表）——只剥离已知标签，不误伤正文 `[重要]` 这类方括号；
   - `companion-persona-v2` 追加标签使用说明（仅自然贴合时嵌入、不堆砌）→ **prompt hash 变更**，需同步冻结测试 + worker 重启；
   - 切段时解析段内最后一个控制类标签 → 段级 `emotion` 字段随 `voice.segment.ready` 下发（wire schema 加可选 `emotion?: string`，向后兼容）；
   - **live2d 协同（预留）**：segment.emotion 与 character.cue 共用一张 emotion→Live2D 映射表（即上文待办 3 的 `emotion-expression-map.ts`），facs 驱动留到 emotion 待办一并做。
3. ✅ **连接复用（api 侧连接池）**：`qwen-tts.ts` 重构为单连接池（maxSize=1，与 `withQwenConcurrencyLimit` 串行语义一致）：task-finished 后归还连接，新任务重新 `run-task`（**每次新 task_id**）；取消（HTTP 流断开 → `finish-task` + `input.directive=cancel` → 等 task-finished）后同样可复用；task-failed / 网络错误 → 关闭连接不归还；空闲 60s 自动断开。效果：连续多轮对话免建连，首包延迟显著降低。
4. ✅ **验证（真机）**：标签剥离 / emotion 解析 / 连接池状态机单测；**真机实测 duplex 模式下标签是否生效**（文档标注"仅支持单向流式模式"——当前每段是单次 continue-task 发整段文本，大概率可用；若不生效，降级为用 instruction 表达情绪）；桌宠连续两轮对话抓 WS 确认连接复用；确认展示/DB 无标签残留。

---

## 6. 待确认问题（等你拍板）

1. **范围**：是否按上述「情绪驱动表现层」方向继续完成 §5 待办？（这是最能直接改善"对话聊天体验"且方案内、风险低的一块）
2. **是否补充对话内容质量**：可选项包括 persona 升版（成本高，需全量 persona regression）、上下文注入情绪/时间信息（成本中），是否本轮一并做？
3. ~~已改的代码：保留还是回滚？~~ 已提交（7be4ffe），**保留继续**；后续改动以增量提交追加。
4. ~~**TTS 标签清单范围**：prompt 中标签表用精选 18 个还是文档全表？~~ **已拍板（2026-08-12）：全表 30 个**（控制类 23 + 富语言类 7），§5 二期第 2 项已按全表更新。

---

## 7. 风险与回滚

- TTS 表现力二期（指令控制 / 情感标签双文本管线 / 连接复用）为增量改动：prompt hash 变更需同步冻结测试与 worker 重启；双文本管线不改入库 schema（DB 只存剥离版）；连接复用仅在 api 内部，wire 与前端契约不变；真机验证标签生效性后再决定是否保留 prompt 标签说明（不生效则回退该段提示词）。

**2026-08-12 实施结果（15b 二期）**：全部落地——① instruction 四层贯通（config→tts-config→voice-routes→run-task parameters）；② 双文本管线（delta/final/入库零标签，TTS 段保留标签，30 个白名单，persona-v2 已含标签表，hash=575f0c11…）；③ segment.emotion 随 voice.segment.ready 下发（wire 可选字段，前端透传，live2d 消费见上文 emotion 待办）；④ 单槽位连接池（复用/cancel 复用/失败弃连/60s 空闲）。真机验证：模型自动输出 [excited] 标签、展示/DB 零残留、TTS 段保留标签且合成成功（53KB mp3）、两次调用仅 1 条 WS 连接、api 3037/worker 1072/shared 414/web 1008 全绿。

- 已落地改动均为增量/新文件且已提交（7be4ffe），未触碰历史遗留改动；后续改动以增量提交进行，可单独 revert；
- 事件 seq 布局变更影响 integration test（需 postgres 环境验证，本地未跑——实施阶段需补跑）；
- cue 为表现层建议，reducer 有 generation/accountEpoch 守卫，极端失败也不影响对话正文（fail-closed 到确定性投影）；
- 前端表现层未实施前，cue 事件到达 reducer 无消费者，运行行为与提交前完全一致（无回归风险）。
