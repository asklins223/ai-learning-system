/**
 * 阶段 07（W6）任务 07-1：首次引导状态机纯逻辑（§3.2 + §5.4.3）。
 *
 * 对接阶段 02（W1）任务 02-3 的 `CompanionOnboardingStateV1` CAS（服务端已实现于
 * apps/api/src/modules/companion-shell/service.ts）：本文件是**客户端纯逻辑**，
 * 无 React / 无 DOM / 无网络 / 无副作用源，只做：
 * - 六步引导（认识边界 → 调整相处方式 → 选择起点 → 走过示例流程 → 看见可信交接
 *   → 明确结束）的结构与元数据；
 * - 从服务端 onboarding 状态 + 本地存在感/隐藏偏好推导唯一的展示决策
 *   （invite / guide / passive_note / none）；
 * - 引导内步骤导航与服务端 stepId 的映射（服务端初始 step "intro" → 第一页）；
 * - 把 UI 动作翻译成与 02-3 `OnboardingTransitionRequest` 一致的 CAS 请求；
 * - 终态 / 手动重播判定。
 *
 * 冻结语义（§5.4.3 / §3.2）：
 * - 注册成功首次进入只发一次账号级设置邀请；"我自己看看" = 直接跳过（无弱化、
 *   无倒计时、无二次挽留、无推荐角标——本文件不产生任何此类状态）；
 * - 已有偏好为 quiet / temporary hidden / global off 时只在设置/帮助被动介绍；
 * - 引导结束不自动开始正式航程；完成或跳过后不再自动邀请或重放，可手动重新开始；
 * - 引导**零副作用**：本模块不触发 exposure、学习事实或调度（不 import 任何
 *   api/事件/持久化模块；见单测的源码零副作用断言）。
 */

import type {
  CompanionOnboardingStateV1,
  OnboardingTransitionRequest,
  TransitionAction,
} from "@ailearn/shared";
import type { CompanionPresence } from "./companion-control-state.ts";

// ─── 1. 版本与常量 ──────────────────────────────────────────────────────

/** 本产品 onboarding 版本（与 02-3 服务端 /me/companion/onboarding/:version 对齐）。 */
export const ONBOARDING_VERSION = "onboarding-v1";

/** 服务端 run 的初始 stepId（02-3 service.ts `INITIAL_ONBOARDING_STEP_ID`）。 */
export const SERVER_INITIAL_ONBOARDING_STEP_ID = "intro";

/** 客户端引导第一个页面（服务端初始 step "intro" 映射到这里）。 */
export const ONBOARDING_FIRST_STEP_ID = "boundaries";

/** 示例材料命名空间前缀（§5.4.3 `onboarding_sample:*`，隔离样本资产）。 */
export const ONBOARDING_SAMPLE_PREFIX = "onboarding_sample:";

/** 引导示例流程使用的内置示例资产（隔离 renderer/demo map，不是用户内容）。 */
export const ONBOARDING_SAMPLE_ASSET_ID = "onboarding_sample:understanding-universe";

/** 示例资产标题（静态文案，随构建固定）。 */
export const ONBOARDING_SAMPLE_TITLE = "理解宇宙（示例）";

/**
 * 示例流程的 published target 资格（§5.4.3）：`false`。
 * 示例材料不是正式发布目标，不能产生正式验证结果；可信交接即在开始正式航程前
 * 清晰标注资格与信任边界。
 */
export const ONBOARDING_SAMPLE_PUBLISHED_TARGET_ELIGIBILITY = false;

/** 调整相处方式默认档位（未选择前默认"安静"，§5.5 / §5.4.3）。 */
export const DEFAULT_ONBOARDING_COMPANIONSHIP: CompanionPresence = "quiet";

// ─── 2. 六步结构 ────────────────────────────────────────────────────────

export const ONBOARDING_STEP_IDS = [
  "boundaries",
  "companionship",
  "starting-point",
  "sample-flow",
  "trusted-handoff",
  "finish",
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingStepMeta {
  id: OnboardingStepId;
  /** 1-based 步序号（导航点编号显示用）。 */
  index: number;
  /** 步骤短标题（顶部步骤点/面包屑用）。 */
  title: string;
  /** 步骤页主标题。 */
  heading: string;
  /** 步骤页说明（组件可按需展开渲染细节）。 */
  description: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepMeta[] = [
  {
    id: "boundaries",
    index: 1,
    title: "认识边界",
    heading: "先认识伴星的边界",
    description:
      "伴星会陪你理解材料、找到证据、安排复习；它不读你的凭据，不替你完成正式验证，也不替你做任何事。",
  },
  {
    id: "companionship",
    index: 2,
    title: "相处方式",
    heading: "调整我们相处的方式",
    description:
      "未选择前默认安静：不主动打扰，只有需要时你召唤。之后可以随时在设置里改成更主动的陪伴。",
  },
  {
    id: "starting-point",
    index: 3,
    title: "选择起点",
    heading: "从哪开始？",
    description:
      "可以先到沙盒用内置示例逛一圈，也可以直接进入你自己的内容。示例流程不会产生正式目标。",
  },
  {
    id: "sample-flow",
    index: 4,
    title: "示例流程",
    heading: "走过一次示例流程",
    description:
      "用一张内置示例卡片（onboarding_sample:*）走一小段：读卡、查看证据、了解一次学习回合长什么样。",
  },
  {
    id: "trusted-handoff",
    index: 5,
    title: "可信交接",
    heading: "看见可信交接",
    description:
      "示例内容标记为 publishedTargetEligibility=false，不是正式发布目标。正式航程会在开始前清晰标注资格与信任边界。",
  },
  {
    id: "finish",
    index: 6,
    title: "明确结束",
    heading: "从这里正式开始",
    description:
      "引导不会自动开始正式航程。你可以从自己的内容开始、去星图看看，或先结束引导。",
  },
];

export function isOnboardingStepId(value: string): value is OnboardingStepId {
  return (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

// ─── 3. 引导内选择与结束动作 ─────────────────────────────────────────────

/** 相处方式三档（= 存在感档位，§5.5）：安静 / 适度陪伴 / 主动建议。 */
export type OnboardingCompanionshipMode = CompanionPresence;

/** 起点选择（§5.4.3）：沙盒示例 或 自己的内容。 */
export type OnboardingStartingPoint = "sandbox" | "own-content";

export const ONBOARDING_STARTING_POINTS: readonly OnboardingStartingPoint[] = [
  "sandbox",
  "own-content",
];

/**
 * 明确结束的三个同级动作（§5.4.3）：从我的内容开始 / 去星图看看 / 结束引导。
 * 任一动作都不会自动开始正式航程（正式航程由用户在自己内容/星图中明确发起）。
 */
export type OnboardingFinishAction =
  | "start-own-content"
  | "go-to-star-map"
  | "end-guide";

export const ONBOARDING_FINISH_ACTIONS: readonly OnboardingFinishAction[] = [
  "start-own-content",
  "go-to-star-map",
  "end-guide",
];

// ─── 4. 展示决策（invite / guide / passive_note / none）───────────────────

export interface OnboardingViewInput {
  /**
   * 服务端 onboarding 状态（本版本）。注册后首次进入时可能尚不存在
   * （GET /me/companion 的 onboardingStates 不含本版本）→ undefined。
   */
  state?: CompanionOnboardingStateV1;
  /** 用户是否已显式选择存在感（false = 未选择，默认 quiet，可主动邀请）。 */
  presenceChosen: boolean;
  /** 当前存在感档位（默认 quiet）。 */
  presence: CompanionPresence;
  /** 本设备 temporary hidden（device-local）。 */
  temporaryHidden: boolean;
  /** 账号级 global off。 */
  globalOff: boolean;
}

export type OnboardingView =
  /** 不展示任何 onboarding surface（已 consumed，不自动重放）。 */
  | { kind: "none" }
  /** 唯一主动 consent surface：邀请用户走一遍（渲染前需服务端 CAS start 取得 permit）。 */
  | { kind: "invite" }
  /** 引导进行中（offered 且有 active run），展示六步引导 UI。 */
  | { kind: "guide"; state: CompanionOnboardingStateV1 }
  /** 已有 quiet/hidden/off 偏好：只在设置/帮助被动介绍，不主动邀请。 */
  | { kind: "passive_note" };

/**
 * 从服务端状态 + 本地偏好推导唯一展示决策（§5.4.3）。
 *
 * 规则（冻结）：
 * - global off / temporary hidden / 已显式选择 quiet → 一律 `passive_note`
 *   （即使 offerStatus=not_offered 也不主动邀请）；
 * - 无偏好且状态为 undefined / not_offered → `invite`（唯一主动 consent surface）；
 * - offered 且有 active run → `guide`；
 * - offered 但无 active run（已 abandon/pause 清空）→ `none`（不自动重开）；
 * - consumed → `none`（完成/跳过终态，不自动邀请或重放）。
 */
export function deriveOnboardingView(input: OnboardingViewInput): OnboardingView {
  const passive =
    input.globalOff
    || input.temporaryHidden
    || (input.presenceChosen && input.presence === "quiet");
  if (passive) return { kind: "passive_note" };

  const state = input.state;
  if (!state || state.offerStatus === "not_offered") return { kind: "invite" };
  if (state.offerStatus === "offered" && state.activeRun) {
    return { kind: "guide", state };
  }
  return { kind: "none" };
}

// ─── 5. 引导内步骤导航（纯函数）──────────────────────────────────────────

/** 下一步；已是最后一步返回 null（无自动循环、无自动进入正式航程）。 */
export function nextOnboardingStep(current: OnboardingStepId): OnboardingStepId | null {
  const index = ONBOARDING_STEP_IDS.indexOf(current);
  if (index === -1 || index === ONBOARDING_STEP_IDS.length - 1) return null;
  return ONBOARDING_STEP_IDS[index + 1];
}

/** 上一步；已是第一步返回 null。 */
export function previousOnboardingStep(current: OnboardingStepId): OnboardingStepId | null {
  const index = ONBOARDING_STEP_IDS.indexOf(current);
  if (index <= 0) return null;
  return ONBOARDING_STEP_IDS[index - 1];
}

/** 是否最后一步（finish）。 */
export function isLastOnboardingStep(step: OnboardingStepId): boolean {
  return step === ONBOARDING_STEP_IDS[ONBOARDING_STEP_IDS.length - 1];
}

/**
 * 把服务端 run 的 stepId 映射到客户端六步。
 * 服务端初始 step "intro" 及任何未知/历史 step 都映射到第一页（boundaries）；
 * 引导内 step 推进是客户端本地状态，不写服务端（服务端只管理 run 生命周期）。
 */
export function resolveGuideStepId(serverStepId: string | undefined): OnboardingStepId {
  if (serverStepId && isOnboardingStepId(serverStepId)) return serverStepId;
  return ONBOARDING_FIRST_STEP_ID;
}

// ─── 6. 终态 / 手动重播判定（§5.4.3）────────────────────────────────────

/** 该版本是否已到单调终态（consumed：completed 或 skipped，不可回退）。 */
export function isOnboardingConsumed(state: CompanionOnboardingStateV1): boolean {
  return state.offerStatus === "consumed";
}

/** 该版本是否已"完成"（完整走完引导）。 */
export function isOnboardingCompleted(state: CompanionOnboardingStateV1): boolean {
  return state.offerStatus === "consumed" && state.offerDisposition === "completed";
}

/**
 * 是否可手动重播：offered / consumed 均可（用户主动、从设置或帮助入口），
 * not_offered 不可（02-3：replay 前必须先 offer）。
 * 重播走 entryMode=manual_replay 独立 run，绝不改变 consumed 终态。
 */
export function canManuallyReplay(state: CompanionOnboardingStateV1): boolean {
  return state.offerStatus !== "not_offered";
}

// ─── 7. CAS 请求构造（对接 02-3 OnboardingTransitionRequest）──────────────

export interface OnboardingTransitionInput {
  action: TransitionAction;
  /** 客户端持有的 base revision（CAS 乐观锁）。 */
  revision?: number;
  /** pause/resume/abandon 必须带当前 runId；start/replay 缺省由服务端签发。 */
  runId?: string;
  /** start/replay 可选起始 stepId（缺省为服务端初始 step "intro"）。 */
  stepId?: string;
  /** resume 时必须提交与 activeRun.resumeTokenRef 一致的令牌。 */
  resumeTokenRef?: string;
}

/** 构造一次 onboarding transition 请求（字段按需携带，与 02-3 schema 一致）。 */
export function buildOnboardingTransitionRequest(
  input: OnboardingTransitionInput,
): OnboardingTransitionRequest {
  const request: OnboardingTransitionRequest = { action: input.action };
  if (input.revision !== undefined) request.revision = input.revision;
  if (input.runId !== undefined) request.runId = input.runId;
  if (input.stepId !== undefined) request.stepId = input.stepId;
  if (input.resumeTokenRef !== undefined) request.resumeTokenRef = input.resumeTokenRef;
  return request;
}

/** 邀请的三个同级动作：带我走一遍 = start；我自己看看 = skip（直接跳过）。 */
export function buildInviteStartRequest(input: { revision?: number; runId?: string }): OnboardingTransitionRequest {
  return buildOnboardingTransitionRequest({
    action: "start",
    revision: input.revision,
    runId: input.runId,
  });
}

/** "我自己看看" = 直接跳过：只写一次终态（skip），不弱化、不二次挽留。 */
export function buildInviteSkipRequest(input: { revision?: number }): OnboardingTransitionRequest {
  return buildOnboardingTransitionRequest({ action: "skip", revision: input.revision });
}

/** 明确结束（finish 的任一同级动作之前，若走完六步则以 complete 收束 run）。 */
export function buildGuideCompleteRequest(input: {
  revision?: number;
  runId: string;
}): OnboardingTransitionRequest {
  return buildOnboardingTransitionRequest({
    action: "complete",
    revision: input.revision,
    runId: input.runId,
  });
}

/** 提前退出引导：pause 只写 runStatus=paused，不自动展开（可后续被动续接）。 */
export function buildGuidePauseRequest(input: {
  revision?: number;
  runId: string;
}): OnboardingTransitionRequest {
  return buildOnboardingTransitionRequest({
    action: "pause",
    revision: input.revision,
    runId: input.runId,
  });
}

/** 手动重播（设置/帮助入口）：独立 manual_replay run，绝不改变 consumed。 */
export function buildManualReplayRequest(input: {
  revision?: number;
  runId?: string;
}): OnboardingTransitionRequest {
  return buildOnboardingTransitionRequest({
    action: "replay",
    revision: input.revision,
    runId: input.runId,
  });
}
