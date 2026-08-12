---
phase: P1
result: passed
scope: "Surface Prototype runtime：Sprite/Live2D 角色渲染、bubble、composer、两级菜单、确认卡、browser fallback、统一视觉设计语言与 G01-G12 证据"
ownerApproval: "docs/plans/learning-companion/desktop-pet-handoff/README.md §4: approvalStatus=approved, approvedAt=2026-08-10T14:40:32Z, approvedBy=user (Owner), approvedPhases=[P1]（Owner 授权代填）；visual-review.yaml ownerApproved=true（Owner 2026-08-10 确认）；LICENSE.json 权属/修改/商用/再分发 approved（8 张图为 Owner 自有资产）"
previousEvidence: "docs/evidence/learning-companion-desktop-pet/P1/20260809-203110/phase-report.md"
implementedScope:
  - "packages/shared: companion-character-contracts.ts（SpriteManifest/LICENSE strict schema、evaluateSpriteLicense fail-closed、CharacterCue、presentation→pose 映射）+ 子路径 exports"
  - "资产 fail-closed validator（sha256 逐文件 + shape + license 三层校验），真实 sprite-v1 包验证为 prototype 模式"
  - "SpriteCharacterDriver：canvas 局部坐标绘制、footAnchor/petScale 变换、呼吸/单次弹跳、alpha mask hitTest、reduced motion/隐藏时停止 ticker"
  - "七域 reducer P1 子集（02 §1-§5）：composer/turn/bubble/menu/lifecycle/voice fixture、generation/cursor guard、deriveCharacterPresentation 固定优先级"
  - "bubble 模型（01 §6）：优先级、中英切句、分段窗口、TTL clamp、长内容/URL 处理"
  - "PetSurface/PetBubble/PetComposer/PetMenu：560×520 布局、bubble-left/right 镜像、菜单固定顺序 + 未到阶段项 disabled、键盘/Esc/focus、语音状态最高优先级投影"
  - "desktop adapter（typed preload 桥接 + browser no-op）、hit geometry 注册（revision 递增）"
  - "pet page 重写：bootstrap（auth/global_off/browser 降级）、账号投影接入 provider、P1 flag fail-closed、__PET_DEMO__ 证据 API"
  - "完整对话占位页 /companion/conversations（明确标记 P2 接入）"
  - "浏览器 fallback（InAppPetHost）：standard 560×520 pinned + compact 96×132 按钮与 bottom popover"
  - "page-coverage registry 新增 /companion/pet 与 /companion/conversations 分类"
deferredScope:
  - "P1 visual approval G01-G12 的 Owner 签署（visual-review.yaml 已生成，ownerApproved=false）"
  - "Level A LICENSE.json 权属批准（权限字段保持 false，运行时 fail-closed）"
  - "make verify 全绿（既有 verify-schema-mirror Gate，P0 known-issue，未改 DB）"
  - "P2 真实文字对话 / P3 语音 / P4 Live2D / P5 学习动作"
testsPassed:
  - "packages/shared: 384/384"
  - "apps/web lib: 761/761（含新增 isCompanionPetV1Enabled fail-closed 测试）"
  - "apps/web features/companion-pet: 41/41（重跑于 2026-08-10 视觉重构后）"
  - "apps/desktop: 14/14"
  - "apps/web host npm run build（含 /companion/pet、/companion/conversations 路由，重构后重跑）"
  - "docker dev compose web build（最新代码重建）+ /companion/pet 200 + 容器日志无 import/build/runtime error（重构后重跑）"
  - "browser fallback smoke（runbook 5.5）：15/15 PASS（重构后重跑，apps/web/scripts/pet-fallback-smoke.mjs）"
  - "Electron dev:build 真实启动 + 登录 + Pet Window surface + 截图采集（2× DPI 1120×1040）"
testsFailed:
  - "make verify 停在既有 verify-schema-mirror Gate（P0 known-issue，与 P1 无关，未改 DB/迁移）"
  - "生产 compose 的 migrate 容器读取 /tmp/shared 源文件 EACCES（Dockerfile COPY 在 macOS buildx 下保留 600 权限；dev compose 挂载宿主文件不受影响，CI 需自行确认）"
unexplainedErrors: []
ownerReviewRequired:
  - "审阅 G01-G12 截图并在 visual-review.yaml 勾选 ownerApproved"
  - "确认 Level A LICENSE.json 权属/修改/商业使用/再分发并填写 approvedBy/approvedAt"
  - "真实桌面透明穿透、焦点、双屏 Retina 实机确认（capturePage 保留 alpha，工具以黑底合成显示）"
  - "README.md §4 approvedAt/approvedBy 补填"
knownIssues:
  - "角色边缘在部分合成/缩放下有轻微光晕（透明边缘抗锯齿伪影，资产层 hidden-RGB 已清理）"
  - "G05_streaming 与 G05_final 文字内容相同（fixture 回复短，delta 快速完成；状态标签有差异）"
  - "G08/G09 为 fixture 语音状态（P1 不接 ASR/TTS，P3 真实接入）"
feedbackRevision20260810:
  - "用户反馈（fit 1.5 版）：1) 角色仅半身（fit 1.5 放大把腿部裁出 244×300 容器）；2) 气泡/选择框在 y=24 顶部、与角色 y≈217 之间有约 190px 空白，视觉上离角色远"
  - "修复 1：fit 改用 Cubism internalModel.getModelBounds()（比 PIXI localBounds 准确、包含全部部件）+ scale fit×1.1 + 脚底锚定 y=504 → 全身完整可见（像素实测角色 y 217–497，占容器近满高、帽子不裁）"
  - "修复 2：模型水平左缘贴容器左缘（消除透明边距视觉偏移）→ 气泡/输入框/菜单与角色间隙 8–32px（像素实测 G02 32.5 / G03 24.5 / G05 11 / G06 8 / G08 14.5 CSS px，均为紧邻）"
  - "修复 3：bubble top 24→180、composer top 208→272（贴近角色头部/身体）；01 合同 §2.2 布局表同步更新 + Live2D dev 适配说明（模型左贴容器、foot 水平随模型宽度浮动 ≈x305、脚底 y=504 锚定）"
  - "证据：G01–G12 已按修复后布局重新采集（真实 Electron 2× 截图，vision + PNG alpha 像素双验证）"
  - "用户反馈 v3（截图确认后）：气泡仍在左上角远处 → 移到角色头顶正上方（x=264 对齐角色容器、y0..72、底边距角色头顶 28px、尾部指向角色）；选择框/二级菜单按钮离角色远 → 菜单右移贴角色左缘（x=84，间隙约 10px）、trigger 移到角色身体左/右侧（x=310/206，浮在角色身上明确归属）；角色偏小 → Live2D stage 扩为右侧全高列（260×520，超出 244×300 Sprite slot），fit×0.95 → 角色 394×250 CSS（占窗口高 76%、宽 45%，相对初版约 ×1.43）"
  - "用户反馈 v4（重构，Owner 指示『改了很多版本全是烂的，建议重构』）：彻底重写 Live2D 定位。诊断结论：pixi-live2d 的 getBounds/position 语义不可靠（centeringTransform 偏移 + 透明边距 + PIXI 清屏色污染 readPixels），此前多轮 patch 全部基于这些不可靠 API。重构为纯几何定位：anchor(0.5,0.5) 下 position=模型画布中心、getBounds 高=originalHeight×scale（probe 实证）；scale=目标高/originalHeight、position=(画布宽/2, 504-354/2) → 画布 354×244 CSS、顶 y150、底 y504。实测：角色不透明渲染 y182-494（312px）、帽顶完整不被裁、气泡（0..140）不遮头、菜单贴角色左缘。删除 readPixels 校准与每帧 ticker（曾互相竞争导致读数混沌发散）。全量测试 761+41 通过。"
  - "用户反馈 v5：1) 气泡内按钮 UI 有问题（确认按钮文字过长挤压）；2) 长文本气泡会挡脸，需要限高+滚动+跟随最新；3) 确认框（需用户操作）应换展示方式。处理：a) 长文本预览改内部滚动区（.pet-bubble-scroll max-height 116px、细滚动条、auto-stick 跟随最新内容——用户手动上翻暂停跟随、回到底部恢复；保留『查看完整内容』入口）；b) 确认框从气泡拆出为独立浮层卡片 PetConfirmationCard（角色左侧 x16 y288、菜单同视觉语言、标题+可滚动内容区+固定竖排按钮区、主按钮带『将在学习能力阶段开放』caption）；c) 按钮 white-space:nowrap 防换行。验证：真实 Electron 长文本 streaming 时 scrollable=true 且 atBottom=true（scrollTop 65.5/181）；G10 截图确认卡片按钮无溢出；web 761/761 全绿。"
  - "用户反馈 v6（视觉重构，Owner 指示『毛毛躁躁、没有成熟产品设计的样子，不好就全部抛弃重做』）：全面重写 pet.css 为统一设计语言——所有浮层（气泡/输入框/菜单/确认卡）共享面板样式（surface-raised 93% 磨砂 + blur 14px、中性边框、16px 圆角、单一柔和阴影）；状态仅用左侧 3px 圆角色条（running/warning/danger），取消彩色边框与渐变；触发点 44px→32px hover 淡入、拖动点 44px→20px 低调；按钮统一 12px 圆角；voice 脉冲改单色柔和扩散；badge 弱化。vision 复核：G03 输入框『精致现代』、G06 菜单『干净统一无彩虹』、G08/G11 『干净简洁』。web 761/761 全绿。"

live2dDevPreview:
  - "按 Owner 指示恢复 Live2D 渲染层：Live2DCharacterDriver（Mao PRO 临时 dev 模型，live2d-dev/ 原有资产）优先渲染，加载失败自动回退 Owner 角色 Sprite（PetCharacterCanvas 双渲染器）"
  - "新 presentation(11 状态)→Mao PRO 动作映射（live2d-motion-map.ts：idle→Idle/0、invite→mtn_02、think/uncertain→mtn_04、navigate→mtn_03、encourage→special_03、celebrate→special_01 等），点击角色触发一次 invite 动作后回待机"
  - "仅非 production 构建启用（Mao PRO 为 dev 占位，P4 前不进入生产；正式角色 Live2D 仍受 §11.4 权属/Cubism 许可 Gate）"
  - "验证：浏览器 9/9 PASS（Live2D 加载/PIXI/Cubism/canvas/点击/无错误）；vendor 脚本拦截→Sprite 回退 PASS（data-renderer=sprite）；真实 Electron 内 rendererMode=live2d；G01-G12 截图已更新为 Live2D 渲染版"
  - "browser fallback（InAppPetHost）补登录 bootstrap：未登录不显示 fallback（它是登录用户的伴星，不是页面挂件）"
  - "Live2D 清晰度/尺寸修复：PIXI resolution=devicePixelRatio + autoDensity（canvas 244×300 → 488×600 @2×，消除 Retina 模糊）；fitModel 放大至 1.5 并锚定容器底部（vision 实测：角色占画面约 1/5 高度、帽子完整无裁切、清晰）"
  - "拖动实现（合同 6.4 + Owner 指示）：renderer pointer 手势（角色本体 + drag handle，位移>6px 判定拖动并抑制误触 click）+ typed IPC dragBy（shared DesktopPetApiV1 / ipc pet:drag-by / main onDragBy：locked 时忽略、setPosition + setWindowPosition 持久化）；放弃 -webkit-app-region（passive 忽略鼠标时不可靠且不持久化）；drag handle 默认半可见"
  - "验证：真实 Electron 拖动手势移动窗口 1352,455→1448,535（PASS）；直接 dragBy 移动 +80,+50（PASS）；locked 忽略拖动（PASS）；注意 Electron 需重新编译 dist（esbuild）后生效"
lateAdditions:
  - "拖动触点（合同 6.4）：.pet-drag-handle 使用 -webkit-app-region: drag / app-region: drag（Electron 原生窗口拖动）；角色/气泡/composer/菜单/触发按钮显式 no-drag；真实拖动待 Owner 实机确认"
  - "browser fallback smoke（runbook 5.5）：standard/compact 模式切换、560×520 右下 8px、pointer-events 分区、透明 root 点击穿透、200% zoom → compact、resize 双向切换、reduced motion dots 关闭 —— 15/15 PASS（apps/web/scripts/pet-fallback-smoke.mjs）"
flagRollback:
  - "无 NEXT_PUBLIC_COMPANION_PET_ENABLED 启动真实 Electron：Pet Window 显示「桌宠功能未启用」，.pet-surface-root 不渲染（fail-closed，runbook 5.4 第 11 步）"
  - "旧 surface（anchor/panel）未被 P1 触碰：AppShell 无改动，/companion/pet 为独立路由"