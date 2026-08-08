# 决策记录 05-5：Global Shell 前端基础设施（§5.4.2/§5.4.4/§5.5）

> 状态：**Frozen（已冻结）**
> 执行：阶段 05（W4）任务 05-5
> 日期：2026-08-08
> 来源：`05-w4-scene-runtime-silent-profile.md` 任务 05-5（原方案 §5.4.2/§5.4.4/§5.5）；
> 冻结记录 01-3（数据/API/工具边界）、01-8（视觉与动画合同）
> 约束级别：context-off/hidden/off 后 observer/context 构造为 0；焦点恢复正确；
> 全站锚点不阻塞主内容。

## 1. 交付物

- `apps/web/lib/learning-companion/companion-control-state.ts` —— §5.5 八个
  versioned 控制状态的类型、作用域、默认值、行为元数据、组合/互斥规则，
  `resolveControlEffects` 权威效果解析、observer/context 零构造判定、
  立即生效的本地动作应用（纯逻辑，无 React/DOM/网络）。
- `apps/web/lib/learning-companion/companion-control-state.test.ts` —— 单测
  （各状态行为、互斥组合、observer/context 零构造、立即隐藏不等待网络、
  PageCompanionContextV1/CompanionTriggerContextV1 adapter 基础设施）。
- `apps/web/lib/learning-companion/page-companion-context.ts` ——
  `PageCompanionContextV1` / `CompanionTriggerContextV1` 类型与 adapter 基础设施
  （构造条件、短 TTL、销毁时机、最小触发快照、permit+接受后升级）。
- `apps/web/components/learning-companion/QuietAnchor.tsx` —— 安静锚点
  （静态中性小立绘、只提供召唤入口、无 idle 动画/闪烁/声音/未读红点、
  `temporary_hidden/global_off` 立即不渲染、默认右下安全边缘不覆盖主操作）。
- `apps/web/components/learning-companion/CompanionSidePanel.tsx` —— 侧板/
  移动端底部面板（可收起、关闭后焦点恢复、live region 只播报必要状态、非模态）。

## 2. 决策：控制状态是唯一权威，纯逻辑与组件分离

八种控制状态 `page_muted / page_context_off / focus_until_task_end /
suggestion_paused / temporary_hidden / global_off / animation_off /
voice_output_off` 各自作用域与行为按原方案 §5.5 完整表冻结（见元数据表）。
组合/互斥规则：

- `global_off` **蕴含** `temporary_hidden` 语义且优先于一切；
- `temporary_hidden` / `global_off` → 立即停渲染、observer、context、声音、
  邀请、预取、新增 job/Provider 调用；只留设置/帮助/全局命令恢复入口；
- `page_context_off` → 不挂载 observer、不构造/传输 entity refs；即使召唤也只
  用静态帮助，不升级上下文；
- `page_muted` / `focus_until_task_end` / `suggestion_paused` → 只抑制主动建议
  （和自动语音），保留锚点与手动召唤；
- `animation_off` / `voice_output_off` → 账号级偏好，功能入口保留但静态/静音，
  不改变学习权限与结果资格。

所有判定是纯同步函数（输入只有快照 + 本地召唤/存在感状态），组件据此
**立即**停渲染/停 observer/停 context —— UI 不等待网络才隐藏。

## 3. 决策：observer/context 零构造（§5.4.4，验收第一项）

`quiet` 未召唤、`page_context_off`、`temporary_hidden`、`global_off` 时，
adapter **不挂载 entity/selection observer，也不构造/发送完整 context snapshot**
（构造为 0）。`shouldMountObserver` / `shouldConstructContext` / 
`pageContextConstructionKind` 统一收口这一判定，测试逐一断言：

- quiet 未召唤 → `none`；
- page_context_off（即使召唤）→ `none`；
- temporary_hidden / global_off（即使召唤）→ `none`。

`quiet` 下只有显式召唤、选择「和伴星看看」或进入 Session 后，才按当前 action
所需字段构造**短 TTL**（默认 30s）的 `PageCompanionContextV1`；面板关闭/动作
结束/TTL 过期即销毁（`shouldDestroyContext` / `destroyContext`）。
`moderate/active` 判断合法 reason 时只能产生最小 `CompanionTriggerContextV1`
（不含 visible/selected entity refs、选区文本或页面内容）；只有
rule/budget/lease 签发 permit **且用户接受提示**后，才升级为完整净化上下文
（`canUpgradeToFullContext`）。

## 4. 决策：关闭面板后焦点回到原触发位置；live region 只播报必要状态

- `CompanionSidePanel` 打开瞬间记录触发元素（`restoreFocusRef` 或当时的
  `document.activeElement`），关闭后 `focus()` 回该元素（preventScroll），
  不把焦点丢给 body（验收「焦点恢复正确」）；
- 面板 `aria-modal="false"`，非模态、不阻塞页面主内容、不劫持 Tab 序；
- 常驻 `sr-only` live region 只在面板打开/关闭时播报两条必要状态，不重复播报
  面板内容。

## 5. 决策：全站锚点不阻塞主内容

- `QuietAnchor` 是静态中性小立绘按钮：无 idle 动画、无闪烁、无声音、无未读
  红点；`quiet` 未召唤时锚点保留（召唤入口）但绝不进入 idle 动画（01-8 §7）；
- 默认固定在右下内容安全边缘、z-index 低、尺寸 ≤48px，不覆盖导航区与内容主
  操作；可用 `className` 覆盖为导航区内嵌定位（移动端并入底部工具栏由后续
  接线任务完成）；
- `temporary_hidden/global_off` 时组件直接返回 null —— 立即停渲染，不等待网络。

## 6. 验收与证据

- [x] context-off/hidden/off 后 observer/context 构造为 0
  （`shouldMountObserver`/`shouldConstructContext` 判定 + 单测逐状态断言）。
- [x] 焦点恢复正确（CompanionSidePanel 关闭后 focus 回触发元素）。
- [x] 全站锚点不阻塞页面主内容（非模态、安全边缘、低 z-index、静态立绘无动画）。
- [x] `npx tsc --noEmit --incremental false`（apps/web）通过。
- [x] `npm test --prefix apps/web` 通过（含新增 companion-control-state.test.ts）。

## 7. 不做的边界（后续任务）

- 本任务不把 QuietAnchor/CompanionSidePanel 挂载进 AppShell 路由，也不建
  `/me/companion` 客户端调用；路由接线、账号级开关读取、runtime-fence 发送与
  lease 重验、page coverage registry 属后续任务。
- 决策记录约束级别：context-off/hidden/off 后 observer/context 构造为 0；
  焦点恢复正确；全站锚点不阻塞主内容。
