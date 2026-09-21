# Third-Party Notices

本应用（AI Learn desktop client）包含以下第三方组件的源码、二进制或素材。
许可证全文见各条目链接；模型/素材的再分发与商用限制见
`apps/desktop-client/src/renderer/public/assets/companion/live2d-v1/manifest.json`。
当前开发中的用户自有角色还记录在
`apps/desktop-client/src/renderer/public/assets/companion/live2d-v2/seethrough/manifest.json`。

## Yjs（`apps/api`；后续 `apps/desktop-client`）
- 用途：笔记正文的协同内核（headless Y.Doc 是唯一的正文写入路径，`note_blocks` 由它派生）
- 许可：MIT License
- 来源：https://github.com/yjs/yjs
- 引入批次：批次 4（4.0 前置验证已通过，见 `apps/api/src/__tests__/note-doc-collab-kernel.test.ts`）

## Hocuspocus（`@hocuspocus/server` + `@hocuspocus/common` 4.7.0，`apps/api`；`@hocuspocus/provider` 同版本，devDependency 用于协同契约测试，批次 4.3 将由 `apps/desktop-client` 主进程使用）
- 用途：把 Yjs 同步协议接成服务端 WS 通道（`apps/api/src/modules/note/collaboration.ts`）；
  升级仍由 `@fastify/websocket` 完成，本组件只吃 `handleConnection` + 宿主接线的
  `handleMessage`/`handleClose`
- 许可：MIT License（Copyright (c) 2023, Tiptap GmbH；企业版模块不在依赖树里）
- 来源：https://github.com/ueberdosis/hocuspocus

## y-protocols（1.0.7）与 lib0（0.2.117）（`apps/api`；后续 `apps/desktop-client`）
- 用途：Yjs 的同步/awareness 协议编解码与工具库，是 Hocuspocus 的运行时依赖
- 许可：MIT License
- 来源：https://github.com/yjs/y-protocols 、https://github.com/dmonad/lib0

## PIXI.js（`apps/desktop-client`）
- 用途：Live2D 渲染器宿主
- 许可：MIT License
- 来源：https://github.com/pixijs/pixijs

## Live2D Cubism Core（`apps/desktop-client/src/renderer/public/assets/companion/vendor/`）
- 用途：Cubism 模型运行时
- 许可：Live2D Proprietary（Cubism Core SDK License；商用需遵循 Live2D 收入/规模条款）
- 来源：https://www.live2d.com/sdk/download/web/

## Live2D Cubism 4 Web SDK（`apps/desktop-client/src/renderer/public/assets/companion/vendor/`）
- 用途：Cubism 4 模型加载与驱动
- 许可：Live2D Proprietary（Cubism SDK License；商用需遵循 Live2D 条款）
- 来源：https://www.live2d.com/sdk/download/web/

## Mao PRO（Live2D 角色模型，`apps/desktop-client/src/renderer/public/assets/companion/live2d-v1/mao-pro/`）
- 用途：桌面宠物角色模型（P4 production，Owner 批准 2026-08-11；2026-08-11 确认免费）
- 仓库：EchoBot（MIT，锁定 commit `08e97a4a33b2ab611d24dd997038c1ec95ac6926`）
- 模型素材许可：Live2D Free Material License Agreement and Terms of Use
  （https://www.live2d.com/en/download/sample-data/）
- 限制：免费使用（个人与商业，**无需商业许可**——Owner 确认 2026-08-11，
  `commercialReleaseAllowed=true`）；不得再分发模型文件本身（`redistributionAllowed=false`）。

## Seethrough（用户提供的 Live2D 角色模型，`apps/desktop-client/src/renderer/public/assets/companion/live2d-v2/seethrough/`）
- 用途：本地开发验证；由 `seethrough_output.psd2live` 经 PSD2Live 0.7.1 导出。
- 模型许可：所有权与再分发范围待确认；manifest 标记
  `commercialReleaseAllowed=false`、`redistributionAllowed=false`。
- 限制：确认权利前不得发布或再分发模型文件；运行时已允许本地开发加载。

## EchoBot-LICENSE（仓库 MIT 许可副本）
- 位置：`apps/desktop-client/src/renderer/public/assets/companion/live2d-v1/EchoBot-LICENSE`
- 覆盖：EchoBot 仓库源码（不含 Live2D 模型素材本身的许可限制）

## sherpa-onnx-node
- 用途：P6 §13 本地 SenseVoice ASR（Electron utility process 内运行；onnxruntime
  推理 + sherpa-onnx C API 绑定）
- 许可：Apache-2.0（含平台二进制包 `sherpa-onnx-darwin-arm64` 等；onnxruntime
  为 MIT）
- 来源：https://github.com/k2-fsa/sherpa-onnx（npm `sherpa-onnx-node@1.13.5`）
- 说明：native addon 随应用打包（asarUnpack）；运行时不持有任何 API Key

## SenseVoice 模型（设备本地，不入仓库/打包）
- 位置：设备本地模型目录（`ASR_SENSEVOICE_MODEL_DIR`；开发机
  `/tmp/sherpa-onnx-models/.../model.int8.onnx` + `tokens.txt`）
- 用途：本地 ASR（P6 §13 local_streaming 路由）；性能探测未通过时自动降级
  SiliconFlow 云端转写
- 许可：Apache-2.0（模型源自 FunAudioLLM/SenseVoice，经 sherpa-onnx 转换为
  ONNX int8；sherpa-onnx 官方模型页以 Apache-2.0 分发）
- 来源：https://github.com/FunAudioLLM/SenseVoice ；
  https://github.com/k2-fsa/sherpa-onnx（asr-models release）
- 说明：**不随应用分发**；应用仅在模型目录存在时启用 local_streaming，
  缺失/探测失败时 fail-closed 到云端/文字降级
