/**
 * 任务 14 接线：journeyPlan 生成（服务端 PREPARE 数据流，03-2 + 14 方案 §3.6）。
 *
 * 纯函数：从 episode 冻结事实（formalPlanKind / eligibilityKind / schedulingDecision）
 * 派生 journeyPlan —— 模态 + scenePlan + trustCeiling + journeyHint。
 * 不写真相：只读 episode 冻结字段，供 public view 下发（前端 modeSelect 消费）。
 *
 * 语义（14 方案 §3.1 编排规则）：
 * - structured_mastery_bundle → silent 正式航程（≥2 互补 Scene；资格由服务端
 *   冻结时已签发，前端不再自行 fail-closed）；
 * - voice_mastery → voice 正式航程；
 * - facet_only → facet-only（text/voice 均可，trustCeiling=facet_eligible）；
 * - practice / record_only → practice（text 兜底）；
 * - transfer：由 authorizedAction + rubric/evidence 完整度判定（06-6 gate）。
 *
 * scenePlan 为确定性默认（05-1 三 family 互补对）；具体 Scene public payload
 * 由 Scene Author 生成（worker 侧场景生成器接入后替换 scenePlan 占位）。
 */

export const JOURNEY_PLAN_VERSION = "journey-plan-v1" as const;

import type { SilentSceneDataV1 } from "./silent-scene-author.ts";

/** journeyPlan 下发的 scenes 形状（前端 SilentProofScene 消费）。 */
export interface JourneyScenePayloadV1 {
  sceneId: string;
  sceneType: "ordering" | "repair";
  targetKeyPointId: string;
  publicPayload: SilentSceneDataV1["ordering"] | SilentSceneDataV1["repair"];
}

export type JourneyMode = "voice" | "silent" | "text" | "transfer" | "practice";

export interface JourneyPlanV1 {
  version: typeof JOURNEY_PLAN_VERSION;
  mode: JourneyMode;
  /** Scene 种类序列（按 05-1 family 互补对；SceneType 字符串） */
  scenePlan: string[];
  /** silent 场景 public 数据（createSession 冻结时确定性生成；前端直接消费） */
  scenes?: JourneyScenePayloadV1[];
  /** 该 episode 的信任天花板（TrustClass 对齐） */
  trustCeiling: "mastery_eligible" | "facet_eligible" | "practice" | "record_only";
  /** 简短指引（前端展示「本轮由伴星安排」文案） */
  journeyHint: string;
  /** 决策原因码（供测试/诊断） */
  reason: string;
}

export interface JourneyPlanInput {
  formalPlanKind: string;
  /** authorizedAction（06-6 transfer gate 输入） */
  authorizedAction: "create_initial" | "consume_pending" | "record_only" | "no_effect";
  /** rubric 全部 required 已满足（transfer gate 双要件之一） */
  rubricComplete: boolean;
  /** evidence 全部齐全（transfer gate 双要件之二） */
  evidenceComplete: boolean;
  /** 05-1 eligibility 五证（structured_mastery_bundle 冻结时已签发；此处透传） */
  structuredProofEligibility: "eligible" | "not_eligible";
  /** 跨模态 Gold 认证（服务端冻结；silent 正式航程门槛） */
  crossModalGoldPassed: boolean;
  /** silent profile family（用于互补 Scene 默认序列；缺省 procedure） */
  silentProfileFamily?: "procedure" | "causal_boundary" | "concept_application";
  /** silent 场景 public 数据（createSession 冻结时生成；下发 scenes） */
  silentSceneData?: import("./silent-scene-author.ts").SilentSceneDataV1 | null;
  /** 目标 Key Point id（scenes 下发时写入 targetKeyPointId） */
  keyPointId?: string;
}

const SILENT_SCENE_PLANS: Record<string, string[]> = {
  procedure: ["ordering", "repair"],
  causal_boundary: ["relation_canvas", "multi_step_scenario"],
  concept_application: ["open_construction", "situated_application"],
};

const DEFAULT_SILENT_SCENE_PLAN = SILENT_SCENE_PLANS.procedure;

/**
 * 从 episode 冻结事实派生 journeyPlan（§3.1 规则 1-4 + 06-6 gate，fail closed）。
 */
export function buildJourneyPlan(input: JourneyPlanInput): JourneyPlanV1 {
  // silent 正式航程需要场景数据真实可用：claim <2 片段或 canonical 缺失时
  // silentSceneData 为 null → 不签发 silent（回退 text/voice，§3.7 fail-closed）。
  const silentEligible =
    input.formalPlanKind === "structured_mastery_bundle"
    && input.structuredProofEligibility === "eligible"
    && input.crossModalGoldPassed
    && input.silentSceneData != null;

  if (silentEligible) {
    // 当前确定性 Scene Author 仅支持 procedure family（ordering/repair）；
    // 非 procedure family 无 scenes 可下发 → 保持 fail-closed 回退（§3.7），
    // 不把 relation_canvas 等场景计划伪装成可渲染。
    const isProcedure = (input.silentProfileFamily ?? "procedure") === "procedure";
    if (isProcedure && input.silentSceneData) {
      const scenePlan = input.silentProfileFamily
        ? (SILENT_SCENE_PLANS[input.silentProfileFamily] ?? DEFAULT_SILENT_SCENE_PLAN)
        : DEFAULT_SILENT_SCENE_PLAN;
      const scenes: JourneyScenePayloadV1[] = [
        {
          sceneId: "scene-ordering-v1",
          sceneType: "ordering",
          targetKeyPointId: input.keyPointId ?? "",
          publicPayload: input.silentSceneData.ordering,
        },
        {
          sceneId: "scene-repair-v1",
          sceneType: "repair",
          targetKeyPointId: input.keyPointId ?? "",
          publicPayload: input.silentSceneData.repair,
        },
      ];
      return {
        version: JOURNEY_PLAN_VERSION,
        mode: "silent",
        scenePlan,
        scenes,
        trustCeiling: "mastery_eligible",
        journeyHint: "本轮由伴星安排排序与修复练习，不强制打字。",
        reason: "silent-formal-plan",
      };
    }
    // scenes 不可用（非 procedure family / 无场景数据）→ 回退默认链；
    // 注意 silentEligible 已要求 silentSceneData 非空，此处检查仅为类型窄化。
  }

  // 06-6 transfer gate（§3.1 规则 3 默认链 silent → transfer → text 的一部分）：
  // rubricComplete + evidenceComplete 双要件齐全才开放（record_only 不消费 schedule）。
  if (input.rubricComplete && input.evidenceComplete) {
    return {
      version: JOURNEY_PLAN_VERSION,
      mode: "transfer",
      scenePlan: ["multi_step_scenario"],
      trustCeiling: "record_only",
      journeyHint: "本轮为情境应用练习，默认不影响复习时间。",
      reason: "transfer-gate-passed",
    };
  }

  if (input.formalPlanKind === "voice_mastery") {
    return {
      version: JOURNEY_PLAN_VERSION,
      mode: "voice",
      scenePlan: ["voice_teachback"],
      trustCeiling: "mastery_eligible",
      journeyHint: "本轮以语音复述为主。",
      reason: "voice-formal-plan",
    };
  }

  if (input.formalPlanKind === "facet_only") {
    return {
      version: JOURNEY_PLAN_VERSION,
      mode: "text",
      scenePlan: [],
      trustCeiling: "facet_eligible",
      journeyHint: "本轮只记录这项能力，复习时间不变。",
      reason: "facet-only",
    };
  }

  return {
    version: JOURNEY_PLAN_VERSION,
    mode: "practice",
    scenePlan: [],
    trustCeiling: "practice",
    journeyHint: "本轮为练习，不影响进度。",
    reason: "practice-or-text",
  };
}
