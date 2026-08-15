# LearningRun UI 重绘实施记录

> 日期：2026-08-13  
> 状态：**UI contract / state coverage complete；production wiring not started**  
> 对应方案：[16-unified-learning-run-micro-journey-live2d-system-companion.md](./16-unified-learning-run-micro-journey-live2d-system-companion.md)  
> 本轮停止边界：完成统一 LearningRunPlayer UI、交互原型、响应式与可访问性基础验证后暂停；不进入 API、数据库、Assessment、Commit、Pet Bridge 或旧链路切流。

---

## 1. 本轮实施范围

本轮没有继续修改旧 `ValidationFocus` 或旧 Card companion 页面，而是建立了一条独立、可删除 fixture 后接入正式数据源的 LearningRun UI 纵切。

已完成：

1. 新的 Focus 全屏 `LearningRunPlayer`；
2. server-shaped 前端公共合同；
3. text / voice teach-back / ordering / repair / choice-with-rationale / scenario / relation 七类 renderer；
4. Run 全阶段视觉状态；
5. 七种结果语义与 schedule impact；
6. 换方式、提示降级、跳过、声明不会、暂停、结束、重试等自主操作；
7. 开发态 UI 状态实验室；
8. 桌面、平板、窄屏、日间、夜间与 reduced-motion 样式；
9. 组件行为测试、TypeScript、ESLint 与真实浏览器视觉验收。

本轮明确未做：

- 不接 `/learning-runs` API 或 SSE；
- 不写 Artifact、Assessment、mastery 或 schedule；
- 不将 Card / Review 的生产 CTA 切到新 Player；
- 不改旧 validation / learning-session writer；
- 不实现 Main ↔ Pet Context / Event / Command Bridge；
- 不修改现有 Live2D 角色资产、驱动或 Pet Window；
- 不改完整对话历史、Journey V2 或星图 projection；
- 不把 fixture 验收称为 production E2E。

---

## 2. 新增与修改文件

### 2.1 公共 UI 合同与 fixture

- `apps/web/features/learning-run/contracts.ts`
  - 定义 `LearningRunPublicV1`、`LearningTaskPublicV1`、`LearningRunResultV1`、`LearningRunUiIntentV1`；
  - intent、interaction、purpose 与 Trust 分离；
  - Result 显式携带 schedule impact，避免 UI 自行推断。
- `apps/web/features/learning-run/demo-fixtures.ts`
  - 使用与正式方案同形的快照驱动 UI；
  - 覆盖 Card text、Review voice、ordering、repair、暂停/错误/过期和七种结果语义。

### 2.2 Player

- `apps/web/features/learning-run/player/LearningRunPlayer.tsx`
- `apps/web/features/learning-run/player/RunHeader.tsx`
- `apps/web/features/learning-run/player/TaskChrome.tsx`
- `apps/web/features/learning-run/player/AssessmentProgress.tsx`
- `apps/web/features/learning-run/player/ResultView.tsx`

统一 Shell 现在负责：

- origin 与返回语义；
- Key Point、Task intent / purpose / Trust；
- phase、预算与真实进度语言；
- 模态切换、提示降级、Skip / Declared Unable；
- Preparing、Assessment、Commit、Checkpoint、Pause、Error、Stale 和终态；
- Result 四问：证明了什么、缺什么、复习是否变化、下一步是什么。

### 2.3 Renderer

- `apps/web/features/learning-run/renderers/TextResponseTask.tsx`
- `apps/web/features/learning-run/renderers/VoiceTeachbackTask.tsx`
- `apps/web/features/learning-run/renderers/OrderingTask.tsx`
- `apps/web/features/learning-run/renderers/RepairTask.tsx`
- `apps/web/features/learning-run/renderers/ChoiceWithRationaleTask.tsx`
- `apps/web/features/learning-run/renderers/ScenarioTask.tsx`
- `apps/web/features/learning-run/renderers/RelationTask.tsx`
- `apps/web/features/learning-run/renderers/TaskRenderer.tsx`

关键行为：

- Text 只提交用户原文，不做模型润色；
- Voice 必须由用户点按开始，并在提交前确认逐字稿；
- Ordering 不要求拖拽，所有步骤可用按钮、Tab 与 Enter 完成；
- Repair 除严格 statement / operation ID 外，还要求用户形成可编辑的完整修复句；
- Choice-with-rationale、Scenario 与 Relation 提供 paraphrase / example / apply 的非连续键盘路径；
- renderer 不执行 Assessment、Commit 或 schedule 推断。

### 2.4 状态实验室与样式

- `apps/web/features/learning-run/demo/LearningRunRedrawLab.tsx`
- `apps/web/app/(prototype)/learning-runs/ui-redraw/page.tsx`
- `apps/web/app/(prototype)/layout.tsx`
- `apps/web/app/styles/learning-run.css`
- `apps/web/components/layout/AppShell.tsx`

开发预览地址：

```text
http://localhost:3000/learning-runs/ui-redraw
```

该路由只在 development 环境存在，production 直接 `notFound()`。实验室显式展示“尚未接入 API / Assessment / Commit”，避免把 fixture 冒充正式学习结果。

样式严格限定在 `[data-page="learning-run"]` / `.learning-run-*` 下，只使用现有语义 token，没有新增静态色值。

---

## 3. UI 状态覆盖

### 3.1 Run phase

| Phase | 已有视觉与动作 |
| --- | --- |
| `preparing` | 非空白准备态；可安全返回；无倒计时压迫 |
| `active` | 精确 prompt / target / purpose / Trust；七类 renderer；自主操作常驻 |
| `assessing` | Artifact 已锁定；禁止重复提交；可先离开 |
| `checkpoint` | partial / not-assessable / skipped-task 结构；修补或按当前结果结束 |
| `committing` | 显示“结果尚未生成”；不提前声称复习已改变 |
| `paused` | 明确草稿与交互状态保留；继续或返回 |
| `completed` | 七种可信结果与 schedule impact |
| `recoverable_error` | prepare / assessment / commit 分阶段重试或安全结束 |
| `stale` | 解释旧状态失效，必须创建新 Run |
| `ended` | 未提交内容不形成证据 |
| `skipped` | 不评价、不 Assessment、不改 schedule |
| `cancelled` | runtime 终止，零新增副作用 |

### 3.2 结果语义

| Outcome | UI 承诺 |
| --- | --- |
| `demonstrated` | 说明已证明 facets；只有真实 Commit 成功才显示 created / rescheduled |
| `partial` | 区分已覆盖与缺口；不把局部证据说成掌握 |
| `needs_repair` | 指出需要修补的具体混淆，不贴失败标签 |
| `not_assessable` | 明示无法可靠评估且 0 正负学习副作用 |
| `practice_completed` | 只说练习完成；明确 0 mastery、0 official schedule |
| `skipped` | 只表示本次不想做，不推断态度或能力 |
| `declared_unable` | 说“暂时不会”；只记录当前选择，是否调整复习以后续可信结算为准 |

---

## 4. 关键产品决定在 UI 中的落点

### 4.1 主观题不再等于 textarea

同一个 explain 目标可在同一 Shell 中切换为：

- 文字短答；
- 20–45 秒语音 teach-back；
- ordering 因果链；
- repair 错误解释。

“换个方式”是一级操作，并明确说明不会产生负面记录。

### 4.2 Skip 与 Declared Unable 分离

- “先跳过”：不评价，也不改变复习；
- “我确实不会”：记录当前选择；UI 不在缺少授权和 Commit 时承诺自动改期。

两者在 active Task 中同时一步可达，不再用“放弃本轮”混合表达。

### 4.3 提示先降级、后展示

点击提示先进入带焦点陷阱和 Escape 支持的确认对话框，明确：

> 查看提示后，本题只记为练习；不会升级正式掌握，也不会改变复习时间。

只有确认后才发出 `request_hint` UI intent。原型先进入带可见提示的 active practice；用户仍需完成回答，提交后才显示 practice completed。

### 4.4 三分钟不是倒计时

界面展示计划进度与“预计还需约 X 分钟”，不显示秒级倒计时、速度评分或超时惩罚。Provider 等待态明确说明不占用主动练习预算。

### 4.5 伴星边界

本 Player 的 DOM 中没有伴星头像、聊天框、内联提示卡或右侧伴星面板。主页面只保留原生学习 UI；Live2D Pet 继续作为唯一伴星前台，后续通过 Bridge 连接。

---

## 5. 验证记录

### 5.1 静态与组件验证

```text
apps/web npm run typecheck
→ passed

npx eslint features/learning-run 'app/(prototype)' components/layout/AppShell.tsx --max-warnings=0
→ passed

npx vitest run features/learning-run/player/LearningRunPlayer.vitest.tsx
  features/learning-run/demo/LearningRunRedrawLab.vitest.tsx
→ 15 tests passed

node --import tsx --test features/learning-run/demo/demo-context.test.ts
→ 4 tests passed

apps/web npm run build
→ production build passed
```

Production build 仍报告两条本轮之前即存在的 hook warning，分别位于旧 Card companion 页面和旧 `VoiceTeachBackScene`；新 `features/learning-run`、prototype route 与 `AppShell` 的定向 ESLint 为 0 warning。

组件测试覆盖：

- Task 精确题面与自主操作可达；
- Text 原文提交；
- Hint 降级确认；
- Ordering 点选/键盘等价路径；
- Repair typed payload；
- Assessment 不提前声称 schedule；
- Practice result 诚实表达 0 正式副作用。

### 5.2 浏览器视觉与交互验证

本地 Next 开发页实际加载并检查：

| Viewport / 模式 | 检查内容 | 结果 |
| --- | --- | --- |
| 1440 × 900 Day | text active、assessment、result、hint dialog | 通过 |
| 1440 × 900 Night | text、voice、ordering | 通过 |
| 768 × 1024 Day | 单列 Task + 双列 control rail | 通过 |
| 390 × 844 Day | Header、Pause / End、Task reflow、自主操作 | 通过 |
| reduced-motion CSS | 循环动画全部停止、身份与信息保留 | 已实现 |

实际点通：

1. Voice：开始 → 停止 → 转写 → 编辑/确认逐字稿；
2. Ordering：依次点选三个动作 → 槽位完成 → Submit enabled；
3. Hint：打开确认 → 明确降为 practice → 显示提示并继续作答 → 提交后进入 practice result；
4. Assessment：锁定后只显示评估与离开动作；
5. Result：显示 facets、gap、schedule impact、next step，并明确不自动下一题。

浏览器没有应用错误；开发态观察到一次 Fast Refresh reload warning，不作为生产验收证据。

---

## 6. 下一阶段接线清单

恢复实施时建议严格按以下顺序：

1. 将本文 `contracts.ts` 与方案 16 的正式 shared schema 对齐并移入 shared package；
2. 实现 `LearningRunSourceV1`：fixture source 与 API/SSE source 共用 `snapshot + dispatch(intent)`；
3. 接 `POST /learning-runs`、GET snapshot、SSE 与 draft CAS；
4. 先跑 Card text/voice 单一真实竖切：Artifact lock → Assessment → Finalizer/Commit → Result；
5. 再接 Review consume authorization 与 generation fence；
6. 通过 Gold Gate 后才开放 ordering/repair 的正式 Trust；
7. Card 与 Review 同时切换到新 Player，之后删除旧双轨；
8. 接 Main ↔ Pet Bridge，让 Live2D Pet 发起/恢复 Run 并消费真实 result；
9. 接 Star Map route / delta；
10. 将已完成的只读档案 UI 接入真实 cursor pagination、全量 session scope、结构化 message block 与动作审计。

### 切流前硬阻断

- 当前 fixture 不得写入 production；
- 当前 prototype route 不得成为 Card / Review 正式入口；
- 当前 UI 的 `created/rescheduled` 只是结果状态样例，不代表真实 scheduler 已实现；
- 当前 UI 验收不能替代真实 API、RLS、幂等、竞态、Assessment Gold 与 E2E Gate。

---

## 7. 本轮结论

本轮已经把“主观题 = 大文本框”的页面结构替换为一个可承载多种认知任务、可信边界、恢复和结果语义的统一 UI Shell，并完成开发态的状态与交互覆盖。

按照 Owner 指示，本记录完成后暂停，不继续进入生产接线。
