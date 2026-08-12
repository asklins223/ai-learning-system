# 学习伴星外部参考项目

本目录保存桌宠式 AI 学习伴星重构所需的外部源码快照，仅用于本地研究、架构验证和许可证审计，不属于 AILearn 产品源码，也不进入应用构建、打包或发布产物。

源码位于 `repos/`。每个目录保留独立的 `.git`，采用浅克隆（`--depth 1`）；父仓库通过 `.gitignore` 排除整个 `repos/`，避免误提交第三方源码。

| 本地目录 | 上游仓库 | 许可证 | 主要参考范围 |
| --- | --- | --- | --- |
| `repos/EchoBot` | <https://github.com/KdaiP/EchoBot> | MIT | 快回复/慢任务分层、角色对话与 Live2D 交互 |
| `repos/airi` | <https://github.com/moeru-ai/airi> | MIT | 透明桌宠窗口、对话运行时、语音生命周期与渲染适配 |
| `repos/soullink-emotion-sdk` | <https://github.com/nanlingyin/soullink-emotion-sdk> | MIT | VAD/FACS/Idle/口型和模型 profile |
| `repos/Meochat-APP` | <https://github.com/Mios-dream/Meochat-APP> | GPLv3 | 透明命中、点击穿透、播放队列；仅洁净室参考 |
| `repos/MoeChat` | <https://github.com/AlfreScarlet/MoeChat> | GPLv3 | 文本流、句子级 TTS 与音频事件；仅洁净室参考 |
| `repos/see-through` | <https://github.com/shitagaki-lab/see-through> | Apache-2.0 | 单图离线分层与 PSD 资产流水线 |

## 使用边界

- 先阅读各仓库自己的 `LICENSE`、`NOTICE` 和资产说明；本清单不是法律意见。
- `Meochat-APP` 与 `MoeChat` 的代码、注释、样式、资源、测试和协议文本不得复制进本项目，只能观察公开行为并独立重新设计。
- MIT/Apache-2.0 项目若产生实质代码复用，必须保留许可证、版权与 NOTICE，并在合并前重新审计确切版本。
- Live2D Cubism Core、Live2D 模型以及角色原画拥有独立许可，不由参考仓库的开源许可证覆盖。
- 不在这些参考仓库内安装依赖、运行不受信任脚本或提交本项目凭据。

确切源码 commit 由本目录的 `SOURCE_LOCK.md` 记录；每次主动更新上游后必须同步更新该文件和重构方案中的审计快照。
