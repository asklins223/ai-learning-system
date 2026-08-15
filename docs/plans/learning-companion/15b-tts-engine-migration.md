# TTS 引擎迁移与字幕般流式（15b）

> 状态：**已实施并真机验证（2026-08-12）**
> 关联：15-companion-chat-emotion-migration.md、15a-pet-quick-wins-priority.md

## 目标

1. TTS 引擎可配置：`config/ai-platforms.json` 新增 `tts` 节点，`engine: "qwen" | "edge"`（默认 qwen）；
2. qwen-audio-3.0-tts-flash（音色 longanlingxi 龙安灵希）实时流式合成；
3. **字幕般效果**：worker 在 delta 生成过程中增量切段下发，前端边收段边合成边朗读。

## 实施内容

### worker：delta 级增量切段
- `tts-segments.ts`：新增 `splitCompanionTtsSegmentsIncremental`（完整句立即切出、未完成句留 rest、final flush、上限按累计维护）；
- `companion-dialogue.ts`：
  - `runStreamingDialogue` flush 后增量切段 → `emitCompanionTtsSegment`（独立事务 fence+seq+NOTIFY）逐个下发 `voice.segment.ready`；
  - provider 完成后 final flush 剩余句；
  - 非流式路径（chatCompletion 回退）validate 后全量切段；
  - **终态事务不再携带 segments**：事件布局变为 final @ eventStart、cue @ +1、action.proposed @ +2。

### api：qwen-audio-3.0-tts-flash provider
- `voice-providers/qwen-tts.ts`：`qwenTtsSynthesizeStream`——WebSocket 原始协议（run-task → task-started → continue-task → 音频二进制帧 → finish-task → task-finished），北京地域 `wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`，鉴权 `bearer ${DASHSCOPE_API_KEY}` + `X-DashScope-DataInspection`，超时/错误/取消（连接关闭即终止）处理；
- `voice-providers/tts-config.ts`：读取 config tts 节点（多路径回退 + env 兜底）；
- `voice-routes.ts` `/voice/tts/stream`：请求 `engine` 显式优先，缺省 config（qwen）；qwen 分支 chunked 透传音频；
- shared `companionTtsStreamRequestV1Schema`：+ `engine` 枚举、ordinal 上限 20→200；
- api 依赖 +`ws`；tsconfig exclude shared `*.test.ts`；`CompanionConversationError` code 类型 +`CONTEXT_STALE/NO_ACTIVE_SESSION/NO_CANDIDATE`（15a 遗留类型修复）。

### 前端：流水线预取
- `companion-stream-player.ts`：`prefetchNext()`——播放段 N 时并行发起段 N+1 fetch（enqueue 时也立即预取）；barge-in abort 全部在途预取；预取失败回退现场 fetch（保留失败重试一次）；
- 引擎由服务端决定，前端请求无需带 engine。

### config
- `config/ai-platforms.json` 新增 `tts` 节点（engine=qwen、qwen{model/voice=longanlingxi/format/sampleRate/workspaceId=llm-55ujpy2wafojbdp8}、edge 兜底）。

## 验证（真机）

- **API 实测**：`POST /voice/tts/stream`（默认 qwen）→ 200，52KB MP3（22.05kHz）0.8s；engine=edge → 200（回归）；
- **字幕般真机（CDP）**：发长文本 → 气泡"回复生成中"（文字流式）同时 voice=speaking 朗读；DB 事件序列确认 `voice.segment.ready`（seq 585）出现在 `assistant.delta`（569-584、586+）**中间**——段事件在 final 前、delta 过程中逐个下发；
- 全量：worker 1064/1064（+3 增量切段）、web 1008/1008（+2 预取）、api 3036/3036、shared 413/413、双端 tsc、`git diff --check` 干净。

## 已知限制 / 后续

- qwen 每段一次独立 WS 任务（连接复用为后续优化——文档：task-finished 后 60s 内可复用）；
- 音色固定 config.qwen.voice（前端"伴星语音设置"的音色仅对 edge 生效）；
- 容器依赖：api 容器 node_modules 需含 ws（npm ci 后 file: 依赖空壳问题——从 /tmp/shared 恢复，正式环境重建镜像即可）。

## 15c 追加（2026-08-12）：对话质量修复

- **对话模型升级**：`task-router.ts` `companion_dialogue` 从 `text_generation`（siliconflow-chat + THUDM/GLM-4-9B-0414，9B 小模型质量差）切换到 `agent_turn`（tokenrhythm + deepseek-v4-flash-0731）；轻量任务保持 GLM。实测："今天天气怎么样" → "这个我还不知道，我无法获取实时天气信息呢…"（不再编造）。
- **persona-v2 加强**（hash 5b9550…）：不编造实时信息（"这个我还不知道"）、先接住情绪、不重复之前内容；grounded tutor prompt 同步加强（无关问题不套模板、纯文本、不重复）。
- **卡 speaking 根因修复**：reducer M3 分支推进 `voice.segmentId`（多段同 run 时 onDrained 回传最后一段，原停留在第一段导致 playback_finished 校验失配 → voice 永久卡 speaking）。
- **连续对话无声修复**：api `withQwenConcurrencyLimit`（qwen 合成全局串行队列，防阿里限流）。
- 验证：shared 414、worker 1066、web 1008、api 3036、双端 tsc、`git diff --check` 干净。
