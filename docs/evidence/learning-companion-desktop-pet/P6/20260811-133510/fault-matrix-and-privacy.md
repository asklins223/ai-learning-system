# P6 顺序 10：故障矩阵 + 隐私审计（evidence）

## 故障矩阵（错误场景 → 行为 → 恢复）

| 场景 | 行为 | 恢复/降级 |
|---|---|---|
| Electron main 启动崩溃 | startupSequence catch → logger.error（不静默） | 用户重启；日志不记录正文 |
| 内嵌 web server 启动失败 | 启动序列报错，窗口不创建 | 重启重试；无数据损坏（DB 在 api） |
| Pet 窗口 webglcontextlost | Live2DCharacterDriver onStatus(failed) → PetCharacterCanvas 切 Sprite 回退 | 自动降级动画（P4-4 已交付） |
| API 不可达（对话 turn） | turn 请求失败 → 客户端错误态 | 可重试；错误计数入 soak（recent_error_count） |
| Worker job 失败 | run failed + action.failed event（P5-4/5-5） | result 消息保留失败语义；可重试（accepted 状态 fence） |
| TTS/ASR provider timeout | /voice/tts|transcribe 4xx/5xx fail closed（P3-3/3-5） | 客户端降级文字；错误码入 soak |
| 显示器拔插 | display-added/removed → Pet 位置重算（main.ts） | petState.applySavedPosition + 生命周期广播 |
| 系统休眠 | powerMonitor suspend → Pet 隐藏 + 生命周期广播 | 唤醒恢复（display/activate 事件） |
| 自动更新失败 | UpdateStateMachine → error（保持当前版本） | 失败回滚语义（旧版可运行，P6-8） |
| 麦克风权限拒绝 | voice 状态机 → voice_disabled + 文字路径（P3） | 降级文字输入 |

## 隐私审计

- **日志不记录消息正文**：main/renderer logger 记录错误码/类别；soak 采样器对自由文本一律脱敏丢弃（白名单枚举/数字才可进入快照，`sanitizeSoakValue`）。
- **语音链路**：audio 上传仅用于一次性 ASR；临时文件即时清理（P3-3 ffprobe 1h cap）；grant signature 不落库（P5-6：只存 permissionSnapshot，不存 raw grant/signature）。
- **proposal/事件**：proposal payload 存服务端构造的 canonical 数据；job payload 只含 opaque id（conversationId/runId/actionRunId），不复制正文。
- **soak 采样**：§10.4「最近错误计数，不记录消息正文」→ 采样点值经 `sanitizeSoakValue` 过滤（URL/正文/标题/对象一律拒绝）。

## 24h soak

- 采样器代码：`apps/desktop/src/soak-sampler.ts`（默认间隔 30min，§10.4 最低采样；快照 version/seq/样本，脱敏规则可测 5/5）。
- 采样类别已覆盖 §10.4 清单：CPU/内存/GPU/窗口/track/AudioContext/SSE/timer/Pet 坐标/display fingerprint/click-through/API·Worker restart/DB 连接/job backlog/错误计数。
- 真机采样执行（休眠/锁屏/断网/显示器拔插/更新回滚演练）需人工真机 —— 记录为 known-issue。
