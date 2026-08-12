# P1 角色交互表面 V2 回归报告

- 日期：2026-08-11
- 结果：通过
- 阶段声明：`Surface Prototype`，不是“可用 AI 桌宠”
- 工程基线：`c73f9eabfd4c80e157dfca56db95eab655372dd7` + 当前未提交工作区

## 实施范围

- 角色本体短按、直接拖动、右键、长按与键盘入口；
- 8px 手势仲裁、拖动后 click 抑制、locked 短按/拖动分支；
- 微型气泡、composer、独立确认卡、根/学习/更多菜单；
- idle 快捷 toolbar、辅助 drag handle、焦点与 reduced motion；
- standard/compact browser fallback；
- DOM `ResizeObserver` hit geometry；
- Live2D renderer 安全回退与 canvas 生命周期修复。

## 自动验证

| Gate | 结果 |
| --- | --- |
| Web `npm test`（已包含 `lib/**` + `features/**`） | 817/817 PASS |
| Companion Pet tests | 54/54 PASS |
| Desktop tests | 14/14 PASS |
| Web typecheck / lint | PASS / PASS（0 warning） |
| Desktop typecheck / build | PASS / PASS |
| Host Web production build | PASS |
| Docker Web typecheck | PASS |
| Docker Web build（`NODE_ENV=production`） | PASS |
| 真实 Electron interaction | 9/9 PASS |

真实 Electron 断言见 [interaction-report.json](./interaction-report.json)。关键行为：

- 角色短按打开 composer；
- 角色本体拖动原生窗口且不误开 composer；
- typed `dragBy` bridge 可移动窗口；
- locked 后窗口不移动，明显拖动不误点，真正短按仍可用；
- 角色右键打开菜单；
- renderer 最终无 page error / console error。

## 视觉证据

- G01–G12：idle、incoming、composer、thinking、streaming/final、三层菜单、listening、speaking、confirmation、error、边缘默认态；
- I01–I04：角色点击、角色拖动、锁定点击、角色右键菜单；
- 所有 PNG 均来自真实 Electron 透明 Pet Window；查看器黑底只是透明像素合成背景。

人工复核结论：面板层级清楚、角色与气泡归属明确、长文可读、禁用阶段诚实；确认卡/气泡出现时快捷工具不遮挡；角色键盘焦点从整身大环改为脚下小环。

## 未完成与 Gate

- 当前仍是 P1 fixture；真实 P2 文字对话纵切未在本轮宣称完成；
- P3 语音与 P5 学习动作保持 disabled；
- P4 生产 Live2D 仍需正式资产与许可；
- 仓库级 `make verify` 当前在未触及的 P2 PostgreSQL integration lifecycle Gate 停止（JSON 参数使用 `JSON.stringify(...)`；前置 27/28 通过），尚未运行到后续 schema-mirror；两者均不在本轮 UI 范围内。
