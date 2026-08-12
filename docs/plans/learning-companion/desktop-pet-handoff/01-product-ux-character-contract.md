# 01 — 产品、UX、视觉金标准与角色资产合同

> 状态：P1 Surface V2.3 已实施；无阴影表面、外置点按式麦克风、无大气泡流体语音岛与拖动平滑化证据已追加
>
> 适用阶段：P1–P6；P0 只验证窗口技术，不据此宣称视觉完成
>
> 目标：让不同实施 Agent 在不自行发挥审美、不替换角色的前提下，交付同一种桌宠体验

---

## 1. 产品体验唯一解释

学习伴星是长期存在于桌面的角色本体。用户普通点击角色后，交互必须发生在角色身旁；主应用不是日常对话的必经界面。

### 1.1 常态画面

常态最多出现：

1. 一个角色本体；
2. 角色身旁一个小气泡；
3. 用户主动打开的紧凑 composer；
4. 用户主动打开的二级菜单；
5. 麦克风、思考、播报、错误等必要状态指示。

不得出现：

- 固定圆形 Anchor；
- 全高右侧聊天栏；
- 默认展开的消息列表；
- 覆盖其他应用的大透明阻挡矩形；
- 与角色分离的 toast 作为普通回复；
- 因主动消息自动打开 Main Window。

### 1.2 产品表面职责

| Surface | 常态 | 负责 | 不负责 |
| --- | --- | --- | --- |
| Pet Window | 常驻 | 角色、当前气泡、composer、二级菜单、点按式语音状态 | 完整历史、长内容编辑、设置表单 |
| Main Window | 按需 | 完整对话、引用、导出、学习页面、设置 | 角色每帧动画、普通短回复、P0–P6 未定义的二进制附件/全局检索 |
| Browser fallback | Web 内按需 | 同一角色/气泡/composer/menu 语义 | OS 置顶、跨应用、透明穿透 |
| Mobile fallback（P0–P6 后） | 页面边缘 | future：紧凑角色和 bottom popover | 当前阶段实施、可拖动 OS 桌宠 |

---

## 2. Desktop Pet Window 视觉坐标合同

### 2.1 基准内容尺寸

P1 基准 `contentSize` 冻结为：

```ts
const PET_WINDOW_BASE_SIZE = { width: 560, height: 520 } as const;
```

说明：

- 这是透明窗口的内容边界，不是可见矩形；
- 透明区域必须按 runtime 合同穿透；
- P0 实测若平台限制要求调整，必须在 P0 证据中记录新值，并先更新本合同；
- 实施 Agent 不得为了省事把窗口缩成只包角色，从而让气泡跨窗或被裁切。

### 2.2 两种镜像布局

角色靠近屏幕右侧时使用 `bubble-left`：

```text
0                                                        560
┌──────────────────────────────────────────────────────────┐
│ 12 ┌──────── bubble 288 ────────────┐                    │
│    │ current turn / status          │                    │
│    └───────────────────────────────╲│                    │
│              composer/menu slot     ╲   character slot  │
│                                      ╲  x=300..544       │
│                                         foot=(422,504)    │
└──────────────────────────────────────────────────────────┘
```

角色靠近屏幕左侧时使用 `bubble-right`：

```text
0                                                        560
┌──────────────────────────────────────────────────────────┐
│                    ┌──────── bubble 288 ────────────┐ 12 │
│                    │ current turn / status          │    │
│                    │╱────────────────────────────────┘    │
│ character slot    ╱     composer/menu slot               │
│ x=16..260        ╱                                        │
│ foot=(138,504)                                            │
└──────────────────────────────────────────────────────────┘
```

P1 Surface V2 base scale 的 slot rect 冻结如下（坐标均为 content CSS px；2026-08-11 重构后的值取代旧版 `280/216px` panel 表）：

| Surface | `bubble-left` rect | `bubble-right` rect | 规则 |
| --- | --- | --- | --- |
| Sprite character canvas（1×） | `x=300,y=216.777,w=244,h=299.771` | `x=16,y=216.777,w=244,h=299.771` | 将 `700×860` canvas 以 `244/700` 缩放，source foot `(350,824)` 精确映射到 `(422,504)` / `(138,504)`；Sprite alpha mask 同时承载点击与直接拖动 |
| Live2D dev stage / character hit zone | `x=300,y=150,w=260,h=354` | `x=0,y=150,w=260,h=354` | 纯几何定位，不依赖 bounds/readPixels；anchor(0.5,0.5)，底边锚定 `y=504`。生产 Live2D 仍受 P4 权属/许可 Gate |
| bubble | `x=12,y=88,w=288,h=96..184` | `x=260,y=88,w=288,h=96..184` | 贴近角色头部，尾部指向角色；正文滚动区 `max-height=86`，长内容保留“完整内容”入口 |
| bubble + root/study menu | `x=12,y=72,w=288,max-h=92` | `x=260,y=72,w=288,max-h=92` | 菜单打开时只保留一行当前上下文，footer 收起，避免与菜单争抢空间 |
| bubble + more menu | `x=292,y=10,w=256,max-h=92` | `x=12,y=10,w=256,max-h=92` | 气泡移到菜单对侧，菜单与当前上下文同时可读但不重叠 |
| composer | `x=12,y=292,w=288,h=auto` | `x=260,y=292,w=288,h=auto` | header + 最多三行 textarea + 44px 发送/停止按钮；与 menu 互斥；未发送草稿在菜单开关后保留 |
| confirmation card | `x=12,y=194,w=288,max-h=300` | `x=260,y=194,w=288,max-h=300` | 独立 dialog，不伪装普通气泡；出现时接管焦点，并收起角色快捷工具 |
| external voice control | button `x=490,y=392,w=50,h≈67`；active island `x=306,y=386,w=178,h=58` | button `x=26,y=392,w=50,h≈67`；active island `x=82,y=386,w=178,h=58` | 与 drag handle 同列（2026-08-12 布局修复：原 x=304,y=372 与 quick toolbar 重叠 12px 且盖住星环法杖手柄）；位于角色透明留白区、composer 之外；单击开始，再次单击结束；活动时只展开无阴影流体语音岛，listening 显示停止图标，finalizing/transcribing 时显示识别状态且防重复提交 |
| character quick toolbar | `x=282,y=282,w=54,h=auto` | `x=230,y=282,w=54,h=auto` | idle hover/focus 时展示“对话/菜单”两个 44px 控件；bubble/composer/confirmation/menu/dragging 时收起 |
| drag handle | `x=506,y=470,w=44,h=44` | `x=10,y=470,w=44,h=44` | 未锁定且角色 hover/focus 时出现；只作可发现的辅助拖动入口，不是唯一入口 |
| root menu | `x=32,y=182,w=252,h=auto` | `x=276,y=182,w=252,h=auto` | 2×2 根动作卡；与 compact bubble 保持 18px 间距，footer 不越过 520px；语音项进入 P1 fixture UI，真实 ASR/TTS 仍以 P3 Gate 为准 |
| study menu | `x=32,y=174,w=252,h=auto` | `x=276,y=174,w=252,h=auto` | 与 compact bubble 保持 10px 间距；P5 前四个学习动作保持 disabled，含返回项 |
| more menu | `x=32,y=8,w=252,h=502` | `x=276,y=8,w=252,h=502` | 历史、隐私、锁定、置顶、隐藏、设置、退出桌宠模式与返回；内部列表滚动 |

- Bubble 固定从上向下增长，达到最大高度后正文内部滚动，不推角色；streaming 仅在用户仍位于底部时自动跟随；
- Menu 与 bubble 并存时使用上表 compact 布局；menu 与 composer 永不并存，confirmation 也不与普通 bubble 并存；
- Menu、bubble、composer、confirmation、dragging 或活动语音出现时 quick toolbar/drag handle 按上表收起；角色本体仍可点击、可直接拖动；voice control 在 menu/confirmation/dragging 时收起，在 composer/普通 bubble 时保留且不得覆盖面板；隐藏节点同时从 hit geometry 移除；
- 每次 surface 变化后，Renderer 必须通过 `ResizeObserver` 读取实际 `[data-pet-region]` DOM rect 并注册新 revision；不得再按旧卡片假定高度写死命中区域；
- `petScale` 只缩放角色与角色附属动效；effective window、左右布局偏移和 hit geometry 严格按 §2.3 计算，Bubble/Menu/Composer 与 44px 控件保持 1×；
- P0 若必须修改 content size，本表与十二个金标准必须在 P1 开始前一起重新冻结。

布局规则：

- 角色脚底基线：`y = 504px`；
- 1× 运行时 canvas 固定宽 `244px`、高 `860 × 244/700 = 299.771px`；可见 opaque 高度由 manifest bounds 决定，不以另一套“约 320px”猜测；
- 用户缩放范围 `0.85–1.25`，始终围绕 source foot anchor `(350,824)`；最大档 canvas 顶约 `144.971px`、底约 `519.686px`，仍在 520px content 内；
- 角色主体不得被气泡遮住脸、双眼、嘴或手部主要动作；
- 气泡方向由窗口在目标 display workArea 的中心点决定；
- 距屏幕边缘不足时先镜像布局，再 clamp 窗口；
- 角色脚底锚点在 streaming、菜单开关和气泡高度变化时不得移动；
- 任何气泡、菜单或 composer 距窗口内容边缘至少 `12px`；
- 可见内容距实际 display workArea 至少 `8px`。

### 2.3 视觉缩放

用户设置只改变角色与角色附属动效的 `petScale`，不改变 CSS browser zoom，也不缩小 Bubble/Menu/Composer 字体和控件：

```ts
type PetScale = 0.85 | 1 | 1.15 | 1.25;
```

- base canvas scale 固定 `244/700`；角色先把 source footAnchor 映射到当前 layout foot，再围绕该点乘 `petScale`。不得用 `object-fit` 再做第二次隐式缩放；
- Bubble/Menu/Composer、外置麦克风和 44px 控件保持 1×，因此 `0.85` 档仍可读、可点；
- `extraWidth = ceil(244 × (max(1, petScale) - 1))`，effective content size 固定为 `(560 + extraWidth) × 520`；主进程必须调用 `setContentSize`，不能在 560px 窗口里裁切放大角色；
- `bubble-left`：气泡侧 x 不变，character/menu-trigger/drag-handle/voice-control 的 base x 加 `ceil(extraWidth/2)`；
- `bubble-right`：character/menu-trigger/drag-handle/voice-control 的 base x 加 `floor(extraWidth/2)`，bubble/composer/menu 的 base x 加 `extraWidth`；
- hit geometry 报告 effective content width 和当前 scale，角色 mask 围绕 footAnchor 使用同一公式变换；
- 保存的是枚举值，不保存任意浮点；
- DPI 改变后重新计算物理位置，不改变语义 scale；
- 触控/键盘目标在所有 scale 下不得小于 `44 × 44 CSS px`。

### 2.4 Browser fallback

- `visualViewport >= 600×560 CSS px` 时复用 560×520 layout root，固定在应用 viewport 右下 `8px`；root `pointer-events:none`，仅 character/bubble/composer/menu/controls 子区域为 `pointer-events:auto`，因此透明 DOM 不阻挡页面；
- `visualViewport` 任一维低于阈值（包括 200% page zoom）时切为 compact fallback：角色按钮固定右下 safe area，box `96×132px`；bubble 使用 `max-width:min(280px,calc(100vw - 16px))` 并位于角色上方；composer/menu 改为底部 popover，宽 `min(360px,calc(100vw - 16px))`、单项仍 `44px`；
- compact fallback 一次仍只显示角色 + 外置麦克风 + 一个 bubble/composer/menu，不变成聊天侧栏；打开完整历史进入 Main route；
- Web fallback 不使用 Electron preload、OS always-on-top、native drag、screen API 或 alpha-mask polling；位置只在当前应用 viewport 内，默认不持久化；
- visualViewport resize/zoom 后重新 clamp，不能遮挡应用底部导航、当前 primary action 或浏览器安全区；无法同时避让时只保留 44px 角色入口，bubble/menu 由用户点击后以 modal popover 打开并正确 trap/restore focus。

---

## 3. 视觉 token 合同

Pet Web surface 必须复用 `apps/web/app/styles/tokens.css` 的语义 token。不得在页面组件内散布新的静态十六进制颜色。

### 3.1 Bubble

| 属性 | 值 |
| --- | --- |
| Desktop 宽度 / compact 最大宽度 | `288px / min(360px, calc(100vw - 16px))` |
| 内边距 | `10px 12px 11px` |
| 圆角 | `calc(var(--radius-lg) + 4px)` |
| 背景 | 单层 `var(--color-surface-raised)`；不使用灰黑渐变或半透明暗底 |
| 边框 | `1px solid` 语义 `--color-border-strong` 混合色 |
| 主文字 | `var(--color-text)` |
| 次文字 | `var(--color-text-secondary)` |
| 字体 | `var(--font-ui)` |
| 字号/行高 | `13px / 1.55` |
| 阴影 | `none`；Bubble、Menu、Composer、Confirmation 均不得使用灰黑投影 |
| tail | `12 × 12px`，继承背景与相邻两条边框 |
| backdrop blur | `none`；以不透明语义 surface 和清晰边框保证对比度 |

状态色只用于小型图标/状态线，不给整个气泡大面积染色：

- listening：`--color-running`；
- thinking：`--color-evidence`；
- confirmation：`--color-warning`；
- success：`--color-success`；
- error：`--color-danger`。

### 3.2 Composer

| 属性 | 值 |
| --- | --- |
| 宽度 | 与当前 bubble 相同，Desktop `288px` |
| 输入 field 最小高度 | `80px` |
| 最大文本行数 | 3 |
| 输入区 | 1fr，字号 `13px`，行高 `1.5` |
| 发送、停止按钮 | 每个至少 `44 × 44px`；麦克风不放在 composer 内 |
| 背景/边框/阴影 | 与 Bubble 相同，阴影固定为 `none` |
| focus ring | `2px solid var(--color-focus-ring)`，offset `2px` |

composer 不显示头像、历史列表、模型选择器、附件入口或设置表单。P0–P6 不实现二进制附件；未来若批准，只在完整对话页提供。

### 3.3 二级菜单

| 属性 | 值 |
| --- | --- |
| 宽度 | `252px` |
| 单项高度 | `44px` |
| 圆角 | `var(--radius-md)` |
| padding | `6px` |
| 菜单层级 | 最多两层，不同时显示两列 |
| 图标 | `16px`，必须有文字标签 |
| 危险操作 | 仅“退出桌宠模式”使用 danger 语义色；退出整个应用只保留原生 App menu/Cmd+Q，不放进 Pet 菜单 |

根层固定顺序：

1. 说句话；
2. 语音对话（点按开始、再次点按结束）；
3. 学习；
4. 更多。

“学习”子层固定顺序：

1. 继续当前学习；
2. 开始一小段学习；
3. 今日复习；
4. 回到当前卡片；
5. 返回。

“更多”子层固定顺序：

1. 完整对话；
2. 关闭自动播报/恢复自动播报；
3. 隐私模式开关；
4. 锁定/解锁位置；
5. 置顶开关；
6. 暂时隐藏；
7. 设置；
8. 退出桌宠模式；
9. 返回。

隐私模式是用户手动开启的设备本地状态，默认关闭。它不得通过截屏、录屏状态、前台窗口标题、进程列表或其他应用内容自动推断。开启后，主动消息气泡只显示“伴星有一条消息，内容已隐藏”，不展示正文且不自动 TTS；用户主动打开 composer、发送消息或进入完整对话页时仍显示该用户发起会话的内容。关闭后不得自动补播隐私期间被抑制的语音。

“关闭/恢复自动播报”修改现有账号级 `voiceOff`，所有设备按 account revision 与既有状态广播收敛；正在播放时关闭还必须立即停止本次 queue。Bubble 上的“停止”只停止当前 queue，不改 `voiceOff`，二者不得共用含糊状态。

P1 中尚未接线的学习动作必须 disabled 并显示“将在学习能力阶段开放”，不得点击后伪造完成。

P5 后，“继续当前学习/开始一小段学习”只有在 03 合同的只读 learning context 返回对应候选时 enabled；点击只创建待确认 proposal，不能直接 mutation。“今日复习/回到当前卡片”分别使用 response 的 typed review/card route，目标为空则 disabled。加载候选时菜单项显示短 spinner 但不移动顺序；失败时显示“暂时无法读取学习状态”，保留完整对话与设置入口。

### 3.4 Day/Night

- Main/Pet 使用同一账号主题语义；
- Pet route 必须加载 `tokens.css`，但不得加载完整 AppShell；
- 透明窗口的 `body/html/root` 背景必须为 transparent；
- night 只覆盖 token，不改变角色原画色相；
- 若主题状态尚未加载，先以系统 `prefers-color-scheme` 选择临时 token，加载后无闪白矩形。

### 3.5 角色输入映射

| 输入 | 固定结果 |
| --- | --- |
| 角色主键单击 / 键盘 Enter、Space | 打开并聚焦 composer；若已打开则保持，不切换 Main |
| 气泡主键单击 | 暂停 auto-dismiss 并打开 composer；只有“查看完整内容”链接可打开 Main |
| 角色右键 / Shift+F10 / Menu 键 / ArrowDown | 打开根菜单，并抑制浏览器原生 context menu |
| 角色旁外置麦克风主键单击 / 键盘 Enter、Space | `idle/error/cancelled/speaking → requesting_permission → listening`；listening 中再次点按进入 finalizing/transcribing；不监听 pointerup，不存在长按、松开提交或滑动取消语义 |
| 根菜单“语音对话”单击 / Enter、Space | 关闭菜单并执行与外置麦克风相同的 `voice.toggle_requested`；P1 只演示 fixture 录音 UI，P3 Gate 通过前不得声称真实 ASR/TTS 已完成 |
| 触摸或笔长按 `500ms` | 位移不超过 `8px` 时打开根菜单并抑制随后 click |
| idle hover 或 keyboard focus | 在角色内侧显示含“对话/菜单”的快捷 toolbar（两个 `44×44px` 控件）与独立 `44×44px` 辅助 drag handle；bubble/composer/confirmation/menu/dragging 时收起 |
| 角色本体或明确 drag handle 主键按下后移动超过 `8 CSS px` | 未锁定时进入 dragging；取消 long-press，并抑制本次 click/menu；每次位移通过 typed `dragBy` 交给主进程 |
| 角色本体或 drag handle 移动未超过 `8 CSS px` 后松开 | 角色本体按一次 click 处理；drag handle 不触发角色 click |
| 双击 | 无额外语义，按一次主键单击处理，避免误触发两个 surface |

角色身体是 P1 的直接拖动区，也是主点击区，因此必须使用手势仲裁而不是原生整块 `app-region: drag`：pointerdown 后先等待位移阈值，超过 `8 CSS px` 才进入 dragging；未超过阈值的 pointerup 才触发 click。右键不进入拖动。`locked=true` 时跳过窗口移动，但仍独立记录是否越过阈值：真正短按保留点击与菜单，明显拖动尝试必须抑制 click。菜单触点、voice control、drag handle、composer 控件彼此不得重叠；voice control/drag handle 可视觉覆盖角色透明留白，但显示时必须在 DOM/event 层优先于 character click，不能一按同时触发两个 intent。

菜单项的 focus 与 `aria-checked=true` 选中线必须使用向内绘制的 outline；不得依赖向外扩张且会被 `.pet-menu`/滚动容器裁切的蓝色边框。顶部、底部和二级菜单首项均必须保留完整的 2px focus ring。

---

## 4. 动效与时序合同

### 4.1 UI 动效

| 动作 | 时长 | easing | 位移/缩放 |
| --- | --- | --- | --- |
| Bubble 进入 | `160ms` | `var(--ease-standard)` | opacity `0→1`，Y `6→0px`，scale `0.98→1` |
| Bubble 退出 | `140ms` | `var(--ease-standard)` | opacity `1→0`，Y `0→4px` |
| Composer 展开 | `180ms` | `var(--ease-standard)` | 高度 + opacity；角色锚点不动 |
| Menu 进入 | `140ms` | `var(--ease-standard)` | opacity + scale `0.98→1` |
| 子菜单切换 | `120ms` | `var(--ease-standard)` | 横向 `4px`，不旋转 |
| Error shake | 禁止 | — | 不以抖动惩罚用户 |

### 4.2 角色 Level A 动效

Sprite 阶段仅允许不破坏角色像素的轻量变换：

- idle 呼吸：`3.2s`，Y `0↔-2px`，scaleY `1↔1.006`；
- incoming：单次 Y `0→-5→0px`，总时长 `420ms`；
- listening：每 `1.8s` 一次不超过 `1.01` 的呼吸；
- thinking：角色本体不旋转，状态由气泡 dots 和 `think` pose 表达；
- speaking：不得伪造逐音素嘴形；Level A 固定使用 `analyze` pose + 最大 `1px` 呼吸；
- celebrate：只在真实、允许庆祝的事件使用，单次且不循环；
- hidden/sleep：停止 RAF/ticker，不在透明后台持续动画。

### 4.3 reduced motion

`prefers-reduced-motion: reduce` 或 `animationOff=true` 时：

- 所有持续角色动画关闭；
- UI transition 不超过 `0.01ms`；
- 状态仍由 pose、图标和文本表达；
- 不通过“动画消失”隐藏 thinking/listening/speaking 的语义。

---

## 5. 十二个视觉金标准场景

P1 必须按下列场景提交 1×、2× DPI 截图；涉及动态的场景另交 10–20 秒录屏。Owner 未批准这些证据前不得进入 P2。

### G01 Idle

- 只显示角色；
- 无气泡、无输入、无菜单；
- 角色完整、脚底不裁切；
- 透明区域可看见并点击下层应用。

### G02 Incoming

- 角色轻量提示一次；
- bubble 最多 3 行；
- 不抢当前应用焦点；
- 不自动显示 Main Window。

### G03 Composer

- 点击角色后就地出现输入；
- 光标在输入框；
- 角色不位移；
- Enter/Shift+Enter/Esc 语义正确。

### G04 User Sent / Thinking

- 发送后输入立即清空；
- 同一气泡先显示用户文本最多 2 行和确定性“已收到”，accepted 后切为 thinking；privacy mode 不隐藏这条用户主动提交的正文，只有 proactive delivery 使用无正文占位；
- 不展示伪造的 assistant 文本；
- 可见“停止”入口。

### G05 Streaming / Final

- 同一个 assistant bubble 更新；
- 不堆叠 token 卡片；
- 超过限定高度（滚动区 max-height 116px）后出现细滚动条，内部滚动并**自动跟随最新内容**（用户手动上翻时暂停跟随，回到底部恢复）；同时保留“查看完整内容”入口；
- streaming 不移动角色脚底锚点。

### G06 Root Menu

- 四个固定根项；
- 可键盘操作；
- 点击外部透明区关闭菜单并恢复穿透。

### G07 Second-level Menu

- 学习/更多各一张证据；
- more menu 打开时 bubble 固定单行 `56px`，两者之间至少 `16px`，不得重叠；
- Esc 返回根层，再按 Esc 关闭；
- focus 返回触发项。

### G08 Listening / Transcribing

- 外置麦克风、角色侧 `178×58` Siri 式流体语音岛和“再点一下结束”提示同时可见；活动语音期间不得显示对话大气泡、通用卡片、柱状图、灰黑阴影或“声音 → 文字”流程图；
- listening 使用彩色流体声纹；再次点按后立即变为 finalizing/transcribing，同一流体核心原地收束为旋转色场 + 识别脉冲点，禁止突然替换为另一套大面板；
- active voice 时 quick toolbar/drag handle 必须收起且不得从语音岛后方露出；角色本体点击与直接拖动能力保持；
- 识别完成后 transcript 回填可编辑 composer，外置麦克风与 composer 几何面积不得重叠；
- 没有麦克风时显示可恢复文字入口。

### G09 Speaking / Interrupted

- 文字与声音对应同一 turn；
- 可见停止播报；
- 再次点按麦克风后在 200ms 目标内停止声音并进入 listening。

### G10 Confirmation

- 交互确认**不使用被动气泡**：渲染为角色身旁的独立卡片（`pet-confirmation-card`，x16 y288 w280，菜单同视觉语言），标题+内容区（内容过长卡片内滚动）+ 固定按钮区；

- 显示动作名称、目标和影响摘要；
- 明确“确认/取消”；
- 取消后零副作用；
- 不使用模糊的“好/不要”代替动作语义。

### G11 Error / Offline

- 错误文案不泄漏 provider、凭据或用户私密内容；
- 提供重试、改用文字或查看状态；
- 角色不庆祝、不假装成功。

### G12 Screen Edges / Privacy

- 屏幕四角、左右气泡镜像、1×/2× DPI；
- 四个 petScale 档位的 effective window、角色锚点、文字尺寸和 hit geometry；
- quietHours/DND 不显示 Pet 气泡；手动隐私模式显示固定无正文提示；
- 角色、气泡、菜单不越界；
- 显示器拔插后仍至少 60% 可见。

---

## 6. Bubble 内容与切句合同

### 6.1 显示层级

Bubble 永远只显示一个最高优先级表面：

1. voice/permission/safety error；
2. 用户当前 turn；
3. typed action confirmation；
4. 用户启动的真实任务结果；
5. 允许的 proactive delivery；
6. ambient 装饰。

低优先级项进入队列或过期，不能覆盖 composer、confirmation 或用户正在阅读的 final。

### 6.2 文本分段

服务端保存完整 assistant message；客户端生成 bubble preview：

- 中文优先按 `。！？；\n` 切句；
- 英文优先按 `.?!;\n` 且避免常见缩写误切；
- 单段目标 `18–60` 个中文字符或 `40–140` 个拉丁字符；
- 一个 bubble viewport 最多显示 6 行；
- 不为满足长度改写、概括或删除原始 assistant 文本；
- 代码块、表格、超过 280 字的长内容只显示纯文本摘要入口，完整内容在 Main Window；
- URL 在 bubble 中显示域名或短标签，不显示超长原始 URL；
- TTS 只读取稳定、净化后的句子，不朗读 Markdown 标记、URL 或隐藏 metadata。

### 6.3 自动消失

- incoming：`max(4s, min(12s, 2.5s + 字符数 × 80ms))`；
- final：同上；
- hover、focus、composer 打开、正在 speaking 或 confirmation 时不计时；
- error/confirmation 不自动消失；
- content-hidden/privacy placeholder 最长停留 `6s`；quietHours/DND 不创建可见 Bubble；
- 用户主动关闭后，本次 delivery 不再次弹出。

---

## 7. 角色资产事实与锁定清单

### 7.1 当前唯一 Owner 身份参考

| 字段 | 值 |
| --- | --- |
| 路径 | `docs/image/learning-companion-character-action-reference.png` |
| SHA-256 | `159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5` |
| 尺寸 | `700 × 1880` |
| 格式 | RGB PNG |
| Alpha | 无 |
| 内容 | 8 个 `350 × 430` 动作格 |
| 角色权属 | `BLOCKED — Owner 尚未确认商业使用/修改/再分发权` |
| 生产可用性 | `BLOCKED — 棋盘格烘焙、分辨率不足、非分层原画` |

此图片只定义角色身份、服装、发型、眼镜、星饰、配色、导航环和八个动作意图。它不是可直接发布的透明资产，也不是 Live2D 输入包。

### 7.2 当前裁切文件

这些文件只允许作为旧实现证据，不得通过“文件有 Alpha 通道”宣称背景已清理：

| 文件 | SHA-256 | 尺寸 | 状态 |
| --- | --- | --- | --- |
| `dormant.png` | `8ee3bb2565773fe10735189ca79bb59d5557b8c4adfcef2b8e5f5f2c26c127bc` | 350×430 | rejected：可见棋盘背景 |
| `invite_once.png` | `fe34d85053b4f445648efb8e93360caf6df902e5cb39f41aa69d2ffdb5ca2a31` | 350×430 | rejected：可见棋盘背景 |
| `navigate.png` | `fd67fd7e4fcf841dceaf659960e09b3fa62e608d459eb98b7ac73870971659fc` | 350×430 | rejected：可见棋盘背景 |
| `present_evidence.png` | `a2196b480b97fd4e4cdf5996bd5943e7e405ab9f38d2247d61059e0f46219fa9` | 350×430 | rejected：可见棋盘背景 |
| `listen.png` | `3f2fc1dbe214842b1f251b37c44aee8fdfab7094cfcaeda01517b6d37d9e40f3` | 350×430 | rejected：可见棋盘背景 |
| `co_manipulate.png` | `abbb3b3b46bb702fb495819eaa8f2c4ba0e02e307552bd24f89c740eba5a6a10` | 350×430 | rejected：可见棋盘背景 |
| `committed_change.png` | `59cc1c68c17b9eeb84a32da4ea8a8edd1657f642eef2f00ee9f3eb396633afe1` | 350×430 | rejected：可见棋盘背景 |
| `uncertain_or_retry.png` | `a6ab9d410aa085510e2fbc3b14e53df6d3f50cf2d448475a03c4c5b431aa5a85` | 350×430 | rejected：可见棋盘背景 |

### 7.3 Level A 必需资产包

P1 开始前必须存在：

```text
apps/web/public/images/companion/pet/sprite-v1/
  manifest.json
  idle.png
  invite.png
  navigate.png
  analyze.png
  listen.png
  think.png
  encourage.png
  celebrate.png
  hit-masks/
    idle.bin
    invite.bin
    navigate.bin
    analyze.bin
    listen.bin
    think.bin
    encourage.bin
    celebrate.bin
  LICENSE.json
```

`manifest.json` 固定 shape：

```json
{
  "schemaVersion": 1,
  "characterId": "learning-companion-owner-reference-v1",
  "sourceReference": {
    "path": "docs/image/learning-companion-character-action-reference.png",
    "sha256": "159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5"
  },
  "canvas": { "width": 700, "height": 860 },
  "poseOrder": ["idle", "invite", "navigate", "analyze", "listen", "think", "encourage", "celebrate"],
  "poses": {
    "idle": {
      "image": "idle.png",
      "imageSha256": "<64 lowercase hex>",
      "naturalSize": { "width": 700, "height": 860 },
      "footAnchor": { "x": 350, "y": 824 },
      "opaqueBounds": { "x": "<integer>", "y": "<integer>", "width": "<positive integer>", "height": "<positive integer>" },
      "hitMask": "hit-masks/idle.bin",
      "hitMaskSize": { "width": 128, "height": 128 },
      "hitMaskSha256": "<64 lowercase hex>",
      "semanticPose": "idle"
    }
  }
}
```

`poses` 必须包含 `poseOrder` 的八个同 shape 条目，不能只交示例中的 idle。示例里的 `<...>` 是刻意 schema-invalid 的待测量标记；最终 manifest 不得保留。`footAnchor` 必须在 canvas 内；`opaqueBounds` 必须完整位于 `700×860` 内并包住全部 `alpha>=32` 像素。所有整数和路径通过 strict shared schema 校验，不允许额外键、绝对路径或 `..`。

`LICENSE.json` 固定包含：

```json
{
  "schemaVersion": 1,
  "characterId": "learning-companion-owner-reference-v1",
  "sourceOwner": "<legal owner>",
  "sourceReferenceSha256": "159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5",
  "permissions": {
    "modify": true,
    "commercialUse": true,
    "redistributeDerivedAssets": true
  },
  "approvedBy": "<Owner identity>",
  "approvedAt": "<ISO-8601 UTC>",
  "notes": "<bounded text>"
}
```

任一 permission 非 true、批准字段为空、仍含 `<...>` 占位符或 source hash 不符，资产 loader 必须 fail closed。

每张 PNG 的 Gate：

- 真 RGBA，角色外像素 alpha 必须为 0；
- P1 交付 PNG 画布固定为 `700 × 860`；更高分辨率源文件可另行归档，但进入 manifest 的运行时导出必须统一为该尺寸；
- 八张画布、脚底基线、角色中心和视觉缩放一致；
- 八张运行时导出的 `footAnchor` 固定为 `(350,824)`；无法在不裁切角色的前提下满足时，必须先更新合同并重新做 G01–G12，不得每姿态使用漂移锚点；
- 不保留棋盘格、文字标签、裁切线或白边；
- 角色脸、眼镜、发饰、导航环和服装细节不被抠掉；
- 透明边缘在浅色、深色、红色、绿色四种检测底色下无明显污染；
- `manifest.json` 记录每个文件 hash、natural size、foot anchor、coarse bounds 和语义 pose；
- 每个姿态的 hit mask 都从该姿态最终 alpha 独立生成，最大 `128 × 128` bit mask；切换 pose 时同步提交新 revision，不能共用 idle mask；
- P1 mask 固定 `128×128`、2048 bytes、无 header、row-major、每行从左到右、每 byte MSB-first；每个 mask pixel 覆盖对应源图区域，只要区域内任一源 pixel `alpha>=32` 就置 1；
- `LICENSE.json` 明确原图来源、修改授权、发布范围、批准人和日期。

不允许：

- 实施 Agent 自行生成另一名相似角色替换；
- 使用简单颜色阈值破坏白色衣服、眼镜高光或浅色皮肤；
- 以 CSS `mix-blend-mode`、遮罩色或裁切矩形掩盖棋盘背景；
- 在 Owner 未批准角色变化时调用生成式图像工具重绘。

### 7.4 Level A pose 映射

新 Sprite Driver 使用资产语义名，不延续旧文件的业务状态命名：

| 运行时投影 | Sprite pose | 备注 |
| --- | --- | --- |
| idle/booted | `idle` | 中性待机 |
| proactive incoming | `invite` | 只在 permit 已签发后 |
| open route/action | `navigate` | 只表达已开始导航 |
| turn phase `thinking` | `think` | 普通模型等待与组织回复 |
| turn phase `acting` | `analyze` | 仅有真实后台动作正在运行时 |
| user speaking/listening | `listen` | 麦克风实际 track active 后 |
| assistant speaking/explaining | `analyze` | Level A 无嘴形，只做过渡 |
| grounded encouragement | `encourage` | 不代表掌握度变化 |
| real allowed celebration | `celebrate` | 仅真实完成事件且策略允许 |
| error/uncertain | `think` | 不使用 celebrate |
| reduced motion | 当前语义 pose | 无持续变换 |

现有 `CompanionVisualStateV1` 的 canonical/assessment 诚实性映射继续有效；新 Pet 状态通过 adapter 映射，不能删除或绕过 `eventAllowsVisualState`。

### 7.5 Level B Live2D Gate

P4 开始前必须提供并批准：

- 高清、真透明、可修改的角色原画；
- 分层 PSD 或等价源文件；
- Cubism Editor 工程源文件；
- 导出的 model3/moc3/textures/motions/expressions；
- 参数 profile 与 hit areas；
- 原画、模型、Cubism runtime 的商业/再分发许可结论；
- Owner 对正面、侧看、眨眼、说话、八种 cue 的录屏批准。

`see-through` 只能辅助生成分层候选，不能替代人工补绘、art mesh、deformer、physics 和 motion。缺少任一项时 P4 标记 `BLOCKED_EXTERNAL_ASSET`，P3 的 Sprite 产品继续可用。

---

## 8. 无障碍与输入合同

- 角色本体必须有可聚焦的语义按钮或等价入口；
- 直接拖动不是唯一移动方式；独立 drag handle 或等价键盘可聚焦入口必须保留，读屏用户可从设置执行“回到屏幕”；
- 角色、气泡、菜单、composer 的 focus 顺序与视觉顺序一致；
- 右键、长按不是唯一打开菜单的方法；
- `Esc` 先关闭子菜单，再关闭根菜单，再关闭 composer；
- 关闭后 focus 返回角色触发点；
- 状态不能只靠颜色、动作或声音表达；
- 每个 listening/thinking/speaking/error 状态有 `aria-live` 短标签，但 token delta 不逐 token 向读屏播报；
- assistant final 才进入礼貌 `aria-live`，长内容只读摘要；
- 无麦克风、拒绝权限、TTS 关闭、animationOff、reduced motion 均保留完整文字路径；
- Pet Window 被系统放大/读屏工具聚焦时暂时关闭 click-through，退出焦点后恢复。
- Electron Pet 的 560×520 合同以 Chromium zoom factor `1` + OS DPI/Retina scale 验收，不把 browser zoom 当 petScale；Main Window 与 browser fallback 必须在 200% page zoom 可重排且不遮挡导航。系统屏幕放大镜下 Pet 仍保持键盘/读屏入口。

---

## 9. P1 视觉批准记录

实施 Agent 只能填写证据路径和测量值，不能替 Owner 勾选 `ownerApproved`。

```yaml
p1VisualReview:
  status: pending
  evidenceDirectory: null
  screenshots:
    G01_idle: null
    G02_incoming: null
    G03_composer: null
    G04_thinking: null
    G05_streaming: null
    G06_root_menu: null
    G07_second_level_menu: null
    G08_listening: null
    G09_speaking_interrupted: null
    G10_confirmation: null
    G11_error_offline: null
    G12_edges_privacy: null
  ownerApproved: false
  ownerApprovedAt: null
  ownerNotes: ""
```

Owner 未批准时 P1 只能标记 `changes_requested` 或 `blocked`，不得开始 P2。纯合同文档补充不属于产品实施，但也不能据此跳过视觉 Gate。

当前真实记录：原 P1 G01–G12 已由 Owner 于 2026-08-10 批准；2026-08-11 Surface V2/V2.1/V2.3 回归没有替代该 Owner 签署，而是追加实现证据。当前 V2.3 截图、机器断言与阶段报告位于 [`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/)。
