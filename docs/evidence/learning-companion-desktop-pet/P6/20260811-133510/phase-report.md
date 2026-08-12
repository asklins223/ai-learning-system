---
phase: P6
result: blocked
headBefore: "c73f9ea（P6 开工前最近 commit，工作区含 P2–P5 未提交交付）"
headAfter: "c73f9ea（HEAD；P6 交付全部在工作区未提交，见 release input verification）"
ownerApproval: "用户批准 P6（「p6 的我批准了」）；语音方向：用户选「保持现状，P6 只做硬化」（streaming 保持 blocked，不引入新 provider/费用/协议）"
previousEvidence: "docs/evidence/learning-companion-desktop-pet/P5/20260811-130140/"
implementedScope:
  - P6-1 AudioWorklet bounded buffer 基础件（BoundedAudioBuffer 环形缓冲、满丢最旧、fillRatio 水位；6/6 单测；AudioWorklet 处理器接线因去 streaming 决策搁置）
  - P6-5 macOS 回归（api 3010/0 + tsc 0、web tsc 0 + build 17/17、AI Learn.app 274M/0.5.0、migrate 根治后 0 to run）
  - P6-6/7 跨平台代码审查（darwin titleBar/linux click-through 分支、DPI scaleFactor、音频在 renderer）+ Windows/Linux 真机待验证
  - P6-8 tray/menu bar（纯逻辑 6/6 + Electron Tray 接线失败安全 + main.ts 接线 + builder 图标）+ 自动更新状态机（失败回滚语义、未冻结更新源 not-supported）
  - P6-9 可访问性验证（键盘/读屏 aria-label/role/aria-live 已具备、reduced motion gate 4/4、200% zoom 固定 px 仅控件尺寸）
  - P6-10 24h soak 采样器（§10.4 全类别 + 脱敏 5/5）+ 故障矩阵（12 场景）+ 隐私审计
  - P6-11 旧 Anchor/Panel 删除 Gate（无代码引用 → 可删；删除需 Owner 显式确认 + 先 commit/归档）
  - P6-12 release manifest（0.5.0 生成 + contract 校验）+ make release-check（阻塞于工作区未提交，记录）
  - 根治：容器 migrate journal（migrate.ts 逐条 hash 跳过，不再受最新 created_at 影响；96 total 0 to run；新迁移 smoke 验证）
  - 许可修正：Mao PRO 免费（Owner 确认，commercialReleaseAllowed=true，manifest/测试/NOTICE 同步）
deferredScope:
  - streaming voice（按用户决策保持 blocked；README streamingVoiceTransport 未改）
  - Windows/Linux 真机验证（P6-6/7）
  - 24h soak 真机采样（休眠/锁屏/断网/拔插/更新回滚演练）
  - Electron 真机启动/GPU/OS DPI/放大镜验证
  - 旧 Anchor/Panel 实际删除（需 Owner 确认 + commit 后）
  - electron-updater 依赖接入（更新源未冻结）
  - release commit（工作区 P2–P6 未提交——release-check 前置阻塞）
changedFiles: "见 changed-files 工作区全量；P6 核心：apps/desktop/src/{tray-menu,tray-runtime,update-state,soak-sampler}.ts + .test.ts、main.ts、electron-builder.yml、apps/web/features/companion-pet/voice/companion-audio-buffer.ts + .test.ts、apps/api/src/db/migrate.ts、THIRD_PARTY_NOTICES.md、manifest.json、docs/evidence/.../P6/"
newDependencies: []
migrations:
  - 0096 临时 smoke 迁移（验证根治后清理，无残留）
featureFlags:
  - COMPANION_ACTION_BRIDGE_V1_ENABLED（P5，P6 未改）
  - streamingVoiceTransport 保持 blocked（README desktop-pet-handoff）
testsPassed:
  - api 3010/0 + tsc 0、web tsc 0 + build 17/17、desktop tsc 0
  - desktop tray/update 6/6、soak 5/5、web audio-buffer 6/6、live2d-gate 4/4
  - migrate 96 total 0 to run（根治后）
  - release manifest 0.5.0 生成 + contract 校验（非 release tag not required）
testsFailed:
  - make release-check（verify-release-inputs：checkout 不干净 + migration SQL 未 git 跟踪——工作区未提交，非代码问题）
dockerServicesChecked: [postgres, api, worker, web, edge-tts, minio]
unexplainedErrors:
  - 同 P5 既有（dmg hdiutil、coverage gate 本地 fail-closed、worker 组合 runner、buildx 权限）
rollbackVerified: false
ownerReviewRequired:
  - release 前 commit 策略（工作区 P2–P6 全部交付未提交——release-check 前置阻塞）
  - 旧 Anchor/Panel 删除确认（铁律：非本会话文件不删除，需 Owner 显式确认）
  - Windows/Linux 真机 + 24h soak + Electron 真机启动（CI/真机）
  - streamingVoiceTransport 保持 blocked（如需 streaming 另行批准 provider + wire contract）

---

## 更正记录（2026-08-12 审计）

原 `result: gate_passed_with_known_issues` 不是 runbook §3.2 枚举值（合法值为
`gate_passed | blocked | changes_requested`），且与 README §4.4"不得提前标记 P3/P5/P6 完成"冲突：
release-check 阻塞、24h soak 未执行、Windows/Linux 真机与签名升级回滚未验证、旧代码未删除，
按 runbook 只能标 `blocked`。P6 §13 本地 ASR / 流式 TTS 基础件为死代码（仅测试引用、模型资产不在仓库），
streaming 保持 Owner blocked 属有意；上述缺口全部保留在 ownerReviewRequired。

## 更正记录（2026-08-12 streaming 解除）

Owner 于 2026-08-12 交互解除 streaming voice blocked（授权记录见 README §4.5）。
本 phase-report 的 `result: blocked` 与 `streamingVoiceTransport 保持 blocked` 条目
已被该授权取代：本地 SenseVoice（sherpa-onnx-node native utility process，取代冻结
文本中的 WASM，Owner 确认）+ SiliconFlow 降级 + edge-tts 流式已接线（README §8）。
**接线完成不构成 P6 完成**：真实 Electron 麦克风/AudioWorklet/edge-tts 端到端、
Windows/Linux 真机、24h soak、签名升级回滚仍未验证，P6 整体仍为 blocked 直至这些
Gate 以真实证据通过。
