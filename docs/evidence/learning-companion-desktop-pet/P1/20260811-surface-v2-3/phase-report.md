# P1 角色语音表面 V2.3 回归报告

- 日期：2026-08-11
- 结果：通过实现与自动/人工回归，等待 Owner 最终视觉确认
- 阶段声明：`Surface Prototype / P1 Fixture`，本轮不宣称已经接入真实麦克风、ASR、TTS 或 AI 对话服务
- 工程基线：当前工作区（包含用户既有未提交改动）

## 本轮重构范围

- 撤销上一版活动语音的大气泡、图表式波形、彩色轨道和“声音转文字”流程卡；
- 活动录音、识别与播报统一改为角色外置麦克风旁的 `178×58` 紧凑流体语音岛，不占用对话 bubble；
- listening 使用旋转彩色色场与呼吸声纹，finalizing/transcribing 在同一流体核心中原地收束为识别脉冲，speaking 使用反向流动；
- 外置麦克风继续采用点按切换：第一次开始录音，第二次结束并进入识别，不存在长按、松开提交或滑动取消语义；
- 识别按钮使用独立星芒状态，不再与语音岛重复显示两组三点加载；
- 语音岛、按钮和其他角色表面均保持 `box-shadow:none`，不使用灰黑投影或 backdrop 暗底；
- 活动语音时自动收起 quick toolbar 与辅助 drag handle，修复真实 Electron hover 状态下的叠层；角色本体仍可点击和直接拖动；
- `data-motion=reduced` 与系统 `prefers-reduced-motion` 下停用循环动画和状态转场。

## 自动验证

| Gate | 结果 |
| --- | --- |
| Web `npm test` | 842/842 PASS |
| reducer / gesture / drag transport / voice visualizer 聚焦测试 | 33/33 PASS |
| Desktop `npm test` | 14/14 PASS |
| Web lint | PASS（0 warning） |
| Web / Desktop typecheck | PASS / PASS |
| Web / Desktop production build | PASS / PASS |
| 真实 Electron interaction | 14/14 PASS |

真实 Electron 断言见 [interaction-report.json](./interaction-report.json)。关键结果：

- 第一次点按外置麦克风进入 listening，第二次点按进入 transcribing，fixture transcript 回到可编辑 composer；
- 外置麦克风与 composer 不重叠，renderer 无 page error / console error；
- 角色短按、右键菜单、角色本体直接拖动、辅助 typed drag bridge 与 locked 分支均保持；
- 原生窗口从 `[1352,455]` 拖到 `[1256,391]`，等待稳定后仍为 `[1256,391]`，释放回弹为 `0 DIP`；
- typed drag bridge 移动到 `[1304,423]`；`locked=true` 后拖动前后均为 `[1304,423]`。

## 视觉证据

- [G08_listening.png](./G08_listening.png)：角色侧流体声纹、独立停止按钮和“再点一下结束”；
- [G08_recognizing.png](./G08_recognizing.png)：同一流体核心收束为识别脉冲与独立星芒按钮；
- [G08_transcript_review.png](./G08_transcript_review.png)：转写稿回填可编辑 composer；
- [G09_speaking.png](./G09_speaking.png)：播报状态沿用同一语音岛语言；
- [I05_voice_listening.png](./I05_voice_listening.png)、[I06_voice_recognizing.png](./I06_voice_recognizing.png)、[I07_voice_transcript.png](./I07_voice_transcript.png)：真实 Electron 点按链路。

所有 PNG 均来自真实 Electron 透明 Pet Window；查看器中的黑色区域是透明像素合成背景，不是界面底色或阴影。

人工复核结论：活动语音没有大气泡或图表卡；语音岛与人物、按钮构成单一紧凑组件；listening、recognizing、speaking 三态可辨识；快捷 toolbar/drag handle 不再从语音岛后方露出；边框、文本和按钮没有被裁切。

## 边界与后续 Gate

- 当前语音链路是 P1 fixture，只验证状态机、动画、布局和交互；真实麦克风采集、ASR 上传、TTS 与严格音频工件协议仍属于 P3；
- 当前对话内容仍是 P1 fixture，真实文字对话纵切按计划进入 P2；
- P5 学习动作仍保持诚实禁用；
- P4 生产 Live2D 仍受正式资产与许可 Gate；
- 本报告不会替代 Owner 的视觉签署，也不得用来宣称 P2、P3 或完整 AI 学习伴星已完成。
