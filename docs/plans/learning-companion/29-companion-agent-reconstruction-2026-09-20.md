# 伴星 Agent 内核重构方案（2026-09-20 实测诊断）

## 0. 文档定位

来源：2026-09-20 用户以真实账号在「连续对话」窗口实测，提出 13 条问题。本文按「现象 / 根因 / 改法 / 验收」逐条落到具体文件与函数，并给出批次划分与待决决策。

行号均为 2026-09-20 在 `v1.0` 分支上逐个打开核实过的，不是推测。开工时若已漂移，以函数名与注释定位为准。

严重度标记：`[阻断]` 功能根本不工作、用户被卡住；`[误导]` 系统说了假话或藏了真相；`[体验]` 能用但效果差。

**本文只做方案，不含实施。** 与 `26-systemwide-behavior-audit-and-fix-plan.md`、`28-companion-decisions.md` 的关系：那两份覆盖行为审计与产品决策，本文覆盖伴星 Agent 内核（路由、prompt、工具面、记忆写路径、输出模型、稳定性策略）。

### 约束（用户 2026-09-20 明确）

- 项目未上线，**不做任何向后兼容**，不为旧版本保留双轨、别名或转发层。确认失效的链路整条删除（与 `AGENTS.md` 清理原则一致）。
- 目标只有「效果好」，不为架构纯洁性牺牲效果。
- `/Users/asklins/Downloads/AAAAGENT-main` 仅作思路参考，其拟人化本身也不到位，**不作基线**。

---

## 1. 结论先说：13 条反馈收敛到 3 条根因

不是「模型笨」。是架构在她的绝大多数轮次里**根本没把能力给到她**。

| 根因 | 一句话 | 覆盖的反馈条目 |
|---|---|---|
| **RC1 关键词路由导致零工具单步** | 用子串匹配选技能，没命中就是 0 个工具、1 步、无记忆无系统视野 | 3、5、6、2(部分)、11 |
| **RC5 prompt 结构性把话压短 + 自我强化** | persona 限 50 字、工具步指令「说一句话就停住」、历史回放让她模仿自己的简短前科、退化闸实际永不触发 | 1、11 |
| **RC8 输出被「单条线性字符串」锁死** | 显示文本与朗读文本共用一条带偏移校验的串，worker 主动剥 markdown、拒 JSON 形状，客户端无 block 分支 | 10、9(读图)、5(跳转) |

另有 4 条独立缺陷，严重但不属于上面三条：

| 根因 | 一句话 | 覆盖条目 |
|---|---|---|
| RC2 工具是空壳 | 17 个工具里 `read_memory`/`read_history` 返回的就是已注入 prompt 的那份，调用等于 no-op | 3、5、6 |
| RC3 记忆写入三路全断 | 抽取 job 静默失败、抽取结果被 `candidate` 自锁、唯一能写的工具被 RC1 挡住 | 3、6 |
| RC4 活跃度/边界从未进 prompt | `pet_profiles` 这两列只有念头调度器读，对话链路连字段都没查 | 2 |
| RC7 稳定性：一律 fail-closed + 静默成功 | 校验失败即 throw 且无恢复；语音超时作废整轮音频；念头调度器每 15 分钟报错一次只 warn | 4、8 |
| RC9 滚动缺 ResizeObserver | 纯前端 bug，与 Agent 无关，可独立立刻修 | 7 |

---

## 2. 实测证据（复现成本高，先固化在此）

数据取自 dev 栈（`ailearn-dev-postgres-1`，`ailearn` 库）。

### 2.1 真实对话（节选，倒序）

```
09-20 17:32 | assi | 喵
09-20 17:29 | assi | 嘿嘿
09-20 16:42 | assi | 这里
09-20 16:40 | assi | 嗯
09-20 16:37 | assi | 嘿嘿        ← 用户：我笔记库里好像没有多少数据啊
09-20 16:36 | assi | 陪你学习     ← 用户：你能干啥呢
09-20 16:35 | assi | 你好呀！     ← 用户：你好呀
09-20 15:07 | assi | 我这边没拿到你的身份信息。   ← 用户：我是谁？
```

「嘿嘿」在两处独立复现，「你好呀→你好呀！」是原样回声。

### 2.2 运行模式分布（`companion_turn_runs`）

```
status    | error_code          | agent_mode  | count | max_step
succeeded |                     | single_step |  142  | 1
succeeded |                     | hybrid      |  103  | 3
failed    | INTERNAL_ERROR      | single_step |   14  | 1
cancelled |                     | hybrid      |   14  | 1
failed    | AI_CONSENT_REQUIRED | hybrid      |   10  | 0
running   |                     | hybrid      |    6  | 0   ← started_at 为 NULL，僵尸
failed    | INTERNAL_ERROR      | hybrid      |    5  | 1
```

**single_step 占已成功的 58%**，且步数恒为 1 —— 这就是 RC1 的量化形态。

模型分布：`qwen3.8-flash` 241 次、`deepseek-v4-flash-0731` 4 次、空 63 次。交互链路全程 `withThinkingDisabled`（`companion-dialogue.ts:341`）。

### 2.2b 质量基线（B1 实测，`scripts/companion-quality-report.py`）

上面的 58% 只数了 `single_step`，**低估了**。按「本轮实际有没有拿到工具」重算，取语音
分段管线上线之后（2026-09-19 11:00）的 140 轮：

```
agent_mode=single_step  n=92  最大步数=1  零工具=92
agent_mode=hybrid       n=48  最大步数=2  零工具=35   ← 拿到工具面也没调
零工具轮占比 = 90.7%        失败率 = 2.1%

短输入(<=6字)回复  n=98  均值=14.4  p10/p50/p90 = 2/6/38   退化(<4字) = 43
长输入(>6字)回复  n=32  均值=65.5  p10/p50/p90 = 7/45/86   退化(<4字) = 3
推进率(带问句/提议) = 37.7%     回声率 = 10.8%     开场重复率 = 9.2%
检索命中轮占比 = 97.1%   抽取写入行数 = 0   活行 = 18   卡在候选 = 5
成功轮 = 130   有正文却零语音段 = 0   平均段数 = 1.77
首字 p50 = 1538ms   p90 = 9810ms
主动投递 = 0   念头 = 0   死掉的念头 job = 3
```

三个修正性结论：

1. **RC1 比初判严重**：90.7% 的轮次她一个工具都没有（不是 58%）。且 hybrid 里 35/48
   也没调用任何工具 —— 说明光把工具面打开还不够，还得让她**有理由**去调（§4.1 的
   `<here_and_now>` 环境块负责把「知道」变成免费，工具只留下钻）。
2. **坍缩集中在短输入**：短输入 p50 = 6 字、44% 退化到 4 字以下；长输入 p50 = 45 字
   基本正常。所以 #1 不是「她不会说长话」，是**用户越随意她越没话说** —— 正是最该
   像活人的那一类轮次。这条直接决定 §4.5 的后检阈值必须按输入长度分档。
3. **语音的服务端分段是健康的**（见 §2.5 修正）。

基线快照：`.impeccable/companion/baseline-2026-09-20.json`，之后每批改完跑
`--compare` 出 delta。

### 2.3 记忆

```
assistant_memory_items WHERE source_event_id LIKE 'memory-extract:%'  → 0 行
jobs WHERE type='companion_memory_extract'                            → 265 个，242 succeeded
companion_memory_embedding_rebuild                                    → 24 dead / 8 succeeded（dead 全为 AIConsentRequiredError）
assistant_memory_embeddings                                           → 6 行
memory_usage_log                                                      → 290 行，全部 retrieval_mode='vector'
```

worker 日志累计：`memory extract JSON unparsable or schema-invalid; retrying once` **88 次**，`memory extract completed` **0 次**。

即：**读侧（向量检索）确实在工作**，写侧一行都没产出过；库里 23 条真实记忆全部来自 e2e 脚本 `POST /companion/memory`。

### 2.4 主动提醒

```
companion_proactive_deliveries → 0 行
assistant_thoughts             → 0 行
jobs WHERE type='companion_thought' → 3 行，全部 dead，last_error='operational_error:database:Error'
```

容器 env：`COMPANION_THOUGHTS_V1=true`、`COMPANION_THOUGHTS_LLM=false`。调度器已注册且每 15 分钟 tick（`workers/ai-worker/src/index.ts:458`，`companion-thought-scheduler.ts:14,19`），但每次都在取素材 SQL 处抛错，只 `logger.warn`（`companion-thought-scheduler.ts:30-35`）。**源头就死了，不是投递/渲染丢的。**

### 2.5 语音

```
近 30 轮 / 全部 226 个已完成 run：有文字但零语音段的 run = 0
voice.segment.ready 事件 = 454；API 侧 /voice/tts 200 = 54；/voice/tts/stream = 0
companion_voice_artifacts = 0 行（且只有 ASR 列，不存 TTS 结果）
edge-tts 容器：15 次 "edge-tts unavailable" 500 + BrokenPipeError（server.py:134 do_GET 自身崩溃）
```

按小时定位分界后修正（B1 复核）：

```
09-19 02:00–10:00  106 轮  零语音段 = 106（100%）
09-19 11:00 起     108 轮  零语音段 =   0
```

即**服务端分段下发是健康的**，一条都没漏。全时段统计会得到「125/255 ≈ 49% 有正文零语音」，
那是 09-19 11:00 管线上线之前的历史数据，不是故障率。

这条排除掉一个很容易抱错的假设：#4 的「输出了但语音根本不读」**不在** worker 侧，
责任落在客户端 deadline 降级（§3.5）与 edge-tts 上游故障。所以 §4.9 的改法不动分段
逻辑，只动 deadline、重试、作废语义与可审计性。

---

## 3. 逐条诊断

### 3.1 能力与视野（RC1 / RC2）

#### `[阻断]` #5 对系统与界面完全不熟悉；#6 不知道用户刚做了什么；#3 的一部分

- **根因 A — 路由**：`selectSkill()`（`workers/ai-worker/src/handlers/companion-agent-runtime.ts:120-149`）对 `read.userText` 做 `triggerHints` 子串匹配。5 个技能的提示词见 `packages/shared/src/companion-agent-registry.ts:25,37,49,61,76`（合计 39 个词）。无命中且无 `pageContext` → 返回 `null` → `definitions=[]`（`:1409-1411`）→ `agentMode:"single_step"`（`:1436`）→ `budget.maxSteps = Math.min(skill?.maxSteps ?? 1, ...)` = **1**（`:1402`）。
  桌面宠物位聊天天然没有 pageContext，所以「哈哈」「我笔记库里没多少数据」「这里任务还有多久」全部落进零工具单步。
- **根因 B — 技能互斥**：`resolveCompanionAgentTools([skill], permission)` 只接收**一个**技能。记忆工具只在 `companion-memory`/`learning-context`，导航只在 `companion-navigation`，规划只在 `learning-planner`。复合意图永远只能拿到三分之一。
- **根因 C — 工具是空壳**：
  - `companion_read_context`（`:357-381`）返回 `{pageKind, groundedTutorAvailable, currentLearningRun:{runId,phase,taskId}}`，仅此。没有笔记、统计、队列、复习到期、界面内容。
  - `companion_read_memory`（`:391-397`）参数 schema 是 `emptyParameters`（registry `:87`），实现是 `read.activeMemories.slice(0,10)` —— **就是已经注入 system prompt 的那一份**，调用不产生任何新信息。
  - `companion_read_history`（`:383-390`）同理返回 `read.recentMessages` 的尾巴。
- **改法**：见 §4.1（常开工具面 + `<here_and_now>` 环境块）与 §4.4（真实检索工具）。
- **验收**：对 §6 回放集里「系统视野类」提问（我是谁 / 我笔记库里有什么 / 队列现在什么情况 / 我刚才学了什么 / 当前界面是什么），**零工具调用的轮次数为 0**，且回答内容能对上库里的真实数据。

### 3.2 记忆写路径（RC3）

#### `[阻断]` #3 不会写记忆

三条独立断点，任修一条都无效：

1. **静默成功**：`companion-memory-extractor.ts:227` `if (raw === null || !parsed) return;` —— 无日志、无异常，job 仍记 `succeeded`。242 个「成功」的 job 写了 0 行。顺带 `:228-232` 是**死代码**：`parsed` 只在 `candidate?.success` 为真时被赋值（`:210-212`），`!parseResult.success` 永假。
2. **候选自锁**：抽取只写 `candidate=true`（`:273-276` 的 VALUES 第三个布尔位），而检索三处查询都要求 `candidate=false`（`companion-memory-vector.ts:157,205,251`）。唯一桥梁是用户点确认气泡（`memory-service.ts:213-221`）。即使解析修好，抽取结果也永远读不到。
3. **唯一活路被 RC1 挡住**：`companion_save_memory` 属 `companion-memory` 技能，且 `requiresConfirmation=true`（registry `:105`）→ guided 档还要过一轮提案确认。而 `memoryRefs` 在 loop 两个返回点被硬编码为 `[]`（`:1797`、`:1938`），使用溯源恒空。

- **改法**：见 §4.3。
- **验收**：说一次「记住我习惯在图书馆三楼复习」，`assistant_memory_items` 出现 1 行 `candidate=false`；下一轮问「我复习习惯在哪」能答对；抽取 job 在解析失败时状态为 `failed` 且带 error。

### 3.3 人格与配置（RC4）

#### `[阻断]` #2 配置的人格、活跃度、边界完全没生效

- **根因**：`petProfile` 进对话链路的形状只有 4 个字段（`companion-dialogue-store.ts:50-55`：`name/speakingStyle/personalityTags/examples`）。`activeness` 与 `boundaries` **在对话链路里从未被查询**——全仓只有 `companion-thought.ts:383-386` 读它们。
- 次因：`buildCompanionPersonaMessages`（`companion-dialogue-content.ts:566-593`）的拼装顺序是 `COMPANION_PERSONA_V4`（3718 字节固定人格）→ `OUTPUT_SAFETY_GUARD` → `PERSONA_SAFETY_GUARD` + `<persona_data>` → `WORKSPACE_POLICY_BLOCK` → 数据块。用户人格排在第 4 段，前面压着 20+ 条禁令。
- 再次因：persona 第 23 行禁止输出任何 `[方括号]` 标记，而记忆块格式正是 `[kind] content`（`:461`）—— prompt 自己造出了它禁止的形状。
- **改法**：见 §4.2。
- **验收**：`activeness` 三档分别跑回放集，输出长度分布、追问率、主动投递量有统计可测的差异；`boundaries.allowPlayful=false` 时俏皮语气消失。

### 3.4 输出坍缩（RC5 / RC6）

#### `[体验]` #1 太短、不抛延续话题；#11 这套 agent 让她变蠢

- **根因（四处叠加）**：
  1. `COMPANION_PERSONA_V4`（`companion-persona.ts:19`）：「日常闲聊…控制在 1–3 个短句、50 字以内」。三档口径只覆盖长度，**没有任何一处要求「回答之后推进对话」**——第 21 行的「把球抛回去」带了「但如果用户明显想结束…就不要再追问」的豁免，小模型会一律走豁免。
  2. `companion-agent-runtime.ts:1519`：`"如果你决定调用工具：先用一句话说明你打算做什么就停住"` —— 只要本轮有工具就注入，字面指令就是「说一句、停」。
  3. **自我强化**：历史以原生多轮回放（`companion-dialogue-content.ts:594-598`），「喵/嘿嘿/嗯」进了 `recentMessages` 就成为下一轮的模仿样本。代码注释已承认（`companion-agent-runtime.ts:1681`「一词回复自我复制」）。
  4. **退化闸实际不可能触发**：条件在 `:1683-1694` —— 要求正文 `<6` 字 **且** `currentUserPromptLen>=8` **且** `!stepEmitted`。「哈哈」只有 2 字，第一个条件即不成立；而流式路径一旦 emit 过就置 `stepEmitted=true`（`:1572`），第三个条件在流式下**恒不成立**。
- **根因（放大器）**：3718 字节、20+ 条禁令、4–6 段拼接补丁的 system prompt，跑在关思考的 flash 档上，且每步随最多 24k 字符历史重发（`companion-dialogue-content.ts:410`）。小模型顾此失彼是必然。
- **改法**：见 §4.2、§4.5。
- **验收**：回放集上 assistant 平均字符数、含问句/提议的比例、连续两轮完全相同开头的比例，三项均有阈值门；「哈哈」类短输入不再产出单字回复。

### 3.5 稳定性（RC7）

#### `[阻断]` #4 经常输出不了东西，或输出了但语音不读

**文字侧 —— fail-closed 无恢复**：`json_envelope_leak` / `stream_full_text_diverged` / `delta_stream_diverged` / `EMPTY_AGENT_RESPONSE` / 预算超限，全部走 `markCompanionRunFailed(..., "INTERNAL_ERROR")` 然后 `throw`（`companion-dialogue.ts:595-614, 640, 684, 715`）。用户侧表现为空白或半句。库里 19 次 INTERNAL_ERROR + 28 次空码。

信封问题的**成因没有被处理**：worker 用 `unwrapCompanionJsonEnvelope`（`companion-dialogue-content.ts:59-76`）+ 头部嗅探解码器（`companion-agent-runtime.ts:1091-1180`）+ 形状判据（`:143-156`）三层去**识别和拒绝**，而源头是模型被要求输出「既不能是 JSON、又不能带方括号、又要复述工具结果」的纯文本。

**语音侧 —— 超时即作废整轮**：`companion-voice-playback.ts:76-77` 定义 `FIRST_AUDIO=1600ms`、`GAP=1200ms`；命中即 `:362` `generation += 1` + `:366` `phase:"text_only"`，**本轮音频永久作废**，而文字早已流完。这正是「输出了但语音根本不读」。上游 `edge-tts` 有 500 与 `BrokenPipeError` 崩溃；454 个段事件只对上 54 次 `/voice/tts` 成功，且 `/voice/tts/stream` 为 0。`synthesizeWithRetry` 一次盲重试无退避、原异常丢弃（`:306-311`）；非超时类失败 `:360` `continue` 静默跳段。

**可审计性**：`companion_voice_artifacts` 只有 ASR 列、0 行，**全仓没有任何 TTS 结果表**，合成成败在数据上不可见。

**僵尸与配置**：6 个 run 停在 `running` 且 `started_at` 为 NULL、0 步；三套预算互相制约（handler 110s / lease 120s / `COMPANION_AGENT_DEADLINE_MS`，见 `companion-agent-runtime.ts:1358-1371`）；24 个 embedding rebuild job 死于 `AIConsentRequiredError`（rebuild 按请求者解析 consent）。

#### `[阻断]` #8 完全没感知到主动提醒

见 §2.4：调度器每次 tick 抛 DB 错只 warn，`assistant_thoughts` 与 `companion_proactive_deliveries` 双零。
叠加一条结构性死锁：`proactive-policy.ts:42` `quietDailyLimit: 0`，活跃度=安静时 `:67` 直接 `quiet_budget_exhausted` —— **该档下主动输出恒为 0**，不是调参问题。

- **改法**：见 §4.6、§4.7。
- **验收**：注入一条到期的复习与一次 3 小时沉默，客户端出现主动消息；`companion_proactive_deliveries` 有行、且每个被抑制的候选都留下一行 reason code；语音在人为注入 2s 延迟时仍完整朗读（不再降级 text_only）。

### 3.6 时间、定时、读图（RC8 相关）

#### `[阻断]` #9 无系统时间概念、无定时提醒、不读图

- **时间**：`buildCompanionPersonaMessages` 全函数**没有任何时钟注入**（`companion-dialogue-content.ts:384-599` 逐段核实）。她不知道几点、星期几、用户多久没来。
- **定时**：对话工具面里没有任何提醒原语；`companion_defer_review` 是唯一与时间沾边的工具，且 `consequential` 需确认。
- **读图**：provider 层能力**已存在**——`analyzeImage`（`provider-factory.ts:45`）、vision 槽与回退（`governance.ts:181-186`）、dashscope `qwen3-vl-plus`（`providers/dashscope.ts:44,79`）、opencode-go 的 `input_image`（`providers/opencode-go.ts:119-120`）。伴星链路一次都没接。
- **改法**：见 §4.6、§4.8。

### 3.7 富输出（RC8）

#### `[阻断]` #10 只能返回纯文本

- **锁死点是「一条线性串 + 偏移校验」**：`companionVoiceSegmentReadyPayloadV2Schema` 要求 `displayEnd - displayStart === displayText.length`，且这个偏移算术建立在净化后的**单条**文本上（`companion-conversation-contracts.ts:795-812`）。任何非文本块都会让算术崩掉。
- **worker 主动破坏**：`stripCompanionMarkdown`（`companion-dialogue-content.ts:248-272`）删代码围栏、`[文本](url)→文本`（`:268`）——图片 markdown 会被剥成 alt 文本；`validateCompanionOutput`（`:226-243`）拒绝 `json_envelope_leak`，结构化卡片直接判失败；同一套净化也跑在流式前缀上（`companion-dialogue-stream.ts` 的 `stableVisibleCut`）。
- **契约与渲染**：block 联合是 `text|code|citation|action_ref` 的 `discriminatedUnion`（`companion-conversation-contracts.ts:49-80`），结构可扩展；但 `assistant.delta` 只有 `{appendFrom, textDelta:string}`、`assistant.final` 不带 blocks（`:845-857`）。客户端**没有 block 类型分支**：全部经 `companionMessageText()`（`companion-chat-session.tsx:282-291`）压平，再 `<p>{text}</p>`（`CompanionChatRecord.tsx:97`、`CompanionHud.tsx:2124`）。
- **已有的可复用资产**：`components/surfaces/note-blocks.ts`（markdown↔block 投影，含 `parseImageBlock:43`、`parseMarkdownTable:55`）、`image-viewer.tsx`（`useImageLightbox:36`）、`source-image.ts`（object-key→blob）、已打包的 Milkdown 7（`note-markdown-editor.tsx`）。
- **跳转其实已通**：`agent.tool` 事件带 `route` 与 `autoExecute`（`companion-agent-runtime.ts:841-855`）→ `CompanionNavChip` → `goToRoute`（`companion-chat-session.tsx:1698`）。但它渲染在消息流**之外**的一行 chip（`CompanionHud.tsx:2225`），所以「跳转」在体感上不像她给的东西。
- **改法**：见 §4.8。

### 3.8 前端独立缺陷（RC9）

#### `[体验]` #7 自动跟随最新消息位置算错，最后一条只露一半

- **根因**：抽屉的滚到底只有**一次** `requestAnimationFrame`，`list.scrollTop = list.scrollHeight`，依赖数组 `[open, mounted, recordOpen, chat.messages.length, chat.phase]`（`CompanionHud.tsx:1885-1893`）。**该列表上没有 ResizeObserver**（同文件 `:1083-1089` 的 HUD 气泡有，`companion-center-surface.tsx:149-165` 也有，唯独这里没有）。
  时序：发送 → `messages.length` 变 → pin 打完 → 1600ms 轮询（`companion-chat-session.tsx:89`）填 `runTraces`（**不在依赖里**）→ 「执行过程」`<details open>` 在最后一段**下方**挂载、`scrollHeight` 撑高一整个气泡 → `scrollTop` 不动 → 最新正文被输入框压住。流式草稿按 60ms tick 增长（`CompanionHud.tsx:2241`）同样不在依赖里。
- **兜底也坏了**：`handleListScroll`（`:1779-1787`）把距底 160px 内都算「已在最新」，约 120px 的遮挡既不触发重滚、也不显示「最新」按钮（`:2172-2175`）。
- **改法**：
  1. 给 `.companion-history__list` 加 `ResizeObserver`，同时观察**内容包裹层**与滚动容器自身；
  2. pin 的触发源改为「内容高度变化」事件，纳入 `runTraces` 与 draft，并在 `<details>` 展开/收起时重算；
  3. 底部判定改成 `scrollHeight - scrollTop - clientHeight <= 2`（小阈值），「最新」按钮据此显示；
  4. 保留用户上滚意图（用户主动上滚后停止自动 pin，直到再次触底或点「最新」）；
  5. 把 composer / navChips 行 / error 行纳入观察——它们是 `.companion-history` grid 的兄弟行（`companion-hud.css:1097-1100`），出现时 `1fr` 行 `clientHeight` 变小而 `scrollHeight` 不变，同样会切掉底部。
- **验收**：在真机上用 CDP 量取最后一条 assistant 气泡的 `getBoundingClientRect().bottom` 与滚动容器可视底边，差值 ≤ 0；含「执行过程」展开态、流式增长中、navChips 出现后三种情形。

---

## 4. 目标架构

### 保留（这些是扎实的，AAAAGENT 无 comparable）

run/event 持久化事件流、`generation` + `accountEpoch` fencing、RLS 事务边界、SSE 下发管线、`companion_agent_steps` / `companion_agent_tool_calls` 审计表、三档权限模型（`read_only|guided|full`）、划选/拖拽投喂、grounded tutor 的 HMAC grant 一次性消费。

### 4.1 删掉技能路由，改成「常开工具面 + 环境块」

- **删除** `selectSkill()` 与 `COMPANION_AGENT_SKILLS` 的工具门控语义（`companion-agent-runtime.ts:120-149`、`registry.ts:18-82`）。技能不再是「能用什么」的单位。
- **一组扁平工具面，每轮全部提供**，`maxSteps` 固定（建议 6）。权限三档只**过滤**工具，不参与发现。
- **基本自觉改为免费**：每轮预计算一个 `<here_and_now>` system 块（纯 SQL，不调模型），装：
  - 时钟：本地时间、星期、时段、时区、距上次交互间隔；
  - 界面：当前页面类型与标识、选中内容、该页可见列表摘要；
  - 学习：今日目标/完成、连击、时长、到期复习数、活跃 run 与当前任务、任务队列内容；
  - 近期活动：最近 N 条笔记（标题+时间）、最近生成、最近作答结果；
  - 待办：未确认提案、已排提醒、未读主动消息；
  - 关系：称呼、活跃度档、边界摘要。
- **效果**：常见轮次 **0 次工具调用、1 步作答**——延迟与质量同时改善；工具退化为「下钻」手段，而不是「有没有视野」的开关。

### 4.2 prompt 重写成三层 + 预算打包

| 层 | 内容 | 可否被用户人格覆盖 |
|---|---|---|
| A 宿主协议 | 输出形状、block 规则、工具规则、安全边界 | 否 |
| B 角色 | `pet_profiles` 的 name / speakingStyle / personalityTags / examples / **activeness** / **boundaries** / catchphrase | 是（且为主导指令） |
| C 本轮程序 | `<here_and_now>`、记忆、划选、页面、few-shot | 否 |

- B 层**位置上移到 A 之后第一段**，不再排在 3718 字节的固定人格之后。
- 禁令从 20+ 条压成一份**正向行为规范** + few-shot；长度与形状改由**代码确定性保证**（§4.5），不靠求模型。
- 消除自相矛盾：记忆块格式不再用 `[kind]`（改 `· kind — content` 或结构化字段），persona 的方括号禁令才成立。
- 借鉴 AAAAGENT 两点：预算贪心打包 + `omittedIds` 留痕（其 `memory/context.ts:66-102`）；「宠物持续心情不得镜像用户心情」的分主体规则（其 `providers/emotion-inference.ts`）。

### 4.3 记忆接通

- **先让失败可见**：`:227` 的静默 `return` 改为抛错并写 `jobs.last_error`；删除 `:228-232` 死代码。抽取改用更宽松的输出协议（或逐条抽取 + 局部容错），把 88 次解析失败先降到可解释水平。
- **拆掉候选自锁**：低风险 kind（`preference`/`goal`/`learning_context`）抽取后**直接写活**（`candidate=false`）；只有可能引起用户异议的才留 `candidate=true`，并在**记忆中心**拦截而不是在检索处。
- **`remember` 降为直执行**：可逆 + 用户明确要求，除 `read_only` 外不过提案确认。
- **`recall(query)` 做成真检索**：向量 + 关键词混合，返回**尚未注入**的内容；删掉现返回已注入那份的 `companion_read_memory`（AGENTS.md：无调用价值的旧实现直接删）。
- **溯源回填**：`memoryRefs` 从硬编码 `[]`（`:1797`、`:1938`）改为真实命中集，喂 `memory_usage_log` 与星图。
- **扩来源**：episodic 记忆从 activity 流生成（写了哪篇笔记、做了什么练习、改了哪个配置），不再只从聊天文本抽 —— 这是 #6 的正解。

### 4.4 系统工具面（替换现有 17 个里的空壳）

读：`search_notes`、`read_note`、`get_learning_stats`、`list_task_queue`、`list_due_reviews`、`list_recent_activity`、`describe_current_screen`、`recall_memory`、`read_image`。
写/动作：`remember`、`forget_memory`、`open_page(kind,target)`、`schedule_reminder`、`list_reminders`、`cancel_reminder`、`set_activeness`、`set_boundary`、`render_diagram`、`emit_card`。
删除：`companion_read_history`、`companion_read_memory`（no-op）、以及随技能层一起失效的 `skillIds` 归属校验。

### 4.5 对话连续性硬约束（治 #1）

- 终答步后检（确定性，不调模型）：短于阈值 **或** 不含任何推进信号（问句 / 提议 / 下一步）→ 用思考档重跑一次取更优者。
- 退化闸触发条件重写：与 `stepEmitted` 解耦（流式下也能生效），长度阈值与输入长度相关而非固定 6 字。
- 工具步指令「先用一句话说明你打算做什么就停住」（`:1519`）改为允许成段表述。
- 历史回放加**风格消毒**：对连续多条极短 assistant 前科做降权或折叠，切断「一词回复自我复制」。

### 4.6 时间与定时

- 时钟进 `<here_and_now>`，并显式声明「历史与设定里的时间不是现在」。
- 新建 `companion_reminders` 表 + worker tick（复用现有 job/lease 机制），模型侧 `schedule_reminder/list/cancel`，系统侧（复习到期、连击风险、长时间沉默）共用同一投递管线。

### 4.7 主动提醒复活

- 修 `companion-thought.ts:383-386` 取素材 SQL 的 DB 报错（先复现、看真实异常，别再 warn 掉）。
- `quietDailyLimit: 0`（`proactive-policy.ts:42`）改为一个真实的小预算 —— 安静档是「少而轻」，不是「结构上恒零」。
- 每个被抑制的候选落一行 reason code，让「她今天为什么没说话」可查。
- embedding rebuild 的 24 个 `AIConsentRequiredError`：按记忆归属用户而非请求者解析 consent。

### 4.8 block 输出协议（治 #10、#9 读图、#5 跳转）

- 消息 = 有序 typed block：`text | image | code | diagram | card | nav | audio | video | quote`。
- **两个投影**：
  - `visibleBlocks` → 交给真实渲染器（复用 `note-blocks.ts` + Milkdown 只读镜像 + `image-viewer.tsx`）；
  - `speakable` → 线性文本投影，不可朗读块**占 0 区间但自报**（「这儿有张图」）。偏移校验改为**按块索引**，取代 `displayEnd-displayStart===displayText.length` 的单串算术。
- **worker 不再剥 markdown、不再拒绝结构化输出**；`stripCompanionMarkdown`（`:248-272`）与 `json_envelope_leak` 整族校验器随其成因一并删除。
- **工具结果直接携带富载荷**由客户端渲染 —— 模型不需要用文字「画」东西。流程图走 `render_diagram`（收结构化输入，客户端渲染）。
- 读图接已存在的 vision 槽（`governance.ts:181-186`）。
- `nav` 块进消息流内渲染，取代现在游离在外的 chip 行。

### 4.9 稳定性策略：fail-open

- 轮内失败：先用简化 prompt 重试一次 → 再失败则**说出一句符合角色的话**，绝不空白。把「校验器判失败」与「用户看到东西」解耦。
- 语音：提高首字/段间 deadline，超时**不再作废整轮**（允许迟到音频）、加真实退避重试、修 `edge-tts` 的 `BrokenPipeError`、新增 TTS 结果表让合成成败可审计。
- 预算：handler / lease / 合同三套收成一个；回收 6 个 `running` 僵尸。
- 通则：**job 的 succeeded 必须意味着活儿干了**（抽取即先例）。

### 4.10 评测底座（建议最先做）

代码里 20+ 条带日期与编号的补丁注释（`T0`、`④-b`、`E`、`S6`…）是「无测量地反复打补丁」的痕迹。把库里 273 个真实轮次做成回放集，对每个候选设计打分：

长度分布 · 追问/推进率 · 零工具轮占比 · 记忆命中率 · 失败率 · 首字延迟 · 音频完整率 · 完全相同开头连续次数

没有它，§4.1–§4.9 改完仍靠肉眼判断她聪明了没有。

---

## 5. 参考项目的取舍

**可借鉴**：预算打包 + `omittedIds` 留痕；persona(可编辑) / host-protocol(不可覆盖) / 程序性 三层分离；`expression`（本轮表现）与 `emotionAssessment.{user,companion}`（持续状态、分主体）分离；模型输出的视觉预设 id 在**模型之后**再对白名单校验、未知标签只影响渲染不丢正文；感知通道并行且各自独立超时、降级为 `partial`；generation fencing 覆盖到播放中；舞台提示词剥离器；`hostClock()` 在请求构造时打戳。

**明确不抄**：它**完全没有工具回路**（全仓 `grep tools:|tool_calls|function_call` 零命中）—— 与我们要修的是同一个洞，不能把它当作已验证的设计；约 30 条密集子句的记忆维护 prompt（其 live 路径直接把 `relevance` 打桩成 `()=>1`）；关键词 bigram + 硬编码雇佣正则的检索；`click_invitation` 这种抛错的死子系统；无流式、无对话重试；为两只宠物搭 200 文件 40 套测试的仪式；单例 `COMPANION_ID` 且人格配置并非真的按实例走。

---

## 6. 批次划分

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | §3.8 滚动 ResizeObserver（#7） | 无，独立可立刻发 | 小 |
| **B1** | §4.10 评测底座 + 回放集 | 无 | 中 |
| **B2** | §4.1 常开工具面 + `<here_and_now>`；§4.4 系统工具 | B1 | 大 |
| **B3** | §4.2 三层 prompt；§4.5 连续性硬约束；§3.3 活跃度/边界进 prompt | B2 | 中 |
| **B4** | §4.3 记忆读写接通 | B2 | 中 |
| **B5** | §4.7 主动提醒复活 + §4.6 时钟与提醒表 | B3、B4 | 中 |
| **B6** | §4.8 block 输出协议（含读图、跳转进流） | B2 | 大 |
| **B7** | §4.9 稳定性 fail-open + §9.3 dead job 收尸 + 语音链路 | B3 | 中 |
| **B8** | §9.6 provider 退化：模型级 fallback、供应商健康探测、退化率一票否决 | B1 | 中 |

B1 先行的理由：它决定后面每一刀是否有效。B0 与一切并行。

---

## 7. 待决决策

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 常开工具面的延迟代价 | (a) 全工具面恒在、模型自判；(b) `<here_and_now>` 常开保证自觉，工具面按「本轮是否可能需要动作」做**模型自判的轻量前置路由**（不是关键词） | 建议 (b)：(a) 会让 hybrid 轮次与尾延迟显著上升，而环境块已覆盖多数「知道」类需求 |
| D2 | B6 富输出范围 | (a) 先 `nav/card/image/diagram`，`audio/video` 下一轮；(b) 一次全要 | 建议 (a)：block 协议改动最大，先覆盖你点名的跳转/图片/流程图 |
| D3 | 抽取记忆的确认策略 | (a) 低风险 kind 直接写活、记忆中心可撤；(b) 全部保留候选 + 确认气泡 | 建议 (a)：(b) 正是当前「写了没人读」的死因 |
| D4 | 是否保留 `companion-navigation` 等技能概念 | (a) 整层删除；(b) 降级为纯 prompt 片段 | 建议 (a)：按 AGENTS.md，被取代的旧链路整条删 |

---

## 8. 完成定义

1. ~~`single_step` 占比降到 <10%~~ → **工具面常开后该读数失效**（`agent_mode` 恒为 hybrid）。
   改看 `INTERNAL_ERROR` 与空码失败归零。（2026-09-20 修订，见 §9.12）
2. §2.3 的 `memory-extract:*` 行数从 0 变为与对话量相称，且下一轮可被检索到。
3. §2.4 的 `companion_proactive_deliveries` 与 `assistant_thoughts` 不再恒零，且每个抑制有 reason。
4. 「有文字无音频」的轮次在真机 100 轮抽样中为 0。
5. ~~系统视野类提问零工具调用轮次为 0~~ → 判据错，见 §9.12。改为：**系统视野类提问
   答对率 ≥95%**（答案与库内真值逐项可比对）；零工具率降为诊断项、不设门。
6. 长度分布、追问率、连续相同开头率三项过 B1 定的阈值门。
7. §3.8 的遮挡在 CDP 量取下差值 ≤ 0。
8. **退化率一票否决**（§9.6 新增）：assistant 正文「不足 6 字」占比从基线 66% 降到
   <10%，且「以正常句末标点收尾」占比 >85%。这一条不过，其余各条的体感都不成立。

---

## 9. 实施期发现（2026-09-20，B0 / B1 / B2a）

### 9.1 已完成

- **B0 抽屉贴底跟随** —— 活应用 CDP 实测六个用例：`+120px 执行过程气泡` 从切掉 51px 变 0，
  `兄弟行抢 50px 视口` 从 101px 变 0，滚轮上滚后正确停住并出现「最新」按钮，点「最新」恢复跟随。
  978 个客户端测试全过。
  **实施纠正了方案的一处判断**：原 §3.8 改法第 3 条设想「用 scroll 事件 + 小阈值」判定意图，
  实测**不成立**——打开抽屉先贴底、内容随后继续长高，那一下 `scroll` 的 `distance>0` 会把
  贴底意图误关掉，B/C 两个用例当时仍然被切。意图只能由**用户输入**（向上滚轮 / 手指下拉 /
  键盘上翻）判定，`scroll` 事件只用于**恢复**。代码里已按这个口径实现。
- **B1 质量基线** —— `scripts/companion-quality-report.py`（只读库、零模型调用），
  基线快照 `.impeccable/companion/baseline-2026-09-20.json`。数字见 §2.2b。
- **B2a 环境快照** —— `workers/ai-worker/src/handlers/companion-here-and-now.ts`，
  9 条 SQL 全部在容器内用真实 RLS 事务与真实参数绑定验通，渲染块实测：

  ```
  <here_and_now>
  现在：2026-09-20 19:17 周日（晚上）
  距上次和用户说话：22 小时前
  你是「元气小猫」，累计互动 273 次
  用户正在学习「牛顿第二定律的公式 F=ma」，计划 3 分钟，正在做：请回忆这个主题的关键信息…
  今日已学 18 分钟，6 个学习运行，到期待复习 25 项
  最近笔记：《消防疏散与灭火器使用》(2 天前)、…；笔记库共 9 篇
  </here_and_now>
  ```

### 9.2 新发现：坍缩的真实形态比 RC5 描述的更硬

端到端跑「现在几点／我今天学了多久／最近写了哪几篇笔记／有多少到期复习」四问，
落库正文分别是 `现在是`(3) / `今天`(2) / `最近`(2) / `你`(1)，全部 `succeeded`、单条 delta。

拉长到 6 小时窗口看，这是**常态不是偶发**：绝大多数 succeeded 轮次正文 1–3 字。
同时同一会话里也存在 `deltas=1 len=49`、`deltas=1 len=71` 的正常轮次 —— 所以
**`deltas=1` 不等于被截断**，是模型真的在 1–3 个 token 后就 `stop` 了。

两个结论：

1. **环境块已经在被使用**：四条截断恰好都是各自问题的正确开头
   （现在是**晚上7点24分**… / 今天**你学了18分钟**… / 最近**是《消防疏散》**… / 你**有25项**…）。
   她读到了数据、开了正确的头，然后停住。
2. **RC5 的退化闸在流式路径恒不触发，这次拿到了活体复现**：
   `companion-agent-runtime.ts` 的闸门要求 `!stepEmitted`，而流式一旦 emit 过就必然
   `stepEmitted=true`。这四条全是流式，所以闸一次都没拦。

**因此 B3 的「输出坍缩闸」必须提到 B2b/B2c 之前做完**，否则环境块、工具面、记忆
改到哪一步都没法判断有效没有效——判据本身被这个 bug 吃掉了。

实现口径（保住「已下发原文必须是最终正文前缀」这条硬约束）：**终答步在累积到
最小可发长度之前不落 delta**，攒够再发；若整步就在阈值以下，走思考档重跑后
再从头发。这样重跑时客户端一个字都没收到，不存在分叉。

### 9.3 新缺陷：dead job 把 run 永久钉在 active（#4 的独立机制）

```
jobs.status='dead'（3 次尝试用尽）  而  companion_turn_runs.status='accepted'
```

job 已经不会再有人消费，run 却永远停在非终态；该会话之后**每一轮都吃 409
`RUN_ALREADY_ACTIVE`**，直到有人手工收尸。B2a 调试期间连续撞了三次，每次都要手工
`UPDATE ... status='failed'`。

这就是 #4「经常性的出现输出不了东西了」的一条独立成因，和 §3.5 的 fail-closed
是两回事：那条是单轮失败，这条是**一次失败毒死整个会话**。归 B7，且必须做在
worker 侧（job 终结时同事务把 run 落终态），不能只靠客户端 supersede 兜。

> **已修（B 序提前，2026-09-20）**：迁移 `0232_companion_orphan_run_reclaim.sql`
> 新增 SECURITY DEFINER 函数 `ailearn_reclaim_orphaned_companion_runs()`，
> 由 `companion-run-reconcile-scheduler.ts` 每 30s 触发，注册在
> `tickCompanionProposalExpiry()` 旁边（同一理由：被锁死的会话压根没有可 claim 的
> job，所以必须跑在 claim 之前）。副作用与 worker 侧 `markCompanionRunFailed` 逐条
> 对齐：run → failed（`JOB_DEAD`/`JOB_MISSING`）、补写 error + character.cue 两个
> 事件、刷事件 TTL、回写 last_event_seq、pg_notify。
> 实测把库里那 6 个 09-19 遗留的僵尸全部收掉，非终态 run 归零，事件形状逐条核对过。
>
> **为什么必须写成 SQL 函数而不是 worker 里一条 SELECT**：生产 worker 用
> `DATABASE_URL_WORKER=ailearn_worker`（非 superuser、无 BYPASSRLS），跨租户扫描会被
> `companion_turn_runs` 的 RLS 滤成空集——**在 dev 一切正常、在生产静默什么都不做**。
> dev 下 worker 走 `DATABASE_URL=ailearn`（superuser + BYPASSRLS），所以这个坑在本地
> 完全看不见。
>
> 另记一条实施期事实：`apps/api/src/db/migrate.ts` 的迁移清单读
> `meta/_journal.json` 的 entries，**不扫目录**。只加 `.sql` 文件不登记 journal，
> `db:migrate` 会报 "0 to run" 并且不报错，看起来像"已经应用过了"。

### 9.4 实施期踩到的两个坑（写下来免得重踩）

- **Postgres 保留字不能裸当列别名**：`EXTRACT(hour ...)::int hour` 报
  `syntax error at or near "hour"`，直接把 read 阶段打挂、job 连败三次。别名改
  `hour_of_day`。同理 `date`、`time` 等。
- **drizzle 的 `= ANY(${数组})` 是坏的**：JS 数组被摊成 6 个独立标量参数，生成
  `= ANY(($3,$4,$5,$6,$7,$8))`，Postgres 报 `op ANY/ALL (array) requires array on
  right side`。要用 `IN (${sql.join(arr.map(v => sql`${v}`), sql`, `)})`。
- **手工用 psql 验 SQL 会漏掉这两类错**：手敲时用的是字面量而非参数绑定，
  `ANY(ARRAY[...])` 也写得比代码更合法。SQL 必须**在容器内用真实绑定**跑
  （临时脚本放 `src/` 下，`docker exec npx tsx` 执行，用完删）。

### 9.5 另外两处待归批的发现

- **`learning_runs.goal` 是机器枚举**，活跃运行里实测恒为 `stabilize`，注入进去会
  让她说「你正在学习 stabilize」。人类可读的主题在 `learning_tasks.target_summary`
  （实测「牛顿第二定律的公式 F=ma」）。环境快照已按后者取。
- **两套「活跃度」互不相通**（B5 必须处理）：`companion_set_activeness` 工具写
  `pet_profiles.activeness`，而主动提醒门禁 `proactive-policy.ts` 读的是
  `user_companion_account_state.intervention_level`。也就是说她**自己说"我把活跃度
  设成安静了"，对主动提醒完全没有影响**。同时 `pet_profiles.boundaries` 只有念头
  调度器读、对话链路不读（§3.3 已记）。
- **`scripts/companion-turn-e2e-verify.py` 已过期**：它还在
  `POST /companion/conversations` 建会话，而连续历史模型下该路由已删除（会话是隐式
  `kind='inbox'` 单条）。照抄会 404。要么修要么删。

### 9.6 坍缩闸已生效，但量出了它治不了的那一半（重要）

§9.2 的坍缩闸按「结构不完整」判定（裸数字结尾 / 成对符号未闭合 / <6 字）+ 终答步
攒够 12 字才下发，实测**确实救回了轮次**：worker 日志两次触发、一次产出完整答案，
那条落库成 63 字、内容全对、语气自然：

```
你最近写的是《消防疏散与灭火器使用》、《IndexTTS 2.5 让声音跨越语言》那篇，
还有一篇《无标题笔记》，都是两天前啦。
```

环境快照本身也全线验证通过——问「现在几点」「今天学了多久」「最近写了哪几篇」
「有多少到期复习」，答案与库内真值逐项对上（晚上八点 / 18 分钟 / 三篇真笔记 / 25 项）。
**§4.1 的设计目的达成。**

但同一窗口（最近 3 小时 32 条 assistant 正文）的分布是：

```
不足 6 字        21 / 32   66%
以正常句末标点收尾  6 / 32   19%
裸数字结尾截断      1
成对符号未闭合截断   1
```

且**没有任何 `truncated by maxTokens` 日志**——模型是以 `finishReason=stop` 结束
却交出半截话的。结论：

> 坍缩有两个来源。一个是 prompt/历史侧（§4.2、§4.5 能治，且已经看到效果）；
> 另一个是 **provider 侧**：`tokenrhythm → litellm → qwen3.8-flash` 在交互链路上
> 高频返回退化补全。重跑一次只能缓解，连续两次都退化时无解。

这部分**不在原方案 13 条里**，是实施期量出来的新根因，单独立项（见 §6 的 B8）：
伴星链路需要**模型级 fallback**（退化判据命中后换候选模型重试，而不是只换思考档）、
供应商健康度探测，以及把「退化率」做成 §8 的一票否决指标。否则 B2–B7 全部做完，
用户看到的仍然是一半的轮次只有两个字。

### 9.7 顺带修掉的实施期回归

历史消毒第一版只剔除退化的 assistant 轮，结果在历史里留下**没被回答的用户问句**，
模型转而去补答它——实机问「哈哈」答「有25个到期该复习啦」（那是上一条被剔除的提问）。
现改为：**丢答案必须连它所回答的那句提问一起丢**。

### 9.8 B2b 扁平工具面已上线，实测形态变化显著

删掉 `selectSkill()` 的工具门控（`resolveAllCompanionAgentTools(permission)` 取代
`resolveCompanionAgentTools([skill], permission)`），步数改为固定 4（仍夹在合同上限
`COMPANION_AGENT_MAX_STEPS` 之下）。迁移 0233 放开
`companion_agent_tool_calls.skill_id` 的 NOT NULL——审计列不该塞占位身份。

10 场景驱动脚本实测（A–G 跑完，H 被 API 一次断连打断）：

```
12:55  "帮我记住：我习惯在图书馆三楼复习"
       → 好呀，我帮你记下来啦～ 记住啦，以后提到复习我就默认是图书馆三楼那个位置～要不要现在去占座
         (steps=2 tools=1, 47字, 带追问)
12:56  "你还记得我平时在哪儿复习吗"  → 132字, steps=2 tools=1
12:58  "带我去复习页面看看"
       → 好嘞，带你去复习页面～ 到啦… 你手上攒了 25 项到期没清的，要不要挑三五个先做一轮？…
         (steps=2 tools=1, 73字, 4 个语音段)
```

对比 §2.2b 基线的「单步、零工具、1–3 字」：**工具真的被调用了，循环走起来了，
回复回到 47–132 字并带延续性追问**。`companion_save_memory` 也首次写进库
（`12:55:29 preference candidate=false user_stated=true 习惯在图书馆三楼复习`）。

> 注意 `agent_mode` 从这一刻起**不再是"有没有能力"的读数**（工具面常开后恒为
> hybrid）。判能力是否真被用到只能看 `tool_call_count`——质量报告的零工具率已按此
> 口径统计。

### 9.9 新发现：写进去的记忆**读不到**，卡在向量检索

上一条刚写成功，下一条她就说"记忆里没这条"。不是没写进去，也不是候选自锁
（那条 `candidate=false`）。根因是检索主路径：

```
assistant_memory_items 活行 = 21    assistant_memory_embeddings = 6    embedding_status=pending = 39
memory_usage_log 的 retrieval_mode 全部 = 'vector'
```

向量检索要求条目有 embedding，而**21 条活记忆里只有 6 条有向量**——新写的记忆在
embedding 补上之前对主路径完全不可见。keyword 降级路径本身不要求向量（且已修过
"整段查询塞 ILIKE 永远匹配不到"的问题），但它只在向量路径**失败**时才走，
而不是与向量结果**并集**。

归 B4，且这是 B4 的正解入口（不是抽取器那个静默失败——那个也要修，但它不是
"她记不住"的直接原因）：**检索必须是 vector ∪ keyword**，让缺向量的条目永远不会
结构性隐身；并考虑写入时同步补一次 embedding。

### 9.10 活跃度与边界已进对话链路（抱怨 #2 关闭）

`pet_profiles.activeness` / `boundaries` 此前**对话链路根本不查**（只有念头调度器读），
所以用户在设置里调的东西对日常对话是字面意义的零。现在 read 阶段一并取出，并在
`<persona_data>` 里**翻译成行为句**而不是丢标签——`活跃度：active` 模型不知道该改什么，
`「回答完主动抛一个跟当前话题连着的小问题或提议」`它才知道。

活体 A/B（同一问题「我今天状态一般，你随便跟我说两句吧」）：

```
active  69字 带追问=是
        状态一般就别硬撑啦，今天已经学了 18 分钟，够本了。
        那 25 项复习不会跑掉的，明天精神好再收拾它们～要不要我陪你发会儿呆？
quiet    7字 带追问=否
        嗯嗯，收到啦。
```

默认档（moderate + 边界全开）**不新增任何一个字符**——有测试钉住这点，否则会
悄悄把 §4.2 要收敛的"常驻禁令"又堆回去。`catchphrase` 走与人格字段同一道
`sanitizePersonaField`，有测试断言 `</persona_data>` 只能出现一次。

**顺带量出一处设计冲突（归 B3 收尾）**：坍缩闸的判据含「<6 字即重跑」，而
`quiet` 档的正确输出**就是** 7 个字甚至更短。于是安静档用户几乎每一轮都会白打一次
思考档重跑。闸门阈值必须读 `activeness`：quiet 档下要么放宽阈值，要么直接不拦。
这是"两个各自正确的规则打架"，不是哪个 bug——记下来免得只改一边。

### 9.11 B4 记忆链路已打通（抱怨 #3 关闭），根因比预想的更朴素

抽取器 88 次解析失败的真实原因：**schema 要求 `version: z.literal(1)` 且
`importance`/`confidence` 必填，而 prompt 里从未把这个形状告诉模型**——只写了
"输出严格 JSON"。模型自然给 `{"candidates":[…]}`，于是必然失败。契约单方面存在于
代码里，等于必然违约。

四处修复合起来才让链路通：

1. **prompt 写出完整 JSON 形状与枚举**，并明确"没有值得记的就返回空数组"。
2. **schema 宽容缺省、不宽容错值**：`version` 可省（回填 1）、`importance` 默认 0.5、
   超过 3 条**截断而非判失败**；但 `confidence` 保持必填——它是 §9.1 置信度闸的输入，
   给默认值等于替模型表态（默认高了什么都写、低了什么都不写，两种都比"模型没给"更坏）。
3. **解析失败必须抛**（新增 `MemoryExtractOutputError`，判不可重试直接 dead）。
   以前是 `return` 而 job 记 `succeeded`——242 个"成功"写了 0 行，监控上一切健康。
4. **抽取结果按 kind 直接写活**（决策 D3=a）：`preference`/`goal`/`learning_context`
   写 `candidate=false`；`interaction_note`/`episodic` 保留候选（是关于用户当下状态的
   推断，长期引用显得被监视）。三处检索查询一律要求 `candidate=false`，所以不拆这道
   锁，光修解析仍然是"写了没人读"。

活体证据（说一句 → 等抽取 → 下一轮问）：

```
[1] "我换了张书桌，在靠窗那个位置学习，晚上喜欢开着台灯只留一盏"
[2] 抽取 job succeeded；累计抽取写入 4 行，其中 3 行 candidate=false
    preference|cand=false|用户偏好短节奏学习，每次练习约10分钟…
    preference|cand=false|用户喜欢在靠窗书桌、仅开一盏台灯的环境下学习…
    goal      |cand=false|用户正在备考日语N3，考试时间为下个月…
[3] 问"我现在一般坐在哪儿学习？" → 该轮 memory_usage_log 的 8 条命中里
    包含本轮刚抽出的两条 ✓
```

**残留（归 B3/B8，非链路问题）**：`[3]` 她答"靠窗位置开台灯这些你说过，但坐哪儿没提过"
——一边引用一边否认。两个原因叠加：(a) `topK=8` 已被集成测试留下的夹具行
（"第一次独立完成三分钟微旅程验证"等）挤占，靠窗那条排在 8 名之外；
(b) 模型过度自谦。先清 dev 库的测试记忆行并复核 topK，再判断 (b) 还占多少。

### 9.12 B8 跨模型兜底已接线；同时**作废我自己定的一个验收指标**

新增 `companion_fallback` 能力槽（`provider-capabilities.ts` + `config/ai-platforms.json`
+ governance 暴露 + 对话 handler 构造 provider），退化闸从"单级思考档重跑"改成
**降级阶梯**：思考档 → 跨模型兜底，任一级拿到结构完整答案即停。容器内实测解析：

```
primary  = openai_compatible/qwen3.8-flash
fallback = openai_compatible/THUDM/GLM-4-9B-0414   ← 不同模型、不同上游
```

14:40 之后 7 轮的真实读数（对照 §2.2b 基线）：

| 指标 | 基线 | 现在 |
|---|---|---|
| 短输入均值 / p50 | 14.4 / 6 字 | **57.0 / 54 字** |
| 长输入均值 / p50 | 56.5 / 43 字 | **173.5 / 182 字** |
| 退化（<4 字）占比 | 44% | **0** |
| 以正常句末标点收尾 | 19% | **7/7 = 100%** |
| 推进率（带问句/提议） | 37.7% | **85.7%** ✓ 过 §8 目标 |
| 回声率 / 开场重复率 | 10.8% / 9.2% | **0 / 0** |
| 抽取写入行数 | 0 | **9** |
| 失败率 | 2.1% | **0** |

实际对话形态（节选）：

```
"你好呀"     → 你好呀！周日晚上好～ 今天已经学了 18 分钟啦，N3 的进度还在跑。要不要趁…
"有点累了"   → 累了就歇会儿嘛，别硬撑。 覆盖索引这块你刚才接得挺快的…
"讲讲覆盖索引" → 我先去翻翻你笔记里关于索引的内容… [316 字]
"帮我想想怎么复习贝叶斯" → 让我先看看你之前关于贝叶斯的学习记录～ [287 字]
```

阶梯这一批**一次都没触发**——退化主要是被前面的 hold + 形状闸 + 扁平工具面 + 环境块
压下去的，跨模型兜底现在是安全网而不是主力路径。这是好事，但它也意味着
**B8 的实际效果还没有被真实验证过**（没有退化样本可打）。要验证得等下一次网关退化窗口，
或人为注入（把主模型换成一个已知会退化的端点）。

#### §8 第 1 条与第 5 条要改

原第 1 条「`single_step` 占比降到 <10%」已经**失去意义**：工具面常开后 `agent_mode`
恒为 hybrid，它不再表达"有没有能力"。

原第 5 条「系统视野类提问**零工具调用轮次为 0**」是**错的判据**。§4.1 的设计目的恰恰是
"自觉 = 每轮免费预计算，工具只留下钻"——环境块把大多数"知道类"问题在**不调工具**的情况
下答掉了才是成功。实测这一窗口零工具率 85.7%（比 B2b 后的 57.1% 更高），
但同一批**答对率是 100%**：她答对了周日、晚上、18 分钟、N3 目标、覆盖索引。
拿"调没调工具"当门，会逼着系统去做无用的工具调用来满足指标。

改成：**系统视野类提问的答对率 ≥95%（答案与库内真值逐项可比对）**，
零工具率降级为诊断项、不设门。

### 9.13 B7 语音与 fail-open（抱怨 #4 的主体已修）

**语音：一次超时不再作废整轮。** `companion-voice-playback.ts` 旧行为是首段
1.6s / 段间 1.2s 截止一到就 `generation += 1` + `host.stop()` + `phase:"text_only"`
并 return —— 文字早已流完，音频连同**后面已经合成好的段**一起作废，当轮不可恢复。
这就是「输出了但语音根本不读」的机制本体。

| 改动 | 前 | 后 |
|---|---|---|
| 首段 / 段间截止 | 1600 / 1200 ms | **4000 / 3000 ms** |
| 截止命中 | 作废整轮音频 | **只跳过那一段，继续后面** |
| `text_only` 降级 | 每次截止都触发 | **整轮一段都没播出来时**才触发，且带原因 |
| 合成重试 | 1 次、零退避、`catch{}` 丢弃原始异常 | 3 次、250/500ms 退避、保留最后一次异常 |

截止包住的是**整个重试序列**（`withDeadline` 包 `synthesizeWithRetry`），所以退避
不会突破段预算。放宽截止的代价接近零：语音是对已显示文字的渐进增强，晚两秒开始念
远好于不念。

新增两条回归护栏（fake timers + `FakeHost.hangFor` 造"永不返回"）：
`首段合成超时只跳过那一段，不再把整轮音频作废`、`整轮一段都没播出来时才降级 text_only`。
18/18 通过。

**文字 fail-open：失败也绝不空白。** `persistFailedPartial` 原本在
`deliveredText < 12 字`时直接 `return false` —— 于是校验判失败的轮次界面上**什么都没有**，
像她突然不理人。现在：有半句就保留半句，一句都没有则落一句**诚实的**角色内兜底话
（三条按 runId 确定性轮换；不编造、不宣称已完成任何事、不暴露 provider/错误码，
`kind='error'` 以便统计）。真库集成测试两条：空下发必须写出消息且幂等（重投不产生第二条）、
已有半句时不得被人造话术顶掉。

**edge-tts 容器**：`_send` 写 `wfile` 时客户端断开会抛 `BrokenPipeError`，被
`socketserver` 打成 traceback 混进真实故障里。现在 `handle()` 与 `_send()` 都吞掉
`BrokenPipeError`/`ConnectionResetError`（请求已无法送达，安静收场）。已重建镜像，
容器 healthy，实测合成返回 200 / 24336 字节 / `fff3` 合法 MP3 帧头。
（注：截止放宽 + 重试次数增加会让"放弃中的请求"变多，这个修复是前置必要的。）

#### 本批**没有**做完的两件事，不要当成做完了

1. **TTS 结果不可审计**（§4.9 第 5 项）。`companion_voice_artifacts` 只有 ASR 列、
   0 行，全仓没有 TTS 结果表。质量报告的语音段计数只能证明"**服务端下发了**段"，
   证明不了"**客户端播出来了**"——而后者才是用户抱怨的那个东西。补它需要
   客户端→服务端的播放结果回报通道（新端点或新事件类型），是跨边界改动，
   没有顺手做。在那之前，§8 第 4 条（真机 100 轮抽样「有文字无音频」为 0）
   **仍然无法自动验证**，只能靠人耳。
2. **三套预算未收一**（§4.9 第 6 项）。handler 110s / lease 120s /
   `COMPANION_AGENT_DEADLINE_MS` 仍靠 `Math.min` 手工协调
   （`companion-agent-runtime.ts` 的 `deadlineAt`）。合并会同时动超时配置、
   租约与错误归因分类，风险与收益不匹配，留待单独一批。

### 9.15 B5 主动提醒：不是"投递/渲染丢了"，是源头六道闸全关（抱怨 #8/#9）

§2 里我写过"调度器已注册且每 15 分钟 tick，但每次都在取素材 SQL 处抛错"。那句只对了一半，
真相比它更难看：**念头管线从头到尾没有一次成功跑完过**，而它的失效是一串互相遮蔽的闸，
每一道都"静默且成功"。逐道核实结果：

| # | 闸 | 证据 | 处置 |
|---|---|---|---|
| 1 | 入队函数要求"30 天内有正式学习运行" | `ailearn_enqueue_companion_thoughts()`（0227）里 `EXISTS(… FROM learning_runs …)`；dev 库该用户 `learning_runs` **0 行**，却有 320 次伴星互动、25 条待复习 | 0236 改成以 `pet_profiles.last_active_at` 14 天内为门槛；桶 4h→2h |
| 2 | worker 无 `assistant_thoughts` 权限 | job 全 dead，`cause: permission denied for table assistant_thoughts` | 0235 补授权（同一坑 0085/0091 已踩过两次） |
| 3 | worker 无**函数** EXECUTE 权限 | 实测 `proacl` 里只有 `ailearn`/`ailearn_migrator`，0231 的 `GRANT … TO ailearn_worker` 不在 ACL 里 | roles.sql 白名单补两条（见下条"复发陷阱"） |
| 4 | LLM 候选批量被 `COMPANION_THOUGHTS_LLM=false` 关掉 | compose 两份 + `.env.example` + CI 契约脚本都写着 false | 开关整体删除：关掉它等于让主动提醒只能念三句模板 |
| 5 | 确定性候选依赖不存在的数据 | 该用户 `ready_reviews=0`（25 条被"稍后"推到明早 09:18）、`companion_daily_summaries` 0 行 → streak=0、`learning_runs` 0 行 → `days_since_last_learning IS NULL` → `candidates.length===0` → **无日志 return** | 新增 `review_due_soon`（12 小时内到期，含用户自己推走的批次）；素材改用 here_and_now 事实块；每次调度必写一行 `outcome` |
| 6 | 送达后客户端不知道 | worker 直投 `assistant_deliveries` 不发 NOTIFY（API 的 `deliver()` 发）；且 `companion-home-projection` 只被 `snapshot_invalidated`/`connection_changed` 打断，**`companion_activity_changed` 不在其列** | `enqueueSystemEventDelivery()` 收拢"序列锁 + 写行 + NOTIFY"；投影失效加第三种事件 |

#### 复发陷阱：`roles.sql` 会清掉迁移里的函数授权

`infra/postgres/roles.sql` 在迁移之后跑 `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public`，
再按**显式白名单**重新授予。文件自己就写着这件事（673/746 行注释："必须在此重新授予，否则
worker 每分钟 tick 报 permission denied"）。所以任何新增 SECURITY DEFINER 函数，
**只写迁移 GRANT 等于没写**。这一类已经暴露过：`similarity`、`ailearn_claim_run_processing`、
`ailearn_reclaim_stale_companion_proposals`、`ailearn_run_companion_memory_maintenance`。

本次顺带发现我自己也踩了：0232 的 `ailearn_reclaim_orphaned_companion_runs()`（§9.3 那把
"会话被孤儿 run 锁死"的钥匙）**不在白名单里**，dev 库里它现在能跑只是因为比 roles.sql 后应用。
两者一起补进了 roles.sql。

#### 顺带修掉的两个真 bug

- **念头定稿写 embedding 一定失败**：`embedding = ${"[...]::vector"}` 把 `::vector` 写进了**参数值**
  里，Postgres 收到 `"[0.1,…]::vector"` 这个字符串去 cast → `invalid input syntax for type vector`。
  写法本身在仓库里只此一处（另外三处 `${vec}::vector` 都正确）。它从没暴露，是因为第 1–5 道闸
  让它压根跑不到这一行。
- **LLM 念头按序号去重**：`llm:<date>:<index>` 会让同一天**第二次**调度必然产不出候选——模型说的
  全新那句话只要排在第 0 位，就和上一轮第 0 位撞 key。改成按内容 hash。
- **念头库是一次性的**：`activeDedupeKeys` 把"还没说出口的 candidate"和"已经说过的"同等对待，
  于是被日预算/时机压住的那条，下一轮会因为 key 已存在而被过滤，**永远不会被送达**。拆成
  `blockedDedupeKeys`（delivered/spent）与 `storedCandidates`（candidate → 复用原行、后续提升）。

#### 新建能力：到点提醒（0238）——之前这不是"坏了"，是**根本不存在**

全仓库 `reminder` 只命中 card-generation / learning-objectives 的同名概念；伴星侧一张表、
一个工具、一个 tick 都没有。用户说"明早九点提醒我复习"，没有任何一行数据能活到明早九点。

- `companion_reminders`（pending/fired/cancelled/missed）+ `ailearn_fire_due_companion_reminders(int)`：
  每分钟由 worker tick 调用，**认领、写 system_event 投递、NOTIFY 在同一事务里**做完。
  超过 2 小时没兑现的约定先作废——闹钟迟到八小时不是提醒，是骚扰。
- 时刻存 UTC，但工具参数收**用户本地挂钟**（`fireAtLocal`），换算交给 Postgres
  （`$local::timestamp AT TIME ZONE 账号时区`）。模型做时区算术必错。
- 三个工具：`companion_schedule_reminder` / `companion_list_reminders`(read) / `companion_cancel_reminder`。
  建/撤都是 `reversible_low` + 免确认——用户刚亲口说的"提醒我"，再弹一次"确定吗"是噪音。
- 提醒进 here_and_now（`你已经答应：09-21 09:00 提醒用户「…」`），不然她许过约转头就忘。
- 投影区分来源：`proactiveCue.origin = thought | reminder | system`。到点的提醒气泡停 30 秒**并念出口**，
  不再和随口一提共用 7.4 秒的静默气泡。

#### 实测（dev 库，北京时间 2026-09-20 深夜）

- 入队：`SELECT ailearn_enqueue_companion_thoughts()` → **1**（该用户 `learning_runs` 仍是 0 行）。
- 生成：`assistant_thoughts` 从 0 行 → 一批候选，内容直接引用真实笔记标题与当下时刻
  （"消防笔记还热乎着呢""周日深夜还在卷？"）——第 4/5 道闸解开后，here_and_now 的事实确实进了 prompt。
- 送达：`companion thought outcome outcome=delivered`，`assistant_deliveries` 出现
  `thought:<uuid>`（state=queued，含 1024 维 embedding），**这条管线第一次跑通到底**。
- 提醒：插三条（10 分钟前 / 9 小时后 / 3 天前）→ 分别 fired / 保持 pending / missed，
  fired 那条产出 `reminder:<uuid>` 投递；worker 自己的 tick 打出 `companion reminders delivered`。
- 测试：worker 单测 666 中 665 通过（唯一失败 `retry-strategy-contract` 是**容器没挂载 api 源码**
  的既有环境限制，读 `../apps/api/.../0064_*.sql` ENOENT）；shared 312 全过；api home-projection
  11 全过；desktop-client 1017 全过；四处 typecheck 干净。

#### 仍然没有闭环的部分（不算完成）

1. **气泡的真机渲染未验证**。服务端已经产出未过期的 `thought:` 投递，但我在 CDP 上轮询 90 秒
   没看到 `.companion-bubble--cue`；紧接着桌宠端在 00:01 被重启、`--remote-debugging-port=9222`
   没了，我没有去动用户正在运行的窗口。所以第 6 道闸的两处修复（NOTIFY、投影失效）**只有代码，
   没有真机证据**。下次开局第一件事就是补这个测量。
2. **"正在思考"那个卡死现场**已无法复现：涉事会话 `2487c84b` 现在**一条 run 都没有**（被删了），
   而它不是活动会话。§9.3 的回收链路本身可用（能打出 reclaim SSE），但这条具体的 wedge 需要
   一次新的现场才能定性。
3. `companion_daily_summaries` 0 行 → `streak` 候选永远拿不到素材；`ailearn_enqueue_companion_daily_summaries`
   在白名单里，所以更可能是它自己的产物链路没跑，另案。
4. 念头管线的**成本**从"每天 2–4 次纯 SQL"变成了"每 2 小时一次 LLM 批量 + 一次表达"。
   预算合并（§4.9 第 6 项）没做，所以这笔新增目前没有统一账本。

### 9.16 B2c 系统敞开面：7 个真工具上线，同时抓到我自己造成的一个"存在但必错"

抱怨 #5/#6（「连跳到某个笔记都做不到、看不到学习数据、看不到当前界面、看不到任务队列」）
的根因是**她面前压根没有这些能力**：注册表里 16 个工具全部围绕学习运行生命周期
（start/resume/pause/hint/variant/defer/plan_route）加三个一键跳转，没有任何一个能查
笔记、查统计、查队列。

**新增 7 个工具**（全部 worker 侧 SQL、RLS 事务内、带归属校验）：

| 工具 | 数据来源 | 说明 |
|---|---|---|
| `companion_search_notes` | `notes` + `note_blocks` ILIKE | 关键词两侧 `%`（记忆检索踩过的同一个坑，注释里点名了） |
| `companion_read_note` | `note_blocks` 按 ordinal 拼 | 上限 3000 字，带 `truncated` |
| `companion_open_note` | 归属校验后 route | 不可越权跳别人的笔记 |
| `companion_open_page` | route | `home/today/review/star_map/conversation/source/settings` |
| `companion_get_learning_stats` | `learning_metric_events` 等 | 今日按**用户本地日**、活跃卡/笔记数与 `stats/service.ts` 同谓词 |
| `companion_list_task_queue` | `learning_tasks` × 活跃 `learning_runs` | label 取 `target_summary`，回落 `prompt` |
| `companion_list_due_reviews` | `review_schedules` × 卡片 `front->>'cue'` | 带逾期小时数 |

**顺带删掉** `companion_open_review` / `companion_open_star_map` / `companion_open_history`
——三者是 `companion_open_page` 的真子集（AGENTS.md：被取代的旧链路整条删除，不留兼容入口）。
同步清理了技能清单、参数 schema 表、执行器分支与前端图标映射。

**当前界面改成 ambient 而不是工具**：`here_and_now` 新增 `currentPage`（解析本轮
pageContext，note/card 才去查标题）。理由同 §4.1：她要么已经知道用户在哪儿，要么这一轮
不知道该问什么；实测 592 条 page context 里 498 条是 `other`（人 idle 在首页），所以
`other/home` 直接不渲染，免得她围绕"你在首页"找话。

#### 我自己造成的缺陷（已被新加的不变量测试拦住）

`companionAgentToolArgumentSchemas` 与 `COMPANION_AGENT_TOOL_DEFINITIONS` 是两份清单，
缺条目时 `validateCompanionAgentToolArguments` 返回 `"unknown tool argument schema"`——
**工具出现在她面前、她也会去调、每一调必失败**。上一批我加的 3 个提醒工具就漏了这一步，
也就是说它们上线即坏，只是没人调用所以没暴露。

补了两条不变量测试（`companion-agent-registry.test.ts`，该文件此前不存在）：

1. `findCompanionAgentToolSchemaGaps() === []`——注册表与参数 schema 表必须齐平；
2. 技能清单里的每个工具名都必须真实存在（防止再留下指向已删工具的孤儿名）。

这类"两份清单靠人记得同步"的结构，正是 §1 RC7 说的静默失效族。真正的一次性修法是把
参数 schema 收进 `tool()` 构造本身，让二者同源——留待下一批与技能层删除一起做
（技能层仍是 `tool()` 的必填参数，而那层已经没有解析路径了）。

#### 测量：被并行改动挡住，未完成

`python3 scripts/companion-turn-e2e-verify.py --rounds 16`（新增 K–P 六个场景专测这批工具）
跑到一半全部 `failed`，worker 日志给出的原因是：

> Workspace policy forbids sending data to external AI providers (sendToExternal=false).

同一时刻 `workers/ai-worker/src/lib/governance.ts` 报 4 个类型错误
（`Property 'aiDataPolicy' does not exist on type …`）。核对结果：
工作区里有一份**未提交**的 `packages/shared/src/db-schema/identity.ts` 改动，
把 workspace 上的 `ai_consent_*` / `ai_data_policy` 迁到了新的 `user_ai_settings` 表
（迁移 `0237_user_ai_settings` 已应用，`workspaces` 的 `ai_*` 列已不存在），
而 worker 的治理读取还停在旧列上 → 运行时取到 `undefined` → 同意判定 fail closed →
**dev 里所有外部 AI 调用被拒**。

这是别人手上的在建改动，涉及隐私/同意边界，不猜语义去改。因此本批的真机测量记录为
**未完成**，已验证的只有：worker 665/666 单测（唯一失败是容器没挂 api 源码的既有环境限制）、
shared 315 全过（含 2 条新不变量测试）、四处 typecheck 除 governance 那 4 条外干净。
治理读取补完后的第一件事，就是重跑这 16 轮并把 K–P 的 `tools=` 计数记进本文件。

### 9.17 两个"配置没生效"的余波：退化闸的字数线、记忆块的括号自相矛盾

**(1) 坍缩闸会烧掉"安静"档的每一次正常回复。**
`looksTruncatedReply` 的三条判据里有一条"短于 6 字即算退化"，当时的注释写着"会**故意**
把「好呀」「嘿嘿」判进来，因为抱怨 #1 就是太短"。这个取舍对**活跃**档成立，对**安静**档
正好相反：设成安静的人要的就是三个字的答案，于是每轮被判退化 → 走思考档/跨模型重跑 →
用更啰嗦的档位覆盖用户自己的设定，还白付一次延迟。现在阈值跟着活跃度走
（`TRUNCATED_REPLY_MIN_CHARS`：quiet 2 / moderate 4 / active 6），由
`companion-dialogue.ts` 把 `read.petProfile.activeness` 传进 agent loop。
"安静"不等于"可以说半截话"：空、裸数字结尾、没关的括号在安静档照样拦（有测试钉住）。

**(2) 人格 prompt 禁止方括号，记忆块却用方括号喂她。**
`companion-persona.ts` 写着"不要输出 [方括号] 形式的任何标记"，而 `<memory_data>`
每行是 `[preference] 喜欢用语音交流`。模仿的效力强过禁令，这条格式要么教她把括号带进
正文（只能靠 sanitize 事后削），要么让她学会干脆不用记忆。改成中文冒号前缀
（`偏好：` / `目标：` / `学习情境：` / `互动记录：` / `那件事：`），测试同时钉住
新格式与"不再出现 `[preference]`"。

**(3) 一处一致性顺带修**：`here_and_now` 的 `dueReviews` 少了
`user_deferred_until <= now()` 这条，于是同一次对话里"到期待复习 N 项"可能把用户自己
按了"稍后"的卡也算进去，和 `companion_get_learning_stats` / 复习页对不上号。补上。

验证：worker 667 项仅 1 失败（`retry-strategy-contract` 的容器无 api 源码挂载，既有环境限制），
typecheck 除 governance 的 4 条（§9.16 的并行改动）外干净。真机效果仍未测——同样受 §9.16 阻塞。

### 9.18 技能层整条删除（§4.1 的收尾），并把"两份清单"合成一份

工具面已经每轮全给、只按权限档过滤（§9.8），技能层就只剩一副空壳：`tool()` 还必填
`skillIds`、审计表还留着 4 个 skill 列、run 上还有 `agent_mode`、设置里还有
`enabledSkillIds`。留着它们不是"以后可能用到"，是让下一个读代码的人以为还存在一层
路由。本次按 AGENTS.md 整条删：

- **shared**：`companionAgentSkillManifestV1Schema` / `Summary` / `SkillEventV1` 三个 schema、
  `COMPANION_AGENT_SKILLS`、`resolveCompanionAgentSkills`、`getCompanionAgentSkill`、
  `resolveCompanionAgentTools(skills,…)`、`CompanionAgentSettingsV1.enabledSkillIds`、
  工具定义上的 `skillIds`、SSE 联合里的 `agent.skill` 事件类型、`companionAgentModeSchema`。
- **worker**：`selectSkill` 之后残留的 `skillId` 形参（5 个函数逐个穿下来的 `null`）、
  `agent_mode`/`active_skill_*` 的读写、DEFAULT_SETTINGS 里的技能清单，
  以及**只在为技能服务的地方**读的 `agent_settings`（`settings` 变量删后已无人读）。
- **api**：节点事件类型去掉 `agent.skill`；`enabledSkillIds` 的 allowlist 校验与
  `INVALID_AGENT_SETTINGS`（唯一使用者就是它）；`mode` 从 run 摘要里去掉。
- **desktop**：`skill` 节点类型与 `appendSkillNode`、轨道可见性判据、图标映射分支。
  轨道现在只看**这一轮有没有工具节点**——比原来的 `mode === "hybrid"` 更硬，
  它说的是"确实查/做了东西"，不是"系统允许她查"。
- **迁移 0239**：`companion_turn_runs.{agent_mode,active_skill_id,active_skill_version}`、
  `companion_agent_steps.skill_id`、`companion_agent_tool_calls.skill_id`、
  `companion_action_proposals.agent_skill_id` 全部 DROP；
  `agent_settings` 去掉 `enabledSkillIds` 键并改 default。
  理由写进迁移头：合同 schema 是 `.strict()` 的，**留着这个键的存量行会让 worker 侧
  safeParse 失败并静默回落默认设置，也就是用户的权限档可能被无声忽略**。

顺带做掉一件结构性的事（§9.16 留下的）：`tool()` 现在同时收**模型可见的 JSON schema** 与
**服务端 zod 校验**两个参数，参数校验表由注册表派生。上一批 3 个提醒工具"上线即坏"
就是因为它们是两份靠人同步的清单；现在少传一个参数是类型错误。另加一条不变量测试：
技能清单式的孤儿名与重复工具名都会红。

**实机验证**（mock provider，零外部调用；dev worker 停机跑，避免与后台队列抢 job）：

| 套件 | 结果 |
|---|---|
| worker `companion-agent-postgres.integration.ts` | **8/8 通过** |
| api `companion-proposal-expiry-sweep-postgres.integration.ts` | 3/3 通过 |
| worker 单测 | 666/667（唯一失败仍是容器未挂载 api 源码的既有环境限制） |
| shared 单测 | 314/314 |
| api 单测 | 1401 项，1 跳过 0 失败 |
| desktop-client | 1027 项通过；typecheck 干净 |
| 四处 `tsc --noEmit` | 仅 `workers/ai-worker/src/lib/governance.ts` 4 条，属 §9.16 记录的并行改动 |

集成测试里有三条断言的前提随技能层一起没了，改动都是**换成仍然成立的事实**，不是放宽：

1. "闲聊 → 零工具" 改为断言"审计行数 == run 上的 `tool_call_count`"与"闲聊不得冻结确认"。
   调不调工具现在是模型的选择；把零工具当不变量会反过来逼系统做无用调用
   （§8 作废"零工具率"时说过同一件事）。
2. "预算耗尽 / epoch 失效 → 不得产出答复" 原写作 `assistant.length === 0`。实测那条
   assistant 行**确实存在**：fail-open 的失败兜底文案会在被拒绝的轮次留一行答复，
   这正是抱怨 #4 要的行为。断言改成"没有 `assistant.final` 事件"，其余零副作用
   （零步骤 / 零工具 / 零提案）原样保留。**这一处值得单独确认**：被拒绝的轮次留下
   一行兜底答复是否会在抽屉里渲染成一条没有上下文的空话，需要真机看一眼。

### 9.19 主动额度与静默时段：两份实现已经分叉，现在只有一份

§4.7 的三项里做掉两项（第三项 embedding rebuild 的 consent 归属随 §9.16 的并行改动一起待验）：

**(1) `quietDailyLimit: 0` → 1。** 方案 16 §10.2 把"安静"写成"不主动"，于是设成安静的人
**结构上永远不会收到主动提醒**（抱怨 #8 在安静档下不是 bug 而是必然）。界面上并没有
"关闭主动提醒"这个开关，只有一档写着"安静"——真要关有账号级 `globalEnabled`。安静应该是
**少而轻**：一天一条，且仍受冷却/去重/反馈降权约束。同时把 `reasonCode` 从
`quiet_budget_exhausted` 改名 `daily_budget_exhausted`（三档都会命中它，原名会误导排查）。

**(2) 预算只有一个来源。** 念头管线原来自己写死 `maxDeliveredPerDay: 2`，与 API 的
3/6 完全不是一回事。`proactive-policy.ts` 整体移到 `packages/shared`，两边都走
`proactiveDailyLimit(intervention_level)`；念头侧现在还会把 `interventionLevel` 与
`dailyLimit` 打进 `outcome` 日志，"她今天为什么没说话"第一次可查。

**(3) 顺带抓到的分叉——静默时段。** `isWithinQuietHours` 在 api 与 worker 各有一份，
且**已经朝相反方向坏掉**：

| 情况 | api 那份（改前） | worker 那份（改前） |
|---|---|---|
| 时区名非法（catch 分支） | `return false` = **不在静默时段** → 照发 | `return true` = 抑制 |
| 钟面越界（`25:00` / `07:60`） | `parseClock` 返回 null → 同上，**照发** | 没校验，算出 1500 分 → 结果不可解释 |
| 注释声明的意图 | "解析失败 fail closed 抑制" | 与代码一致 |

也就是说：**同一个坏配置，API 路径会半夜吵人，念头路径会整天沉默**，而 api 那份的注释
写的是它没做的事。合并成一份（`companion-proactive-policy.isWithinQuietHours`），语义统一为
"解析不出可信钟面值就按静默处理"；顺手补上 worker 那份的 `hour % 24`（`en-US` + `hour12:false`
在午夜会给 "24"，不取模会算出 1440 分让跨午夜分支判错）和 `24:00 ≡ 00:00`。
反馈降权规则（`shouldStaySilentForFeedback` 与 `evaluateDismissalFeedback` 字节级重复）同样合并为一份。

静默时段此前在 api 侧**没有任何单测**，worker 侧只有三条；现在移到 shared 并补齐：
跨午夜环绕、`start===end` 全时段、非法时区、非法钟面、`24:00` 归一，外加一条
**按账号时区而不是 UTC 判**的用例（北京 22:30 = UTC 14:30，按 UTC 判会整晚不静默；
反过来 UTC 01:30 会被误判成"在静默时段"）。

**验证**：shared 11/11（含 4 条新用例）、worker 664/665（唯一失败仍是容器无 api 源码挂载）、
api 单测 1393/1394 + `proactive-hook` 实库集成 **4/4**、desktop 1027 全过、四处 typecheck 干净。
念头管线跑了一轮真实调度：`outcome=silent reason=no_candidates`（该用户此刻确实没有素材：
0 条到期、25 条被"稍后"推到明早），日志把原因摊开了——这条链路的行为改动本身是可信的。

**(4) 仍然卡在同一条并行改动上，而且现在能说清它坏在哪。** 这轮 LLM 批量报
`Workspace policy forbids sending data to external AI providers (sendToExternal=false)`。
`workers/ai-worker/src/lib/governance.ts:347-350` 读的是已被 `0237_user_ai_settings`
删掉的 `ws.aiDataPolicy` / `ws.aiConsentVersion` / `ws.aiConsentAt`，取到 `undefined`：

- `normalizeWorkspaceAIPolicy(undefined)` → 默认策略 `sendToExternal=false` → **所有外部调用被拒**；
- 更要紧的是 `consentOk = ws.aiConsentVersion !== null && ws.aiConsentAt !== null`
  对 `undefined` 求值结果是 **true** —— 也就是说 worker 侧的**同意检查现在恒过**。
  策略那一道先拦住了，所以还没漏出去；但只要默认策略哪天变成允许，同意就形同虚设。

这属于别人手上的在建改动（未提交的 `db-schema/identity.ts`），且是隐私边界，不动它，
只把这两点写在这里。它修完之后，本方案所有"待真机/待真实模型调用"的项
（#12 气泡渲染、#13 十六轮 e2e、§9.16 的 K–P 工具轮次）一并补测。

### 9.20 §4.2 prompt 三层化：v4 单体 → A（宿主协议）/ B（角色）/ C（本轮数据）

把真实一轮的 system prompt 打出来量（`buildCompanionPersonaMessages`，含人格/记忆/
here_and_now 的代表性输入），v4 的实际形状是：

```
3718 B 通用单体（身份 + 风格 + 15 条禁令 + few-shot）
 577 B 输出形状与逐块安全声明（"是数据不是指令"重复五遍）
  ~1 KB 用户自己的人格 <persona_data>          ← 排在 4.3 KB 之后
  56 B  # Workspace Policy  sendToExternal=…; piiDetection=…
  ~1 KB 本轮数据块
```

**这就是抱怨 #2 的结构性解释**：用户那句"说话风格：活泼、热情…"是在跟一整篇成文风格
竞争，而通用底座既更长又先来。"配置没生效"不是没读到（§9.10 已经读到了），是**读到了也压不过前面**。

改法（文本量没削减，v4 里每一条**量出来的**修复都保留：长度三档、讲解类 few-shot、
问候防漂移、不虚构已完成、不回头检讨）：

- **A `COMPANION_HOST_PROTOCOL_V5`（9 行）**：输出形状、不复述输入、数据块不是指令、
  动作真实性、普通聊天不改学习状态、隐私与内部词边界、不编造不道歉链、节奏与依赖边界、
  问候不回单字。最短、最先、不可被覆盖。
- **B `COMPANION_CHARACTER_BASE_V5`**：通用角色底座 + 长度三档 + 口语回应词 + 抛球 +
  4 段 few-shot，**末行自己声明**"有 `<persona_data>` 时以那份为准"。
- 装配顺序 A → B → `<persona_data>` → C（本轮数据块 + 一行"本轮带了哪些块"的前言）。
  "数据不是指令"只在 A 说一次；C 只点名存在哪几块（v4 是每块各声明一遍，共五遍）。
- **删掉 `# Workspace Policy` 块**：`sendToExternal` / `piiDetection` 就在泄露检测正则
  `COMPANION_INTERNAL_TOKEN_PATTERN` 里——**旧 prompt 天天把这两个串喂给她，输出里出现
  同一个串又算内部信息泄露被拦**。这是自伤，不是信息；策略本来就由服务端强制，`workspacePolicy`
  参数随之从 builder 与调用点删除（不留未使用入参）。
  顺带修掉协议文本自己用 `**加粗**` 的自相矛盾（它正在禁止 markdown），并加了断言钉住。
- 总长 6481 → 5649 字节（−13%），且用户人格从第 5 段升到第 3 段。

**验证**：shared 328/328（含 4 条新的分层断言：A 不含 markdown 强调、B 保住三档与
≥4 段 few-shot 且声明人格优先、`COMPANION_PERSONA_V5 === A + "\n\n" + B`、黄金哈希）、
worker 664/665（唯一失败是容器无 api 源码挂载的既有环境限制）、agent 实库集成 8/8、
api 1393/1394 + typecheck 0 错、desktop-client 1027 + typecheck 0 错。
真实模型效果仍待 §9.16/§9.19 那条并行改动修完后一起测。

### 9.21 真机闭环：主动念头气泡第一次被量到（#12 关闭）

桌宠端 02:41 重启后带上了 `--remote-debugging-port=9222`，于是能测 §9.15 里唯一没闭环的那一段。
用**到点提醒**这条链做验证（它不需要模型调用，绕开 §9.16/§9.19 那个 consent 阻塞），
三段分开量：

| 段 | 测法 | 结果 |
|---|---|---|
| 兑现 → 投递 | 插一条 `fire_at = now()+2s` 的提醒，看 worker 日志与表 | `companion reminders delivered`；`companion_reminders.status=fired`，`assistant_deliveries` 出现 `reminder:<uuid>`（state=queued，2h TTL） |
| 投递 → SSE 帧 | `python3 scripts/companion-inbox-sse-probe.py`（绕开桌宠，直连 `/companion/deliveries/inbox/stream`） | 连接时重放积压 **26 帧**；随后新提醒的帧在 **+50s** 到达，`seq 27 text=第五条…` |
| SSE → 气泡 | CDP 只读 DOM，不调任何投影接口 | **+32s** `.companion-bubble--cue` 自己长出，文案与提醒一致，**158×40**，停留 **28.0s** 后自动收起（`origin=reminder` 走 30s 分支，4s 采样粒度内一致）；窗口 `hidden=false`、`presencePaused=null` |

投影侧同时读到 `proactiveCue = { text, expiresAt, revision: 22, origin: "reminder" }`——
`origin` 是这批新加的字段，气泡时长与"是否念出口"由它决定。

**中途一次假阴性值得记下来**：第二次跑（DOM-only）报 `NO_CUE_WITHIN_WINDOW`，我差点据此判"推送坏了"。
真实原因是**客户端自己的低频闸**：`companionCueAllowed` + localStorage
`ailearn.home-v2.last-ordinary-cue`（active 5 分钟 / moderate 10 分钟 / quiet 永不）。
第一条气泡在 22:44 弹出时写了这个时间戳，我 22:46 的第二条**本来就该被压住**——那是设计。
清掉时间戳重跑才拿到正例。**"两条主动提示五分钟内只显示一条"是真行为，不是故障**，
但它会让"我明明做了你却没反应"的排障一路跑偏，所以记在这里。

### 9.22 顺带暴露：收件箱每次启动全量重放，而我上一批的改动会把它放大成重取风暴

`assistant_deliveries` 里 `state=queued` 的行永不终结（主动投递不做 ACK），
而主进程每次生命周期结束把 `companionInboxCursor` 归零 → **每次启动都从 `after=0` 重放全部积压**
（实测 26 条）。在 §9.15 之前这没有后果：那些 `companion_activity_changed` 不被投影层当作失效信号。
加上之后，一次启动就是 26 次并发投影重取。

修法：主进程把突发**合流**成一次广播（400ms 尾沿，带最大 `inboxSequence`，停机时清计时器）。
**这条改动没有真机验证**——主进程代码要重启桌宠才生效，我没有去动用户正在用的窗口。
下一次重启后要做的是：确认启动只出现 1 次（而不是 N 次）`/companion/home/projection` 类请求，
且气泡行为不变。

顺带一句：更根本的修法是给主动投递补 ACK 或给 queued 行加保留期清理，但那会改动收件箱语义
（谁算"已读"、跨设备只允许一个租约），不在本次范围内。

### 9.23 §4.3/§4.4 记忆与活动面四个工具上线，以及量出来的新失效形状："承诺当答案"

**这批做了什么**（抱怨 #3「完全不读记忆」/ #6「看不到系统在发生什么」的收尾）：

| 工具 | 干什么 | 权限档 |
| --- | --- | --- |
| `companion_recall_memory` | 真检索（向量 + keyword 降级），**排除本轮已注入的那些** | read |
| `companion_forget_memory` | 软删一条记忆（`deleted_at`） | reversible_low，免二次确认 |
| `companion_list_recent_activity` | 笔记/复习/卡片/已兑现提醒合成一条时间线 | read |
| `companion_set_boundary` | 改 `pet_profiles.boundaries`（玩趣/催学习/语气标签/口头禅） | reversible_low，免二次确认 |

**同时删掉 `companion_read_memory`**：它 `return` 的就是本轮已经拼进 prompt 的那一份
记忆（`event.read.activeMemories`），调一次等于把看过的东西再看一遍。她以为自己在"回忆"，
实际一个字节都没查到——这正是抱怨 #3 的字面根因，比"没有工具"更坏，因为它看起来像有。

`companion-agent-registry.ts` 的**成对声明**（一次 `tool()` 同时给 JSON schema 和 zod）
在这批救了一次：上一批三个提醒工具就是这么"上线即坏"的（§9.16）。

**顺带补了一个从来没人消费的开关**：`boundaries.allowVoiceTags` 在库里、在伴星中心的
复选框上、在首页投影里，**但全链路没有任何一处读它**——确定性语气层
`applyDeterministicToneToSegments` 无条件注入 `[excited]`。现在它接了第三个参数
`injectTags`：关掉后仍然净化模型自己写的幻觉标签，只是不再由我们注入。
一个改不动任何东西的开关，比没有开关更糟。

#### 真机第一次跑：她的工具面是全的、预算是够的，却一步都不调

`--only S,Q,R,T,U` 五轮（`permission_level=full`、`budget.maxSteps=4`、27 个工具全部在列）：

```
S 活动流   steps=4 tools=4  → 答对了，标题、时间、本周 57 分钟全真
Q 记忆     steps=1 tools=0  → "这就去记忆里翻一翻～"（然后没有然后）
R 忘掉     steps=1 tools=0  → "好，这就把它忘掉～"
T 边界     steps=1 tools=0  → "收到喵～"
U 口头禅   steps=1 tools=0  → "嘿嘿，那我可就不客气地收下啦～"
```

**4/5 的失效不是框架没给工具，是她用一句话把请求"接住"就结束了。** 而这句话比半截话更伤：
用户听到的是"她答应去做了"。第二轮更糟——R 变成"嗯？这条我刚才已经忘掉啦，记忆里现在没有它了喵"，
**零工具调用却声称已经做完**，而这句话会进历史，下一轮她把自己的谎当作依据。

根因里有一条是我自己写进协议的。A 层原来那句：

> 动作还没被确认时，只说你想做什么、会有什么影响，不说它已经发生。

它写于"通往动作的唯一路径是提案确认"那个版本。现在这批工具全是免确认直执行，
这句话对她就成了**"只说你想做什么"的许可证**。已改成：能做的这一轮就调工具再回答，
不要用承诺代替动作；只有确实需要用户先确认的动作才只描述意图。另外补了一条同形的：
只有查系统才有答案的问题（他写过什么、最近干了啥、你记得他什么）先查再答。

**prompt 不能只靠信。** 所以加了确定性的第三步（`companion-agent-runtime.ts` 的"让她做事"闸）：
`calls.length===0 && toolCallCount===0 && 步数有余 && 未过 deadline` 时，若
①用户这句话明确在要求一个只有工具能完成的动作（`looksLikeActionRequest`），或
②她整条回复就是一句承诺（`looksLikeUnfulfilledActionNarration`，≤24 字 + 承诺措辞），
则把她已说出的话原样留在正文（已流式，收不回），追一条系统提示重跑一步，每轮至多一次。
判据放在**输入侧**是因为冒领没有可靠措辞判据（中文不标时态，"我记住了"既可能是完成也可能是表态）。

#### 改完再跑：链路通了，断点在参数

```
00:02:17  run 0c7e83aa  steps=3 tools=2
  companion_recall_memory=succeeded  «又翻到 2 条相关记忆»
  companion_forget_memory =succeeded «已忘掉（用户习惯在图书馆三楼复习。）»
23:58:35  run 27828509  steps=3 tools=2
  companion_set_activeness=succeeded ; companion_set_boundary=succeeded «口头禅=就这么定了»
```

第一次 R 失败的原因**完全是我的**：`recall` 的返回体里没有 `memoryId`，
于是她凭空编了一个 `5e0a2b1c-3d4f-4a5b-8c9d-0e1f2a3b4c5d` 传给 `forget`，
被判"找不到"（fail-closed 正确，但她看到的错误是"没有这条记忆"，看起来像她记错了）。
工具描述里明明写着"先 recall 拿到 memoryId 再删"——**描述要求的字段，返回值没给**。
现在 `memoryId` 回传，失败信息也改成可执行的下一步（"先用 companion_recall_memory 拿真实 id"）。

`set_boundary` 的写入与消费两端都核过：`boundaries` 从 48 到 50 版，
`{"catchphrase":"就这么定了", allowPlayful/allowVoiceTags/allowNudgeLearning 保持原值}`
（jsonb `||` 只合并显式给的键）；prompt 侧 `renderPersonaBehaviour` 与念头管线各自读这一列。

**仍然开着的两个**：
- T（"以后别主动催我复习"）跑出来 `steps=2 tools=0`——第一步一个字都没吐（provider 退化），
  闸把它补回来了，但第二步答成了别的。这是 §9.6 那条 provider 问题，不是工具问题。
- Q 被 steer 之后调的是 `list_recent_activity` 而不是 `recall_memory`：结果能用，
  但"你还记得我说过什么"的正解应该是记忆检索。工具描述之间的分工还不够尖。

#### 这批顺手修掉的三个测量缺陷

1. **`--only`**：以前只能从 A 开始连续跑，验 4 个新工具要付 21 轮的钱。
2. **落库正文按 run 取**（`run.assistant_message_id`）。原来查的是"会话里最后一条 assistant"，
   而**用户此刻正在桌面端跟她聊天**（同一隐式连续会话）——两次把真实用户的"大肥鱼"轮
   读成了脚本轮的结论。这类"结论来自别人的对话"是共享会话下最容易犯的读数错。
3. 每轮打印 `工具: name=status`。`tools=2` 只给个数，看不出"调了哪个、成没成"，
   而这一批的结论全在名字上。

#### 验证快照

worker `tsc --noEmit` 干净，单测 **673/673**；shared 干净，**328/328**；
api 干净，**1393/1394 + 1 skip，0 失败**；desktop 干净，**1031/1031**；
agent postgres 集成 **8/8**（跑的时候需停 dev worker，跑完已恢复，容器 healthy）。

#### 测试在这台 dev 库里留下的东西（需要时可回滚）

- 软删了记忆"用户习惯在图书馆三楼复习。"（`deleted_at` 已置，`SELECT` 恢复即可）；
- `pet_profiles.boundaries` 多了 `catchphrase="就这么定了"`，`revision` 48 → 50
  （`set_activeness` 那次写回了原值 `active`，无净变化）；
- 真机对话里多了 5 条脚本轮 + 若干条提取出来的新记忆（live 27 → 46，soft-deleted 2 → 3）。
- **一条待兑现提醒留着没删**：`4cac04e7…`，"把消防疏散路线再背一遍…"，`fire_at=2026-09-22 01:00Z`
  =本地早上九点。它是 `companion_schedule_reminder` 走真机写进来的，时区换算正确
  （模型给"明早九点"，库里落 01:00Z）。留着是故意的：明天九点它该自己响，那是
  "工具写入的提醒会按时兑现"目前唯一的真证。不想看就 `UPDATE … SET status='cancelled'`。

### 9.24 她的谎会自己长出"出处"：编的数字进了记忆，闸就永远不响

K–P 六轮跑完（SSE 修好之后，见 §9.25）：**K 搜笔记真调 `search_notes` 两次并答对；
L/M/P 都是零工具却答对**——L 靠上一轮工具结果留在历史里，M/P 靠 `<here_and_now>`
已经注入的任务队列与下一条提醒（这正是 §9.12 说的"环境注入该省掉那次调用"）。

**N 是唯一答错的**，而且错得最有价值：

```
第 1 轮  steps=1 tools=0  "本周你学了 23 分钟，活跃卡片 10 张，笔记 9 篇。"
真值     滚动 7 天 = 60 分钟；ISO 周 = 0；库里任何口径都不是 23
第 2 轮  steps=1 tools=0  "还是那三个数：本周 23 分钟…"   ← 更理直气壮
```

卡片数、笔记数都对，只有周时长是编的。第 3 轮加了"没查过就不许报数"的闸之后**仍然不响**，
查库才知道原因：

```
learning_context | 截至当前，用户本周累计学习时长为23分钟，拥有10张活跃卡片和9篇笔记。
```

**抽取器把她的编造写成了长期记忆**，而记忆块每一轮都注入 prompt。于是"这个数上下文里
出现过"为真，任何照上下文核对的判据都会被它洗白——一句谎话获得了自动续期的出处。

两处一起修：

1. **数字的合法出处只剩"本轮重算的那几块"**（`keepRecomputedBlocks`：`here_and_now` /
   `page_context` / `selection_data` / `grounded_target`，加上用户自己说的话）。
   `<memory_data>` 与 `<persona_data>` 不再算出处。
2. **统计量根本不该进记忆**（`isVolatileStatisticMemory`：时间窗词 + 数字量词；
   prompt 先讲规矩，服务端再拦一道并把被丢的内容 `logger.warn` 出来）。
   判据里刻意**不放"累计/总计"**：`每天总计约 40 分钟` 是用户说过的真偏好，
   误伤它比放过一条统计更糟。

改完的第四次 N：

```
steps=2 tools=1  companion_get_learning_stats=succeeded
"诶，这周涨了呢——本周 60 分钟了。活跃卡片还是 10 张，笔记 9 篇。"   ← 与库一致
统计量记忆条数 0（那一轮抽取没再写出这种行）
```

那条被污染的 `learning_context` 已删除——它是我这几轮脚本轮造出来的，留着会继续洗白。

**通用教训**：她说的话会被写进她的记忆，下一轮再变成她的"依据"。所以任何
"照上下文核对"的判据都必须先问一句：**这个出处本身是不是她上一轮生成的？**
§9.13 那个"一词回复自我复制"是同一机制的弱版——那只在历史里复制，这次是跨轮持久化。

### 9.25 SSE 探针早就断了，而"零批数"看着像"流式坏了"

五轮跑出来客户端批数全是 0，服务端却明明有 `assistant.delta=31`。不是流式坏了，是
**订阅根本没建立**：连续会话的 durable 事件有 TTL，不带 cursor 的订阅等于要求从 seq 1
全量 replay → `409 CURSOR_EXPIRED`，脚本把这个错误响应当"一帧都没收到"静默吞了。

修法：订阅前读 `next_event_seq - 1` 当游标（`event_cursor()`），并且**订阅失败必须自己喊**
（每轮 `!!! SSE 订阅失败`，汇总列出这些轮，因为它们的"批数/跨度"根本不可信）。
现在 K–P 的批数是 14/13/7/6/7/7 批、跨度 0.3–4.2 秒——抱怨 #4 的流式形态第一次有了可信读数。

同批还修了两处读数错：落库正文改按 `run.assistant_message_id` 取（用户当时正在桌面端跟她
聊天，脚本两次把真人的"大肥鱼"轮读成了自己的结论），以及每轮打印 `工具: name=status`。

### 9.26 一次并发事故（不是我改的，但要记）

08:18 另一个 workstream 在 `packages/shared/src/db-schema/note.ts` 里给 CRDT 快照列写
`import { … bytea … } from "drizzle-orm/pg-core"`——装的是 drizzle 0.45.2，`pg-core`
**没有** `bytea` 这个导出（他们自己的注释就写着要用 `customType` 自定义）。
worker 因此**崩溃循环**：容器 unhealthy、job 只入队不消费，那几分钟桌宠整个不响应，
`companion_turn_runs` 停在 `accepted steps=0 tools=0`。几分钟后他们改成 `customType` 就好了。

两条要记住的：
1. **共享 dev 栈上，别人一个 import 错误就能让我的所有真机测量静默失真**——
   跑活链路之前先看 `docker ps --format '{{.Names}}\t{{.Status}}'`，unhealthy 先处理，
   别拿"本轮 0 批 0 工具"下结论。
2. 遇到这种崩溃先确认文件归属（`git status` + 注释内容），不要替别人改他们在飞的实现。
