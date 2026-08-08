# 决策记录 07-5：学习卡一个主行动与四入口共享内核（§8/§3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-5
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-5（原方案 §8 学习卡 + §10.3 星图行动
> + §3.3~3.8 旅程）；旅程 A~F（`00-6-users-journeys.md`，阶段 00 任务 00-6）作为验收场景。
> 约束级别：**四入口结果一致且就地完成**；**学习卡无第二个平级玩法菜单**。
> 配套：03-2（PREPARE 冻结与 origin-aware completion）、02-8（learning_unit_exposure
> aggregate/guard）、06-5（official scheduler 唯一写入权）、06-6（学习卡主行动与静态卡 fallback）、07-7（当前 target Tutor）。

---

## 1. 交付物

- `apps/web/components/learning-companion/LearningCardActions.tsx`：学习卡组件——唯一主行动
  「开始/继续一小段航程」+ 内容工具（朗读/查看证据/问一问），无第二个平级玩法菜单；纯 UI +
  props 回调（不调用服务端、不引用 canvas/webgl，与 06-6 StaticCardFallback 同风格）；
- `apps/web/lib/learning-companion/four-entry-origin.ts`：四入口共享内核纯逻辑——originRef
  冻结（PREPARE）、star_map/card/review/now/tutor_detour 四入口的 viewport/selection/
  completion summary 恢复语义、每处「在星图中查看」可选跳转、学习卡状态≠用户理解、
  内容工具 exposure 与 assistance cooldown；
- `apps/web/lib/learning-companion/four-entry-origin.test.ts`：单测（32 例）；
- 本文件：决策记录。

## 2. 学习卡一个主行动（§8）

- 学习卡仍是有证据的知识载体；前台**只保留一个主行动**「开始/继续一小段航程」
  （`LEARNING_CARD_PRIMARY_ACTION`），不把「动/试」做成平级玩法菜单；
- Supervisor 决定本轮使用语音、排序、修复还是情境：`journeyHint` 是一行提示（「本轮由伴星
  安排：…」），由 Supervisor 结果注入，**不是可点选的平级玩法入口**；
- 主行动唯一性在组件结构上保证：主行动区只渲染一个主按钮；不渲染「让我试试」等并列玩法按钮。

## 3. 内容工具与 assistance cooldown（§8）

- 朗读（TTS 播放摘要/论点/证据）、查看证据（展开 exact evidence 与 semantic support）、
  问一问（当前 target 有界 Tutor detour）作为**内容工具**存在，不必创建完整 formal Session；
- **按实际暴露内容记录 exposure**：`recordToolExposure` 记录 `(tool, contentExposureKey,
  atEpoch)`；组件通过回调让父级在「实际播放/实际展开/实际发生」时落账（02-8
  contentExposureKey 语义，跨页面/设备/Session 持久）；
- 随后开始航程必须遵守 **assistance cooldown**：`resolveJourneyReadiness` 在暴露后的
  cooldown 窗口内返回 `practice_only`（不制造「已掌握」）；冷却过后可再独立验证（旅程 E
  「冷却后再独立验证」）。

## 4. 学习卡状态 ≠ 用户理解（§8 / 07-5）

`classifyCardEvent` / `projectCardStateEffects` 冻结分类：

| 事件 | 投影效果 |
| --- | --- |
| `asset_published`（发布） | `no_change`（资产过生成与证据 Gate，是资产状态不是理解） |
| `opened` / `listened` / `favorited` | `no_change`（只表示接触） |
| `tutor_explained`（Tutor 解释） | `practice_event`（只产生 practice 事件） |
| `trusted_validation` / `trusted_review` | `understanding_change`（唯一改变个人理解投影的来源） |

`buildCompletionSummary` 只接受 trusted 验证/复习事件进入能力/复习变化摘要；practice/contact
事件进入摘要为 0（§10.4：浏览/打开/停留/收藏/朗读/看过答案不能点亮理解）。组件状态徽标据此
区分展示：已发布/已打开/已收听/已收藏/练习 N 次均非理解变化，仅「已验证 N 次」标记为 trusted。

## 5. 四入口共享内核与 PREPARE 冻结（§3）

`freezePrepareOrigin`（PREPARE）把以下内容**深度冻结**（任意修改 fail-closed）：

- `originRef`（合法类型：key_point / card / review_schedule / question_suggestion；ephemeral
  只作 originRef，正式 target 仍是 Key Point，03-2 §3）；
- star_map 入口的原 **viewport/selection snapshot**（`{offsetX, offsetY, zoom}` + 选中/高亮；
  star_map 入口必须携带，缺失 fail closed）；
- **completion summary contract**（能力/复习变化摘要、未处理事实、schedule 结果；
  `fromTrustedContractOnly: true`）。

四入口从同一 `FrozenPrepareOrigin` 派生出结果一致的视图并**就地完成**（`completedInPlace`）：

| 入口 | 恢复语义（§3.3~3.8） |
| --- | --- |
| `star_map` | 恢复原 viewport/zoom/selection 并**显影真实变化**（`revealRealChange=true`；只有 trusted 事件依据的变化，旅程 A「返回原星图视口 → 只有真实验证过的切面变化」） |
| `card` | 返回当前卡片显示能力/复习变化摘要（来自冻结 contract；旅程 D/E 返回卡片） |
| `review` / `now` | 展示本 Episode schedule 结果与未处理事实（事实语言，不道德化为债务；旅程 F） |
| `tutor_detour` | 回到原 Episode / 保留为练习 / 明确结束三选一（Must 固定动作；旅程 D） |

- 每处可「在星图中查看」但不强制跳转：`starMapView.forced` 恒为 `false`，`available` 仅
  star_map 本身为 `false`（§10.6 星图不是唯一入口）；组件只渲染可选次级动作
  `onViewInStarMap`；
- 四入口一致性判定：`fourEntriesShareCore` 校验所有视图共享同一
  `sessionId + episodeId + targetKeyPointId + originRef`。

## 6. 旅程 A~F 验收映射（00-6）

- **A 第一次遇见一颗新星**：`star_map` 入口恢复冻结视口/选择并显影真实变化（只有 trusted
  切面）；「在星图中查看」可选不强制；
- **B 完全不打字的稳固航程**：主行动唯一（无平级玩法菜单），Supervisor 决定本轮形式；
- **C 语音 Teach-back**：朗读（TTS）是内容工具，按实际播放记录 exposure；
- **D 边学边问**：问一问是有界 Tutor detour（回到原 Episode/保留为练习/明确结束），只产生
  practice 事件；
- **E 从误区到修补**：cooldown 窗口内 `practice_only`、不制造「已掌握」，冷却后再独立验证；
- **F 长时间离开后回来**：review/now 入口展示 schedule 结果与未处理事实（事实语言、非债务）。

## 7. 验收

- [x] 学习卡无第二个平级玩法菜单（组件只渲染一个主行动 + 内容工具；单测断言主行动常量与工具集）；
- [x] 四入口结果一致且就地完成（`fourEntriesShareCore` + `completedInPlace` 单测）；
- [x] originRef / viewport / selection / completion summary 在 PREPARE 深度冻结（单测断言
  `Object.isFrozen` 与修改抛错）；
- [x] 每处可「在星图中查看」但不强制跳转（`starMapView.forced === false` 单测）；
- [x] 学习卡状态 ≠ 用户理解（`classifyCardEvent` / `buildCompletionSummary` 单测）；
- [x] 朗读/查看/Tutor 按实际暴露记录 exposure，随后开始航程遵守 assistance cooldown
  （`recordToolExposure` / `resolveJourneyReadiness` 单测）；
- [x] `npm test --prefix apps/web` 通过（581/581，含新增 32 例）；类型检查以
  `npx tsc --noEmit --incremental false` 通过（环境对 tsconfig.tsbuildinfo 施加写保护，
  `tsc --incremental` 报 EPERM，属既有环境限制，历史任务沿用同等效命令）。
