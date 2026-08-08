# 决策记录 00-6：目标用户与关键旅程确认（§3）

> 状态：**Confirmed（已确认）**
> 批准人：Repository Owner（阶段 00 执行指令）
> 日期：2026-08-04
> 来源：`00-decision-and-scope.md` 任务 00-6（原方案 §3）
> 用途：目标用户画像 + 前置旅程 + 旅程 A~F 作为验收场景库（W6/W7/W8 复用）。

---

## 交付物

目标用户画像 + 前置旅程 + 旅程 A~F 作为验收场景库（W6/W7/W8 复用）。

## 目标用户画像（五类用户）

原文逐类列出：

1. 低打字意愿用户
2. 好奇型阅读者
3. 复习型用户
4. 严肃学习者
5. 无障碍用户

## 前置旅程（注册 → 第一次独立使用）

原文完整流程：

1. 注册/登录页静态伴星说明产品用途。
2. 首次进入只发一次欢迎（"要不要用大约 3 分钟和我走一遍？"）。
3. 三个同级动作"带我走一遍 / 我自己看看 / 先调整方式"，每步可返回/暂停/跳过。
4. "带我走一遍"进入物理隔离的 `onboarding_sample:*` 沙盒（示例材料 → 示例学习卡 → 极短操作 → 星图演示预览），固定标记 `onboarding_sample / practice_only`，不写 mastery/assessment/exposure/scheduler，演示结束即还原。
5. 自己的材料先结束 onboarding 再走正常导入/生成。
6. 结束后提供"从我的内容开始 / 去星图看看 / 结束引导"，不自动开始正式航程。
7. 完成后不再自动邀请或重放，可手动重开。
8. 老用户首次获得全局伴星只得到一个被动、非阻塞的短介绍。

## 旅程 A~F

### 旅程 A：第一次遇见一颗新星

轻邀请一次 → 选择语音/静音/稍后 → Encounter → 返回原星图视口 → 只有真实验证过的切面变化。

### 旅程 B：完全不打字的稳固航程

10 分钟静音 + `structuredProofEligibility` → 预冻结 structured-proof bundle 两个互补无即时反馈 Encounter → 不显示正确答案不自动吸附 → 覆盖全部 required rubric 且过 Gold 等价 Gate 才归一 canonical review outcome → 明确结束。

### 旅程 C：语音 Teach-back

按住说 20~60 秒 → ASR 逐字 transcript → 确认/重录/切模态 → Agent 不润色 → Critic 引用 transcript 片段与 canonical evidence 逐项评估 → 关键内容不确定则 not_assessable，无损重试不判为不会。

### 旅程 D：边学边问

trusted challenge 中提问先询问切到一起学习 → 原子记录 assistance/practice 后调 Grounded Tutor → 有界 detour → 固定返回原航程或结束；问题标记 Should flag 开启才持久保存。

### 旅程 E：从误区到修补

结果页不显示"失败"，指出尚未说清部分 → 仅在结果页存在的问题建议，Should 开启且用户确认才保存 → 可立即进入引导式练习但 assistance 后不制造"已掌握" → 冷却后再独立验证。

### 旅程 F：长时间离开后回来

不展示"欠了 87 项" → 询问 3/10/20 分钟 → 用 official scheduler 优先级+canonical outcome+兴趣提议一条短恢复路线 → 可缩短/换一条/自由漫游/关闭 → 未处理 schedule 保留事实但不被道德化为债务。

## 验收标准

旅程 A~F 被 W6（实现）、W7（E2E）、W8（RC）引用为验收场景。
