# 决策记录 07-1：注册/登录静态伴星与首次引导（§3.2+§5.4.3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-1
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-1（原方案 §3.2 + §5.4.3）
> 约束级别：注册/登录页不读取凭据、不调用个性化模型；首次引导对 exposure、学习事实与调度零副作用；引导结束不自动开始正式航程。

## 1. 目标

注册/登录/找回账号页的伴星只做静态或轻量状态说明（产品用途、登录与无障碍帮助、
确定性登录故障），不读取凭据、不观察输入、不建画像、不请求麦克风、不调用个性化模型。
注册成功首次进入系统时，伴星**只发一次账号级设置邀请**，经六步引导让用户建立对
伴星边界与信任交接的认知。

## 2. 决策

### 2.1 公开认证层 = 确定性动作 + 零采集（对接 02-5）

- 注册/登录/找回账号页的伴星内容来自随构建签名的 auth-surface manifest（02-5），
  只使用确定性产品动作；本任务不新增任何认证页伴星采集。
- 注册页**不读取凭据**：伴星组件与状态机不 import api、不读写表单字段、无 observer；
  页面职责矩阵把 `read_credentials / observe_input / build_profile / request_microphone`
  列为公开认证层 forbid 动作（07-2 registry 数据 + 单测断言）。

### 2.2 一次性 consent surface（§5.4.3）

- 注册成功首次进入（`offerStatus = not_offered` 或服务端尚无该版本状态、且无
  quiet/temporary hidden/global off 偏好）→ 展示唯一主动 consent surface：
  「欢迎来到你的理解宇宙。要不要用大约 3 分钟和我走一遍？」
- 固定三个**同级**动作：`带我走一遍 / 我自己看看 / 先调整方式`。
  - 带我走一遍 → 02-3 CAS `start`（渲染前必须先获得一次性 display permit）；
  - 我自己看看 = **直接跳过** → CAS `skip`（无弱化颜色、无倒计时、无二次挽留、
    无推荐角标；组件层面三个按钮等视觉权重）；
  - 先调整方式 → 进入存在感/相处方式设置（不改 offer 状态）。
- 已有偏好为 quiet（显式选择）/temporary hidden/global off 时 → 只在设置/帮助中
  被动介绍（`deriveOnboardingView` 返回 `passive_note`，不渲染邀请）。

### 2.3 六步引导（§5.4.3）

1. 认识边界：不读凭据、不代做、不代验证、不自动开始正式航程；
2. 调整相处方式：三档存在感，未选择前默认安静（quiet）；
3. 选择起点：沙盒（内置示例）或自己的内容；
4. 走过示例流程：只读示例卡 `onboarding_sample:*`（隔离样本资产，不进入用户内容）；
5. 看见可信交接：示例内容 `publishedTargetEligibility=false`，不是正式发布目标；
   正式航程在开始前清晰标注资格与信任边界；
6. 明确结束：从我的内容开始 / 去星图看看 / 结束引导。

### 2.4 CAS 状态机对接（02-3 已实现，本任务完成 UI 与入口接线）

- 服务端只管理 run 生命周期（start/skip/pause/resume/replay/complete/abandon）；
  引导内步进是**客户端本地 UI 状态**，不写服务端。
- 服务端初始 stepId `intro` 映射到客户端第一页 `boundaries`；未知/历史 step 同映射。
- 终态：`consumed`（completed/skipped）后不再自动邀请或重放；
  用户可随时从设置或帮助入口**手动重播**（CAS `replay` → `manual_replay` 独立 run，
  绝不改变 consumed）。
- 结束三选一动作**不自动开始正式航程**；own-content 起点先退出 sandbox 再走正常合同。

### 2.5 零副作用保证

- `onboarding-state.ts` 是纯逻辑（无 React/DOM/网络/随机/持久化），单测以源码扫描
  断言不含 api/网络/事件/调度副作用源，并断言派生函数是纯同步确定函数；
- 两个组件是纯 UI + props 回调，不调用服务端、无计时器、无动画（reduced-motion 友好）。

## 3. 实现

| 文件 | 内容 |
| --- | --- |
| `apps/web/lib/learning-companion/onboarding-state.ts` | 六步结构/导航、`deriveOnboardingView`、终态与重播判定、CAS 请求构造、示例与可信交接常量 |
| `apps/web/lib/learning-companion/onboarding-state.test.ts` | 六步冻结、展示决策全分支、终态/重播、CAS 请求、零副作用源码断言（23 项） |
| `apps/web/components/learning-companion/OnboardingInvite.tsx` | 唯一主动 consent surface：三个同级动作、跳过语义 |
| `apps/web/components/learning-companion/OnboardingGuide.tsx` | 六步引导 UI，全部动作经 props 回调接线 |

## 4. 验收

- 注册/首次引导全流程通过（邀请 → 六步 → 明确结束三选一）；
- onboarding 对 exposure、学习事实和调度零副作用（单测源码断言 + 组件纯回调）；
- 完成或跳过后不再自动邀请或重放；手动重播不改变 consumed 终态；
- 注册页不读取凭据（公开认证层 forbid 动作 + 零采集契约）。
