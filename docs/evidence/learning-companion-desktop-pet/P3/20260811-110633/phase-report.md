---
phase: P3
result: blocked
headBefore: "b5eb8d1（P3 开工前最近 commit，工作区含 P2 未提交交付）"
headAfter: "c73f9ea（HEAD；P3 交付全部在工作区未提交，见 changed-files.txt）"
ownerApproval: "用户口头批准 P3（runbook 7.3 语音阶段）；资产/法务类批准不适用（P3 无外部资产）"
previousEvidence: "docs/evidence/learning-companion-desktop-pet/P2/（P2 phase-report 未落盘，P2 交付经 complete_step 逐项签收）"
implementedScope:
  - P3-1 voice reducer：barge-in、operationEpoch 守卫、资源清理测试
  - P3-2 macOS NSMicrophoneUsageDescription + Electron trusted-origin media policy
  - P3-3 ffprobe 实测（200..60000ms、临时文件即时清理）+ /voice/transcribe Companion branch（pending artifact、§11.2）
  - P3-4 transcript → turn 原子绑定（FOR UPDATE、唯一 text block hash 精确相等、只绑一次、TTL 1h）
  - P3-5 worker 切句（≤20 段/≤2000 字/单段 ≤160/净化）+ voice.segment.ready + /voice/tts Companion branch（strict ref）+ jsonb payload 双重序列化修复
  - P3-6 playback 状态机（barge-in 清队列/fence/cooldown/mic 守卫）
  - P3-7 voice_off + SSE 映射修复（扁平 payload/顶层 runId consume-only）+ voice.segment.ready → voice.segments
  - P3-8 §11.6 crash cleanup（1h cap + server 启动清扫）+ P3 flag off 文字路径 + desktop 打包 smoke
deferredScope:
  - TTS 播放的浏览器接线（HTMLAudioElement 播放循环 + navigator.locks.request 实际获取）——状态机与事件映射已就绪，播放循环留在 P4/P6 或真机验证时接线
  - electron-main.log / renderer-console.log 真机日志（未启动真实 Electron）
  - dmg 产物（宿主 hdiutil 限制）
changedFiles: "见 changed-files.txt（工作区全量；P3 核心见 test-summary.md 覆盖文件）"
newDependencies: []
migrations:
  - 0092（P3 无新迁移；P3-3 的 voice artifacts 沿用 0088/0090/0091）
featureFlags:
  - COMPANION_DIALOGUE_V1_ENABLED（P3 flag off → 文字路径验证，reducer 24/24）
testsPassed:
  - api 全量 3010/0
  - shared 397/397
  - web companion-pet 47/47
  - 集成 23/23 cancelled 0 无残留
  - ffprobe 4/4、worker tsc 0、api tsc 0、web tsc 0
testsFailed: []
dockerServicesChecked: [web, api, worker, edge-tts]
unexplainedErrors:
  - desktop dmg hdiutil APFS 失败（宿主环境，非代码）
  - worker 组合测试 runner 挂起（既有）
  - make verify coverage gate 本地 fail-closed（CI 专用基准；测试步骤全过）
rollbackVerified: false
ownerReviewRequired:
  - Electron 真机麦克风/播放/TTS 端到端人工验证（未执行）
  - dmg 打包在 CI/其他机器完成
---

# P3 phase report — Push-to-Talk Half-Duplex Voice

## 已自动验证（自动测试 + 构建）
- runbook 7.3 步骤 3-12 全部落地：ffprobe/transcribe/turn 绑定/worker 切句/TTS branch/playback/voiceOff/cleanup/flag off。
- 验证矩阵全绿（见 test-summary.md）：api 3010/0、shared 397/397、web 47/47、集成 23/23、tsc 0、web build 17/17。
- 集成测试无残留数据（conversations/voice_artifacts 均 0）。

## 已人工验证
- desktop 打包核心：`AI Learn.app`（arm64 267M）生成成功（含可执行文件）。

## 未验证
- Electron 真机麦克风/TTS 播放端到端（§3.3 步骤 4）。
- TTS 播放的浏览器接线（HTMLAudioElement 播放循环）。
- dmg 产物。

## 被 Gate 阻塞
- P4（Production Character and Performance）：输入 Gate 缺 Owner 批准 + Live2D/Cubism/Soullink 资产与许可 → 按用户决定暂缓，维持 Sprite Driver。

---

## 更正记录（2026-08-12 审计）

原 `result: gate_passed` 与 runbook §2.4/§3.3 及 desktop-pet-handoff README §4.4 冲突：
本阶段交付代码存在且测试通过，但**真实 Electron 端到端（麦克风→ASR→TTS→播放）、dmg 产物、rollback 验证均未完成**，
runbook 规定"环境使其无法运行时阶段只能标为 `blocked`，不能标为通过"。故更正为 `blocked`。
deferredScope / ownerReviewRequired 中列出的未完成项即 Gate 缺口；TTS 播放浏览器接线已在 P6 后补接（见代码），
但真机验证仍缺失，不影响本状态。此状态不因补接自动提升。
