/**
 * 任务 14 接线：练习页 modeSelect 编排（14 方案 §3.2 / §3.6 / §4 阶段 B）。
 *
 * 纯逻辑（无 React / 无 DOM / 无网络）：
 * - **以服务端 PREPARE 下发的 journeyPlan 为权威输入**（任务 14 接线后不再
 *   由前端自行 fail-closed 猜测）：journeyPlan.mode 决定可展示的作答模态
 *   集合与默认模态；
 * - 决策 4「偏好=优先」：显式 voice/text/silent 偏好优先于 journeyPlan 默认，
 *   但资格约束（journeyPlan 编排的模态集合）仍然生效；
 * - cooldown 窗口内 → 只给 practice（§3.1 规则 1）；
 * - text 恒可达（§3.1 规则 4 fail-open 兜底），不允许「无路可走」；
 * - 不新增第二套运行时：模式选择只是前端作答层入口，提交仍走既有
 *   learning-session answer 链（§3.6）。
 */

export type PracticeModeSelectOption = "silent" | "voice" | "text" | "transfer";

/** 服务端 journeyPlan（api 侧 buildJourneyPlan 下发，版本 journey-plan-v1） */
export interface PracticeJourneyPlan {
  version: "journey-plan-v1";
  mode: "voice" | "silent" | "text" | "transfer" | "practice";
  scenePlan: string[];
  trustCeiling: "mastery_eligible" | "facet_eligible" | "practice" | "record_only";
  journeyHint: string;
  reason: string;
}

export interface PracticeModeSelectInput {
  /** 服务端 PREPARE 下发的 journeyPlan（权威编排；缺省 = 未下发，回退 text） */
  journeyPlan: PracticeJourneyPlan | null;
  /** 浏览器麦克风/MediaRecorder 能力可用（voice 可选前置） */
  voiceAvailable: boolean;
  /** 内容工具暴露后的 cooldown 窗口内 → 只给 practice（规则 1） */
  inCooldown: boolean;
  /** 用户全局偏好（设置 → 伴星；决策 4「偏好=优先」）；缺省 any = 跟随安排 */
  userPreference?: "voice" | "silent" | "text" | "any";
}

export interface PracticeModeSelectResult {
  /** 可展示的模态（顺序即默认优先级） */
  options: PracticeModeSelectOption[];
  /** 默认选中模态（modeSelect 初始呈现；text 恒为兜底可达） */
  defaultOption: PracticeModeSelectOption;
  /** 决策原因码（供 UI/测试断言） */
  reason: string;
}

/** journeyPlan.mode → 可展示模态集合（服务端编排权威，前端不自行 fail-closed）。 */
function optionsForJourneyMode(mode: PracticeJourneyPlan["mode"]): PracticeModeSelectOption[] {
  switch (mode) {
    case "silent":
      return ["silent", "voice", "text"];
    case "voice":
      return ["voice", "text"];
    case "transfer":
      return ["transfer", "voice", "text"];
    case "practice":
    case "text":
      return ["text"];
  }
}
/**
 * 解析练习页 modeSelect（§3.1 规则 1/3/4 + §3.6 服务端编排）。
 */
export function resolvePracticeModeSelect(
  input: PracticeModeSelectInput,
): PracticeModeSelectResult {
  // 规则 1：cooldown 窗口内 → 练习级（不升级、不延长 interval）。
  if (input.inCooldown) {
    return { options: ["text"], defaultOption: "text", reason: "cooldown-practice" };
  }

  // journeyPlan 未下发（旧客户端/异常路径）→ text 兜底，不猜模态。
  if (!input.journeyPlan) {
    return { options: ["text"], defaultOption: "text", reason: "no-journey-plan" };
  }

  const plan = input.journeyPlan;
  const baseOptions = optionsForJourneyMode(plan.mode);
  const canSilent = baseOptions.includes("silent");
  const canVoice = input.voiceAvailable && baseOptions.includes("voice");

  // 决策 4「偏好=优先」：显式偏好决定默认模态（仍受服务端编排集合约束）。
  const preference = input.userPreference ?? "any";
  if (preference === "voice") {
    const opts: PracticeModeSelectOption[] = canVoice ? ["voice", "text"] : ["text"];
    return { options: opts, defaultOption: canVoice ? "voice" : "text", reason: "preference-voice" };
  }
  if (preference === "text") {
    return { options: ["text"], defaultOption: "text", reason: "preference-text" };
  }
  if (preference === "silent") {
    const opts: PracticeModeSelectOption[] = [];
    if (canSilent) opts.push("silent");
    if (canVoice) opts.push("voice");
    opts.push("text");
    return {
      options: opts,
      defaultOption: canSilent ? "silent" : canVoice ? "voice" : "text",
      reason: canSilent ? "preference-silent" : "preference-silent-unavailable",
    };
  }

  // 跟随安排：服务端编排的默认模态。
  const options: PracticeModeSelectOption[] = [];
  if (canSilent) options.push("silent");
  if (canVoice) options.push("voice");
  if (baseOptions.includes("transfer")) options.push("transfer");
  options.push("text"); // text 恒可达（规则 4 fail-open 兜底）

  const defaultOption: PracticeModeSelectOption = canSilent
    ? "silent"
    : baseOptions.includes("transfer")
      ? "transfer"
      : canVoice
        ? "voice"
        : "text";
  return { options, defaultOption, reason: `journey-${plan.mode}` };
}
