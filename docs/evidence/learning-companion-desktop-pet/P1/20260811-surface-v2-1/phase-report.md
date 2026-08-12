# P1 角色交互表面 V2.1 回归报告

- 日期：2026-08-11
- 结果：通过
- 阶段声明：`Surface Prototype / P1 Fixture`，本轮不宣称已经接入真实 ASR、TTS 或 AI 对话服务
- 工程基线：当前工作区（包含用户既有未提交改动）

## 本轮实施范围

- 气泡、composer、根菜单和二级菜单改为单层不透明平面：移除灰黑投影、`backdrop-filter` 和角色投影；
- 麦克风从 composer 内移到角色旁，保持与人物和输入框均不重叠；
- 语音交互改为点按切换：第一次开始聆听，第二次结束并进入识别，转写完成后回填可编辑 composer；
- 增加聆听彩色波形、识别彩色环和 speaking 状态动效，并提供 reduced-motion 降级；
- 二级菜单选中态与键盘 focus 改用内收描边，列表增加安全内边距，四边不再被裁切；
- 重新安排学习菜单、更多菜单、状态气泡、快捷工具和阶段徽标，避免互相遮挡；
- 角色继续支持短按、右键/长按菜单、角色本体直接拖动和辅助拖动 handle；
- 拖动链路改为 `screenX/screenY` 增量、首帧补偿、`requestAnimationFrame` 合并、单 IPC 串行和结束前 final flush；主进程拖动期间不再逐帧写偏好或广播窗口状态；
- 将 Next.js standalone tracing root 固定到仓库根，确保宿主机构建与桌面打包约定的 `apps/web` 目录一致。

## 自动验证

| Gate | 结果 |
| --- | --- |
| Web `npm test` | 833/833 PASS |
| 本轮 reducer / drag transport 聚焦测试 | 27/27 PASS |
| Desktop `npm test` | 14/14 PASS |
| Web lint | PASS（0 warning） |
| Web / Desktop typecheck | PASS / PASS |
| Web / Desktop production build | PASS / PASS |
| 真实 Electron interaction | 14/14 PASS |

真实 Electron 断言见 [interaction-report.json](./interaction-report.json)。关键结果：

- 角色短按打开 composer，直接拖动移动原生 Pet Window，拖后不误触 click；
- 原生窗口从 `[1352,455]` 拖到 `[1256,391]`，等待稳定后仍为 `[1256,391]`，回弹位移为 `0 DIP`；
- typed drag bridge 可继续移动到 `[1304,423]`；`locked=true` 后拖动前后均为 `[1304,423]`；
- locked 分支仍允许真正短按，明显拖动则抑制误点；
- 第一次点按外置麦克风进入 listening，第二次点按进入 transcribing，fixture transcript 回到可编辑 composer；
- 外置麦克风与 composer 重叠面积为 `0`；renderer 无 page error / console error。

## 视觉证据

- [G03_composer.png](./G03_composer.png)：外置麦克风与 composer 的最终布局；
- [G07_study_menu.png](./G07_study_menu.png)：学习二级菜单、完整蓝色焦点边框和气泡间距；
- [G07_more_menu.png](./G07_more_menu.png)：更多菜单选中态、阶段徽标避让；
- [G08_listening.png](./G08_listening.png)：Siri 风格聆听波形与“再次点按结束”；
- [G08_recognizing.png](./G08_recognizing.png)：识别中的彩色环动效；
- [G08_transcript_review.png](./G08_transcript_review.png)：转写稿回填并允许编辑确认；
- [I02_character_dragged.png](./I02_character_dragged.png)、[I07_voice_transcript.png](./I07_voice_transcript.png)：真实 Electron 交互截图。

所有 PNG 均来自真实 Electron 透明 Pet Window；查看器中的黑色区域是透明像素合成背景，不是界面底色或阴影。

人工复核结论：气泡和选择框已经无灰黑投影；学习/更多菜单与状态气泡不重叠；焦点和选中描边四边完整；麦克风固定在角色外侧；listening、transcribing、transcript review 三态可辨识且操作文案与点按切换一致。

## 边界与后续 Gate

- 当前语音链路是 P1 fixture，只验证状态机、动效、布局和交互；真实麦克风采集、ASR 上传、TTS 与严格音频工件协议仍属于 P3；
- 当前对话内容仍是 P1 fixture，真实文字对话纵切按计划进入 P2；
- P5 学习动作仍保持诚实禁用；
- P4 生产 Live2D 仍需正式资产与许可；
- 仓库级 `make verify` 的既有 P2 PostgreSQL integration lifecycle Gate 问题不属于本轮 UI 范围；本轮受影响包的测试、lint、typecheck、build 和真实 Electron gate 均已通过。
