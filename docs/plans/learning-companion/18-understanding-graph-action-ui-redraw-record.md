# 理解星图行动面 UI 重绘记录

> 日期：2026-08-13  
> 状态：**UI redraw complete；projection / route / LearningRun API wiring not started**  
> 对应方案：[16-unified-learning-run-micro-journey-live2d-system-companion.md](./16-unified-learning-run-micro-journey-live2d-system-companion.md)  
> 实施边界：保留现有 `/graph` API、搜索、筛选、真实血缘与 Canvas；本轮只实现行动面及诚实的 Run 返回状态，不新增写 API，不在页面中增加伴星头像、聊天框或 AI 面板。

---

## 1. 本轮完成

### 1.1 选中节点后的原生学习动作

Card / Key Point 详情新增“从这颗星继续”决策区：

- **三分钟练习**：进入统一 LearningRun 开发预览，并携带 `origin=graph`、目标 node/card/keyPoint 上下文；当前不创建真实 Run；
- **比较相邻概念**：优先比较同卡 Key Point，再使用一跳相邻 Card/Key Point；只并列展示真实摘要和证据信号，不由 UI 判定概念差异；
- **回溯证据**：使用现有 graph API 的 lineage 展示 Source → Note → Card → Key Point，并可打开真实对象；不生成补充证据；
- **规划路线**：提供三步本地 UI 预览（回到证据 → 辨清边界 → 完成练习），明确标为未保存；不冒充服务端冻结的 RoutePlan。

决策区常驻边界文案：只有独立 Assessment 并完成 Commit，正式星图才可能变化。

### 1.2 LearningRun 返回星图

新增四种互斥的 UI 状态：

| 状态 | UI 表达 | 禁止行为 |
| --- | --- | --- |
| `delta` | 显示可追溯变化及服务端 delta 指定的切面摘要 | 客户端自行 diff 或写投影 |
| `pending` | 明示 Run 已完成但 projector 尚未追上 | 提前点亮或声称掌握提升 |
| `practice` | 只显示练习航迹已记录 | 修改正式理解状态 |
| `none` | 明示本次无星图变化 | 播放庆祝或制造变化动画 |

这些状态当前是 development-only query fixture，用来验收表现合同，不读取或伪造正式投影：

```text
/graph?graphUi=delta
/graph?graphUi=pending
/graph?graphUi=practice
/graph?graphUi=none
```

可选 `targetNodeId=<graph node id | entity id>`；未指定时仅在原型首次加载中聚焦一个真实 Key Point/Card。关闭详情后不会被自动重新打开。

复审修补后，返回显影会按服务端样例中的目标、切面与 evidence 引用聚焦，而不是把任意当前节点冒充变化目标；`seen` 也不再被归入“已理解”，而是明确显示为“待验证”。

### 1.3 原系统能力保持

- `api.getUnderstandingGraph()` 数据读取未替换；
- `UnderstandingUniverse` Canvas、节点布局、缩放、适配、选中路径未替换；
- 搜索、状态筛选、Source / Claim / Link 图层及本地偏好保持；
- 详情仍展示真实 evidence count、误解记录、时间和一跳关系；
- 提供可聚焦的文本星体列表，让键盘与读屏用户不必操作 Canvas 才能选择节点；
- 路线预览支持顺序调整、恢复默认和过期态，且始终标为本地未保存；
- 星图页面没有伴星头像、伴星对话框、内联 AI 卡或右侧 AI 面板。

---

## 2. 修改文件

- `apps/web/app/(workspace)/(default)/graph/page.tsx`
  - 新增动作选择、相邻概念解析、真实 lineage 工作区；
  - 新增 development-only return fixture 与状态切换；
  - 保持所有动作 fail-closed，不接写端。
- `apps/web/app/styles/understanding-graph.css`
  - 详情面板扩展为学习决策面；
  - 新增比较、证据路径、路线和四类返回状态样式；
  - 覆盖 desktop / compact desktop / tablet / phone、day / night、reduced-motion、focus-visible 与 high-contrast。

---

## 3. 验证记录

### 3.1 静态检查

```text
eslint app/(workspace)/(default)/graph/page.tsx --max-warnings=0
→ passed

apps/web tsc --noEmit
→ passed

git diff --check -- graph/page.tsx understanding-graph.css
→ passed
```

### 3.2 浏览器验收

| 视口 / 模式 | 验收内容 | 结果 |
| --- | --- | --- |
| 1280 × 720 day | return delta、动作入口、详情滚动与固定底栏 | 通过 |
| 1024 × 768 day / night | 紧凑侧栏、return notice 与详情不重叠 | 通过 |
| 768 × 900 | 双行 HUD、搜索与详情头不重叠 | 通过 |
| 390 × 844 | bottom sheet、动作网格、关闭恢复、return notice | 通过 |

实际点通：

1. 比较相邻概念：能展示当前 / 相邻对象并在 Canvas 中转到相邻节点；
2. 回溯证据：当前 fixture 展示 3 个真实 lineage 对象及打开入口；
3. 规划路线：3 个步骤完整，且明确本地预览、未保存；
4. 返回状态：`delta → pending → none` 文案、progress 和变化摘要互斥；
5. Escape 关闭详情，手机关闭后不被 return fixture 重新打开；
6. 返回显影与详情可同时存在，关闭详情不会清除返回结果；
7. 键盘星体列表、路线重排 / 恢复 / 过期态可操作；
8. 浏览器控制台 `error/warn = 0`。

---

## 4. 后续接线边界

恢复实施时应按正式方案接入，而不是扩写当前 fixture：

1. 实现 Projection checkpoint-aware reader；
2. 实现 RoutePlan 冻结与读取；
3. 从星图创建真实 LearningRun，并保存语义 return target 与设备本地 viewport；
4. 接 `LearningRunReturnContractV1` 的 active / pending / ready / none / unavailable；
5. 只从服务端 immutable change set 渲染 delta，并保存设备级一次性显影 receipt；
6. practice trail 与 canonical personal state 使用两条独立 projection plane；
7. 完成后再把三分钟练习链接从 prototype 路由切到正式 Run Player。

当前 UI 不得被解释为 RoutePlan、Assessment、Commit 或 Projection 已经实现。
