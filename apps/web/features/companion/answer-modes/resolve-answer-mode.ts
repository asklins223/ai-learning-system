/**
 * 任务 14：作答模态编排纯函数（14-learning-card-review-multimodal-reconstruction §3.1）。
 *
 * Supervisor 侧「不写真相」的模态选择：把 Key Point 资格 + 用户偏好 + session
 * 上下文解析成唯一作答模态与 trustCeiling。纯同步、无 React / 无 DOM / 无网络。
 *
 * 锁定语义（§3.1 注 1.0 + Owner 决策 1/2/4，单测锁定，不得松动）：
 * - 复习页：text 默认、voice 可选（决策 1）；voice 不可用自动落回 text；
 * - 练习页：未设偏好时 silent 优先、text 兜底（「不以打字为默认前提」，决策 2）；
 * - 显式偏好优先（决策 4「偏好=优先」）：显式 text 不被 silent 抢跑；
 * - cooldown 窗口内（内容工具暴露后）一律 practice（§3.1 规则 1）；
 * - silent 正式航程需 eligibility 五证齐全 + 跨模态 Gold（fail closed，§7 决策 2）；
 * - transfer 需 rubricComplete + evidenceComplete（06-6 gate，fail closed）；
 * - 任何模态不可用时 fail-open 到 text，不允许「无路可走」（规则 4）。
 *
 * scenePlan 为 PREPARE/journeyPlan 的建议默认（§3.1 输出含 scenePlan）；实际
 * Scene 序列以 journeyPlan 为准，本函数只保证模态级编排语义。
 */

import { SceneType } from "@ailearn/shared";

export type AnswerPage = "practice" | "review";

export type AnswerMode = "voice" | "silent" | "text" | "transfer" | "practice";

/** 用户全局偏好（设置 → 伴星，跨设备一致；决策 4）。"any" = 未设置偏好。 */
export type AnswerModePreference = "voice" | "silent" | "text" | "any";

/**
 * 模态信任天花板（与 01-2 §7.3 TrustClass 对齐；record_only 为 06-6 transfer
 * 的 0 schedule 副作用语义）。
 */
export type AnswerModeTrustCeiling =
  | "mastery_eligible"
  | "facet_eligible"
  | "record_only"
  | "practice";

export interface ResolveAnswerModeInput {
  page: AnswerPage;
  keyPointId: string;
  /** rubric 全部 required 项已满足（transfer gate 要件之一）。 */
  rubricComplete: boolean;
  /** evidence 全部齐全（transfer gate 要件之二）。 */
  evidenceComplete: boolean;
  /** 05-1 eligibility 五证综合判定（fail closed：全证明通过才 eligible）。 */
  structuredProofEligibility: "eligible" | "not_eligible";
  /** 跨模态 Gold 认证通过（silent 正式航程硬门槛之一，§7 决策 2）。 */
  crossModalGoldPassed: boolean;
  /** 用户全局偏好；"any" = 未设置。 */
  userPreference: AnswerModePreference;
  /** 内容工具暴露后的 cooldown 窗口内 → 一律 practice（规则 1）。 */
  inCooldown: boolean;
  /** voice 能力可用（浏览器支持 + 麦克风 + ASR provider 可用）。 */
  voiceAvailable: boolean;
  /** journeyPlan 建议的 Scene 序列（透传为默认 scenePlan）。 */
  scenePlanHint?: SceneType[];
}

export interface ResolveAnswerModeOutput {
  mode: AnswerMode;
  scenePlan: SceneType[];
  trustCeiling: AnswerModeTrustCeiling;
  /** 决策原因码（供 UI 解释与测试断言）。 */
  reason: string;
}

/** silent 正式航程的 eligibility 门槛：五证 eligible 且过跨模态 Gold。 */
function silentEligibleForFormal(
  input: ResolveAnswerModeInput,
): boolean {
  return (
    input.structuredProofEligibility === "eligible" &&
    input.crossModalGoldPassed
  );
}

/** transfer gate：rubricComplete + evidenceComplete（06-6，fail closed）。 */
function transferGatePassed(input: ResolveAnswerModeInput): boolean {
  return input.rubricComplete && input.evidenceComplete;
}

const VOICE_SCENE_PLAN: SceneType[] = [SceneType.VOICE_TEACHBACK];
const SILENT_DEFAULT_SCENE_PLAN: SceneType[] = [
  SceneType.ORDERING,
  SceneType.REPAIR,
];
const TRANSFER_SCENE_PLAN: SceneType[] = [SceneType.MULTI_STEP_SCENARIO];

function voice(
  scenePlanHint: SceneType[] | undefined,
  reason: string,
): ResolveAnswerModeOutput {
  return {
    mode: "voice",
    scenePlan: scenePlanHint?.length ? scenePlanHint : VOICE_SCENE_PLAN,
    trustCeiling: "mastery_eligible",
    reason,
  };
}

function silent(
  scenePlanHint: SceneType[] | undefined,
  reason: string,
): ResolveAnswerModeOutput {
  return {
    mode: "silent",
    scenePlan: scenePlanHint?.length ? scenePlanHint : SILENT_DEFAULT_SCENE_PLAN,
    trustCeiling: "mastery_eligible",
    reason,
  };
}

function transfer(reason: string): ResolveAnswerModeOutput {
  return {
    mode: "transfer",
    scenePlan: TRANSFER_SCENE_PLAN,
    trustCeiling: "record_only",
    reason,
  };
}

function text(reason: string): ResolveAnswerModeOutput {
  return {
    mode: "text",
    scenePlan: [],
    trustCeiling: "mastery_eligible",
    reason,
  };
}

function practice(reason: string): ResolveAnswerModeOutput {
  return {
    mode: "practice",
    scenePlan: [],
    trustCeiling: "practice",
    reason,
  };
}

/**
 * 解析作答模态（§3.1 规则 1–4）。
 *
 * 规则 1：cooldown 窗口内 → 一律 practice；
 * 规则 2：复习页默认 text；仅显式 voice 偏好（且 voice 可用）才走 voice；
 * 规则 3：练习页显式偏好优先（voice → text），否则 silent → transfer → text；
 * 规则 4：任何模态不可用 → fail-open 到 text。
 */
export function resolveAnswerMode(
  input: ResolveAnswerModeInput,
): ResolveAnswerModeOutput {
  // 规则 1：cooldown 窗口内一律 practice（trustCeiling=practice）。
  if (input.inCooldown) {
    return practice("cooldown-active");
  }

  // 规则 2：复习页 —— text 默认（决策 1）；显式 voice 偏好且 voice 可用才 voice。
  if (input.page === "review") {
    if (
      input.userPreference === "voice" &&
      input.voiceAvailable
    ) {
      return voice(input.scenePlanHint, "review-preference-voice");
    }
    // voice 不可用 / 未显式选 voice / 偏好 silent/text/any → text（fail-open）。
    return text("review-default-text");
  }

  // 规则 3：练习页正式航程 —— 显式偏好优先（决策 4「偏好=优先」）。
  if (input.userPreference === "voice") {
    return input.voiceAvailable
      ? voice(input.scenePlanHint, "practice-preference-voice")
      : text("practice-voice-unavailable");
  }
  if (input.userPreference === "text") {
    // 显式 text 偏好优先，不被 silent 抢跑（决策 4）。
    return text("practice-preference-text");
  }
  if (input.userPreference === "silent") {
    return silentEligibleForFormal(input)
      ? silent(input.scenePlanHint, "practice-preference-silent")
      : text("practice-silent-unavailable");
  }

  // 未设偏好：silent（eligible + Gold）→ transfer（gate）→ text 兜底。
  if (silentEligibleForFormal(input)) {
    return silent(input.scenePlanHint, "practice-default-silent");
  }
  if (transferGatePassed(input)) {
    return transfer("practice-default-transfer");
  }
  return text("practice-default-text");
}
