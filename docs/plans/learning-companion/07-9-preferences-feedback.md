# 决策记录 07-9：个性化偏好与反馈文案（§11）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-9
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-9（原方案 §11）+ 冻结记录 01-9（§11.1~§11.4）+ 06-5 route-launcher（「此刻」/官方 scheduler 边界）
> 约束级别：偏好全量可查看/修改/重置/导出/删除；无 XP/streak/排行榜/债务/随机奖励/强制每日目标；Agent 不能静默改偏好。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/session-preferences.ts`：§11 偏好决策面
  的纯逻辑（无数据库/无网络/无时钟/无副作用源）——本轮上下文（§11.1）、
  长期可编辑偏好白名单与值校验（§11.2 清单）、偏好 CRUD（查看/修改/重置/
  导出/删除）、Agent suggested preference 边界、产品状态与学习偏好分离、
  设置与帮助能力。
- `apps/api/src/modules/learning-sessions/session-preferences.test.ts`：32 个单测。
- `apps/web/lib/learning-companion/feedback-copy.ts`：反馈文案规则纯逻辑
  （§11.3 允许/禁止集合 + §11.4 具体可行动非身份化校验与合规文案构造）。
- `apps/web/lib/learning-companion/feedback-copy.test.ts`：37 个单测。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 本轮上下文（§11.1）

`buildRoundContext`：**默认只要求选择目的地**（destinationKeyPointId 唯一必填），
其余全部可选（缺省 null）；时长 3/10/20/自定义（自定义必须带正整数分钟）、
本轮精力（低负荷/正常）、挑战偏好（温和/标准/挑战）、输入方式（静音/可语音/
只用触控或键盘）、复习范围（聚焦一个星域/混合复习）。

`resolveRoundContextBoundaries`：`neverPersisted: true`（**本轮精力不长期保存、
不形成心理画像**）；只影响 route composition / 表达 / 数量 / 互动选择；
`masteryInfluence: 0` 与 `schedulerInfluence: false` 在类型面与运行面双重
保证 —— **不能直接进入 mastery 或 official scheduler**（route-launcher 的
official 事实边界保持一致）。

### 2.2 长期可编辑偏好白名单（§11.2 清单）

`PREFERENCE_KEYS` 恰为 §11.2 清单的 **23 个键**：默认输入优先级 / 禁用
Encounter / 反馈风格 / 存在感 / 页面静音与专注（默认）/ 动画与语音输出 /
全局关闭 / 仅本设备持久化的临时隐藏 / 不再提示的 suggestion classes / 挑战
倾向 / 单主题交错 / 默认时长 / 每周负荷 / 时间窗 / 通知边界 / TTS 语速 /
字幕 / 音效 / reduced-motion / 无障碍偏好 / 原始音频保留与隐私选择。
每个键带展示标签与值校验（枚举/布尔/范围/时间窗格式）。

### 2.3 偏好全量可查看 / 修改 / 重置 / 导出 / 删除（§11.2 验收）

- 查看：`PreferencesState`（explicit + suggested）直接可读；
- 修改：`setExplicitPreference`（键合法 + 值通过 schema 才写入）；
- 重置：`resetPreference`（单键，explicit/suggested 一并移除）与
  `resetAllPreferences`；
- 导出：`exportPreferences`（JSON，含 explicit/suggested）；
- 删除：`deleteAllPreferences`；
- 导入回读：`importPreferences`（任何非法键/值整体拒绝）。

### 2.4 Agent 只能提出 suggested preference（§11.2 / 01-9 §3）

`applyAgentSuggestedPreference` 只写 `suggested`（`explicitChanged` 恒
false）；值不合法连 suggested 也不写（fail closed）。`explicit` 只有三个
**用户显式路径**可改：`setExplicitPreference` / `acceptSuggestedPreference` /
`importPreferences`。`agentSilentChangeAttempt` 对任何静默改变一律
`blocked: true` 且 explicit 原样保留。

### 2.5 产品状态与学习偏好分离（§11.2）

onboarding 完成 / 跳过是**产品状态不是学习偏好**：`PRODUCT_STATE_KEYS`
（onboarding_completed / onboarding_skipped）不在偏好白名单；
`isLearningPreferenceKey` 恒为 false；`resetAllPreferences` / 
`deleteAllPreferences` 的结果不含 onboarding 键 —— **重置偏好不得重新触发
已跳过引导**。

### 2.6 设置与帮助（§11.2）

`REPLAY_FIRST_GUIDE_ENTRY = "重新播放首次引导"`（07-1 手动重播接线）；
`buildCompanionPageContextAvailability` 输出「伴星当前可使用哪些页面上下文」
（07-2 coverage registry 的 page kind，去重排序，不编造可用页面）。

### 2.7 游戏感来源与反馈文案规则（§11.3 / §11.4）

`feedback-copy.ts`：
- **允许表达集合**（七种）：选择目的地和路线 / 预测决定后果 / 操作看到系统
  ·因果·条件变化 / 修复光路·让星重新清晰 / 可信理解变化在知识世界显现 /
  主动保存的问题得到回答 / 回看理解变化；
- **禁止表达集合**（21 种机制，各自独立正则）：XP/等级/金币/连击/宝箱、
  streak/断签宽限/保住火焰、每日清空/自动追加/无限下一题、排行榜/分享成绩/
  跨用户比较、失败扣分/掉级羞辱/倒计时、随机奖励/内容锁/体力墙、伴星失望·
  焦虑·拟人依赖催促；
- **身份化 / 伪精确校验**：拒绝「你落后了」「欠了 N 项」「你不适合这种学习
  方式」「完全掌握 92%」「再来一题保住进度」（§11.4 禁止文案）；
- **合规文案构造**：`buildSpecificFeedback` 生成「这次你已经能重建前三个步骤，
  边界条件还没独立验证。可以试着独立验证一遍。」式具体、可行动、非身份化
  文案，输出保证通过 `validateFeedbackCopy`。

## 3. 测试覆盖

- session-preferences 32 个单测：默认只要求目的地、精力不长期保存且不进
  mastery/scheduler、白名单 23 键、值校验、CRUD 往返、Agent 建议只进
  suggested / 静默改变 blocked、onboarding 键非学习偏好、重置不触发引导、
  设置与帮助入口；
- feedback-copy 37 个单测：允许表达七种、21 种禁止机制逐一样例检测、
  身份化/伪精确/债务化/催促拒绝、可行动判定、文档示例文案合规验证。

## 4. 验收对照

- 偏好全量可查看 / 修改 / 重置 / 导出 / 删除：§2.3 五个 CRUD 路径齐备 ✓
- 无 XP / streak / 排行榜 / 任务债务 / 随机奖励 / 强制每日目标：
  `validateFeedbackCopy` 21 种禁止机制逐一拒绝 ✓
- Agent 不能静默改偏好：`agentSilentChangeAttempt` 恒 blocked，
  `explicitChanged` 恒 false ✓

---

*本文档为阶段 07 W6 任务 07-9 决策记录，忠实覆盖 `07-w6-global-companion-map-tutor.md`
任务 07-9（§11）与冻结记录 01-9。*
